import type { FetchedDocument } from "../core/types";
import type { IngestResult, IngestSink } from "./sink";

export interface HttpSinkConfig {
  /** Full URL to POST documents to. */
  endpoint: string;
  /** Optional tenant id, sent as `company_id`. */
  companyId?: string;
  /** Optional async bearer-token provider (prefer a narrowly scoped credential). */
  token?: () => Promise<string | undefined>;
  /**
   * Hostnames the bearer token may be sent to. A token is never attached unless
   * the endpoint host is explicitly listed, so a misconfigured destination
   * cannot exfiltrate a credential.
   */
  allowTokenHosts?: string[];
  /** Extra static headers. */
  headers?: Record<string, string>;
}

type FrozenHttpSinkConfig = Readonly<Omit<HttpSinkConfig, "allowTokenHosts" | "headers">> & {
  allowTokenHosts?: readonly string[];
  headers?: Readonly<Record<string, string>>;
};

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
 * form field and a header so the server can dedup however it prefers. A `409`
 * is accepted as a deduplication only when the server's JSON contract marks it
 * as `duplicate: true`; all other conflicts remain delivery failures.
 */
export class HttpSink implements IngestSink {
  private readonly cfg: FrozenHttpSinkConfig;

  constructor(cfg: HttpSinkConfig) {
    assertSafeStaticHeaders(cfg.headers);
    // Sink configuration crosses a credential boundary. Snapshot every mutable
    // container at construction so no caller can redirect a delivery while an
    // asynchronous token provider is resolving.
    this.cfg = Object.freeze({
      endpoint: cfg.endpoint,
      companyId: cfg.companyId,
      token: cfg.token,
      allowTokenHosts: cfg.allowTokenHosts ? Object.freeze([...cfg.allowTokenHosts]) : undefined,
      headers: cfg.headers ? Object.freeze({ ...cfg.headers }) : undefined,
    });
  }

  async send(doc: FetchedDocument): Promise<IngestResult> {
    const url = assertSecureEndpoint(this.cfg.endpoint);

    const form = new FormData();
    form.append("file", new Blob([doc.bytes], { type: doc.contentType }), doc.filename);
    form.append("source", doc.source);
    form.append("vendor_id", doc.vendorId);
    form.append("vendor_invoice_id", doc.vendorInvoiceId);
    if (doc.issuedAt) form.append("issued_at", doc.issuedAt);
    form.append("idempotency_key", doc.idempotencyKey);
    if (doc.total) form.append("amount_gross", doc.total);
    if (doc.currency) form.append("currency", doc.currency);
    if (this.cfg.companyId) form.append("company_id", this.cfg.companyId);

    const token = await this.cfg.token?.();
    // Never send the token to a host that isn't explicitly allow-listed.
    if (token && !tokenHostAllowed(url.hostname, this.cfg.allowTokenHosts)) {
      throw new Error(`refusing to send auth token to "${url.hostname}" (not in allow-list)`);
    }
    const res = await fetch(url.href, {
      method: "POST",
      headers: {
        ...this.cfg.headers,
        "Idempotency-Key": doc.idempotencyKey,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: form,
      // The sink validates exactly one configured endpoint. Following a
      // redirect would move invoice bytes (and possibly the bearer token) to
      // a destination that has not passed that validation.
      redirect: "error",
    });

    const body = (await res.json().catch(() => ({}))) as {
      id?: string;
      document_id?: string;
      duplicate?: boolean;
    };
    if (res.status === 409 && body.duplicate === true) return { accepted: true, deduped: true };
    if (!res.ok) throw new Error(`ingest failed: HTTP ${res.status}`);
    return { accepted: true, deduped: body.duplicate, id: body.document_id ?? body.id };
  }
}

function assertSafeStaticHeaders(headers: Record<string, string> | undefined): void {
  const reserved = new Set(["authorization", "idempotency-key", "content-type"]);
  for (const name of Object.keys(headers ?? {})) {
    if (reserved.has(name.toLowerCase())) {
      throw new Error(`ingest header "${name}" is managed by HttpSink`);
    }
  }
}

function tokenHostAllowed(hostname: string, allowTokenHosts: readonly string[] | undefined): boolean {
  return allowTokenHosts?.some((host) => host.trim().toLowerCase() === hostname.toLowerCase()) ?? false;
}
