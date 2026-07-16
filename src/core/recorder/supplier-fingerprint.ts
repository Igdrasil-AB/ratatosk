import { z } from "zod";
import type { CaptureSession, CapturedEntry, DraftRecipe } from "./types";

export const SUPPLIER_FINGERPRINT_SCHEMA = "ratatosk.supplier-fingerprint.v1" as const;
export const SUPPLIER_FINGERPRINT_SUBMISSION_SCHEMA = "ratatosk.supplier-fingerprint-submission.v1" as const;
export const SUPPLIER_FINGERPRINT_CONSENT = "ratatosk.studio.share.v1" as const;
export const SUPPLIER_FINGERPRINT_TARGET = "svala" as const;

const MAX_FINGERPRINT_BYTES = 64 * 1024;
const MAX_SUBMISSION_BYTES = MAX_FINGERPRINT_BYTES + 4 * 1024;
const MAX_REQUESTS = 40;
const FINGERPRINT_ID = /^fp_[a-f0-9]{32}$/;
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_PATH = /^\/(?:[A-Za-z0-9._~{}-]+(?:\/[A-Za-z0-9._~{}-]+)*)?$/;
const SAFE_DOTTED_PATH = /^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*$/;
const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const NOISE = /javascript|text\/css|font|image\/|\.(js|css|woff2?|png|svg|jpe?g|gif|ico)(\?|$)/i;
const AUTH_PATH = /\/(?:auth|login|me|profile|session|users?|accounts?|organizations?|workspaces?)(?:\/|$)/i;

const STATIC_PATH_SEGMENTS = new Set([
  "account", "accounts", "api", "auth", "billing", "billings", "customer", "customers",
  "document", "documents", "download", "graphql", "history", "invoice", "invoices", "login",
  "me", "organization", "organizations", "payment", "payments", "pdf", "portal", "profile",
  "receipt", "receipts", "session", "settings", "subscription", "subscriptions", "user", "users",
  "v1", "v2", "v3", "workspace", "workspaces",
]);

const safeOriginSchema = z.string().max(300).superRefine((value, ctx) => {
  try {
    const parsed = new URL(value);
    const local = parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
    if ((parsed.protocol !== "https:" && !local) || parsed.origin !== value || parsed.username || parsed.password) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected a canonical HTTPS origin" });
    }
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected a valid origin" });
  }
});

const pathPatternSchema = z.string().regex(SAFE_PATH).max(1_024).refine(
  (value) => !value.split("/").some((segment) => segment === "." || segment === ".."),
  "Path patterns cannot contain traversal segments",
);

const requestRoleSchema = z.enum(["auth", "invoice_list", "document", "other"]);
const requestReferenceSchema = z.object({
  method: z.string().regex(/^[A-Z]{1,12}$/),
  origin: safeOriginSchema,
  pathPattern: pathPatternSchema,
  queryKeys: z.array(z.string().regex(SAFE_IDENTIFIER)).max(20),
}).strict();

const requestFingerprintSchema = requestReferenceSchema.extend({
  role: requestRoleSchema,
  status: z.number().int().min(0).max(599),
  contentType: z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/).max(100),
  operationName: z.string().regex(SAFE_IDENTIFIER).optional(),
}).strict();

const inferredFieldSchema = z.object({
  field: z.enum(["id", "issuedAt", "total", "currency", "documentUrl", "documentRef"]),
  path: z.string().regex(SAFE_DOTTED_PATH).max(300),
  transforms: z.array(z.string().regex(SAFE_IDENTIFIER)).max(8),
}).strict();

const inferredSchema = z.object({
  strategy: z.enum(["network", "html"]),
  itemsPath: z.string().regex(SAFE_DOTTED_PATH).max(300),
  fields: z.array(inferredFieldSchema).max(8),
  auth: z.object({
    kind: z.enum(["cookie", "bearer-template", "unknown"]),
    probe: requestReferenceSchema.optional(),
  }).strict(),
  pagination: z.object({ cursorPath: z.string().regex(SAFE_DOTTED_PATH).max(200) }).strict().optional(),
  document: z.object({
    contentType: z.literal("application/pdf"),
    origins: z.array(safeOriginSchema).max(12),
  }).strict(),
}).strict();

export const supplierFingerprintSchema = z.object({
  schema: z.literal(SUPPLIER_FINGERPRINT_SCHEMA),
  fingerprintId: z.string().regex(FINGERPRINT_ID),
  capturedAt: z.string().datetime(),
  studioVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/).max(40),
  supplier: z.object({
    origin: safeOriginSchema,
    idCandidate: z.string().regex(SAFE_SLUG).max(100),
  }).strict(),
  evidence: z.object({
    requestCount: z.number().int().min(0).max(100_000),
    structuredResponseCount: z.number().int().min(0).max(100_000),
    documentCount: z.number().int().min(0).max(100_000),
    confidence: z.enum(["high", "medium", "low", "none"]),
    requests: z.array(requestFingerprintSchema).max(MAX_REQUESTS),
    inferred: inferredSchema.nullable(),
  }).strict(),
  privacy: z.object({
    structuralOnly: z.literal(true),
    rawBodiesIncluded: z.literal(false),
    requestHeadersIncluded: z.literal(false),
    fixtureIncluded: z.literal(false),
    queryValuesIncluded: z.literal(false),
    invoiceValuesIncluded: z.literal(false),
  }).strict(),
}).strict();

export type SupplierFingerprintV1 = z.infer<typeof supplierFingerprintSchema>;

export const supplierFingerprintSubmissionSchema = z.object({
  schema: z.literal(SUPPLIER_FINGERPRINT_SUBMISSION_SCHEMA),
  target: z.literal(SUPPLIER_FINGERPRINT_TARGET),
  fingerprint: supplierFingerprintSchema,
  consent: z.object({
    statementVersion: z.literal(SUPPLIER_FINGERPRINT_CONSENT),
    approvedAt: z.string().datetime(),
    authorityConfirmed: z.literal(true),
    shareApproved: z.literal(true),
    previewedFingerprintId: z.string().regex(FINGERPRINT_ID),
  }).strict(),
}).strict().superRefine((submission, ctx) => {
  if (submission.consent.previewedFingerprintId !== submission.fingerprint.fingerprintId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Consent does not match the previewed fingerprint" });
  }
});

export type SupplierFingerprintSubmissionV1 = z.infer<typeof supplierFingerprintSubmissionSchema>;

export interface BuildSupplierFingerprintInput {
  fingerprintId: string;
  capturedAt: string;
  studioVersion: string;
  session: CaptureSession;
  draft: DraftRecipe | null;
}

export function buildSupplierFingerprint(input: BuildSupplierFingerprintInput): SupplierFingerprintV1 {
  const listUrl = recipeRequestUrl(input.draft, "list");
  const authUrl = recipeRequestUrl(input.draft, "auth");
  const requests = dedupeRequests(input.session.entries.map((entry) => requestFingerprint(entry, listUrl, authUrl)));
  const candidate: SupplierFingerprintV1 = {
    schema: SUPPLIER_FINGERPRINT_SCHEMA,
    fingerprintId: input.fingerprintId,
    capturedAt: input.capturedAt,
    studioVersion: input.studioVersion,
    supplier: {
      origin: normalizeOrigin(input.session.origin),
      idCandidate: supplierIdCandidate(input.session.origin),
    },
    evidence: {
      requestCount: input.session.entries.length,
      structuredResponseCount: input.session.entries.filter((entry) => Boolean(entry.responseBody)).length,
      documentCount: input.session.entries.filter((entry) => baseContentType(entry.contentType) === "application/pdf").length,
      confidence: input.draft?.confidence ?? "none",
      requests,
      inferred: inferredFingerprint(input.draft),
    },
    privacy: {
      structuralOnly: true,
      rawBodiesIncluded: false,
      requestHeadersIncluded: false,
      fixtureIncluded: false,
      queryValuesIncluded: false,
      invoiceValuesIncluded: false,
    },
  };
  return parseSupplierFingerprint(candidate);
}

export function parseSupplierFingerprint(value: unknown): SupplierFingerprintV1 {
  assertJsonSize(value, MAX_FINGERPRINT_BYTES, "Supplier fingerprint");
  const parsed = supplierFingerprintSchema.parse(value);
  assertFingerprintSafety(parsed);
  return parsed;
}

export function parseSupplierFingerprintSubmission(value: unknown): SupplierFingerprintSubmissionV1 {
  assertJsonSize(value, MAX_SUBMISSION_BYTES, "Supplier fingerprint submission");
  const parsed = supplierFingerprintSubmissionSchema.parse(value);
  parseSupplierFingerprint(parsed.fingerprint);
  return parsed;
}

export function approveSupplierFingerprint(input: {
  fingerprint: unknown;
  approvedAt: string;
  authorityConfirmed: boolean;
  shareApproved: boolean;
}): SupplierFingerprintSubmissionV1 {
  if (!input.authorityConfirmed) throw new Error("Confirm your authority to share this supplier fingerprint.");
  if (!input.shareApproved) throw new Error("Explicitly approve sharing the displayed structural fingerprint.");
  const fingerprint = parseSupplierFingerprint(input.fingerprint);
  return parseSupplierFingerprintSubmission({
    schema: SUPPLIER_FINGERPRINT_SUBMISSION_SCHEMA,
    target: SUPPLIER_FINGERPRINT_TARGET,
    fingerprint,
    consent: {
      statementVersion: SUPPLIER_FINGERPRINT_CONSENT,
      approvedAt: input.approvedAt,
      authorityConfirmed: true,
      shareApproved: true,
      previewedFingerprintId: fingerprint.fingerprintId,
    },
  });
}

function requestFingerprint(entry: CapturedEntry, listUrl?: string, authUrl?: string): z.infer<typeof requestFingerprintSchema> {
  const reference = requestReference(entry.url, entry.method);
  const contentType = baseContentType(entry.contentType);
  const role = contentType === "application/pdf"
    ? "document"
    : sameRequest(entry.url, listUrl)
      ? "invoice_list"
      : sameRequest(entry.url, authUrl) || AUTH_PATH.test(new URL(entry.url).pathname)
        ? "auth"
        : "other";
  const operationName = graphqlOperationName(entry);
  return {
    ...reference,
    role,
    status: Number.isInteger(entry.status) && entry.status >= 0 && entry.status <= 599 ? entry.status : 0,
    contentType,
    ...(operationName ? { operationName } : {}),
  };
}

function requestReference(url: string, method = "GET"): z.infer<typeof requestReferenceSchema> {
  const parsed = new URL(url);
  return {
    method: safeMethod(method),
    origin: parsed.origin,
    pathPattern: structuralPath(parsed.pathname),
    queryKeys: [...new Set([...parsed.searchParams.keys()].filter((key) => SAFE_IDENTIFIER.test(key)))].sort().slice(0, 20),
  };
}

function structuralPath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean).slice(0, 40).map((segment) => {
    let decoded = "";
    try { decoded = decodeURIComponent(segment); } catch { return "{id}"; }
    const lower = decoded.toLowerCase();
    return STATIC_PATH_SEGMENTS.has(lower) ? lower : "{id}";
  });
  return `/${segments.join("/")}` || "/";
}

function graphqlOperationName(entry: CapturedEntry): string | undefined {
  if (entry.requestBody) {
    try {
      const parsed = JSON.parse(entry.requestBody) as { operationName?: unknown };
      if (typeof parsed.operationName === "string" && SAFE_IDENTIFIER.test(parsed.operationName)) return parsed.operationName;
    } catch {
      // Non-JSON request bodies are deliberately ignored rather than exported.
    }
  }
  try {
    const candidate = new URL(entry.url).searchParams.get("q") || "";
    return SAFE_IDENTIFIER.test(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function inferredFingerprint(draft: DraftRecipe | null): z.infer<typeof inferredSchema> | null {
  if (!draft) return null;
  const recipe = draft.recipe as Record<string, unknown>;
  const invoices = objectValue(recipe.invoices);
  const strategy = invoices.strategy === "html" ? "html" : "network";
  const list = objectValue(invoices.list);
  const map = objectValue(list.map);
  const fields = (["id", "issuedAt", "total", "currency", "documentUrl", "documentRef"] as const).flatMap((field) => {
    const spec = map[field];
    const path = typeof spec === "string" ? spec : typeof objectValue(spec).path === "string" ? String(objectValue(spec).path) : "";
    if (!SAFE_DOTTED_PATH.test(path)) return [];
    const transforms = Array.isArray(objectValue(spec).transforms)
      ? (objectValue(spec).transforms as unknown[]).flatMap((transform) => {
          const kind = objectValue(transform).kind;
          return typeof kind === "string" && SAFE_IDENTIFIER.test(kind) ? [kind] : [];
        })
      : [];
    return [{ field, path, transforms }];
  });
  const auth = objectValue(recipe.auth);
  const token = objectValue(auth.token);
  const check = objectValue(auth.check);
  const probeRequest = objectValue(check.request);
  const probeUrl = typeof probeRequest.url === "string" ? probeRequest.url : "";
  const listRequest = objectValue(list.request);
  const listHeaders = objectValue(listRequest.headers);
  const bearer = Object.values(listHeaders).some((value) => typeof value === "string" && value === "Bearer {token}");
  const paginate = objectValue(list.paginate);
  const cursorPath = typeof paginate.cursor === "string" && SAFE_DOTTED_PATH.test(paginate.cursor) ? paginate.cursor : undefined;
  const hosts = Array.isArray(recipe.hosts) ? recipe.hosts : [];
  const origins = [...new Set(hosts.flatMap((host) => {
    if (typeof host !== "string") return [];
    try { return [new URL(host).origin]; } catch { return []; }
  }))].sort();
  const itemsPath = typeof list.items === "string" && SAFE_DOTTED_PATH.test(list.items) ? list.items : "items";
  return inferredSchema.parse({
    strategy,
    itemsPath,
    fields,
    auth: {
      kind: Object.keys(token).length > 0 || bearer ? "bearer-template" : probeUrl ? "cookie" : "unknown",
      ...(probeUrl ? { probe: requestReference(probeUrl, typeof probeRequest.method === "string" ? probeRequest.method : "GET") } : {}),
    },
    ...(cursorPath ? { pagination: { cursorPath } } : {}),
    document: { contentType: "application/pdf", origins },
  });
}

function recipeRequestUrl(draft: DraftRecipe | null, kind: "list" | "auth"): string | undefined {
  if (!draft) return undefined;
  const recipe = draft.recipe as Record<string, unknown>;
  const request = kind === "list"
    ? objectValue(objectValue(objectValue(recipe.invoices).list).request)
    : objectValue(objectValue(objectValue(recipe.auth).check).request);
  return typeof request.url === "string" ? request.url : undefined;
}

function dedupeRequests(requests: Array<z.infer<typeof requestFingerprintSchema>>): Array<z.infer<typeof requestFingerprintSchema>> {
  const seen = new Set<string>();
  const out: Array<z.infer<typeof requestFingerprintSchema>> = [];
  for (const request of requests) {
    if (NOISE.test(`${request.contentType} ${request.pathPattern}`)) continue;
    const key = JSON.stringify(request);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(request);
    if (out.length >= MAX_REQUESTS) break;
  }
  return out;
}

function normalizeOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Capture origin must not contain credentials, paths, queries, or fragments");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) {
    throw new Error("Supplier fingerprints require HTTPS except for local development");
  }
  return parsed.origin;
}

function supplierIdCandidate(origin: string): string {
  const labels = new URL(origin).hostname.toLowerCase().split(".").filter(Boolean);
  const useful = labels.length > 1 ? labels.slice(0, -1) : labels;
  const slug = useful.join("-").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100);
  return slug || "supplier";
}

function safeMethod(value: string): string {
  const method = String(value || "GET").toUpperCase();
  return /^[A-Z]{1,12}$/.test(method) ? method : "OTHER";
}

function baseContentType(value: string): string {
  const candidate = String(value || "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(candidate) ? candidate : "application/octet-stream";
}

function sameRequest(actual: string, expected?: string): boolean {
  if (!expected) return false;
  try {
    const a = new URL(actual);
    const b = new URL(expected);
    return a.origin === b.origin && structuralPath(a.pathname) === structuralPath(b.pathname);
  } catch {
    return false;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function assertFingerprintSafety(fingerprint: SupplierFingerprintV1): void {
  const serialized = JSON.stringify(fingerprint);
  if (/\b[Bb]earer\s+(?!\{token\})[A-Za-z0-9._~+/-]{8,}/.test(serialized)) throw new Error("Supplier fingerprint contains an authentication value");
  if (/\beyJ[A-Za-z0-9._-]{20,}/.test(serialized)) throw new Error("Supplier fingerprint contains a JWT-like value");
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(serialized)) throw new Error("Supplier fingerprint contains an email address");
}

function assertJsonSize(value: unknown, maxBytes: number, label: string): void {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { throw new Error(`${label} must be JSON serializable`); }
  if (serialized === undefined) throw new Error(`${label} must be JSON serializable`);
  if (new TextEncoder().encode(serialized).byteLength > maxBytes) throw new Error(`${label} exceeds its safety limit`);
}
