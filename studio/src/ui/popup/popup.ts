import type { SupplierFingerprintSubmissionV1 } from "../../../../src/core/recorder/supplier-fingerprint";
import {
  send,
  type FingerprintOutboxItemSummary,
  type FingerprintOutboxStatus,
  type RecorderProgress,
  type RecorderStopResult,
} from "../../platform/messaging";

const app = document.getElementById("app") as HTMLElement;
const error = document.getElementById("error") as HTMLElement;
let timer: ReturnType<typeof setInterval> | undefined;

const esc = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string);

async function load(): Promise<void> {
  const response = await send({ type: "recorderStatus" });
  if (response.ok && "recording" in response && response.recording) return showRecording();
  showConsent();
}

function showConsent(): void {
  stopPolling();
  app.innerHTML = `<section class="card">
    <b>Before you record</b>
    <ul>
      <li>Studio observes network request metadata, JSON/HTML response bodies, embedded billing frames, and a rendered DOM snapshot.</li>
      <li>Request header values are never stored except a normalized content type. Studio keeps only a bounded authentication scheme/header-name marker.</li>
      <li>Capture data stays in browser session storage and is deleted when recording stops or Chrome closes.</li>
      <li>Nothing is sent automatically during capture. Approved fingerprints stay locally recoverable and can be explicitly delivered only after pairing with a scoped Svala intake token.</li>
    </ul>
    <label><input id="consent" type="checkbox" /> <span>I understand the capture scope and am authorized to record this billing page.</span></label>
    <button id="start" disabled>Start recording this page</button>
    <div id="mission" class="mission" aria-live="polite"></div>
    <div id="outbox" class="outbox" aria-live="polite"></div>
  </section>`;
  const consent = document.getElementById("consent") as HTMLInputElement;
  const start = document.getElementById("start") as HTMLButtonElement;
  consent.addEventListener("change", () => { start.disabled = !consent.checked; });
  start.addEventListener("click", () => void startRecording());
  void refreshOutbox();
  void refreshMission();
}

async function startRecording(): Promise<void> {
  error.textContent = "";
  const response = await send({ type: "recorderStart" });
  if (!response.ok) { error.textContent = response.error; return; }
  showRecording();
}

function showRecording(): void {
  app.innerHTML = `<section class="card"><div class="live"><span class="dot"></span><b>Recording</b><span id="progress">Waiting for billing traffic…</span></div><button id="stop">Stop and analyze</button></section>`;
  document.getElementById("stop")?.addEventListener("click", () => void stopRecording());
  stopPolling();
  timer = setInterval(() => void poll(), 1200);
  void poll();
}

async function poll(): Promise<void> {
  const response = await send({ type: "recorderProgress" });
  if (!response.ok || !("progress" in response)) return;
  const p: RecorderProgress = response.progress;
  const el = document.getElementById("progress");
  if (el) el.textContent = `${p.captured} captured${p.documents ? ` · ${p.documents} documents` : ""}${p.detected ? " · enough to analyze" : ""}`;
}

async function stopRecording(): Promise<void> {
  stopPolling();
  const response = await send({ type: "recorderStop" });
  if (!response.ok || !("report" in response)) { error.textContent = response.ok ? "No report was produced" : response.error; return showConsent(); }
  showResult(response);
}

function showResult(result: RecorderStopResult): void {
  const summary = result.draft ? `Recipe drafted with ${result.draft.confidence} confidence.` : "No recipe could be inferred automatically.";
  const fingerprint = result.fingerprint;
  const preview = fingerprint ? JSON.stringify(fingerprint, null, 2) : "No structural fingerprint was produced.";
  app.innerHTML = `<section class="card result">
    <b>${esc(summary)}</b>
    <span>${result.captured} captured entries analyzed.</span>
    <details><summary>Agent report</summary><pre>${esc(result.report.slice(0, 5000))}</pre></details>
    <button id="copy">Copy redacted report</button>
    <hr />
    <div class="section-title"><b>Supplier fingerprint</b><span class="badge">structural only</span></div>
    <p class="notice">This exact preview contains request shapes and inferred field paths, never captured header values, bodies, query values, fixtures, or invoice values. Origins and schema names can still reveal tenant or internal naming, so inspect them before approval.</p>
    <pre class="fingerprint-preview">${esc(preview)}</pre>
    ${fingerprint ? `<div class="approval">
      <label><input id="authority" type="checkbox" /> <span>I am authorized to share structural information about this supplier portal.</span></label>
      <label><input id="share" type="checkbox" /> <span>I approve saving the exact fingerprint displayed above for Svala.</span></label>
      <button id="approve" disabled>Approve &amp; save for Svala</button>
      <div id="delivery-status" class="notice" aria-live="polite">Approval saves locally first. Delivery is always a separate action.</div>
    </div>` : ""}
    <button class="secondary" id="again">Record another page</button>
    <div class="notice">The approved outbox retains at most 20 fingerprints for 30 days. You can clear it from the start screen.</div>
  </section>`;
  document.getElementById("copy")?.addEventListener("click", () => void copy(result.report));
  document.getElementById("again")?.addEventListener("click", showConsent);
  if (fingerprint) wireFingerprintApproval(fingerprint);
}

function wireFingerprintApproval(fingerprint: NonNullable<RecorderStopResult["fingerprint"]>): void {
  const authority = document.getElementById("authority") as HTMLInputElement;
  const share = document.getElementById("share") as HTMLInputElement;
  const approve = document.getElementById("approve") as HTMLButtonElement;
  const status = document.getElementById("delivery-status") as HTMLElement;
  const update = () => { approve.disabled = !authority.checked || !share.checked; };
  authority.addEventListener("change", update);
  share.addEventListener("change", update);
  approve.addEventListener("click", async () => {
    approve.disabled = true;
    error.textContent = "";
    const response = await send({
      type: "fingerprintApprove",
      fingerprint,
      authorityConfirmed: authority.checked,
      shareApproved: share.checked,
    });
    if (!response.ok || !("submission" in response) || !("outbox" in response)) {
      error.textContent = response.ok ? "The approved fingerprint was not saved." : response.error;
      update();
      return;
    }
    status.textContent = `${outboxLabel(response.outbox)} No automatic delivery was attempted.${response.outbox.transport.configured ? " Open the start screen to deliver it." : " Pair with Svala on the start screen when ready."}`;
    approve.textContent = "Approved & saved locally";
    authority.disabled = true;
    share.disabled = true;
    const download = document.createElement("button");
    download.id = "download-fingerprint";
    download.className = "secondary";
    download.textContent = "Download approved JSON for Svala";
    download.addEventListener("click", () => downloadSubmission(response.submission));
    status.insertAdjacentElement("afterend", download);
  });
}

async function refreshOutbox(): Promise<void> {
  const [statusResponse, listResponse] = await Promise.all([
    send({ type: "fingerprintOutboxStatus" }),
    send({ type: "fingerprintOutboxList" }),
  ]);
  if (!statusResponse.ok || !("outbox" in statusResponse) || !listResponse.ok || !("items" in listResponse)) return;
  renderOutbox(statusResponse.outbox, listResponse.items);
}

function renderOutbox(status: FingerprintOutboxStatus, items: readonly FingerprintOutboxItemSummary[] = []): void {
  const outbox = document.getElementById("outbox");
  if (!outbox) return;
  const pairing = status.transport.configured
    ? `<div class="pairing-row"><span><b>Svala paired</b><br />Scoped upload token stored locally.</span><button class="text-button" id="disconnect-svala">Disconnect</button></div>`
    : `<div class="pairing"><label for="svala-token">Svala intake token</label><input id="svala-token" type="password" autocomplete="off" spellcheck="false" placeholder="rtk_…" /><button class="secondary" id="pair-svala">Pair with Svala</button></div>`;
  const heading = status.totalCount
    ? `<div class="outbox-heading"><span>${esc(outboxLabel(status))}</span><button class="text-button" id="clear-outbox">Clear all</button></div>`
    : `<span>No approved fingerprints saved.</span>`;
  outbox.innerHTML = `${pairing}${heading}
    <div class="outbox-items">${items.map((item) => `<article class="outbox-item">
      <b>${esc(item.supplierId)}</b><span title="${esc(item.supplierOrigin)}">${esc(item.supplierOrigin)}</span>
      <span>Captured ${esc(formatTimestamp(item.capturedAt))} · expires ${esc(formatTimestamp(item.expiresAt))}</span>
      <span class="delivery-state">${esc(deliveryLabel(item))}</span>
      ${item.receipt ? `<span>Receipt ${esc(item.receipt.receiptId)} · ${esc(formatTimestamp(item.receipt.acceptedAt))}</span>` : ""}
      ${item.mission ? `<span>Mission ${esc(item.mission.missionId)} · ${esc(item.mission.status.replaceAll("_", " "))}</span>` : ""}
      ${status.transport.configured && (item.deliveryState === "pending" || item.deliveryState === "retryable") ? `<button class="deliver-saved" data-fingerprint-id="${esc(item.fingerprintId)}">Deliver to Svala</button>` : ""}
      <button class="secondary download-saved" data-fingerprint-id="${esc(item.fingerprintId)}">Download JSON</button>
    </article>`).join("")}</div>`;
  document.getElementById("pair-svala")?.addEventListener("click", () => void pairWithSvala());
  document.getElementById("disconnect-svala")?.addEventListener("click", () => void disconnectSvala());
  outbox.querySelectorAll<HTMLButtonElement>(".deliver-saved").forEach((button) => {
    button.addEventListener("click", () => void deliverSavedSubmission(button));
  });
  outbox.querySelectorAll<HTMLButtonElement>(".download-saved").forEach((button) => {
    button.addEventListener("click", () => void downloadSavedSubmission(button.dataset.fingerprintId ?? ""));
  });
  document.getElementById("clear-outbox")?.addEventListener("click", async () => {
    const response = await send({ type: "fingerprintClearOutbox" });
    if (response.ok && "outbox" in response) renderOutbox(response.outbox, []);
  });
}

async function refreshMission(): Promise<void> {
  const container = document.getElementById("mission");
  if (!container) return;
  const response = await send({ type: "missionStatus" });
  if (!response.ok || !("mission" in response)) return;
  const mission = response.mission;
  if (!mission) {
    container.innerHTML = `<label for="mission-code">Optional capture mission code</label><input id="mission-code" type="password" autocomplete="off" spellcheck="false" placeholder="rmc_…" /><button class="secondary" id="load-mission">Load mission</button>`;
    document.getElementById("load-mission")?.addEventListener("click", () => void loadMission());
    return;
  }
  container.innerHTML = `<div class="mission-heading"><b>${esc(mission.supplierLabel)} capture mission</b><button class="text-button" id="clear-mission">Remove from Studio</button></div>
    <span>Required origin: ${esc(mission.allowedOrigin)}</span>
    <p>${esc(mission.eligibilityStatement)}</p>
    <ol>${mission.actions.map((action) => `<li>${esc(action.label)}</li>`).join("")}</ol>
    <span>Status: ${esc(mission.status.replaceAll("_", " "))} · expires ${esc(formatTimestamp(mission.expiresAt))}</span>`;
  document.getElementById("clear-mission")?.addEventListener("click", async () => {
    await send({ type: "missionClear" });
    await refreshMission();
  });
}

async function loadMission(): Promise<void> {
  const input = document.getElementById("mission-code") as HTMLInputElement | null;
  const code = input?.value.trim() ?? "";
  if (input) input.value = "";
  error.textContent = "";
  const response = await send({ type: "missionLoad", code });
  if (!response.ok) error.textContent = response.error;
  await refreshMission();
}

async function pairWithSvala(): Promise<void> {
  const input = document.getElementById("svala-token") as HTMLInputElement | null;
  const token = input?.value.trim() ?? "";
  if (input) input.value = "";
  error.textContent = "";
  const response = await send({ type: "fingerprintPair", token });
  if (!response.ok) error.textContent = response.error;
  await refreshOutbox();
}

async function disconnectSvala(): Promise<void> {
  error.textContent = "";
  const response = await send({ type: "fingerprintDisconnect" });
  if (!response.ok) error.textContent = response.error;
  await refreshOutbox();
}

async function deliverSavedSubmission(button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  error.textContent = "";
  const response = await send({ type: "fingerprintDeliver", fingerprintId: button.dataset.fingerprintId ?? "" });
  if (!response.ok) error.textContent = response.error;
  await refreshOutbox();
}

async function downloadSavedSubmission(fingerprintId: string): Promise<void> {
  error.textContent = "";
  const response = await send({ type: "fingerprintOutboxGet", fingerprintId });
  if (!response.ok || !("submission" in response)) {
    error.textContent = response.ok ? "The saved fingerprint could not be exported." : response.error;
    await refreshOutbox();
    return;
  }
  downloadSubmission(response.submission);
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : value;
}

function outboxLabel(status: FingerprintOutboxStatus): string {
  return `${status.totalCount} approved fingerprint${status.totalCount === 1 ? "" : "s"} saved locally${status.deliveredCount ? ` · ${status.deliveredCount} delivered` : ""}${status.rejectedCount ? ` · ${status.rejectedCount} needs review` : ""}.`;
}

function deliveryLabel(item: FingerprintOutboxItemSummary): string {
  if (item.deliveryState === "pending") return "Ready for explicit delivery";
  if (item.deliveryState === "delivering") return "Delivering…";
  if (item.deliveryState === "delivered") return "Delivered — receipt retained locally";
  if (item.deliveryState === "rejected") return "Rejected — re-pair or review before retrying";
  return item.nextAttemptAt ? `Retry eligible ${formatTimestamp(item.nextAttemptAt)}` : "Retryable";
}

function downloadSubmission(submission: SupplierFingerprintSubmissionV1): void {
  const json = `${JSON.stringify(submission, null, 2)}\n`;
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `ratatosk-${submission.fingerprint.supplier.idCandidate}-${submission.fingerprint.fingerprintId}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

async function copy(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); }
  catch { error.textContent = "Clipboard access failed. Select the preview manually."; }
}

function stopPolling(): void { if (timer) clearInterval(timer); timer = undefined; }

void load();
