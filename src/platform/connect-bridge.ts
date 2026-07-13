/**
 * Connect bridge — the ONLY link between the Igdrasil web app and the extension.
 *
 * It runs only on `https://accounting.igdrasil.se/*` (see the `content_scripts`
 * match in the manifest), announces the extension to the page, and relays a
 * small, fixed set of requests to the service worker. The service worker
 * independently re-validates the sender origin before it touches a token, so the
 * page never needs the extension id and there is no direct page→worker channel.
 *
 * Wire protocol (window.postMessage, same-origin only):
 *   page → bridge:  { __ic: "invoice-collector", kind: "request", requestId, payload }
 *   bridge → page:  { __ic: "invoice-collector", kind: "response", requestId, result }
 *   bridge → page:  { __ic: "invoice-collector", kind: "present", version }   (on load)
 *
 * `payload.type` is one of: "igdrasil:ping" (answered locally), "igdrasil:connect",
 * "igdrasil:status", "igdrasil:disconnect" (relayed to the service worker).
 */
const TAG = "invoice-collector";
const APP_ORIGIN = location.origin; // guaranteed to be the Igdrasil origin by the match
const VERSION = chrome.runtime.getManifest().version;

/** Requests forwarded to the service worker (everything else is rejected). */
const RELAYED = new Set(["igdrasil:connect", "igdrasil:status", "igdrasil:disconnect"]);

// Announce presence so the app can render "Connect" without polling. The app can
// also ping at any time (below), which is the reliable path if it loads later.
window.postMessage({ __ic: TAG, kind: "present", version: VERSION }, APP_ORIGIN);

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window || event.origin !== APP_ORIGIN) return;
  const data = event.data as { __ic?: string; kind?: string; requestId?: string; payload?: unknown } | null;
  if (!data || data.__ic !== TAG || data.kind !== "request") return;

  const reply = (result: unknown) =>
    window.postMessage({ __ic: TAG, kind: "response", requestId: data.requestId, result }, APP_ORIGIN);

  const payload = data.payload as { type?: string } | undefined;
  const type = payload?.type ?? "";

  // Presence check is answered locally — no need to wake the worker.
  if (type === "igdrasil:ping") {
    reply({ ok: true, present: true, version: VERSION });
    return;
  }
  if (!RELAYED.has(type)) {
    reply({ ok: false, error: "unsupported request" });
    return;
  }

  chrome.runtime.sendMessage(payload, (res) => {
    reply(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : res);
  });
});
