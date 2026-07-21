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
 * `payload.type` is one of: "igdrasil:ping" (answered locally), or the fixed
 * prepare/validate/connect/status/disconnect requests relayed to the worker.
 */
const TAG = "invoice-collector";

/** Requests forwarded to the service worker (everything else is rejected). */
const RELAYED = new Set([
  "igdrasil:prepare",
  "igdrasil:validate",
  "igdrasil:connect",
  "igdrasil:status",
  "igdrasil:disconnect",
]);

export interface ConnectBridgeWindow {
  readonly location: { readonly origin: string };
  postMessage(message: unknown, targetOrigin: string): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

export interface ConnectBridgeRuntime {
  getManifest(): { version: string };
  sendMessage(message: unknown, callback: (response: unknown) => void): void;
  readonly lastError?: { message?: string };
}

/** Install one bridge listener. Dependencies are injectable so the complete
 * page/extension trust boundary can be exercised without privileged APIs. */
export function installConnectBridge(
  bridgeWindow: ConnectBridgeWindow,
  runtime: ConnectBridgeRuntime,
): void {
  const appOrigin = bridgeWindow.location.origin;
  const version = runtime.getManifest().version;

  // Announce presence so the app can render "Connect" without polling. The app
  // can also ping at any time, which is reliable if it loads later.
  bridgeWindow.postMessage({ __ic: TAG, kind: "present", version }, appOrigin);

  bridgeWindow.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== bridgeWindow || event.origin !== appOrigin) return;
    const data = event.data as { __ic?: string; kind?: string; requestId?: string; payload?: unknown } | null;
    if (
      !data || data.__ic !== TAG || data.kind !== "request" ||
      typeof data.requestId !== "string" || data.requestId.length < 1 || data.requestId.length > 160
    ) return;

    const reply = (result: unknown) =>
      bridgeWindow.postMessage({ __ic: TAG, kind: "response", requestId: data.requestId, result }, appOrigin);

    const payload = data.payload as { type?: string } | undefined;
    const type = payload?.type ?? "";

    // Presence check is answered locally — no need to wake the worker.
    if (type === "igdrasil:ping") {
      reply({ ok: true, present: true, version });
      return;
    }
    if (!RELAYED.has(type)) {
      reply({ ok: false, error: "unsupported request" });
      return;
    }

    runtime.sendMessage(payload, (res) => {
      reply(runtime.lastError ? { ok: false, error: runtime.lastError.message } : res);
    });
  });
}

if (typeof window !== "undefined" && typeof chrome !== "undefined") {
  installConnectBridge(
    window as unknown as ConnectBridgeWindow,
    chrome.runtime as unknown as ConnectBridgeRuntime,
  );
}
