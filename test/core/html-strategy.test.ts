import { describe, expect, it } from "vitest";
import { extractEmbeddedJson, extractRows, htmlStrategy } from "../../src/core/strategies/html";
import { mapListResponse } from "../../src/core/strategies/network";
import type { HttpResponse, RequestSpec, RunContext, VendorRecipe } from "../../src/core/types";
import type { HtmlListSpec } from "../../src/core/types";

/**
 * The HTML strategy is what lets the collector reach server-rendered vendors
 * (GitHub-class pages) whose invoices never come back as a clean JSON API.
 * These exercise the two pure extraction paths — embedded-JSON hydration blobs
 * and a row regex — against page markup, with no network I/O.
 */
describe("html strategy — embedded JSON extraction", () => {
  const page = `
    <!doctype html><html><head>
      <script type="application/json" id="analytics">{"pageview":1}</script>
      <script type="application/json" data-target="react-app.embeddedData">
        {"payload":{"invoices":[
          {"id":"rcpt_1","amount":1299,"currency":"usd","date":"2026-06-01","pdf":"https://github.com/account/receipt/rcpt_1"},
          {"id":"rcpt_2","amount":1299,"currency":"usd","date":"2026-05-01","pdf":"https://github.com/account/receipt/rcpt_2"}
        ]}}
      </script>
      <script>window.notJson = 1</script>
    </head><body></body></html>`;

  it("parses every JSON blob and skips non-JSON scripts", () => {
    const blobs = extractEmbeddedJson(page);
    expect(blobs).toHaveLength(2); // analytics + embeddedData; the plain <script> is ignored
  });

  it("finds the invoice array via its path across blobs", () => {
    const spec: HtmlListSpec = {
      request: { url: "https://github.com/account/billing/history" },
      embeddedJson: true,
      items: "payload.invoices",
      map: {
        id: "id",
        issuedAt: "date",
        total: { path: "amount", transforms: [{ kind: "divide", by: 100 }] },
        currency: { path: "currency", transforms: [{ kind: "upper" }] },
        documentUrl: "pdf",
      },
    };
    const rows = extractRows(spec, page);
    expect(rows).toHaveLength(2);

    const refs = mapListResponse("github", { request: spec.request, items: spec.items!, map: spec.map }, { payload: { invoices: rows } });
    expect(refs[0]).toMatchObject({
      vendorInvoiceId: "rcpt_1",
      issuedAt: "2026-06-01",
      total: "12.99",
      currency: "USD",
      documentUrl: "https://github.com/account/receipt/rcpt_1",
    });
  });

  it("recovers HTML-entity-escaped JSON as a fallback", () => {
    const escaped = `<script type="application/json">{&quot;rows&quot;:[{&quot;id&quot;:&quot;a&quot;}]}</script>`;
    const blobs = extractEmbeddedJson(escaped);
    expect(blobs).toEqual([{ rows: [{ id: "a" }] }]);
  });
});

describe("html strategy — row regex fallback", () => {
  it("turns each regex match's named groups into a row", () => {
    const html = `
      <tr><td>INV-100</td><td><a href="/receipt/100.pdf">download</a></td></tr>
      <tr><td>INV-101</td><td><a href="/receipt/101.pdf">download</a></td></tr>`;
    const spec: HtmlListSpec = {
      request: { url: "https://acme.example/billing" },
      rowRegex: "<td>(?<id>INV-\\d+)</td><td><a href=\"(?<href>[^\"]+)\">",
      map: { id: "id", documentUrl: "href" },
    };
    const rows = extractRows(spec, html) as Array<Record<string, string>>;
    expect(rows.map((r) => r.id)).toEqual(["INV-100", "INV-101"]);
    expect(rows[0].href).toBe("/receipt/100.pdf");
  });
});

describe("html strategy — full list run resolves relative links", () => {
  // The exact recipe the recorder now auto-drafts for a GitHub-style page.
  const recipe = {
    id: "github",
    invoices: {
      strategy: "html",
      list: {
        request: { url: "https://github.com/account/billing/history" },
        rowRegex: 'href="(?<documentUrl>[^"]*/account/receipt/[^"]*)"',
        map: { id: "documentUrl", documentUrl: "documentUrl" },
      },
      document: { contentType: "application/pdf" },
    },
  } as unknown as VendorRecipe;

  const page = `<a href="/account/receipt/ch_AAA">a</a><a href="/account/receipt/ch_AAA">dup</a>
    <a href="/account/receipt/ch_BBB">b</a><a href="/settings">x</a>`;

  function ctx(): RunContext {
    const fetch = (spec: RequestSpec): Promise<HttpResponse> =>
      Promise.resolve({
        status: 200,
        ok: true,
        json: async () => ({}),
        arrayBuffer: async () => new TextEncoder().encode(page).buffer,
        headers: { get: () => "text/html" },
      });
    return { companyId: "co", vars: {}, seen: { has: async () => false, add: async () => {} }, fetch };
  }

  it("extracts unique receipts and makes their URLs absolute against the page", async () => {
    const refs = await htmlStrategy.list(recipe, {}, ctx());
    expect(refs.map((r) => r.documentUrl)).toEqual([
      "https://github.com/account/receipt/ch_AAA", // relative → absolute, deduped
      "https://github.com/account/receipt/ch_BBB",
    ]);
    // The dedup id is the raw href — stable & unique per receipt.
    expect(refs[0].vendorInvoiceId).toBe("/account/receipt/ch_AAA");
    expect(refs).toHaveLength(2); // the duplicate ch_AAA anchor collapsed
  });
});
