import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureBoundedDomInPage,
  captureDomSnapshot,
} from "../../studio/src/platform/recorder/dom-snapshot";
import { MAX_BODY_CHARS } from "../../src/core/recorder/cdp";

afterEach(() => vi.unstubAllGlobals());

describe("Studio DOM snapshot boundary", () => {
  it("stops serialization inside the page before a large DOM crosses the boundary", () => {
    const text = { nodeType: 3, nodeValue: "x".repeat(10_000), parentNode: undefined };
    const root = {
      nodeType: 1,
      localName: "html",
      attributes: [],
      childNodes: [text],
      parentNode: null,
    };
    text.parentNode = root as any;
    vi.stubGlobal("document", { documentElement: root });
    vi.stubGlobal("location", { href: "https://vendor.example/billing?secret=discarded" });

    const result = captureBoundedDomInPage(128);

    expect(result.html.length).toBeLessThanOrEqual(128);
    expect(result.truncated).toBe(true);
  });

  it("passes the canonical body cap into the injected serializer", async () => {
    const executeScript = vi.fn(async (options: { args?: unknown[]; func?: unknown }) => [{ result: {
      url: "https://vendor.example/billing",
      html: "<html><body>invoice</body></html>",
      truncated: false,
    } }]);
    vi.stubGlobal("chrome", { scripting: { executeScript } });

    await expect(captureDomSnapshot(7)).resolves.toMatchObject({ method: "DOM", status: 200 });
    expect(executeScript.mock.calls[0][0].args).toEqual([MAX_BODY_CHARS]);
    expect(executeScript.mock.calls[0][0].func).toBe(captureBoundedDomInPage);
  });
});
