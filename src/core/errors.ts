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

/** A template variable was missing, or a path resolved to nothing required. */
export class TemplateError extends CollectorError {}

/** The recipe failed schema validation. */
export class SchemaError extends CollectorError {}

/** A DOM selector matched nothing — the recipe's DOM steps need updating. */
export class SelectorMiss extends CollectorError {}

/** The vendor responded in a way the recipe did not anticipate. */
export class UnexpectedResponse extends CollectorError {
  constructor(readonly status: number, message: string, vendorId?: string) {
    super(`unexpected response (${status}): ${message}`, vendorId);
  }
}

export const OPERATIONAL_OUTCOME_CODES = [
  "auth_expired",
  "rate_limited",
  "recipe_incompatible",
  "document_invalid",
  "destination_unavailable",
  "partial_scope_failure",
  "unknown",
] as const;

export type OperationalOutcomeCode = typeof OPERATIONAL_OUTCOME_CODES[number];

export function operationalCodeForError(error: unknown): OperationalOutcomeCode {
  if (error instanceof AuthExpired) return "auth_expired";
  if (error instanceof RateLimited) return "rate_limited";
  if (error instanceof DocumentInvalid || error instanceof DocumentNotFound) return "document_invalid";
  if (error instanceof UnexpectedResponse || error instanceof SelectorMiss || error instanceof SchemaError || error instanceof TemplateError) {
    return "recipe_incompatible";
  }
  return "unknown";
}

export function operationalOutcomeLabel(code: OperationalOutcomeCode): string {
  switch (code) {
    case "auth_expired": return "Session expired";
    case "rate_limited": return "Supplier asked Ratatosk to wait";
    case "recipe_incompatible": return "Supplier integration needs review";
    case "document_invalid": return "Supplier returned an invalid document";
    case "destination_unavailable": return "Invoice destination unavailable";
    case "partial_scope_failure": return "Some account scopes need attention";
    case "unknown": return "Collection failed";
    default: return assertNever(code);
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled operational outcome: ${String(value)}`);
}
