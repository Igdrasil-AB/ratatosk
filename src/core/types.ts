import type { OperationalOutcomeCode } from "./errors";

/**
 * Core contracts for the invoice collector.
 *
 * These types are the entire vocabulary a vendor recipe author needs. Nothing
 * in this file imports a browser or `chrome.*` API — the core is deliberately
 * platform-free so it can run in Node (tests, CI, a server-side runner) as
 * well as inside the extension service worker.
 *
 * The two output shapes:
 *   - `InvoiceRef`       what a strategy's `list` step produces (metadata only)
 *   - `FetchedDocument`  a materialized invoice ready for an IngestSink
 *
 * Everything else describes a *recipe* — the declarative, serializable
 * description of how to talk to one vendor.
 */

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/** A single invoice discovered during the `list` phase, before its PDF is fetched. */
export interface InvoiceRef {
  /** Vendor's own stable id for the invoice (e.g. Stripe "in_9F2..."). */
  vendorInvoiceId: string;
  /** ISO 8601 issue date (`YYYY-MM-DD`) when the list exposes it. Link-only
   * strategies leave it absent for the destination/accounting pipeline to derive. */
  issuedAt?: string;
  /** Decimal string, e.g. `"49.00"`. String (not number) to avoid float drift. */
  total?: string;
  /** ISO 4217 currency code, e.g. `"USD"`. */
  currency?: string;
  /** Direct URL to the PDF, when the list response already exposes one. */
  documentUrl?: string;
  /** Opaque token the `document` step uses to build the fetch, when there is no direct URL. */
  documentRef?: string;
  /** Anything else worth carrying through (line items, description, ...). */
  meta?: Record<string, unknown>;
  /** Bounded, provenance-carrying facts observed outside the PDF body. These
   * never participate in document identity or deduplication. */
  metadataEvidence?: InvoiceMetadataEvidence[];
  /** Previous safe identities accepted only for dedup migration. Strategies
   * bound this list; recipe data cannot supply it directly. */
  identityAliases?: string[];
  /** Platform-free resolution contract. Semantic actions are opaque, run-scoped
   * capabilities and are never executed during listing. */
  resolution?: DocumentResolution;
}

export type DocumentResolution =
  | { kind: "direct_url"; url: string }
  | { kind: "inline_pdf"; handle: string }
  | { kind: "semantic_action"; handle: string };

export type InvoiceMetadataSource =
  | "network"
  | "embedded"
  | "dom-row"
  | "download-filename"
  | "content-disposition"
  | "document-url";

export type InvoiceMetadataConfidence = "high" | "medium" | "low";

/**
 * One independently observed metadata claim. Values come from structured API
 * fields, labelled DOM cells, or browser-owned download metadata—not PDF text.
 */
export interface InvoiceMetadataEvidence {
  source: InvoiceMetadataSource;
  confidence: InvoiceMetadataConfidence;
  invoiceNumber?: string;
  issuedAt?: string;
  total?: string;
  currency?: string;
  filename?: string;
}

export interface ResolvedInvoiceMetadata {
  invoiceNumber?: string;
  issuedAt?: string;
  total?: string;
  currency?: string;
  filename?: string;
  /** Fields withheld because equally strong evidence disagreed. */
  conflicts?: Array<"invoiceNumber" | "issuedAt" | "total" | "currency" | "filename">;
}

export type RetrievalCompleteness = "complete" | "partial";

export type RetrievalTermination =
  | "explicit_end"
  | "stable_end"
  | "continuation_failed"
  | "repeated_state"
  | "page_cap"
  | "action_cap"
  | "document_cap"
  | "time_cap";

/** Structural proof about path traversal. Completeness is independent of how
 * many invoices exist and never depends on document text or language. */
export interface RetrievalProof {
  completeness: RetrievalCompleteness;
  termination: RetrievalTermination;
  pagesVisited: number;
  observedItems: number;
  resolvedItems: number;
  unresolvedItems: number;
}

/** The list phase returns both normalized invoice references and proof that the
 * available route, pagination, or rendered controls were exhausted. */
export interface InvoiceListResult {
  refs: InvoiceRef[];
  retrieval: RetrievalProof;
  /** Privacy-safe browser replay phases. Platform adapters may provide this;
   * network and embedded strategies omit it. */
  replay?: ReplayTrace;
}

export type ReplayPlanKind = "network" | "embedded" | "exact_dom" | "typed_dom" | "semantic_dom";
export type ReplayPhase =
  | "shell_create"
  | "supplier_commit"
  | "menu_reveal"
  | "settings_select"
  | "billing_select"
  | "invoice_section_select"
  | "document_enumeration"
  | "identity_validation";
export type ReplayPhaseResult =
  | "complete"
  | "not_present"
  | "time_cap"
  | "action_cap"
  | "mutation_blocked"
  | "ambiguous"
  | "page_left_origin";
export interface ReplayPhaseAttempt {
  phase: ReplayPhase;
  result: ReplayPhaseResult;
  durationMs: number;
}
export interface ReplayTrace {
  planKind: ReplayPlanKind;
  phases: ReplayPhaseAttempt[];
  firstFailure?: Pick<ReplayPhaseAttempt, "phase" | "result">;
}

/** User-selected invoice issue-month range. Both endpoints are inclusive. */
export interface SyncMonthWindow {
  granularity: "month";
  fromMonth: string;
  throughMonth: string;
}

export interface SyncWindowStats {
  range: SyncMonthWindow;
  /** One supplier-wide decision made after every successful scope is listed. */
  mode: "bounded" | "all_history_fallback";
  matched: number;
  skippedBefore: number;
  skippedAfter: number;
  skippedUndated: number;
}

/** A fully materialized invoice document, ready to hand to an {@link IngestSink}. */
export interface FetchedDocument {
  /** Namespaced source, e.g. `"ext:openai"`. */
  source: string;
  vendorId: string;
  /** Display name of the supplier, e.g. `"Anthropic (Claude)"` — used for folder names. */
  vendorName: string;
  vendorInvoiceId: string;
  /** Supplier-facing label when independently observed. It is deliberately
   * separate from the stable vendorInvoiceId used for deduplication. */
  invoiceNumber?: string;
  /** Known list date, or absent when document/accounting extraction owns it. */
  issuedAt?: string;
  total?: string;
  currency?: string;
  metadataEvidence?: InvoiceMetadataEvidence[];
  metadataConflicts?: ResolvedInvoiceMetadata["conflicts"];
  filename: string;
  contentType: string;
  bytes: ArrayBuffer;
  /** Stable across runs — the dedup key. See {@link idempotencyKey}. */
  idempotencyKey: string;
  /** Exact-PDF fallback identity. This catches supplier identity/URL drift
   * without relying on invoice text, language, dates, or amounts. */
  contentIdempotencyKey: string;
}

// ---------------------------------------------------------------------------
// Extractors — declarative field reads with an optional transform pipeline
// ---------------------------------------------------------------------------

/**
 * How to pull one value out of a JSON node.
 *
 * Shorthand: a dotted path string, `"data.total"`.
 * Long form: a path plus a pipeline of transforms applied left-to-right.
 */
export type Extractor = string | { path: string; transforms?: Transform[] };

export type Transform =
  /** Divide a numeric value, e.g. minor units → major: `{ kind: "divide", by: 100 }`. */
  | { kind: "divide"; by: number }
  /**
   * Parse a value into an ISO `YYYY-MM-DD` date.
   * `epoch: "s"` treats the value as unix **seconds**, `"ms"` as milliseconds;
   * omit for ISO strings or values `Date` already understands.
   */
  | { kind: "date"; epoch?: "s" | "ms" }
  /** Keep a capture group of a regex match. Group defaults to 0. */
  | { kind: "regex"; pattern: string; group?: number }
  /** Wrap the current value into a string template; `{value}` is the current value. */
  | { kind: "template"; pattern: string }
  /** Regex replace, e.g. insert `/pdf` into a Stripe hosted-invoice URL. */
  | { kind: "replace"; pattern: string; with: string }
  /** Trim surrounding whitespace. */
  | { kind: "trim" }
  /** Upper-case (e.g. normalize a currency code `eur` → `EUR`). */
  | { kind: "upper" }
  /** Lower-case. */
  | { kind: "lower" };

// ---------------------------------------------------------------------------
// HTTP + predicates
// ---------------------------------------------------------------------------

export interface RequestSpec {
  method?: "GET" | "POST";
  /** Supports `{templating}` from the run context (config values, item fields, date window). */
  url: string;
  headers?: Record<string, string>;
  /** Supports `{templating}`. */
  body?: string;
  // NOTE: credentials are always `"include"` in the session-replay model and
  // are intentionally not configurable.
}

/** Boolean test over an HTTP response, used to decide "is the session alive?". */
export type Predicate =
  | { statusIn: number[] }
  | { jsonPath: string; equals?: unknown; exists?: boolean }
  | { and: Predicate[] }
  | { or: Predicate[] };

export interface HttpProbe {
  request: RequestSpec;
  /** When this evaluates true, the user's session is considered valid. */
  expect: Predicate;
}

/**
 * A pre-flight that exchanges the session cookie for a bearer token, for SPAs
 * whose API needs `Authorization: Bearer …` (e.g. ChatGPT's `/api/auth/session`
 * → `accessToken`). The token is fetched once at the start of a run and exposed
 * as a template var (default `{token}`) that later requests reference in headers.
 * It is held in memory only — never persisted.
 */
export interface TokenSpec {
  /** Request that returns the token (rides the session cookie). */
  request: RequestSpec;
  /** Where the token is in the response, e.g. `"accessToken"`. */
  value: Extractor;
  /** Template variable to bind it to (default `"token"`); must match a JavaScript-style identifier. */
  as?: string;
}

// ---------------------------------------------------------------------------
// Config discovery — for vendors scoped per workspace / team / account
// ---------------------------------------------------------------------------

/**
 * A parameter the recipe must discover at runtime (e.g. which Slack workspace).
 * Each discovered value becomes a template variable named `id` for the rest of
 * the run, producing one "scope" per value.
 */
export interface ConfigOption {
  /** Template variable name this option binds, e.g. `"workspace"`; must match a JavaScript-style identifier. */
  id: string;
  discover: {
    request: RequestSpec;
    /** Path to the array of options in the response. Omit to discover a SINGLE
     * scalar value (one scope) via `value` read straight off the response root. */
    items?: string;
    /** Extractor for the value bound to `{id}` (per array element, or the root). */
    value: Extractor;
    /** Optional human-readable label. */
    label?: Extractor;
    /** Bounded cursor traversal for multi-page scope discovery. */
    paginate?: CursorPaginateSpec;
  };
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

export interface FieldMap {
  id: Extractor;
  /** Optional: server-rendered rows often carry no date (the pipeline reads the PDF). */
  issuedAt?: Extractor;
  total?: Extractor;
  currency?: Extractor;
  documentUrl?: Extractor;
  documentRef?: Extractor;
}

interface PaginateBase {
  /** Optional response path that must remain truthy before another page is requested. */
  hasMore?: string;
  /** Safety cap on pages fetched (default 20, hard schema cap 100). */
  maxPages?: number;
}

/** Cursor pagination. The omitted `kind` preserves existing bundled recipes. */
export type CursorPaginateSpec = PaginateBase & {
  kind?: "cursor";
  /** Path to the next cursor in the response. */
  cursor: string;
  /** Template variable receiving the cursor; defaults to `{cursor}`. */
  variable?: string;
  /** A full page requires continuation even when the server omits hasMore. */
  pageSize?: number;
};

/** Follow a next-page URL returned in the response. Relative URLs resolve against the current request. */
export type NextUrlPaginateSpec = PaginateBase & {
  kind: "next-url";
  nextUrl: string;
};

/** Follow the response's bounded RFC Link header relation `rel=next`. */
export type LinkHeaderPaginateSpec = PaginateBase & {
  kind: "link-header";
};

/** Increment a `{page}`-style request variable. */
export type PagePaginateSpec = PaginateBase & {
  kind: "page";
  variable?: string;
  start?: number;
  step?: number;
  /** Stop when a page contains fewer rows than this size. */
  pageSize?: number;
};

/** Increment an `{offset}`-style request variable. */
export type OffsetPaginateSpec = PaginateBase & {
  kind: "offset";
  variable?: string;
  start?: number;
  step: number;
  /** Stop when a page contains fewer rows than this size. */
  pageSize?: number;
};

export type PaginateSpec =
  | CursorPaginateSpec
  | NextUrlPaginateSpec
  | LinkHeaderPaginateSpec
  | PagePaginateSpec
  | OffsetPaginateSpec;

export interface NetworkListSpec {
  request: RequestSpec;
  /** Path to the array of invoices in the JSON response. */
  items: string;
  map: FieldMap;
  paginate?: PaginateSpec;
}

export interface DocumentSpec {
  /**
   * How to fetch the PDF. If omitted, the engine fetches `InvoiceRef.documentUrl`
   * directly. Provide a request (templated with `{id}`, `{documentRef}`, scope
   * vars) when the URL must be constructed.
   */
  request?: RequestSpec;
  /** Defaults to `"application/pdf"`. */
  contentType?: string;
  /** Filename template. Defaults to `"{vendorId}-{issuedAt}-{vendorInvoiceId}.pdf"`. */
  filename?: string;
}

/** Minimal DOM step language, used only when a vendor has no JSON API to replay. */
export type DomStep =
  | { action: "waitFor"; selector: string; timeoutMs?: number }
  | { action: "extractAll"; selector: string; attr: string; as: string }
  /** Packaged browser primitive: inspect explicitly labelled download controls,
   * capture only safe HTTPS GET targets, and never persist page-provided actions. */
  | { action: "extractSemanticDownloads"; as: string; maxActions?: number };

/**
 * Packaged continuation primitive for rendered invoice lists. The platform,
 * not the recipe, owns the closed recognition rules for Next/More controls and
 * infinite scroll. Every dimension is bounded again at runtime.
 */
export interface DomContinuationSpec {
  mode: "auto";
  maxActions?: number;
  maxDocuments?: number;
  timeoutMs?: number;
  allowScroll?: boolean;
}

export interface DomListSpec {
  /** URL to open in an offscreen document / tab before running steps. */
  open: string;
  steps: DomStep[];
  /** Enumerate subsequent rendered pages after the first page has verified the source. */
  continuation?: DomContinuationSpec;
  /** Which collected variable holds the list of PDF hrefs. */
  hrefsFrom: string;
}

/** Extract invoices from an HTML page (server-rendered vendors). */
export interface HtmlListSpec {
  request: RequestSpec;
  /** Pull rows from JSON embedded in the HTML (`<script type="application/json">`). */
  embeddedJson?: boolean;
  /** Or pull rows by a global regex whose named groups become each row. */
  rowRegex?: string;
  /** Path to the row array within an embedded JSON blob (searched across blobs). */
  items?: string;
  map: FieldMap;
}

// ---------------------------------------------------------------------------
// The recipe
// ---------------------------------------------------------------------------

export type NetworkInvoices = {
  strategy: "network";
  list: NetworkListSpec;
  document: DocumentSpec;
};

export type DomInvoices = {
  strategy: "dom";
  list: DomListSpec;
  document: DocumentSpec;
};

export type HtmlInvoices = {
  strategy: "html";
  list: HtmlListSpec;
  document: DocumentSpec;
};

/**
 * The full description of one vendor. This is the object a contributor writes
 * (via {@link defineVendor}) and the object the engine interprets. It is pure
 * data: JSON-serializable, reviewable, bundled, and unit-testable.
 */
export interface VendorRecipe {
  /** Stable, lowercase, unique id, e.g. `"openai"`. Used in `source` and dedup keys. */
  id: string;
  /** Display name, e.g. `"OpenAI"`. */
  name: string;
  homepage: string;
  /** Match patterns for host permissions, e.g. `"https://api.openai.com/*"`. */
  hosts: string[];
  /** Loose grouping for the UI, e.g. `"cloud"`, `"ads"`, `"communication"`. */
  category?: string;
  /** simple-icons slug for the brand logo (e.g. `"github"`). The build pulls just
   * the referenced icons into a bundled data file; unset or unknown → letter avatar. */
  icon?: string;
  /** Freeform note — when the endpoints were captured, quirks, etc. */
  notes?: string;
  /**
   * How requests to this recipe's PRIMARY origin are executed:
   *   "worker" (default) — from the service worker; fine for most vendors.
   *   "page" — from a content script in a tab on the vendor origin, so the
   *     request is first-party. Needed for origins behind bot protection
   *     (e.g. Cloudflare) that reject cross-origin service-worker fetches.
   * Requests to OTHER origins (e.g. a Stripe PDF link) always use the worker.
   */
  fetchContext?: "worker" | "page";
  auth: {
    check: HttpProbe;
    /** Where to send the user to authenticate when the session has expired. */
    loginUrl: string;
    /** Optional cookie→bearer-token exchange run before anything else. */
    token?: TokenSpec;
  };
  config?: ConfigOption[];
  invoices: NetworkInvoices | DomInvoices | HtmlInvoices;
}

// ---------------------------------------------------------------------------
// Runtime plumbing (implemented by platform, consumed by the engine)
// ---------------------------------------------------------------------------

/** A remembered-set of idempotency keys the engine has already emitted. */
export interface SeenStore {
  has(key: string): Promise<boolean>;
  /** Distinguish durable acceptance from a competing in-flight reservation. */
  isAccepted?(key: string): Promise<boolean>;
  /** Atomically reserve an absent key. Returns an opaque ownership id. */
  claimIfAbsent(key: string, source?: string): Promise<string | undefined>;
  /** Release a reservation after failed/abandoned delivery. Accepted keys are never removed. */
  release(key: string, reservationId: string): Promise<void>;
  /** `source` (e.g. "ext:railway") tags the key so a vendor's history can be cleared. */
  add(key: string, source?: string): Promise<void>;
}

/** Everything the engine needs from the outside world for one run. */
export interface RunContext {
  /** The tenant this run belongs to (company/user id in your system). */
  companyId: string;
  /** Base template variables, e.g. the current `{year}`/`{month}` window. */
  vars: Record<string, unknown>;
  /** Present only for an explicitly month-bounded collection run. */
  syncWindow?: SyncMonthWindow;
  seen: SeenStore;
  /** Performs a credentialed HTTP request. Injected so the engine stays platform-free. */
  fetch: (spec: RequestSpec, vars: Record<string, unknown>, signal?: AbortSignal) => Promise<HttpResponse>;
}

/** A thin, testable view over a fetch Response. */
export interface HttpResponse {
  status: number;
  ok: boolean;
  /** Final response URL after redirects, when exposed by the transport. */
  url?: string;
  /** Whether the transport followed one or more redirects. */
  redirected?: boolean;
  json(): Promise<unknown>;
  /** Materialize at most `maximumBytes` when the transport supports streaming.
   * Callers must still validate the returned size because test and platform
   * adapters are independently implemented. */
  arrayBuffer(maximumBytes?: number): Promise<ArrayBuffer>;
  headers: { get(name: string): string | null };
}

export interface RunResult {
  vendorId: string;
  documents: FetchedDocument[];
  /** Aggregate list traversal state across every attempted scope. */
  retrieval: RetrievalCompleteness;
  /** List proofs in deterministic scope traversal order. A scope that failed
   * before producing a list has no proof and remains visible in `scopes`. */
  retrievalProofs: RetrievalProof[];
  syncWindow?: SyncWindowStats;
  scopes: {
    total: number;
    succeeded: number;
    empty: number;
    failed: number;
    failureCodes: OperationalOutcomeCode[];
  };
}
