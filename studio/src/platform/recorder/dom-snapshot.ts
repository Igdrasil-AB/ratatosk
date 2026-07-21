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
      func: captureBoundedDomInPage,
      args: [MAX_BODY_CHARS],
    });
    const result = injection?.result as { url: string; html: string; truncated: boolean } | undefined;
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

/** Self-contained traversal serialized into the inspected page. It never asks
 * the browser to construct `outerHTML`, and stops visiting nodes once the
 * transfer budget is full. Extension-side sanitization remains mandatory. */
export function captureBoundedDomInPage(maxChars: number): {
  url: string;
  html: string;
  truncated: boolean;
} {
  const limit = Math.max(1, Math.min(1_500_000, Math.trunc(maxChars)));
  const chunks: string[] = [];
  let length = 0;
  let truncated = false;

  const append = (value: string, escape: "text" | "attribute" | "none" = "none"): void => {
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      const encoded = character === "&" ? "&amp;"
        : character === "<" ? "&lt;"
        : character === ">" ? "&gt;"
        : escape === "attribute" && character === '"' ? "&quot;"
        : character;
      if (length + encoded.length > limit) {
        truncated = true;
        return;
      }
      chunks.push(encoded);
      length += encoded.length;
    }
  };

  const serialize = (node: Node): void => {
    if (length >= limit) {
      truncated = true;
      return;
    }
    if (node.nodeType === 3) {
      const parentName = node.parentNode && "localName" in node.parentNode
        ? String((node.parentNode as Element).localName).toLowerCase()
        : "";
      append(node.nodeValue ?? "", parentName === "script" || parentName === "style" ? "none" : "text");
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const tag = element.localName.toLowerCase();
    append(`<${tag}`);
    for (const attribute of Array.from(element.attributes)) {
      append(` ${attribute.name}="`);
      append(attribute.value, "attribute");
      append('"');
      if (truncated) return;
    }
    append(">");
    for (const child of Array.from(element.childNodes)) {
      serialize(child);
      if (truncated) return;
    }
    append(`</${tag}>`);
  };

  serialize(document.documentElement);
  return { url: location.href.slice(0, 2_048), html: chunks.join(""), truncated };
}
