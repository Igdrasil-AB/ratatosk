import { isExactDocumentProviderOriginPattern } from "./document-provider";
import type { RetrievalProof } from "./types";

/**
 * Typed error taxonomy.
 *
 * Error *type* drives UX: `AuthExpired` becomes a "reconnect" nudge, `RateLimited`
 * triggers backoff, `SelectorMiss` flags a recipe that needs repair. Keep these
 * meaningful — the platform layer switches on them.
 */

export class CollectorError extends Error {
  constructor(message: string, readonly vendorId?: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The user's session for this vendor is no longer valid — prompt a re-login. */
export class AuthExpired extends CollectorError {
  constructor(vendorId?: string) {
    super(`session expired for "${vendorId ?? "vendor"}"`, vendorId);
  }
}

export type AuthFailureKind = "blocked_or_challenged" | "insufficient_scope" | "transport_failed";

/** Authentication could not be verified, but reconnecting is not known to be the remedy. */
export class AuthFailure extends CollectorError {
  constructor(readonly kind: AuthFailureKind, vendorId?: string) {
    super(`authentication ${kind.replaceAll("_", " ")} for "${vendorId ?? "vendor"}"`, vendorId);
  }
}

/** The vendor rate-limited us; caller should back off and retry later. */
export class RateLimited extends CollectorError {
  constructor(readonly retryAfterMs: number, vendorId?: string) {
    super(`rate limited (retry after ${retryAfterMs}ms)`, vendorId);
  }
}

/** A referenced document could not be found (deleted, or a stale ref). */
export class DocumentNotFound extends CollectorError {}

/** A successful response did not contain the document shape the recipe requires. */
export class DocumentInvalid extends CollectorError {
  constructor(readonly status: number, readonly responseContentType: string, vendorId?: string) {
    super(`document invalid (status ${status}, type ${responseContentType || "missing"})`, vendorId);
  }
}

/** A supplier response exceeded the collector's bounded document budget. */
export class DocumentTooLarge extends CollectorError {
  constructor(readonly maximumBytes: number, vendorId?: string) {
    super(`document exceeds the ${maximumBytes} byte limit`, vendorId);
  }
}

/** A transport stopped reading an HTTP body once it crossed its caller-supplied cap. */
export class ResponseTooLarge extends CollectorError {
  constructor(readonly maximumBytes: number) {
    super(`response exceeds the ${maximumBytes} byte limit`);
  }
}

/** A trusted document provider redirected to a new exact origin that Chrome has
 * not granted yet. Signed paths and queries are deliberately not retained. */
export class DocumentPermissionRequired extends CollectorError {
  readonly requiredOrigins: readonly string[];

  constructor(readonly provider: "stripe", requiredOrigins: readonly string[], vendorId?: string) {
    super(`${provider} document access requires approval`, vendorId);
    const exact = [...new Set(requiredOrigins)].slice(0, 4);
    if (!exact.length || exact.some((origin) => !isExactDocumentProviderOriginPattern(origin))) {
      throw new Error("invalid document provider permission requirement");
    }
    this.requiredOrigins = exact;
  }

  toJSON(): { name: string; provider: "stripe"; requiredOrigins: readonly string[] } {
    return { name: this.name, provider: this.provider, requiredOrigins: this.requiredOrigins };
  }
}

/** A capability URL escaped the provider's strict redirect policy. */
export class DocumentRedirectRejected extends CollectorError {
  constructor(readonly provider: "stripe", vendorId?: string) {
    super(`${provider} document redirect was rejected`, vendorId);
  }
}

/** A template variable was missing, or a path resolved to nothing required. */
export class TemplateError extends CollectorError {}

/** The recipe failed schema validation. */
export class SchemaError extends CollectorError {}

/** A DOM selector matched nothing — the recipe's DOM steps need updating. */
export class SelectorMiss extends CollectorError {}

/** A path yielded evidence but hit a traversal/action/document cap or left
 * observed items unresolved. Candidate verification should try another path. */
export class RetrievalIncomplete extends CollectorError {
  constructor(message: string, vendorId?: string, readonly proof?: RetrievalProof) {
    super(message, vendorId);
  }
}

/** The vendor responded in a way the recipe did not anticipate. */
export class UnexpectedResponse extends CollectorError {
  constructor(readonly status: number, message: string, vendorId?: string) {
    super(`unexpected response (${status}): ${message}`, vendorId);
  }
}

export const OPERATIONAL_OUTCOME_CODES = [
  "auth_expired",
  "auth_blocked",
  "insufficient_scope",
  "transport_failed",
  "rate_limited",
  "recipe_incompatible",
  "document_invalid",
  "document_permission_required",
  "retrieval_incomplete",
  "destination_unavailable",
  "connection_persistence_failed",
  "partial_scope_failure",
  "unknown",
] as const;

export type OperationalOutcomeCode = typeof OPERATIONAL_OUTCOME_CODES[number];

export function operationalCodeForError(error: unknown): OperationalOutcomeCode {
  if (error instanceof AuthExpired) return "auth_expired";
  if (error instanceof AuthFailure) {
    if (error.kind === "insufficient_scope") return "insufficient_scope";
    if (error.kind === "transport_failed") return "transport_failed";
    return "auth_blocked";
  }
  if (error instanceof RateLimited) return "rate_limited";
  if (error instanceof DocumentInvalid || error instanceof DocumentNotFound || error instanceof DocumentTooLarge) return "document_invalid";
  if (error instanceof DocumentPermissionRequired) return "document_permission_required";
  if (error instanceof DocumentRedirectRejected) return "document_invalid";
  if (error instanceof RetrievalIncomplete) return "retrieval_incomplete";
  if (error instanceof UnexpectedResponse || error instanceof SelectorMiss || error instanceof SchemaError || error instanceof TemplateError) {
    return "recipe_incompatible";
  }
  return "unknown";
}

export function operationalOutcomeLabel(code: OperationalOutcomeCode): string {
  switch (code) {
    case "auth_expired": return "Session expired";
    case "auth_blocked": return "Supplier blocked the session check";
    case "insufficient_scope": return "Billing access is not available for this account";
    case "transport_failed": return "Supplier could not be reached";
    case "rate_limited": return "Supplier asked Ratatosk to wait";
    case "recipe_incompatible": return "Supplier integration needs review";
    case "document_invalid": return "Supplier returned an invalid document";
    case "document_permission_required": return "Stripe document access needs approval";
    case "retrieval_incomplete": return "Invoice retrieval was incomplete";
    case "destination_unavailable": return "Invoice destination unavailable";
    case "connection_persistence_failed": return "Supplier connection could not be saved";
    case "partial_scope_failure": return "Some account scopes need attention";
    case "unknown": return "Collection failed";
    default: return assertNever(code);
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled operational outcome: ${String(value)}`);
}
