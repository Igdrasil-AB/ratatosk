import type { FetchedDocument } from "../core/types";
import type { IngestResult, IngestSink } from "./sink";

export interface HttpSinkConfig {
  /** Full URL to POST documents to. */
  endpoint: string;
  /** Optional tenant id, sent as `company_id`. */
  companyId?: string;
  /** Optional async bearer-token provider (e.g. a Clerk session JWT). */
  token?: () => Promise<string | undefined>;
  /**
   * Hostnames the bearer token may be sent to. When set, the token is attached
   * ONLY if the endpoint's host is in this list — so a misconfigured or
   * tampered endpoint can never exfiltrate the token to a foreign host. Omit to
   * allow any (https) host (the generic, token-less default).
   */
  allowTokenHosts?: string[];
  /** Extra static headers. */
  headers?: Record<string, string>;
}

/** Reject non-https endpoints (localhost excepted for dev) — the token/JWT and
 * invoice bytes must never travel in cleartext. */
function assertSecureEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`invalid ingest endpoint: ${endpoint}`);
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !isLocal) {
    throw new Error(`ingest endpoint must be https (got "${url.protocol}//${url.hostname}")`);
  }
  return url;
}

/**
 * The default, host-agnostic sink: multipart POST of the PDF + normalized
 * metadata. Any backend can accept this. The `idempotency_key` is sent both as a
 * form field and a header so the server can dedup however it prefers; a `409`
 * response is treated as a successful dedup, not an error.
 */
export class HttpSink implements IngestSink {
  constructor(private readonly cfg: HttpSinkConfig) {}

  async send(doc: FetchedDocument): Promise<IngestResult> {
    const url = assertSecureEndpoint(this.cfg.endpoint);

    const form = new FormData();
    form.append("file", new Blob([doc.bytes], { type: doc.contentType }), doc.filename);
    form.append("source", doc.source);
    form.append("vendor_id", doc.vendorId);
    form.append("vendor_invoice_id", doc.vendorInvoiceId);
    form.append("issued_at", doc.issuedAt);
    form.append("idempotency_key", doc.idempotencyKey);
    if (doc.total) form.append("amount_gross", doc.total);
    if (doc.currency) form.append("currency", doc.currency);
    if (this.cfg.companyId) form.append("company_id", this.cfg.companyId);

    const token = await this.cfg.token?.();
    // Never send the token to a host that isn't explicitly allow-listed.
    if (token && this.cfg.allowTokenHosts && !this.cfg.allowTokenHosts.includes(url.hostname)) {
      throw new Error(`refusing to send auth token to "${url.hostname}" (not in allow-list)`);
    }
    const res = await fetch(this.cfg.endpoint, {
      method: "POST",
      headers: {
        "Idempotency-Key": doc.idempotencyKey,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...this.cfg.headers,
      },
      body: form,
    });

    if (res.status === 409) return { accepted: true, deduped: true };
    if (!res.ok) throw new Error(`ingest failed: HTTP ${res.status}`);

    const body = (await res.json().catch(() => ({}))) as {
      id?: string;
      document_id?: string;
      duplicate?: boolean;
    };
    return { accepted: true, deduped: body.duplicate, id: body.document_id ?? body.id };
  }
}
