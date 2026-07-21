import type { IngestSink } from "./sink";
import { HttpSink } from "./http-sink";

export interface IgdrasilSinkConfig {
  /** Reviewed Collector API origin: `https://accounting.igdrasil.se`. */
  baseUrl: string;
  /** The company the documents belong to. */
  companyId: string;
  /** Returns an Igdrasil-issued, upload-only Collector token. */
  getToken: () => Promise<string | undefined>;
}

export const IGDRASIL_INGEST_PATH = "/api/documents/ingest";
const IGDRASIL_COLLECTOR_ORIGIN = "https://accounting.igdrasil.se";

/** Normalizes the one reviewed Collector API origin. This check intentionally
 * lives beside the sink so direct configuration cannot bypass the app-connect
 * handshake's exact-origin validation. */
export function normalizeIgdrasilApiBase(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("invalid Igdrasil backend URL");
  }
  if (
    url.origin !== IGDRASIL_COLLECTOR_ORIGIN || url.port || url.username || url.password ||
    url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("Igdrasil backend host is not allowed");
  }
  return url.origin;
}

export function isIgdrasilApiBase(baseUrl: string): boolean {
  try {
    normalizeIgdrasilApiBase(baseUrl);
    return true;
  } catch {
    return false;
  }
}

/**
 * Igdrasil host binding.
 *
 * It is intentionally a thin configuration of {@link HttpSink} rather than a new
 * class — the wire format is identical, Igdrasil just points at its own
 * `/api/documents/ingest` endpoint on the reviewed accounting origin, authenticates with a scoped Collector token, and
 * tags the source. Any other host integrates the same way.
 */
export function createIgdrasilSink(cfg: IgdrasilSinkConfig): IngestSink {
  const baseUrl = normalizeIgdrasilApiBase(cfg.baseUrl);
  const endpoint = `${baseUrl}${IGDRASIL_INGEST_PATH}`;
  const host = new URL(baseUrl).hostname;
  return new HttpSink({
    endpoint,
    companyId: cfg.companyId,
    token: cfg.getToken,
    // The Collector token is only ever sent to the Igdrasil host itself.
    allowTokenHosts: [host],
    // engine-api scopes the tenant from the X-Company-Id header (not the form field).
    headers: { "X-Collector": "invoice-collector-extension", "X-Company-Id": cfg.companyId },
  });
}
