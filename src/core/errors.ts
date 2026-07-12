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
