import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import github from "../../src/vendors/github";
import { htmlStrategy } from "../../src/core/strategies/html";
import { runVendor } from "../../src/core/engine";
import { networkStrategy } from "../../src/core/strategies/network";
import { unavailableDomStrategy } from "../../src/core/strategies/dom";
import { AuthExpired } from "../../src/core/errors";
import { assertAuthenticated } from "../../src/core/auth";
import type { HttpResponse, RequestSpec, RunContext } from "../../src/core/types";

/**
 * The recorder-authored GitHub recipe, exercised end to end against a snippet of
 * real billing-history markup. Proves the HTML strategy: it scrapes every receipt
 * link, collapses the `/ch_x` + `/ch_x.pdf` pair GitHub renders per row into ONE
 * download, and makes the relative links absolute so the PDF fetch can follow them.
 */
const BILLING_HTML = readFileSync("test/vendors/fixtures/github.invoices.html", "utf8");

function ctx(): RunContext {
  const fetch = (_spec: RequestSpec): Promise<HttpResponse> =>
    Promise.resolve({
      status: 200,
      ok: true,
      json: async () => ({}),
      arrayBuffer: async () => new TextEncoder().encode(BILLING_HTML).buffer,
      headers: { get: () => "text/html" },
    });
  return { companyId: "co", vars: {}, seen: { has: async () => false, claimIfAbsent: async () => "test-reservation", release: async () => undefined, add: async () => {} }, fetch };
}

describe("github recipe (recorder-authored, HTML strategy)", () => {
  it("accepts an unredirected billing page as authenticated", async () => {
    await expect(assertAuthenticated(github, ctx())).resolves.toBeUndefined();
  });

  it("treats a redirected GitHub login page as an expired session, not an empty billing history", async () => {
    const loggedOut: RunContext = {
      companyId: "co",
      vars: {},
      seen: { has: async () => false, claimIfAbsent: async () => "test-reservation", release: async () => undefined, add: async () => undefined },
      fetch: async () => ({
        status: 200,
        ok: true,
        url: "https://github.com/login?return_to=%2Faccount%2Fbilling%2Fhistory",
        redirected: true,
        json: async () => ({}),
        arrayBuffer: async () => new TextEncoder().encode("<html>Sign in to GitHub</html>").buffer,
        headers: { get: () => "text/html" },
      }),
    };

    await expect(runVendor(github, loggedOut, {
      network: networkStrategy,
      html: htmlStrategy,
      dom: unavailableDomStrategy,
    })).rejects.toBeInstanceOf(AuthExpired);
  });

  it("extracts one receipt per row (dedups the /x + /x.pdf pair) with absolute URLs", async () => {
    const result = await htmlStrategy.list(github, {}, ctx());
    const refs = result.refs;

    // Three billing rows → three receipts, not six (the .pdf twin collapsed).
    expect(refs).toHaveLength(3);
    expect(refs.map((r) => r.vendorInvoiceId)).toEqual([
      "/account/receipt/ch_AAA",
      "/account/receipt/ch_BBB",
      "/account/receipt/ch_CCC",
    ]);
    // Prefer the explicit PDF twin over the first-seen navigation/download URL.
    expect(refs[0].documentUrl).toBe("https://github.com/account/receipt/ch_AAA.pdf");
    // Unrelated links (settings, docs) are not matched.
    expect(refs.every((r) => r.documentUrl?.includes("/account/receipt/"))).toBe(true);
    expect(result.retrieval).toMatchObject({ completeness: "complete", unresolvedItems: 0 });
  });
});
