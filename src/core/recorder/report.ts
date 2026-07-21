/**
 * Builds the "Copy for agent" report — one paste-ready block that hands a coding
 * agent everything it needs to finish (or fix) a recipe, without the human
 * copying 300 KB of DOM by hand.
 *
 * It is deliberately BOUNDED and pure: the draft recipe + notes, a filtered list
 * of sanitized captured requests, and sanitized document links. HTML bodies are
 * deliberately excluded. Size is capped so it always pastes.
 */
import type { CaptureSession, CapturedEntry, DraftRecipe } from "./types";
import { sanitizeUrl } from "./cdp";

export interface AgentReportInput {
  version: string;
  session: CaptureSession;
  draft: DraftRecipe | null;
  docLinks: string[];
}

const MAX_REPORT_CHARS = 14_000;
const NOISE = /javascript|text\/css|font|image\/|\.(js|css|woff2?|png|svg|jpe?g|gif|ico)(\?|$)/i;

export function buildAgentReport(input: AgentReportInput): string {
  const { version, session, draft, docLinks } = input;
  const entries = session.entries;
  const requests = entries.filter((entry) => entry.method !== "DOM");
  const withBodies = requests.filter((e) => e.responseBody).length;

  const out: string[] = [];
  out.push(`# Invoice Collector capture → paste to your coding agent`);
  out.push(`origin: ${session.origin} · extension v${version} · ${requests.length} requests captured · ${withBodies} with bodies · ${entries.length - requests.length} rendered-page artifacts`);
  out.push("");

  if (draft) {
    out.push(`## Draft recipe (confidence: ${draft.confidence})`);
    out.push("```json");
    out.push(JSON.stringify(redactRecipeForReport(draft.recipe), null, 2));
    out.push("```");
    if (draft.notes.length) {
      out.push("Notes to resolve:");
      for (const note of draft.notes) out.push(`- ${note}`);
    }
  } else {
    out.push("## No recipe could be inferred — diagnostic below");
  }
  out.push("");

  const samples = requests
    .filter((e) => !NOISE.test(`${e.contentType} ${e.url}`))
    .slice(0, 25)
    .map((e) => `${e.status} ${e.contentType || "?"} ${e.method} ${sanitizeReportUrl(e.url)}`);
  if (samples.length) {
    out.push("## Captured requests (noise filtered)");
    out.push("```");
    out.push(samples.join("\n"));
    out.push("```");
    out.push("");
  }

  if (docLinks.length) {
    out.push("## Invoice/receipt links found in the page HTML");
    out.push("```");
    out.push(docLinks.map(sanitizeReportUrl).join("\n"));
    out.push("```");
    out.push("");
  }

  const text = redactSecrets(out.join("\n"));
  return text.length > MAX_REPORT_CHARS ? `${text.slice(0, MAX_REPORT_CHARS)}\n… [truncated]` : text;
}

/**
 * Belt-and-suspenders: scrub anything token-shaped from the final, shareable
 * report so a value that slipped through a captured body can never be pasted out.
 * The `Bearer {token}` template the recipe uses is preserved (its `{` breaks the
 * pattern); only concrete secrets are redacted.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b[Bb]earer\s+[A-Za-z0-9._~+/-]{8,}=*/g, "Bearer «redacted»")
    .replace(/\beyJ[A-Za-z0-9._-]{20,}/g, "«redacted-jwt»")
    .replace(/\b(?:sk|pk|rk|api)[_-](?:live|test|prod)?[_-]?[A-Za-z0-9_-]{12,}\b/gi, "«redacted-key»")
    .replace(/([?&](?:token|key|secret|signature|sig|auth|code)=)[^&#\s"']+/gi, "$1«redacted»")
    .replace(/[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/g, "user@example.com");
}

function redactRecipeForReport(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => redactRecipeForReport(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
      childKey,
      redactRecipeForReport(child, childKey),
    ]));
  }
  if (typeof value !== "string") return value;
  if (key === "body") return redactRequestBody(value);
  if (key === "url" || key === "loginUrl" || key === "homepage") return sanitizeReportUrl(value);
  return redactSecrets(value);
}

function redactRequestBody(value: string): string {
  try {
    return JSON.stringify(redactRequestPayload(JSON.parse(value)));
  } catch {
    return "REDACTED";
  }
}

function redactRequestPayload(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => redactRequestPayload(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
      childKey,
      redactRequestPayload(child, childKey),
    ]));
  }
  if (typeof value === "string") {
    if (key === "query") return redactGraphqlQuery(value);
    if (key === "operationName" || /^\{[A-Za-z][A-Za-z0-9_-]*\}$/.test(value)) return redactSecrets(value);
    return "REDACTED";
  }
  if (typeof value === "number") return 0;
  return value;
}

function redactGraphqlQuery(value: string): string {
  return redactSecrets(value)
    .replace(/"(?:\\.|[^"\\])*"/g, '"REDACTED"')
    .replace(/(:\s*)-?\d+(?:\.\d+)?\b/g, "$10");
}

function sanitizeReportUrl(value: string): string {
  const sanitized = sanitizeUrl(value);
  try {
    const absolute = sanitized.startsWith("http://") || sanitized.startsWith("https://");
    const url = new URL(sanitized, "https://invalid.local");
    url.pathname = url.pathname
      .split("/")
      .map((segment) => isReportIdentifierSegment(segment) ? "REDACTED_ID" : segment)
      .join("/");
    return absolute ? url.toString() : `${url.pathname}${url.search}`;
  } catch {
    return redactSecrets(sanitized);
  }
}

function isReportIdentifierSegment(segment: string): boolean {
  if (/^\d{4,}$/.test(segment)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(segment)) return true;
  if (/^(?:acct|ch|cus|in|inv|org|sub|team|user|ws)_[A-Za-z0-9_-]{3,}$/i.test(segment)) return true;
  return segment.length >= 16 && /^[A-Za-z0-9._~+=-]+$/.test(segment) && /[A-Za-z]/.test(segment) && /[0-9]/.test(segment);
}
