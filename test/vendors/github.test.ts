import { describe, expect, it } from "vitest";
import github from "../../src/vendors/github";
import { htmlStrategy } from "../../src/core/strategies/html";
import type { HttpResponse, RequestSpec, RunContext } from "../../src/core/types";

/**
 * The recorder-authored GitHub recipe, exercised end to end against a snippet of
 * real billing-history markup. Proves the HTML strategy: it scrapes every receipt
 * link, collapses the `/ch_x` + `/ch_x.pdf` pair GitHub renders per row into ONE
 * download, and makes the relative links absolute so the PDF fetch can follow them.
 */
const BILLING_HTML = `<!doctype html><html><body>
  <table class="billing-history">
    <tr><td>Jun 1, 2026</td><td>$25.00</td>
      <td><a href="/account/receipt/ch_AAA">View</a> <a href="/account/receipt/ch_AAA.pdf">Download</a></td></tr>
    <tr><td>May 1, 2026</td><td>$25.00</td>
      <td><a href="/account/receipt/ch_BBB">View</a> <a href="/account/receipt/ch_BBB.pdf">Download</a></td></tr>
    <tr><td>Apr 1, 2026</td><td>$4.00</td>
      <td><a href="/account/receipt/ch_CCC">View</a> <a href="/account/receipt/ch_CCC.pdf">Download</a></td></tr>
  </table>
  <a href="/settings/billing">Payment information</a>
  <a href="https://docs.github.com/billing">Docs</a>
</body></html>`;

function ctx(): RunContext {
  const fetch = (_spec: RequestSpec): Promise<HttpResponse> =>
    Promise.resolve({
      status: 200,
      ok: true,
      json: async () => ({}),
      arrayBuffer: async () => new TextEncoder().encode(BILLING_HTML).buffer,
      headers: { get: () => "text/html" },
    });
  return { companyId: "co", vars: {}, seen: { has: async () => false, add: async () => {} }, fetch };
}

describe("github recipe (recorder-authored, HTML strategy)", () => {
  it("extracts one receipt per row (dedups the /x + /x.pdf pair) with absolute URLs", async () => {
    const refs = await htmlStrategy.list(github, {}, ctx());

    // Three billing rows → three receipts, not six (the .pdf twin collapsed).
    expect(refs).toHaveLength(3);
    expect(refs.map((r) => r.vendorInvoiceId)).toEqual([
      "/account/receipt/ch_AAA",
      "/account/receipt/ch_BBB",
      "/account/receipt/ch_CCC",
    ]);
    // documentUrl is the first-seen variant, made absolute against the page.
    expect(refs[0].documentUrl).toBe("https://github.com/account/receipt/ch_AAA");
    // Unrelated links (settings, docs) are not matched.
    expect(refs.every((r) => r.documentUrl?.includes("/account/receipt/"))).toBe(true);
  });
});
