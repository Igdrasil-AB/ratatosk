/**
 * The recorder turns captured network traffic into a draft vendor recipe, so a
 * human doesn't have to read the DevTools Network tab by hand. These types are
 * platform-free (no chrome.*, no DOM) so the inference is unit-testable in Node.
 */

/** One request/response observed on a page, from either capture backend. */
export interface CapturedEntry {
  url: string;
  method: string;
  status: number;
  /** Lower-cased content type of the response, e.g. "application/json". */
  contentType: string;
  /** Request body (e.g. a GraphQL query) — needed to replay POST endpoints. */
  requestBody?: string;
  /** Allowlisted request-header values needed to reconstruct a request.
   * Authentication and arbitrary header values are never persisted. */
  requestHeaders?: Record<string, string>;
  /** Authentication structure inferred at the sanitizer boundary, without a
   * value, hash, length, prefix, or other credential derivative. */
  requestAuth?: {
    scheme: "bearer" | "basic" | "custom" | "none";
    headerName?: string;
  };
  /** Bounded structural paths whose request JSON values were redacted. */
  redactedRequestPaths?: string[];
  /** Bounded structural paths whose response JSON values were redacted. */
  redactedResponsePaths?: string[];
  /** Response body as text — populated only for JSON-ish responses. */
  responseBody?: string;
}

/** An accumulated capture on one origin. */
export interface CaptureSession {
  origin: string;
  entries: CapturedEntry[];
}

/** The recorder's output: a recipe draft + the fixture that proves it. */
export interface DraftRecipe {
  /** A VendorRecipe-shaped object. Draft — a human reviews the notes. */
  recipe: Record<string, unknown>;
  /** The captured invoice-list JSON (PII-redacted) — becomes the test fixture. */
  fixture: unknown;
  confidence: "high" | "medium" | "low";
  /** What was inferred vs. guessed, and what a human must verify. */
  notes: string[];
}
