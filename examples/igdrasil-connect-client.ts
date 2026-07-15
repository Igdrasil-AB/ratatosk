/**
 * Igdrasil ↔ Invoice Collector connect client — DROP-IN for the Igdrasil web app.
 *
 * Copy this file into the Igdrasil frontend. It talks to the extension's content
 * bridge over `window.postMessage` — no extension id required — and detects
 * whether the extension is installed. It only works on the Igdrasil origin
 * (`https://accounting.igdrasil.se`), which is the only origin the extension trusts.
 *
 *   import { pingInvoiceCollector, connectInvoiceCollector } from "./igdrasil-connect-client";
 *
 *   const { present } = await pingInvoiceCollector();
 *   if (present) {
 *     const prepared = await prepareInvoiceCollectorConnect();
 *     if (!prepared.ok || !prepared.state) throw new Error("No connection intent");
 *     const token = await mintScopedCollectorToken(); // done by the Igdrasil backend
 *     await connectInvoiceCollector({ token, companyId, apiBaseUrl, state: prepared.state });
 *   }
 */
const TAG = "invoice-collector";

export interface ConnectParams {
  /** An Igdrasil-issued, upload-only Collector token. Never pass a session JWT. */
  token: string;
  /** The company the collected invoices belong to. */
  companyId: string;
  /** The Igdrasil API base URL, e.g. "https://api.igdrasil.se". Must be an `*.igdrasil.se` https host. */
  apiBaseUrl: string;
  /** One-use state created by an explicit connection action. */
  state: string;
}

export type ConnectResult =
  | { ok: true; present?: boolean; version?: string; connected?: boolean; companyId?: string; state?: string }
  | { ok: false; error: string };

let seq = 0;

/** Send one request to the extension bridge and await its response (or time out). */
function request(payload: Record<string, unknown>, timeoutMs = 4000): Promise<ConnectResult> {
  return new Promise((resolve) => {
    const requestId = `${TAG}:${seq++}:${String(Math.random()).slice(2)}`;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const d = event.data as { __ic?: string; kind?: string; requestId?: string; result?: ConnectResult } | null;
      if (!d || d.__ic !== TAG || d.kind !== "response" || d.requestId !== requestId) return;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(d.result ?? { ok: false, error: "empty response" });
    };
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve({ ok: false, error: "extension not responding (is Invoice Collector installed?)" });
    }, timeoutMs);
    window.addEventListener("message", onMessage);
    window.postMessage({ __ic: TAG, kind: "request", requestId, payload }, window.location.origin);
  });
}

/** Is the extension installed? Resolves quickly; `present` is false if not. */
export async function pingInvoiceCollector(): Promise<{ present: boolean; version?: string }> {
  const res = await request({ type: "igdrasil:ping" }, 1500);
  return res.ok ? { present: !!res.present, version: res.version } : { present: false };
}

/** Create a one-use intent when connection begins inside the accounting app. */
export function prepareInvoiceCollectorConnect(): Promise<ConnectResult> {
  return request({ type: "igdrasil:prepare" });
}

/** Check a Ratatosk-created intent before minting a scoped token. */
export function validateInvoiceCollectorIntent(state: string): Promise<ConnectResult> {
  return request({ type: "igdrasil:validate", state });
}

/** Hand the extension an upload-only token + company. */
export function connectInvoiceCollector(params: ConnectParams): Promise<ConnectResult> {
  return request({ type: "igdrasil:connect", ...params });
}

/** Whether the extension is currently connected to Igdrasil (and for which company). */
export function getInvoiceCollectorStatus(): Promise<ConnectResult> {
  return request({ type: "igdrasil:status" });
}

/** Disconnect the extension from Igdrasil (clears the token, reverts to local saving). */
export function disconnectInvoiceCollector(): Promise<ConnectResult> {
  return request({ type: "igdrasil:disconnect" });
}
