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
  const withBodies = entries.filter((e) => e.responseBody).length;

  const out: string[] = [];
  out.push(`# Invoice Collector capture → paste to your coding agent`);
  out.push(`origin: ${session.origin} · extension v${version} · ${entries.length} requests captured · ${withBodies} with bodies`);
  out.push("");

  if (draft) {
    out.push(`## Draft recipe (confidence: ${draft.confidence})`);
    out.push("```json");
    out.push(JSON.stringify(draft.recipe, null, 2));
    out.push("```");
    if (draft.notes.length) {
      out.push("Notes to resolve:");
      for (const note of draft.notes) out.push(`- ${note}`);
    }
  } else {
    out.push("## No recipe could be inferred — diagnostic below");
  }
  out.push("");

  const samples = entries
    .filter((e) => !NOISE.test(`${e.contentType} ${e.url}`))
    .slice(0, 25)
    .map((e) => `${e.status} ${e.contentType || "?"} ${e.method} ${sanitizeUrl(e.url)}`);
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
    out.push(docLinks.map(sanitizeUrl).join("\n"));
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
