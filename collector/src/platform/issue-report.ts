import type { CollectorDiagnostic } from "./diagnostics";
import type { DiscoveryDiagnosticV1 } from "./discovery-diagnostic";

/**
 * Turning a diagnostic into a report someone will actually send.
 *
 * A diagnostic that has to be copied, pasted somewhere, and described in prose
 * is a diagnostic that stays on the machine it was produced on. So the report
 * arrives pre-written: the summary a maintainer reads first is already in the
 * issue body, and the full record is on the clipboard for the one paste the
 * body asks for.
 *
 * URLs are the constraint. Browsers and GitHub both truncate long ones, and a
 * silently truncated diagnostic is worse than none — so the body carries only
 * the bounded summary, and the record travels by clipboard where it cannot be
 * cut short.
 *
 * Nothing here widens what a diagnostic contains. It is already free of raw
 * paths, queries, page content, headers, bodies, account and invoice
 * identifiers, and financial values by construction; this only decides how it
 * is presented.
 *
 * It does carry the supplier's hostname, which is the point — "discovery is
 * slow" is not actionable and "discovery is slow on this host" is. That makes a
 * report say which suppliers someone uses, so the wording states it plainly and
 * the flow only ever opens a *draft*: nothing is published until the person
 * presses submit on GitHub's own form.
 */

export const ISSUE_REPOSITORY = "https://github.com/Igdrasil-AB/ratatosk";
const ISSUES_URL = `${ISSUE_REPOSITORY}/issues`;
/** Well under the point where any browser or server truncates. */
const MAX_URL_CHARS = 6_000;
const PASTE_MARKER = "<!-- Paste here: the details were copied to your clipboard. -->";

export interface IssueReport {
  /** Prefilled GitHub issue, ready to open in a tab. */
  url: string;
  /** The full record, for the clipboard. */
  clipboard: string;
}

/** Where to send anything a diagnostic does not describe. */
export function generalIssueUrl(): string {
  return `${ISSUES_URL}/new?labels=${encodeURIComponent("from-extension")}`;
}

/**
 * A report for a search that found nothing.
 *
 * The summary answers the questions a maintainer would otherwise have to ask:
 * how long it ran, how much of the site it saw, which envelope it used, why it
 * stopped, and which route shapes it tried.
 */
export function buildDiscoveryIssueReport(diagnostic: DiscoveryDiagnosticV1): IssueReport {
  // A list, not bare lines: consecutive lines collapse into one paragraph in
  // Markdown, which turns the summary into an unreadable run-on.
  const summary = [
    `- **Site** \`${diagnostic.site}\``,
    `- **Collector** ${diagnostic.runtime.collectorVersion} · discovery engine ${diagnostic.runtime.discoveryEngine}`,
    `- **Result** \`${diagnostic.result}\` · stopped on \`${diagnostic.termination}\``,
    `- **Envelope** ${diagnostic.coverage?.mode ?? "fast"} · ${Math.round(diagnostic.timing.elapsedMs)}ms of ${diagnostic.limits.durationMs}ms`,
    `- **Pages** ${diagnostic.pages.attempted} of ${diagnostic.limits.pages} · ${diagnostic.pages.linked} linked · ${diagnostic.pages.commonRoutes} common`,
    `- **Candidates** ${diagnostic.candidates.compiled} compiled · ${diagnostic.candidates.previewed} previewed · ${diagnostic.candidates.retained} retained`,
  ].join("\n");

  const slowest = [...diagnostic.attempts]
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, 8)
    .map((attempt) =>
      `| ${attempt.page} | \`${attempt.route}\` | ${attempt.source} | ${attempt.adapter ?? "—"} | ${attempt.result} | ${Math.round(attempt.durationMs)}ms |`)
    .join("\n");
  const attempts = slowest
    ? `\n\n### Slowest pages\n\n| # | Route | Source | Adapter | Result | Time |\n| --- | --- | --- | --- | --- | --- |\n${slowest}`
    : "";

  const body = [
    "### What happened",
    "",
    "<!-- What you expected to find, and anything unusual about this account. -->",
    "",
    "### Search summary",
    "",
    summary + attempts,
    "",
    "### Full details",
    "",
    PASTE_MARKER,
    "",
    "```json",
    "",
    "```",
    "",
    "---",
    "",
    `_Includes \`${diagnostic.site}\` and route shapes such as \`/workspace/:id/billing\`. No page content, account or invoice identifier, header, response body, or credential._`,
  ].join("\n");

  return {
    url: issueUrl({
      title: `Discovery found no invoices on ${diagnostic.site} (${diagnostic.result})`,
      body,
      labels: ["from-extension", "discovery"],
    }),
    clipboard: `${JSON.stringify(diagnostic, null, 2)}\n`,
  };
}

/** A report for a supplier whose scheduled collection is failing. */
export function buildCollectionIssueReport(diagnostic: CollectorDiagnostic): IssueReport {
  const body = [
    "### What happened",
    "",
    "<!-- What you expected this supplier to collect. -->",
    "",
    "### Run summary",
    "",
    [
      `- **Collector** ${diagnostic.collectorVersion} · lifecycle ${diagnostic.lifecycleRevision}`,
      `- **Supplier** \`${diagnostic.vendorId}\` · outcome \`${diagnostic.outcomeCode}\``,
      `- **Collected** ${diagnostic.counts.collected} · ${diagnostic.counts.failedScopes} failed scopes · ${diagnostic.counts.emptyScopes} empty`,
      `- **Last run** ${diagnostic.recordedAt ?? "never"}`,
    ].join("\n"),
    "",
    "### Full details",
    "",
    PASTE_MARKER,
    "",
    "```json",
    "",
    "```",
    "",
    "---",
    "",
    "_Includes the supplier id and outcome code. No URL, header, response body, invoice identifier, or token._",
  ].join("\n");

  return {
    url: issueUrl({
      title: `Collection failing for ${diagnostic.vendorId} (${diagnostic.outcomeCode})`,
      body,
      labels: ["from-extension", "collection"],
    }),
    clipboard: `${JSON.stringify(diagnostic, null, 2)}\n`,
  };
}

/**
 * Build the URL, shortening the body rather than letting anything truncate it.
 *
 * Only table rows are droppable, and only from the bottom: rows are sorted
 * slowest first, so the pages that explain the time survive. The header and
 * separator are never touched — removing them leaves the remaining rows as
 * literal pipes rather than a table. Everything dropped is still in the pasted
 * record; the instruction to paste it is not, so that line always stays.
 */
function issueUrl(input: { title: string; body: string; labels: string[] }): string {
  const base = `${ISSUES_URL}/new?labels=${encodeURIComponent(input.labels.join(","))}&title=${encodeURIComponent(input.title)}&body=`;
  const lines = input.body.split("\n");
  const tooLong = () => base.length + encodeURIComponent(lines.join("\n")).length > MAX_URL_CHARS;
  while (tooLong()) {
    const last = lines.map((line) => line.startsWith("| ")).lastIndexOf(true);
    // Leave the header and its separator; two `|` lines are not a table.
    const firstRow = lines.findIndex((line) => line.startsWith("| ")) + 2;
    if (last < 0 || last <= firstRow) break;
    lines.splice(last, 1);
  }
  return base + encodeURIComponent(lines.join("\n"));
}
