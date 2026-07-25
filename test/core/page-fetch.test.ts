import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodePageResult,
  isPrimaryOrigin,
  pageFetchInPage,
  pageFetchFailureLabel,
  PageFetcher,
  parsePageFetchResult,
  selectReusablePageTab,
} from "../../collector/src/platform/page-fetch";
import { VENDORS } from "../../src/vendors";
import { recipeAllowsUrl } from "../../collector/src/platform/runtime";

const pageFetcherSource = readFileSync("collector/src/platform/page-fetch.ts", "utf8");
const publicRecipe = VENDORS[0];
const publicPrimaryOrigin = new URL(publicRecipe.homepage).origin;
const publicPrimaryRequest = `${publicPrimaryOrigin}/api/organizations`;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * The tab/executeScript machinery needs a real Chrome, but the routing and the
 * response-decoding are pure and worth locking down here.
 */
describe("page-fetch origin routing", () => {
  it("does not follow page-context redirects into a secondary allowed origin", () => {
    expect(pageFetcherSource).toContain('redirect: "error"');
    expect(pageFetcherSource).toContain("new URL(result.finalUrl).origin !== this.primaryOrigin");
  });

  it("fails the injected request before a simulated secondary redirect is fetched", async () => {
    let secondaryRequests = 0;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.redirect === "error") throw new TypeError("redirect blocked");
      secondaryRequests++;
      throw new Error("secondary endpoint should not be reached");
    });
    vi.stubGlobal("fetch", fetch);

    await expect(pageFetchInPage({ url: "https://claude.ai/api/invoices" })).resolves.toMatchObject({
      ok: false,
      status: 0,
      base64: "",
    });
    expect(fetch).toHaveBeenCalledWith("https://claude.ai/api/invoices", expect.objectContaining({
      credentials: "include",
      redirect: "error",
    }));
    expect(secondaryRequests).toBe(0);
  });

  it("routes the primary origin through the page and everything else to the worker", () => {
    const primary = "https://claude.ai";
    expect(isPrimaryOrigin(primary, "https://claude.ai/api/stripe/x/invoices")).toBe(true);
    expect(isPrimaryOrigin(primary, "https://pay.stripe.com/invoice/x/pdf?s=ap")).toBe(false);
    expect(isPrimaryOrigin(primary, "not a url")).toBe(false);
  });

  it("rejects dynamic document URLs outside the recipe permission set", async () => {
    const fetcher = new PageFetcher(publicRecipe);
    await expect(fetcher.fetch({ url: "https://attacker.example/invoice.pdf" }, {})).rejects.toThrow(
      /outside the supplier permission set/,
    );
  });

  it("coalesces concurrent primary-origin tab creation and disposes the owned tab", async () => {
    const create = vi.fn(async () => ({ id: 71, status: "loading" }));
    const remove = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn(async () => []),
        create,
        get: vi.fn(async () => ({ id: 71, status: "complete" })),
        remove,
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      scripting: {
        executeScript: vi.fn(async () => [{ result: {
          ok: true,
          status: 200,
          contentType: "application/json",
          finalUrl: publicPrimaryRequest,
          redirected: false,
          base64: "e30=",
        } }]),
      },
    });
    const fetcher = new PageFetcher(publicRecipe);
    const request = { url: publicPrimaryRequest };

    await Promise.all([fetcher.fetch(request, {}), fetcher.fetch(request, {})]);
    expect(create).toHaveBeenCalledTimes(1);

    await fetcher.dispose();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(71);
  });

  it("removes and untracks a newly created tab when its initial load times out", async () => {
    vi.useFakeTimers();
    const remove = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn(async () => []),
        create: vi.fn(async () => ({ id: 72, status: "loading" })),
        get: vi.fn(async () => ({ id: 72, status: "loading" })),
        remove,
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      scripting: { executeScript: vi.fn() },
    });
    const fetcher = new PageFetcher(publicRecipe);
    const request = fetcher.fetch({ url: publicPrimaryRequest }, {});
    const rejection = expect(request).rejects.toThrow(/page fetch failed during tab/);

    await vi.runAllTimersAsync();
    await rejection;
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(72);

    await fetcher.dispose();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("applies the same exact-origin boundary to worker recipes", () => {
    expect(recipeAllowsUrl(publicRecipe, `${publicPrimaryOrigin}/api/invoices`)).toBe(true);
    expect(recipeAllowsUrl(publicRecipe, "https://attacker.example/invoice.pdf")).toBe(false);
  });

  it("prefers the exact supplier page over another same-origin tab", () => {
    const selected = selectReusablePageTab([
      {
        id: 11,
        url: "https://github.com/account/receipt/example.pdf",
        status: "complete",
        discarded: false,
        active: true,
      },
      {
        id: 12,
        url: "https://github.com/account/billing/history",
        status: "complete",
        discarded: false,
        active: false,
      },
    ], "https://github.com/account/billing/history");

    expect(selected?.id).toBe(12);
  });

  it("never selects a discarded or incomplete tab for script injection", () => {
    const selected = selectReusablePageTab([
      {
        id: 21,
        url: "https://github.com/account/billing/history",
        status: "complete",
        discarded: true,
        active: true,
      },
      {
        id: 22,
        url: "https://github.com/settings/billing",
        status: "loading",
        discarded: false,
        active: false,
      },
    ], "https://github.com/account/billing/history");

    expect(selected).toBeUndefined();
  });

  it("opens the preferred supplier page instead of injecting into an unrelated complete tab", () => {
    const selected = selectReusablePageTab([
      {
        id: 31,
        url: "https://github.com/account/receipt/example.pdf",
        status: "complete",
        discarded: false,
        active: true,
      },
    ], "https://github.com/account/billing/history");

    expect(selected).toBeUndefined();
  });
});

describe("decodePageResult", () => {
  it("rejects malformed or oversized MAIN-world results before decoding", () => {
    expect(() => parsePageFetchResult({ ok: true, status: -1, contentType: null, base64: "" })).toThrow(/page fetch result/);
    expect(() => parsePageFetchResult({ ok: true, status: 200, contentType: "application/pdf", base64: "A".repeat(45_000_000) })).toThrow(/too large/);
    expect(() => parsePageFetchResult({ ok: true, status: 200, contentType: "application/pdf", base64: "%%%" })).toThrow(/base64/);
  });

  it("decodes a base64 JSON body", async () => {
    const base64 = Buffer.from(JSON.stringify({ invoices: [{ id: 1 }] }), "utf8").toString("base64");
    const res = decodePageResult({
      ok: true,
      status: 200,
      contentType: "application/json",
      linkHeader: '</api/invoices?page=2>; rel="next"',
      finalUrl: "https://claude.ai/api/invoices",
      redirected: true,
      base64,
    });

    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ invoices: [{ id: 1 }] });
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("link")).toContain('rel="next"');
    expect(res.url).toBe("https://claude.ai/api/invoices");
    expect(res.redirected).toBe(true);
  });

  it("round-trips binary bytes for a PDF", async () => {
    const original = [0x25, 0x50, 0x44, 0x46]; // %PDF
    const base64 = Buffer.from(Uint8Array.from(original)).toString("base64");
    const res = decodePageResult({ ok: true, status: 200, contentType: "application/pdf", base64 });

    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual(original);
  });
});

describe("pageFetchFailureLabel", () => {
  it("reports the closed execution stage without copying exception text", () => {
    expect(pageFetchFailureLabel("injection", new Error("https://github.com/account/receipt/private.pdf"))).toBe(
      "injection (Error)",
    );
    expect(pageFetchFailureLabel("result", "private response contents")).toBe("result (non-error)");
  });
});
