import type { CaptureSession, CapturedEntry, DraftRecipe } from "./types";
import type { PaginateSpec } from "../types";
import { redact } from "./redact";
import { extractEmbeddedJson } from "../strategies/html";

/**
 * Infer a draft vendor recipe from a capture session — the "so you don't read
 * DevTools by hand" step. Pure and heuristic: it scans captured JSON responses,
 * finds the one that looks like an invoice list, and maps its fields. Everything
 * it guesses is recorded in `notes` for a human to confirm; the winning response
 * is emitted (redacted) as the fixture that proves the mapping.
 */

// Field-name heuristics.
const MONEY_KEY = /amount|total|price|sum|due|charge|cost|gross|net/i;
const DATE_KEY = /date|created|issued|_ts$|_at$|timestamp|period/i;
const ID_KEY = /^id$|_id$|invoice.*(id|no|number)|^number$|reference/i;
const CURRENCY_KEY = /^currency$|^curr$|currency_code/i;
// A billing API names its document field in only so many ways, and missing one
// costs the whole candidate: without a document path a previewed invoice list is
// rejected as unusable. The `[_-]?` separator also covers the camelCase spelling
// because the pattern is case-insensitive.
const PDF_KEY = /pdf|hosted|download|receipt|(?:invoice|document|file|attachment|statement)[_-]?(?:url|uri|link|href)/i;
const AUTH_URL = /\/(me|users?\/me|account|session|profile|organizations?|whoami)(\/|\?|$)/i;
const CURSOR_KEY = /^(?:next_page|next_cursor|nextCursor|cursor|endCursor|page_token|nextPageToken)$/;
const HAS_MORE_KEY = /^(?:has_more|hasMore|has_next_page|hasNextPage)$/;
const NEXT_URL_KEY = /^(?:next_url|nextUrl)$/;
const CURSOR_QUERY = new Set(["page", "cursor", "offset", "starting_after", "after", "page_token"]);

type Obj = Record<string, unknown>;

/**
 * Two inference paths, best-first:
 *   1. STRUCTURED — a JSON invoice array (a real API, or an embedded-JSON blob
 *      inside an HTML page). Yields id/date/amount/currency/pdf mappings.
 *   2. LINKS — no JSON array anywhere, but the page HTML/DOM links to the
 *      invoices (`<a href="/documents/…">`). Extract those links; the
 *      accounting pipeline reads amount/date from each downloaded PDF.
 * Path 2 is what reaches server-rendered vendors like GitHub.
 */
export function inferRecipe(session: CaptureSession): DraftRecipe | null {
  return inferStructured(session) ?? inferFromLinks(session);
}

function inferStructured(session: CaptureSession): DraftRecipe | null {
  const notes: string[] = [];

  // 1. Find the invoice list — a JSON API response, or invoices mined from a
  // captured HTML page / DOM snapshot (embedded-JSON hydration blobs).
  const best = findInvoiceList(session.entries);
  if (!best) return null;
  const { entry, sourceKind, arrayPath, elements, root, prefix } = best;
  const p = (k: string) => prefix + k; // prefix field paths for GraphQL/JSON:API envelopes

  const sample = elements.find((e) => e && typeof e === "object") as Obj | undefined;
  if (!sample) return null;
  if (prefix) notes.push(`Rows are wrapped in a "${prefix.slice(0, -1)}" envelope (GraphQL/JSON:API) — field paths are prefixed accordingly.`);

  // 2. Map the fields.
  const idKey = findKey(sample, ID_KEY);
  const dateKey = findKey(sample, DATE_KEY, (v) => isDateish(v));
  const moneyKey = findKey(sample, MONEY_KEY, (v) => isNumeric(v));
  const currencyKey = findKey(sample, CURRENCY_KEY);
  const pdfKey = findPdfKey(sample);

  const map: Obj = {};
  // id: prefer a real id; else fall back to the date (stable + unique per row).
  if (idKey) {
    map.id = p(idKey);
  } else if (dateKey) {
    map.id = p(dateKey);
    notes.push(`No invoice-id field found — using "${dateKey}" as the dedup id. Verify it's stable & unique.`);
  } else {
    return null;
  }

  if (dateKey) map.issuedAt = dateExtractor(p(dateKey), sample[dateKey]);
  else notes.push("No date field found — set issuedAt manually.");

  if (moneyKey) {
    const t = amountTransforms(sample[moneyKey]);
    map.total = t ? { path: p(moneyKey), transforms: t } : p(moneyKey);
    if (t) notes.push(`Assumed "${moneyKey}" is in minor units (÷100). Verify against a known amount.`);
  }
  if (currencyKey) {
    const upper = typeof sample[currencyKey] === "string" && sample[currencyKey] === (sample[currencyKey] as string).toLowerCase();
    map.currency = upper ? { path: p(currencyKey), transforms: [{ kind: "upper" }] } : p(currencyKey);
  }
  if (pdfKey) map.documentUrl = p(pdfKey);
  else notes.push("No PDF URL field found in the invoice rows — the document step needs a manual endpoint.");

  // 3. The list request. For a JSON API: replay url + method + (GraphQL) body,
  // with pagination if present. For HTML: GET the page and re-parse it.
  const isHtml = sourceKind === "html";
  const paginate = isHtml ? undefined : inferPaginate(root, entry.url);
  const listUrl = paginate ? withPaginationParam(entry.url, paginate) : entry.url;
  const listCt = isHtml ? undefined : contentTypeHeader(entry);
  const listRequest: Obj = isHtml
    ? { url: entry.url }
    : {
        url: listUrl,
        ...(entry.method !== "GET" ? { method: entry.method } : {}),
        ...(listCt ? { headers: listCt } : {}),
        ...(entry.requestBody ? { body: entry.requestBody } : {}),
      };
  if (isHtml) {
    notes.push(
      entry.method === "DOM"
        ? "Invoices came from the RENDERED page (DOM snapshot). Re-fetching the URL only works if the data is in the server HTML (view-source) — if it's rendered by JS after load, this vendor needs the DOM strategy."
        : "Invoices were found in the page HTML (an embedded-JSON blob), not a JSON API. Verify the data is in the server HTML (view-source), not injected by JS after load.",
    );
  }
  if (paginate && listUrl === entry.url && paginate.kind !== "next-url") {
    notes.push("Pagination fields present but no obvious page/cursor query param — verify the pagination variable.");
  }
  if (pdfKey && /invoice\.stripe\.com\/i\//.test(String(sample[pdfKey]))) {
    notes.push('documentUrl is a Stripe HOSTED invoice page — insert "/pdf" before the "?" (a `replace` transform) to fetch the actual PDF.');
  }

  // Auth: use the structural bearer marker and a redacted response path. Header
  // values never enter inference or storage.
  const authWiring = isHtml ? undefined : inferAuthToken(session.entries, entry);
  const authHeaders = authWiring?.header;
  if (authWiring && !authWiring.tokenSpec) {
    notes.push("The list request uses a bearer token, but the endpoint that mints it wasn't in the capture — add `auth.token` manually (usually an /auth/session call).");
  } else if (authWiring?.tokenSpec) {
    notes.push(`Auth: bearer token source candidate ${authWiring.tokenSpec.request.url} at "${authWiring.tokenSpec.value}" was inferred from redacted structural evidence — review required; nothing is hardcoded.`);
  }

  // Multi-tenant: trace any per-user id baked into the list URL OR request body
  // back to the endpoint that provides it, and auto-wire a `config` discovery so
  // the recipe works for ANY logged-in user, not just whoever recorded it.
  const provenance = isHtml ? [] : traceIdProvenance(session.entries, entry);
  const config: Obj[] = [];
  const configuredValues = new Set<string>();
  let invoicesUrl = String(listRequest.url);
  let invoicesBody = typeof listRequest.body === "string" ? listRequest.body : undefined;
  for (const pv of provenance) {
    if (pv.location === "url") invoicesUrl = replaceProvenanceInUrl(invoicesUrl, pv);
    else if (invoicesBody) invoicesBody = invoicesBody.split(pv.value).join(`{${pv.configId}}`);
    if (configuredValues.has(pv.value)) continue;
    configuredValues.add(pv.value);
    config.push({ id: pv.configId, discover: { request: withHeaders(pv.source, authHeaders), value: pv.path } });
    notes.push(`Multi-tenant: "${pv.configId}" (in the list ${pv.location}) comes from ${pv.source.url as string} at "${pv.path}" — auto-wired via config as {${pv.configId}}.`);
  }
  const invoicesListRequest = withHeaders(
    { ...listRequest, url: invoicesUrl, ...(invoicesBody !== undefined ? { body: invoicesBody } : {}) },
    authHeaders,
  );
  // The same endpoint without its pagination template. When there is no
  // dedicated auth endpoint the list request becomes the login check, and a
  // `{page}`/`{cursor}` placeholder has no value to render there — the probe
  // would request a literal `?page={page}` and report a transport failure for
  // an endpoint that works.
  let unpaginatedUrl = isHtml ? String(listRequest.url) : entry.url;
  for (const pv of provenance) {
    if (pv.location === "url") unpaginatedUrl = replaceProvenanceInUrl(unpaginatedUrl, pv);
  }
  // A redacted placeholder is safe to store but never safe to replay. Only
  // emit a draft when every such URL value was correlated with a runtime config
  // source above; otherwise a reviewer would receive a recipe guaranteed to
  // fail (or, worse, scoped to an unknown account).
  if (containsUnboundRedaction(invoicesUrl) || (invoicesBody !== undefined && containsUnboundRedaction(invoicesBody))) return null;
  const untracedBodyId = !isHtml && bodyIdTokens(entry.requestBody).length > provenance.filter((p) => p.location === "body").length;
  if (untracedBodyId) notes.push("The request body has an id (e.g. workspace/account) whose source wasn't captured — parameterize it via `config` manually, or re-record so the source endpoint is seen.");
  if (!isHtml && !provenance.length && hasIdSegment(entry.url)) {
    notes.push("The list URL contains an account/org id, but its source wasn't in the capture — parameterize it via `config` for multi-tenant use.");
  }

  // 4. Auth check — a dedicated GET probe if found; else the (id-free, authenticated)
  // config discovery call; else the list request. Never a request with a raw id.
  const probe = inferAuthProbe(session.entries, session.origin);
  const authRequest = probe.real
    ? withHeaders({ url: probe.url }, authHeaders)
    : config.length
      ? ((config[0].discover as Obj).request as Obj)
      : withHeaders(
        { ...listRequest, url: unpaginatedUrl, ...(invoicesBody !== undefined ? { body: invoicesBody } : {}) },
        authHeaders,
      );
  if (!probe.real && config.length) notes.push("No dedicated auth endpoint — using the config discovery call as the login check.");
  else if (!probe.real) notes.push("No dedicated auth endpoint found — using the invoice list request as the login check.");

  // 5. Assemble the draft.
  const id = deriveVendorId(session.origin);
  const extraOrigins = [originOf(entry.url), pdfKey ? originOf(String(sample[pdfKey])) : undefined].filter(
    (o): o is string => Boolean(o) && o !== session.origin,
  );
  const hosts = [...new Set([`${session.origin}/*`, ...extraOrigins.map((o) => `${o}/*`)])];
  notes.push("If this site is behind Cloudflare, add `fetchContext: \"page\"`. Verify every PDF redirect and add only the exact required host pattern.");

  const recipe: Obj = {
    id,
    name: titleCase(id),
    homepage: session.origin,
    hosts,
    notes: "DRAFT auto-generated from a capture session — review before use.",
    ...(config.length ? { config } : {}),
    auth: {
      ...(authWiring?.tokenSpec
        ? { token: { request: authWiring.tokenSpec.request, value: authWiring.tokenSpec.value } }
        : {}),
      check: { request: authRequest, expect: { statusIn: [200] } },
      loginUrl: `${session.origin}/login`,
    },
    invoices: isHtml
      ? {
          strategy: "html",
          list: { request: listRequest, embeddedJson: true, items: arrayPath, map },
          document: { contentType: "application/pdf" },
        }
      : {
          strategy: "network",
          list: { request: invoicesListRequest, items: arrayPath, map, ...(paginate ? { paginate } : {}) },
          document: { contentType: "application/pdf" },
    },
  };

  // A `REDACTED` marker is capture evidence, never an executable request
  // value. The earlier list-request check handles the common case; this final
  // structural guard covers auth/config/document request URLs assembled from
  // other captured entries as well.
  if (containsRecipeRedaction(recipe)) return null;

  const confidence = scoreConfidence({ elements, hasPdf: Boolean(pdfKey), realProbe: probe.real });

  return {
    recipe,
    fixture: redact(root),
    confidence,
    identity: {
      kind: idKey ? "explicit_field" : "date_fallback",
      path: p(idKey ?? dateKey!),
    },
    notes,
  };
}

// ---- id provenance (multi-tenant discovery) -------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_ID_RE = /^[A-Za-z0-9_-]{16,}$/;
const NUM_ID_RE = /^\d{6,}$/;

interface SourceHit {
  url: string;
  path: string;
  method: string;
  body?: string;
  contentType?: string;
}

interface Provenance {
  value: string;
  configId: string;
  /** The request that discovers the value (url + GraphQL method/body if any). */
  source: Obj;
  path: string;
  /** Where the id sits in the list request: the URL, or the request body. */
  location: "url" | "body";
  /** A sanitized URL stores the value as REDACTED; this key identifies the
   * exact query parameter to replace after opaque-alias correlation. */
  redactedQueryKey?: string;
  /** Equivalent structural position for a redacted path segment. */
  redactedPathIndex?: number;
}

/** A `content-type` request header, if one was captured (POST bodies need it). */
function contentTypeHeader(entry: CapturedEntry): Record<string, string> | undefined {
  const ct = entry.requestHeaders?.["content-type"];
  return ct ? { "content-type": ct } : undefined;
}

/** Build a request object from a source hit, preserving a GraphQL POST + body + content-type. */
function sourceRequest(hit: SourceHit): Obj {
  return {
    url: hit.url,
    ...(hit.method && hit.method !== "GET" ? { method: hit.method } : {}),
    ...(hit.contentType ? { headers: { "content-type": hit.contentType } } : {}),
    ...(hit.body ? { body: hit.body } : {}),
  };
}

function isIdLike(v: string): boolean {
  return UUID_RE.test(v) || NUM_ID_RE.test(v) || LONG_ID_RE.test(v);
}

/** Merge extra headers (e.g. a templated bearer) into a request object. */
function withHeaders(req: Obj, extra?: Record<string, string>): Obj {
  return extra ? { ...req, headers: { ...((req.headers as Record<string, string>) ?? {}), ...extra } } : req;
}

/**
 * If the sanitizer observed bearer authentication on the list request, template
 * it without retaining the value. A token-source proposal requires both an
 * auth-like endpoint and one explicitly supported redacted response leaf.
 */
function inferAuthToken(
  entries: CapturedEntry[],
  listEntry: CapturedEntry,
): { header: Record<string, string>; tokenSpec?: { request: Obj; value: string } } | undefined {
  if (listEntry.requestAuth?.scheme !== "bearer") return undefined;
  const source = locateCredentialPath(entries, listEntry);
  return {
    header: { authorization: "Bearer {token}" },
    tokenSpec: source ? { request: sourceRequest(source), value: source.path } : undefined,
  };
}

const TOKEN_SOURCE_LEAF = new Set(["accessToken", "access_token", "idToken", "id_token", "token"]);

function locateCredentialPath(entries: CapturedEntry[], exclude: CapturedEntry): SourceHit | undefined {
  for (const entry of entries) {
    if (entry === exclude || !AUTH_URL.test(entry.url) || !entry.redactedResponsePaths?.length) continue;
    const path = entry.redactedResponsePaths.find((candidate) => TOKEN_SOURCE_LEAF.has(candidate.split(".").pop() ?? ""));
    if (path) {
      return {
        url: entry.url,
        path,
        method: entry.method,
        body: entry.requestBody,
        contentType: entry.requestHeaders?.["content-type"],
      };
    }
  }
  return undefined;
}

/** id-like tokens in a URL's query values and path segments, with the query key if any. */
interface UrlIdToken {
  value: string;
  key?: string;
  redactedQueryKey?: string;
  redactedPathIndex?: number;
}

function urlIdTokens(entry: CapturedEntry): UrlIdToken[] {
  const out: UrlIdToken[] = [];
  try {
    const u = new URL(entry.url);
    for (const [key, value] of u.searchParams) if (isIdLike(value)) out.push({ value, key });
    for (const seg of u.pathname.split("/")) if (isIdLike(seg)) out.push({ value: seg });
  } catch {
    /* not a URL */
  }
  for (const alias of entry.urlValueAliases ?? []) {
    if (alias.location === "query" && typeof alias.key === "string") {
      out.push({ value: alias.alias, key: alias.key, redactedQueryKey: alias.key });
    } else if (alias.location === "path" && typeof alias.pathIndex === "number") {
      out.push({ value: alias.alias, redactedPathIndex: alias.pathIndex });
    }
  }
  return out;
}

/** id-like string values inside a JSON request body (e.g. a GraphQL `variables`
 * workspaceId), tagged with the object key they sit under. */
function bodyIdTokens(body: string | undefined): { value: string; key?: string }[] {
  if (!body) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const out: { value: string; key?: string }[] = [];
  const walk = (node: unknown, key?: string): void => {
    if (typeof node === "string") {
      if (isIdLike(node) || isOpaqueCaptureAlias(node)) out.push({ value: node, key });
    } else if (Array.isArray(node)) node.forEach((v) => walk(v, key));
    else if (node && typeof node === "object") for (const [k, v] of Object.entries(node as Obj)) walk(v, k);
  };
  walk(parsed);
  return out;
}

/**
 * For each per-user id in the list URL OR request body, find WHICH other captured
 * response carries that same value and at what stable path — so it can be
 * discovered at runtime instead of hardcoded. This turns a one-user recipe into
 * a shareable one.
 */
function traceIdProvenance(entries: CapturedEntry[], listEntry: CapturedEntry): Provenance[] {
  const found: Provenance[] = [];
  const tokens: Array<{ value: string; key?: string; location: "url" | "body"; redactedQueryKey?: string; redactedPathIndex?: number }> = [
    ...urlIdTokens(listEntry).map((t) => ({ ...t, location: "url" as const })),
    ...bodyIdTokens(listEntry.requestBody).map((t) => ({ ...t, location: "body" as const })),
  ];
  const sourceByValue = new Map<string, SourceHit>();
  for (const value of new Set(tokens.map((token) => token.value))) {
    const source = locateValue(entries, listEntry, value);
    if (source) sourceByValue.set(value, source);
  }
  for (const { value, key, location, redactedQueryKey, redactedPathIndex } of tokens) {
    const source = sourceByValue.get(value);
    if (!source) continue;
    const lastKey = source.path.split(".").pop() ?? "";
    const preferredKey = tokens.find((token) => token.value === value && token.key)?.key;
    const configId = sanitizeId(preferredKey ?? (/[a-z]/i.test(lastKey) ? lastKey : "scopeId"));
    found.push({ value, configId, source: sourceRequest(source), path: source.path, location, redactedQueryKey, redactedPathIndex });
  }
  return found;
}

function replaceProvenanceInUrl(url: string, provenance: Provenance): string {
  if (!provenance.redactedQueryKey && provenance.redactedPathIndex === undefined) return url.split(provenance.value).join(`{${provenance.configId}}`);
  try {
    const parsed = new URL(url);
    if (provenance.redactedPathIndex !== undefined) {
      const segments = parsed.pathname.split("/");
      if (!isRedactedAliasValue(segments[provenance.redactedPathIndex], provenance.value)) return url;
      segments[provenance.redactedPathIndex] = `{${provenance.configId}}`;
      parsed.pathname = segments.join("/");
      return decodeURIComponent(parsed.toString());
    }
    const values = parsed.searchParams.getAll(provenance.redactedQueryKey!);
    // Duplicated query keys have ambiguous binding. Leave them redacted so the
    // caller rejects this draft rather than substituting a value into both.
    if (values.length !== 1 || !isRedactedAliasValue(values[0], provenance.value)) return url;
    parsed.searchParams.set(provenance.redactedQueryKey!, `{${provenance.configId}}`);
    return decodeURIComponent(parsed.toString());
  } catch {
    return url;
  }
}

function containsUnboundRedaction(value: string): boolean {
  return /(?:^|[?&=:/])REDACTED(?:$|[?&=/])/.test(value);
}

function containsRecipeRedaction(value: unknown): boolean {
  if (typeof value === "string") return value.includes("REDACTED") || /(?:__ratatosk_)?ref_\d+(?:__)?/.test(value);
  if (Array.isArray(value)) return value.some(containsRecipeRedaction);
  return Boolean(value && typeof value === "object" && Object.values(value as Obj).some(containsRecipeRedaction));
}

function isRedactedAliasValue(value: string | undefined, alias: string): boolean {
  return value === "REDACTED" || value === `__ratatosk_${alias}__`;
}

function isOpaqueCaptureAlias(value: string): boolean {
  return /^ref_\d+$/.test(value);
}

/** Find `value` inside another JSON response; return the best (stable, id-ish) path. */
function locateValue(entries: CapturedEntry[], exclude: CapturedEntry, value: string): SourceHit | undefined {
  let best: (SourceHit & { score: number }) | undefined;
  for (const e of entries) {
    if (e === exclude || !e.responseBody || e.contentType.includes("html")) continue;
    // Circular: a request that ALSO takes this value as input (in its URL or body)
    // can't be used to DISCOVER it — it already has it. Skip it as a source, so we
    // pick a real "list" query (e.g. `me`/`workspaces`) over a `get(id)` echo.
    if (e.url.includes(value) || e.requestBody?.includes(value)) continue;
    let root: unknown;
    try {
      root = JSON.parse(e.responseBody);
    } catch {
      continue;
    }
    for (const path of valuePaths(root, value)) {
      // A path that contains the value AS A KEY isn't reusable for other users.
      if (path.split(".").includes(value)) continue;
      const last = path.split(".").pop() ?? "";
      const score =
        (/id$/i.test(last) ? 3 : 0) +
        (/\/(me|account|session|organization|user)/i.test(e.url) ? 2 : 0) +
        (/^\d+$/.test(last) ? -1 : 0) - // avoid array-index paths when a named one exists
        path.length / 100;
      if (!best || score > best.score) {
        best = { url: e.url, path, method: e.method, body: e.requestBody, contentType: e.requestHeaders?.["content-type"], score };
      }
    }
  }
  return best && { url: best.url, path: best.path, method: best.method, body: best.body, contentType: best.contentType };
}

function valuePaths(node: unknown, value: string, prefix = "", depth = 0, out: string[] = []): string[] {
  if (depth > 8) return out;
  if (node === value) out.push(prefix || "$");
  else if (Array.isArray(node)) node.forEach((v, i) => valuePaths(v, value, prefix ? `${prefix}.${i}` : `${i}`, depth + 1, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Obj)) valuePaths(v, value, prefix ? `${prefix}.${k}` : k, depth + 1, out);
  }
  return out;
}

function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "") || "scopeId";
}

// ---- link-based inference (server-rendered pages) -------------------------

// Path segments that mark a link as an invoice/receipt document.
const DOC_LINK_TOKENS = ["receipt", "invoice", "billing", "download", ".pdf"];

/** Diagnostic: invoice/receipt-ish hrefs anywhere in the captured HTML. Lets the
 * popup show what document links a page exposes even when inference finds none. */
const DOC_LINK_HINT = /receipt|invoice|\.pdf(\?|$)|\/download/i;
export function findDocLinks(entries: CapturedEntry[]): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    if (!e.responseBody || !e.contentType.includes("html")) continue;
    for (const m of e.responseBody.matchAll(/\bhref="([^"]+)"/gi)) {
      if (DOC_LINK_HINT.test(m[1])) out.add(m[1]);
    }
  }
  return [...out].slice(0, 20);
}

interface LinkList {
  entry: CapturedEntry;
  regex: string;
  hrefs: string[];
  fromPdf: boolean;
}

/**
 * Fallback when no JSON invoice array exists: pull the invoice/receipt LINKS out
 * of a captured HTML page or the DOM snapshot. The strongest signal is a PDF we
 * actually saw during capture — its observed path prefix is the
 * exact token to look for among the page's anchors, so we find every sibling
 * receipt, not just the one that was clicked.
 */
function inferFromLinks(session: CaptureSession): DraftRecipe | null {
  const links = findInvoiceLinks(session.entries);
  if (!links) return null;
  const { entry, regex, hrefs, fromPdf } = links;

  const notes: string[] = [
    "No JSON invoice list found — extracted invoice/receipt LINKS from the page HTML (rowRegex). Each link is downloaded and the accounting pipeline reads the amount & date from the PDF.",
    "id = the receipt URL with any .pdf/query stripped — so a page that links both `/x` and `/x.pdf` for the same receipt downloads it once, not twice. Adjust if a cleaner id exists.",
  ];
  if (fromPdf) notes.push("The link pattern was learned from a PDF actually captured during recording — high-signal.");
  if (entry.method === "DOM") {
    notes.push("Links came from the RENDERED page (DOM snapshot). Re-fetching the URL only works if the links are in the server HTML (view-source) — if they're injected by JS after load, this vendor needs the DOM strategy.");
  }

  const pageUrl = entry.url;
  const pdfOrigins = session.entries
    .filter((e) => e.contentType.includes("pdf"))
    .map((e) => originOf(e.url))
    .filter((o): o is string => Boolean(o));
  const hosts = [...new Set([`${session.origin}/*`, ...pdfOrigins.map((o) => `${o}/*`)])];

  const probe = inferAuthProbe(session.entries, session.origin);
  const authRequest = probe.real ? { url: probe.url } : { url: pageUrl };
  if (!probe.real) notes.push("No dedicated auth endpoint found — using the billing page load as the login check (verify it 401/redirects when logged out).");

  const id = deriveVendorId(session.origin);
  const recipe: Obj = {
    id,
    name: titleCase(id),
    homepage: session.origin,
    hosts,
    notes: "DRAFT auto-generated from a capture session — review before use.",
    auth: {
      check: { request: authRequest, expect: { statusIn: [200] } },
      loginUrl: `${session.origin}/login`,
    },
    invoices: {
      strategy: "html",
      list: {
        request: { url: pageUrl },
        rowRegex: regex,
        map: {
          // Strip a trailing `.pdf`/query so `/x` and `/x.pdf` dedup to one download.
          id: { path: "documentUrl", transforms: [{ kind: "replace", pattern: "(\\.pdf)?([?#].*)?$", with: "" }] },
          documentUrl: "documentUrl",
        },
      },
      document: { contentType: "application/pdf" },
    },
  };

  return {
    recipe,
    fixture: redact({ matchedLinks: hrefs.slice(0, 20) }),
    confidence: fromPdf && hrefs.length >= 2 ? "medium" : "low",
    identity: { kind: "document_url", path: "documentUrl" },
    notes,
  };
}

function findInvoiceLinks(entries: CapturedEntry[]): LinkList | null {
  // Tokens learned from PDFs we actually captured (most precise), then generic ones.
  const pdfTokens = entries
    .filter((e) => e.contentType.includes("pdf") || /\.pdf(\?|$)/i.test(e.url))
    .map((e) => linkToken(e.url))
    .filter((t): t is string => Boolean(t));

  let best: LinkList | null = null;
  for (const entry of entries) {
    if (!entry.responseBody || !entry.contentType.includes("html")) continue;
    const hrefs = anchorHrefs(entry.responseBody);
    if (!hrefs.length) continue;

    for (const [i, token] of [...pdfTokens, ...DOC_LINK_TOKENS].entries()) {
      const fromPdf = i < pdfTokens.length;
      const matched = [...new Set(hrefs.filter((h) => h.includes(token)))];
      if (!matched.length) continue;
      // Prefer a PDF-learned token, then more matches. (fromPdf beats a bigger generic hit.)
      const better =
        !best ||
        (fromPdf && !best.fromPdf) ||
        (fromPdf === best.fromPdf && matched.length > best.hrefs.length);
      if (better) best = { entry, regex: linkRegex(token), hrefs: matched, fromPdf };
    }
  }
  return best;
}

/** The directory prefix of an observed document URL. */
function linkToken(url: string): string | undefined {
  try {
    const path = new URL(url).pathname;
    const dir = path.slice(0, path.lastIndexOf("/") + 1);
    return dir.length > 1 ? dir : undefined; // ignore root "/"
  } catch {
    return undefined;
  }
}

/** All `href` values in the HTML (any element). outerHTML serializes with double
 * quotes; the token filter, not the tag, decides which links are invoices. */
function anchorHrefs(html: string): string[] {
  return [...html.matchAll(/\bhref="([^"]+)"/gi)].map((m) => m[1]);
}

/** A global rowRegex that captures every href containing `token` as `documentUrl`. */
function linkRegex(token: string): string {
  return `href="(?<documentUrl>[^"]*${escapeRegExp(token)}[^"]*)"`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- invoice-list detection ----------------------------------------------

interface ListCandidate {
  entry: CapturedEntry;
  /** `json` = a real billing API response; `html` = mined from a page's embedded JSON. */
  sourceKind: "json" | "html";
  arrayPath: string;
  /** Elements unwrapped from any GraphQL `node` / JSON:API `attributes` envelope. */
  elements: unknown[];
  /** Path prefix to reach a field on the RAW element (`"node."`, `"attributes."`, or `""`). */
  prefix: string;
  root: unknown;
  score: number;
}

/** The JSON roots to search in one entry: the parsed body for JSON, or every
 * embedded `<script type=json>` blob for an HTML page / DOM snapshot. */
function rootsFor(entry: CapturedEntry): { roots: unknown[]; kind: "json" | "html" } {
  const body = entry.responseBody;
  if (!body) return { roots: [], kind: "json" };
  if (entry.contentType.includes("html")) return { roots: extractEmbeddedJson(body), kind: "html" };
  try {
    return { roots: [JSON.parse(body)], kind: "json" };
  } catch {
    return { roots: [], kind: "json" };
  }
}

const kindRank = (k: "json" | "html"): number => (k === "json" ? 1 : 0); // a clean API beats scraped HTML

function findInvoiceList(entries: CapturedEntry[]): ListCandidate | null {
  let best: ListCandidate | null = null;
  for (const entry of entries) {
    if (entry.status < 200 || entry.status >= 300 || !entry.responseBody) continue;
    const { roots, kind } = rootsFor(entry);
    for (const root of roots) {
      for (const { path, array } of findArrays(root)) {
        const prefix = detectPrefix(array);
        const elements = prefix ? array.map((e) => unwrapEl(e, prefix)) : array;
        const score = scoreInvoiceArray(elements);
        if (score < 0.5) continue;
        const better =
          !best ||
          score > best.score ||
          (score === best.score && kindRank(kind) > kindRank(best.sourceKind)) ||
          (score === best.score && kind === best.sourceKind && elements.length > best.elements.length);
        if (better) best = { entry, sourceKind: kind, arrayPath: path, elements, prefix, root, score };
      }
    }
  }
  return best;
}

/** Relay (`{node}`) and JSON:API (`{attributes}`) wrap each row; detect and unwrap. */
function detectPrefix(array: unknown[]): string {
  const first = array[0];
  if (first && typeof first === "object" && !Array.isArray(first)) {
    const o = first as Obj;
    if (o.node && typeof o.node === "object") return "node.";
    if (o.attributes && typeof o.attributes === "object") return "attributes.";
  }
  return "";
}

function unwrapEl(el: unknown, prefix: string): unknown {
  if (!prefix || !el || typeof el !== "object") return el;
  return (el as Obj)[prefix.slice(0, -1)] ?? el;
}

function findArrays(node: unknown, path = "", depth = 0, out: { path: string; array: unknown[] }[] = []): { path: string; array: unknown[] }[] {
  if (depth > 6 || node === null || typeof node !== "object") return out; // GraphQL nests deep (data.x.invoices.edges)
  if (Array.isArray(node)) {
    if (node.length > 0 && node.every((x) => x !== null && typeof x === "object" && !Array.isArray(x))) {
      out.push({ path: path || "$", array: node });
    }
    return out;
  }
  for (const [k, v] of Object.entries(node as Obj)) findArrays(v, path ? `${path}.${k}` : k, depth + 1, out);
  return out;
}

function scoreInvoiceArray(array: unknown[]): number {
  if (array.length === 0) return 0;
  let invoiceLike = 0;
  for (const el of array) {
    if (!el || typeof el !== "object") continue;
    const o = el as Obj;
    const hasMoney = Object.entries(o).some(([k, v]) => MONEY_KEY.test(k) && isNumeric(v));
    const hasDate = Object.entries(o).some(([k, v]) => DATE_KEY.test(k) && isDateish(v));
    const hasId = Object.entries(o).some(([k, v]) => ID_KEY.test(k) && (typeof v === "string" || typeof v === "number"));
    const hasDocument = Boolean(findPdfKey(o));
    if (hasDate && (hasMoney || (hasId && hasDocument))) invoiceLike++;
  }
  return invoiceLike / array.length;
}

// ---- field inference ------------------------------------------------------

function findKey(obj: Obj, re: RegExp, valueOk?: (v: unknown) => boolean): string | undefined {
  return Object.keys(obj).find((k) => re.test(k) && (!valueOk || valueOk(obj[k])));
}

function findPdfKey(obj: Obj): string | undefined {
  const urls = Object.entries(obj).filter(([, v]) => typeof v === "string" && (/^https?:\/\//.test(v) || /^\/(?!\/)/.test(v)));
  // Prefer a field whose value clearly points at a PDF, else a pdf-named field.
  return (
    urls.find(([, v]) => /\/pdf(\?|$)|\.pdf(\?|$)/i.test(v as string))?.[0] ??
    urls.find(([k]) => PDF_KEY.test(k))?.[0]
  );
}

function dateExtractor(key: string, sample: unknown): unknown {
  if (typeof sample === "number") {
    const epoch = sample < 1e11 ? "s" : "ms"; // seconds vs milliseconds
    return { path: key, transforms: [{ kind: "date", epoch }] };
  }
  return { path: key, transforms: [{ kind: "date" }] };
}

function amountTransforms(sample: unknown): unknown[] | null {
  const n = typeof sample === "number" ? sample : Number(sample);
  // Integer amounts are minor units (cents) in almost every billing JSON API.
  if (Number.isFinite(n) && Number.isInteger(n)) return [{ kind: "divide", by: 100 }];
  return null;
}

function inferPaginate(root: unknown, requestUrl: string): PaginateSpec | undefined {
  const scalars = findScalarPaths(root);
  const nextUrl = scalars.find(({ key, value, parent }) => (
    typeof value === "string" && value.length > 0 &&
    (NEXT_URL_KEY.test(key) || (key.toLowerCase() === "next" && /(?:^|\.)links?$/i.test(parent))) &&
    /^(?:https?:\/\/|\/)/.test(value)
  ));
  if (nextUrl) return { kind: "next-url", nextUrl: nextUrl.path };

  let query: URLSearchParams;
  try {
    query = new URL(requestUrl).searchParams;
  } catch {
    return undefined;
  }

  const cursor = scalars.find(({ key, value }) => CURSOR_KEY.test(key) && typeof value === "string" && value.length > 0);
  const hasMore = closestHasMore(cursor?.path, scalars);
  if (cursor && [...query.keys()].some((key) => CURSOR_QUERY.has(key))) {
    return { cursor: cursor.path, ...(hasMore ? { hasMore } : {}) };
  }

  const genericHasMore = closestHasMore(undefined, scalars);
  const offsetKey = [...query.keys()].find((key) => key.toLowerCase() === "offset");
  if (offsetKey && genericHasMore) {
    const pageSize = positiveQueryInt(query, ["limit", "per_page", "page_size"]) ?? 50;
    return { kind: "offset", step: pageSize, pageSize, hasMore: genericHasMore };
  }
  const pageKey = [...query.keys()].find((key) => /^(?:page|p)$/i.test(key));
  if (pageKey && genericHasMore) {
    const pageSize = positiveQueryInt(query, ["per_page", "limit", "page_size"]);
    return { kind: "page", ...(pageSize ? { pageSize } : {}), hasMore: genericHasMore };
  }
  return undefined;
}

function withPaginationParam(url: string, paginate: PaginateSpec): string {
  if (paginate.kind === "next-url" || paginate.kind === "link-header") return url;
  try {
    const u = new URL(url);
    const key = paginate.kind === "page"
      ? [...u.searchParams.keys()].find((candidate) => /^(?:page|p)$/i.test(candidate))
      : paginate.kind === "offset"
        ? [...u.searchParams.keys()].find((candidate) => candidate.toLowerCase() === "offset")
        : [...u.searchParams.keys()].find((candidate) => CURSOR_QUERY.has(candidate));
    if (!key) return url;
    const variable = paginate.kind === "page" ? paginate.variable ?? "page"
      : paginate.kind === "offset" ? paginate.variable ?? "offset"
        : paginate.variable ?? "cursor";
    u.searchParams.set(key, `{${variable}}`);
    return decodeURIComponent(u.toString());
  } catch {
    /* keep literal */
  }
  return url;
}

interface ScalarPath {
  path: string;
  parent: string;
  key: string;
  value: unknown;
}

function findScalarPaths(node: unknown, path = "", depth = 0, out: ScalarPath[] = []): ScalarPath[] {
  if (depth > 8 || !node || typeof node !== "object" || Array.isArray(node)) return out;
  for (const [key, value] of Object.entries(node as Obj)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) findScalarPaths(value, nextPath, depth + 1, out);
    else if (!Array.isArray(value)) out.push({ path: nextPath, parent: path, key, value });
  }
  return out;
}

function closestHasMore(cursorPath: string | undefined, scalars: ScalarPath[]): string | undefined {
  const candidates = scalars.filter(({ key, value }) => HAS_MORE_KEY.test(key) && (
    typeof value === "boolean" || typeof value === "number" || typeof value === "string"
  ));
  if (!candidates.length) return undefined;
  if (!cursorPath) return candidates[0].path;
  const cursorParts = cursorPath.split(".");
  return candidates
    .map((candidate) => ({ candidate, shared: sharedPrefixLength(cursorParts, candidate.path.split(".")) }))
    .sort((left, right) => right.shared - left.shared)[0].candidate.path;
}

function sharedPrefixLength(left: string[], right: string[]): number {
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) count += 1;
  return count;
}

function positiveQueryInt(query: URLSearchParams, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = Number(query.get(key));
    if (Number.isInteger(value) && value > 0 && value <= 500) return value;
  }
  return undefined;
}

function inferAuthProbe(entries: CapturedEntry[], origin: string): { url: string; real: boolean } {
  const probe = entries.find(
    (e) => e.method === "GET" && e.status === 200 && originOf(e.url) === origin && AUTH_URL.test(e.url),
  );
  return probe ? { url: probe.url, real: true } : { url: "", real: false };
}

// ---- helpers --------------------------------------------------------------

function isNumeric(v: unknown): boolean {
  return typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));
}

function isDateish(v: unknown): boolean {
  if (typeof v === "number") return v > 1e8; // plausible epoch (seconds or ms)
  if (typeof v === "string") return !Number.isNaN(Date.parse(v));
  return false;
}

function hasIdSegment(url: string): boolean {
  try {
    return new URL(url).pathname.split("/").some((s) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) || /^\d{6,}$/.test(s));
  } catch {
    return false;
  }
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

const TLDS = new Set(["com", "net", "org", "io", "ai", "co", "app", "dev", "se", "eu", "de", "uk", "us", "gov"]);
const SUBS = new Set(["www", "app", "api", "dashboard", "my", "portal", "secure", "account", "accounts", "billing", "console", "admin", "pay"]);

export function deriveVendorId(origin: string): string {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return "vendor";
  }
  const parts = host.split(".").filter((p) => !SUBS.has(p));
  while (parts.length > 1 && TLDS.has(parts[parts.length - 1])) parts.pop();
  const label = parts[parts.length - 1] || host;
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "vendor";
}

function titleCase(id: string): string {
  return id.replace(/(^|-)([a-z])/g, (_m, sep, c) => (sep ? " " : "") + c.toUpperCase());
}

function scoreConfidence(x: { elements: unknown[]; hasPdf: boolean; realProbe: boolean }): DraftRecipe["confidence"] {
  if (x.elements.length >= 2 && x.hasPdf && x.realProbe) return "high";
  if (x.elements.length >= 1 && (x.hasPdf || x.realProbe)) return "medium";
  return "low";
}
