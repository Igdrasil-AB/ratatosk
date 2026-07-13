/**
 * Builds the "Copy for agent" report — one paste-ready block that hands a coding
 * agent everything it needs to finish (or fix) a recipe, without the human
 * copying 300 KB of DOM by hand.
 *
 * It is deliberately BOUNDED and pure: the draft recipe + notes, a filtered list
 * of captured requests, the document links found, and — only when inference
 * wasn't confident — a small HTML excerpt centered on the invoice rows so the
 * agent can see the exact markup to target. Size is capped so it always pastes.
 */
import type { CaptureSession, CapturedEntry, DraftRecipe } from "./types";
import { extractEmbeddedJson } from "../strategies/html";

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
    .map((e) => `${e.status} ${e.contentType || "?"} ${e.method} ${e.url}`);
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
    out.push(docLinks.join("\n"));
    out.push("```");
    out.push("");
  }

  // The expensive part — only when the recipe isn't trustworthy on its own.
  if (!draft || draft.confidence === "low") {
    const excerpt = htmlDiagnostic(entries, docLinks);
    if (excerpt) {
      out.push("## HTML diagnostic (excerpt around the invoice rows / data)");
      out.push("```html");
      out.push(excerpt);
      out.push("```");
    }
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
    .replace(/\beyJ[A-Za-z0-9._-]{20,}/g, "«redacted-jwt»");
}

/** A small, whitespace-collapsed slice of the most useful captured HTML. */
function htmlDiagnostic(entries: CapturedEntry[], docLinks: string[]): string | undefined {
  const htmlEntries = entries.filter((e) => e.responseBody && e.contentType.includes("html"));
  if (!htmlEntries.length) return undefined;
  // Prefer the rendered DOM snapshot (post-JS markup), then the largest body.
  htmlEntries.sort(
    (a, b) =>
      (b.method === "DOM" ? 1 : 0) - (a.method === "DOM" ? 1 : 0) ||
      (b.responseBody?.length ?? 0) - (a.responseBody?.length ?? 0),
  );
  const html = htmlEntries[0].responseBody as string;

  // Windows centered on the first few document links show the exact row markup.
  const windows: string[] = [];
  for (const href of docLinks.slice(0, 3)) {
    const idx = html.indexOf(href);
    if (idx < 0) continue;
    windows.push(collapse(html.slice(Math.max(0, idx - 400), idx + href.length + 200)));
  }
  if (windows.length) return windows.join("\n--- next row ---\n");

  // No doc-links: surface embedded-JSON blob shapes (helps locate an array), else a head slice.
  const blobs = extractEmbeddedJson(html);
  if (blobs.length) {
    return blobs
      .slice(0, 6)
      .map((b, i) => `embedded blob[${i}] top-level keys: ${topKeys(b).join(", ") || "(not an object)"}`)
      .join("\n");
  }
  return collapse(html.slice(0, 1500));
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function topKeys(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).slice(0, 30) : [];
}
