import type { IngestSink } from "./sink";
import { HttpSink } from "./http-sink";

export interface IgdrasilSinkConfig {
  /** Base URL of the Igdrasil engine-api, e.g. `https://api.igdrasil.se`. */
  baseUrl: string;
  /** The company the documents belong to. */
  companyId: string;
  /** Returns the user's Clerk session JWT for authenticating to engine-api. */
  getToken: () => Promise<string | undefined>;
}

/**
 * Igdrasil host binding.
 *
 * It is intentionally a thin configuration of {@link HttpSink} rather than a new
 * class — the wire format is identical, Igdrasil just points at its own
 * `/documents/ingest` endpoint, authenticates with the user's Clerk session, and
 * tags the source. Any other host integrates the same way.
 */
export function createIgdrasilSink(cfg: IgdrasilSinkConfig): IngestSink {
  return new HttpSink({
    endpoint: `${cfg.baseUrl.replace(/\/+$/, "")}/documents/ingest`,
    companyId: cfg.companyId,
    token: cfg.getToken,
    // engine-api scopes the tenant from the X-Company-Id header (not the form field).
    headers: { "X-Collector": "invoice-collector-extension", "X-Company-Id": cfg.companyId },
  });
}
