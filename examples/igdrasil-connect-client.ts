/**
 * Igdrasil ↔ Invoice Collector connect client — protocol v2.
 *
 * The region between the `shared:` markers below is the CANONICAL bridge
 * client. It is mirrored verbatim into the Igdrasil web app at
 * `frontend/src/lib/invoiceCollectorApi.ts`, and both repositories hash it
 * against `test/fixtures/igdrasil-connect/manifest.json`. That gate exists
 * because the previous "copy this file into Igdrasil" instruction produced a
 * client that diverged for three weeks with nothing able to notice: no build
 * and no test spanned the two repositories.
 *
 * Keep the region dependency-free. It talks to the extension's content bridge
 * over `window.postMessage` — no extension id required — and only works on the
 * Igdrasil origin (`https://accounting.igdrasil.se`), the only origin the
 * extension trusts.
 *
 *   const { present } = await pingInvoiceCollector();
 *   if (present) {
 *     const prepared = await prepareInvoiceCollectorConnect();
 *     if (!prepared.ok || !prepared.state) throw new Error("No connection intent");
 *     const token = await mintScopedCollectorToken(prepared.state); // Igdrasil backend
 *     await connectInvoiceCollector({ token, companyId, companyName, apiBaseUrl, state: prepared.state });
 *   }
 */

// ---8<--- shared: igdrasil-connect-client (mirrored; edit in Ratatosk) ---8<---
const TAG = "invoice-collector";
export const INVOICE_COLLECTOR_PROTOCOL = 2;
export const IGDRASIL_COLLECTOR_ORIGIN = "https://accounting.igdrasil.se";
const COLLECTOR_TOKEN_PATTERN = /^rat_[a-f0-9]{64}$/;
const COLLECTOR_STATE_PATTERN = /^[a-f0-9]{64}$/;

/** Stable refusal codes. Prose belongs to whoever renders the failure. */
export type InvoiceCollectorErrorCode =
  | "intent_missing"
  | "intent_expired"
  | "origin_not_allowed"
  | "token_invalid"
  | "backend_not_allowed"
  | "company_already_connected"
  | "unknown_company"
  | "invalid_request"
  | "revoke_failed"
  /** The bridge never answered — the extension is absent, asleep, or blocked. */
  | "extension_unavailable";

export interface ConnectedCompany {
  companyId: string;
  companyName: string;
  supplierCount: number;
  /** ISO-8601 expiry of that company's upload credential, when known. */
  expiresAt?: string;
}

export interface ConnectParams {
  /** An Igdrasil-issued, upload-only Collector token. Never pass a session JWT. */
  token: string;
  /** The company the collected invoices belong to. */
  companyId: string;
  /** How the extension labels this company. Shown on every supplier it feeds. */
  companyName: string;
  /** The reviewed Collector API base URL: "https://accounting.igdrasil.se". */
  apiBaseUrl: string;
  /** One-use state created by an explicit connection action. */
  state: string;
  /** Expiry echoed from the mint response, so the panel can warn before it lapses. */
  expiresAt?: string;
}

export type BridgeResult =
  | { ok: true; protocol?: number; present?: boolean; version?: string; state?: string; companies?: ConnectedCompany[] }
  | { ok: false; code: InvoiceCollectorErrorCode };

/** Accept only the upload-only credential shape Collector itself persists. */
export function collectorTokenFromResponse(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const token = (value as Record<string, unknown>).token;
  return typeof token === "string" && COLLECTOR_TOKEN_PATTERN.test(token) ? token : undefined;
}

export function isCollectorConnectionState(value: unknown): value is string {
  return typeof value === "string" && COLLECTOR_STATE_PATTERN.test(value);
}

/**
 * Run a token-minting action only after the extension confirms the one-use
 * connection intent it created. Keeping the ordering here makes it usable by
 * every web-app integration, and lets callers test that minting cannot happen
 * when the extension is absent or the intent has expired.
 */
export async function withValidatedInvoiceCollectorIntent<T>(
  state: string,
  mint: () => Promise<T>,
  validate: (state: string) => Promise<BridgeResult> = validateInvoiceCollectorIntent,
): Promise<{ ok: true; value: T } | { ok: false; code: InvoiceCollectorErrorCode }> {
  const validation = await validate(state);
  if (!validation.ok) return { ok: false, code: validation.code };
  return { ok: true, value: await mint() };
}

let seq = 0;

/** Send one request to the extension bridge and await its response (or time out). */
function request(payload: Record<string, unknown>, timeoutMs = 4000): Promise<BridgeResult> {
  return new Promise((resolve) => {
    const requestId = `${TAG}:${seq++}:${String(Math.random()).slice(2)}`;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const d = event.data as { __ic?: string; kind?: string; requestId?: string; result?: BridgeResult } | null;
      if (!d || d.__ic !== TAG || d.kind !== "response" || d.requestId !== requestId) return;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(d.result ?? { ok: false, code: "extension_unavailable" });
    };
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve({ ok: false, code: "extension_unavailable" });
    }, timeoutMs);
    window.addEventListener("message", onMessage);
    window.postMessage({ __ic: TAG, kind: "request", requestId, payload }, window.location.origin);
  });
}

/**
 * Is the extension installed?
 *
 * Bounded retry, not a single shot. The bridge is a `document_idle` content
 * script, so one 1500 ms ping raced page load and told people with the
 * extension installed that they did not have it.
 */
export async function pingInvoiceCollector(attempts = 3, timeoutMs = 1500): Promise<{ present: boolean; version?: string; protocol?: number }> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const res = await request({ type: "igdrasil:ping" }, timeoutMs);
    if (res.ok && res.present) return { present: true, version: res.version, protocol: res.protocol };
  }
  return { present: false };
}

/** Create a one-use intent when connection begins inside the accounting app. */
export function prepareInvoiceCollectorConnect(): Promise<BridgeResult> {
  return request({ type: "igdrasil:prepare" });
}

/** Check a Ratatosk-created intent before minting a scoped token. */
export function validateInvoiceCollectorIntent(state: string): Promise<BridgeResult> {
  return request({ type: "igdrasil:validate", state });
}

/** ADD a company. It never replaces a destination the extension already holds. */
export function connectInvoiceCollector(params: ConnectParams): Promise<BridgeResult> {
  return request({ type: "igdrasil:connect", ...params });
}

/** Every company this browser profile delivers to, and what each is carrying. */
export function getInvoiceCollectorStatus(): Promise<BridgeResult> {
  return request({ type: "igdrasil:status" });
}

/** Disconnect ONE company. Its suppliers are left unbound and paused. */
export function disconnectInvoiceCollector(companyId: string): Promise<BridgeResult> {
  return request({ type: "igdrasil:disconnect", companyId });
}

/** Map the disconnect acknowledgment without claiming success on refusal or timeout. */
export function disconnectInvoiceCollectorOutcome(result: BridgeResult): {
  state: "connected" | "disconnected";
  code: InvoiceCollectorErrorCode | null;
} {
  return result.ok
    ? { state: "disconnected", code: null }
    : { state: "connected", code: result.code };
}

/**
 * Days a company has left before its credential lapses from disuse.
 *
 * A successful ingest slides the 90-day expiry, so an expiry that is less than
 * 30 days out means nothing has been collected for 60 days — the point at which
 * the app should say so, while reconnecting is still a click rather than a
 * mystery about why invoices stopped arriving.
 */
export const COLLECTOR_TOKEN_LIFETIME_DAYS = 90;
export const COLLECTOR_INACTIVITY_WARNING_DAYS = 60;

export function isCollectorConnectionStale(company: ConnectedCompany, now = Date.now()): boolean {
  if (!company.expiresAt) return false;
  const expiresAt = Date.parse(company.expiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  const quietDays = (COLLECTOR_TOKEN_LIFETIME_DAYS - COLLECTOR_INACTIVITY_WARNING_DAYS) * 24 * 60 * 60 * 1000;
  return expiresAt - now <= quietDays;
}
// ---8<--- end shared ---8<---
