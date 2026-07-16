import type { SupplierFingerprintSubmissionV1 } from "../../../../src/core/recorder/supplier-fingerprint";
import { send, type FingerprintOutboxStatus, type RecorderProgress, type RecorderStopResult } from "../../platform/messaging";

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
      <li>Cookies and authentication values are removed before capture data is stored.</li>
      <li>Capture data stays in browser session storage and is deleted when recording stops or Chrome closes.</li>
      <li>Nothing is sent automatically. An approved structural fingerprint can be saved locally for Svala; no network destination is configured.</li>
    </ul>
    <label><input id="consent" type="checkbox" /> <span>I understand the capture scope and am authorized to record this billing page.</span></label>
    <button id="start" disabled>Start recording this page</button>
    <div id="outbox" class="outbox" aria-live="polite"></div>
  </section>`;
  const consent = document.getElementById("consent") as HTMLInputElement;
  const start = document.getElementById("start") as HTMLButtonElement;
  consent.addEventListener("change", () => { start.disabled = !consent.checked; });
  start.addEventListener("click", () => void startRecording());
  void refreshOutbox();
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
    <p class="notice">This exact preview contains request shapes and inferred field paths, never captured headers, bodies, query values, fixtures, or invoice values.</p>
    <pre class="fingerprint-preview">${esc(preview)}</pre>
    ${fingerprint ? `<div class="approval">
      <label><input id="authority" type="checkbox" /> <span>I am authorized to share structural information about this supplier portal.</span></label>
      <label><input id="share" type="checkbox" /> <span>I approve saving the exact fingerprint displayed above for Svala.</span></label>
      <button id="approve" disabled>Approve &amp; save for Svala</button>
      <div id="delivery-status" class="notice" aria-live="polite">Approval will save locally only. No Svala network destination is configured.</div>
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
    if (!response.ok || !("submission" in response)) {
      error.textContent = response.ok ? "The approved fingerprint was not saved." : response.error;
      update();
      return;
    }
    status.textContent = `${outboxLabel(response.outbox)} No automatic delivery was attempted.`;
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
  const response = await send({ type: "fingerprintOutboxStatus" });
  if (!response.ok || !("outbox" in response)) return;
  renderOutbox(response.outbox);
}

function renderOutbox(status: FingerprintOutboxStatus): void {
  const outbox = document.getElementById("outbox");
  if (!outbox) return;
  if (!status.pendingCount) {
    outbox.innerHTML = `<span>No approved fingerprints saved.</span>`;
    return;
  }
  outbox.innerHTML = `<span>${esc(outboxLabel(status))} Delivery is not configured.</span><button class="text-button" id="clear-outbox">Clear</button>`;
  document.getElementById("clear-outbox")?.addEventListener("click", async () => {
    const response = await send({ type: "fingerprintClearOutbox" });
    if (response.ok && "outbox" in response) renderOutbox(response.outbox);
  });
}

function outboxLabel(status: FingerprintOutboxStatus): string {
  return `${status.pendingCount} approved fingerprint${status.pendingCount === 1 ? "" : "s"} saved locally.`;
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
