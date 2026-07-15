import { send, type RecorderProgress, type RecorderStopResult } from "../../platform/messaging";

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
      <li>Nothing leaves the browser unless you explicitly copy the redacted report.</li>
    </ul>
    <label><input id="consent" type="checkbox" /> <span>I understand the capture scope and am authorized to record this billing page.</span></label>
    <button id="start" disabled>Start recording this page</button>
  </section>`;
  const consent = document.getElementById("consent") as HTMLInputElement;
  const start = document.getElementById("start") as HTMLButtonElement;
  consent.addEventListener("change", () => { start.disabled = !consent.checked; });
  start.addEventListener("click", () => void startRecording());
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
  app.innerHTML = `<section class="card result"><b>${esc(summary)}</b><span>${result.captured} sanitized entries analyzed.</span><button id="copy">Copy redacted report</button><button class="secondary" id="again">Record another page</button><pre>${esc(result.report.slice(0, 5000))}</pre><div class="notice">Review the report before sharing. Studio intentionally removes credential values and query-string values, which may require manual recipe completion.</div></section>`;
  document.getElementById("copy")?.addEventListener("click", () => void copy(result.report));
  document.getElementById("again")?.addEventListener("click", showConsent);
}

async function copy(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); }
  catch { error.textContent = "Clipboard access failed. Select the preview manually."; }
}

function stopPolling(): void { if (timer) clearInterval(timer); timer = undefined; }

void load();
