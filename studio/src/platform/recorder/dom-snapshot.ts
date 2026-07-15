import type { CapturedEntry } from "../../../../src/core/recorder/types";
import { MAX_BODY_CHARS, sanitizeBody, sanitizeUrl } from "../../../../src/core/recorder/cdp";

/**
 * Grab the vendor page's RENDERED html at stop.
 *
 * This is the capture layer that never comes back empty: whatever the user is
 * looking at — a JSON-driven SPA, a server-rendered table, a client-rendered
 * grid — the invoice rows and download links are in the live DOM by definition.
 * Recording the network alone misses cached SPAs and pure-HTML pages; the
 * snapshot backstops both, so the inferer always has the data to work from.
 *
 * Returned as a synthetic `method: "DOM"` entry so the inferer can treat it as
 * just another HTML source (embedded-JSON blobs, receipt links) with no special
 * casing. Failures are swallowed — the network trace still stands on its own.
 */
export async function captureDomSnapshot(tabId: number): Promise<CapturedEntry | undefined> {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ url: location.href, html: document.documentElement.outerHTML }),
    });
    const result = injection?.result as { url: string; html: string } | undefined;
    if (!result?.html) return undefined;
    console.info(`[recorder] DOM snapshot ${result.html.length} chars captured`);
    return {
      url: sanitizeUrl(result.url),
      method: "DOM",
      status: 200,
      contentType: "text/html",
      responseBody: sanitizeBody(result.html.slice(0, MAX_BODY_CHARS), "text/html"),
    };
  } catch (error) {
    console.warn(`[recorder] DOM snapshot failed: ${String(error)}`);
    return undefined;
  }
}
