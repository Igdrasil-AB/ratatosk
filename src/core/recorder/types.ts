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
  /** Request headers (cookie stripped) — lets inference wire token/key auth.
   * Sensitive values live only in the in-memory session, never in outputs. */
  requestHeaders?: Record<string, string>;
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
