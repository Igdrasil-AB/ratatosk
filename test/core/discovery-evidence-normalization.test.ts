import { describe, expect, it } from "vitest";
import { buildDiscoveryEvidenceEntry, sanitizeDiscoveryUrl } from "../../src/core/recorder/discovery-evidence";
import { buildEntry } from "../../src/core/recorder/cdp";
import { inferRecipe } from "../../src/core/recorder/infer";

/**
 * Discovery evidence is inference input, not a shareable capture.
 *
 * These tests pin both halves of that: the values a recipe needs in order to
 * address the right endpoint survive, and the values that would be a credential
 * or a payment instrument do not.
 */

const GRAPHQL_URL = "https://api.vendor.example/graphql?q=enrichCustomer";
const REQUEST_BODY = JSON.stringify({
  operationName: "enrichCustomer",
  variables: { workspaceId: "3f2a9c1e-5b6d-4a7f-8c9d-0e1f2a3b4c5d" },
  query: "query enrichCustomer($workspaceId: String!) { workspace(workspaceId: $workspaceId) { customer { invoices { hostedURL invoiceId total periodEnd } } } }",
});
const RESPONSE_BODY = JSON.stringify({
  data: {
    workspace: {
      customer: {
        invoices: [
          { hostedURL: "https://invoice.stripe.com/i/acct_1PabcDEFghiJKL/live_YWNjdF8xUGFiYw", invoiceId: "in_1Pabc", total: 2000, periodEnd: "2026-07-01T00:00:00.000Z" },
          { hostedURL: "https://invoice.stripe.com/i/acct_1PabcDEFghiJKL/live_ZWNjdF8xUGFiYw", invoiceId: "in_1Pabd", total: 4500, periodEnd: "2026-06-01T00:00:00.000Z" },
        ],
      },
    },
  },
});

function entry(overrides: Partial<Parameters<typeof buildDiscoveryEvidenceEntry>[0]> = {}) {
  return buildDiscoveryEvidenceEntry({
    url: GRAPHQL_URL,
    method: "POST",
    status: 200,
    contentType: "application/json",
    body: RESPONSE_BODY,
    requestBody: REQUEST_BODY,
    requestHeaders: { "content-type": "application/json" },
    ...overrides,
  });
}

describe("discovery evidence normalization", () => {
  it("keeps the invoice list addressable and inferable", () => {
    const observed = entry();

    expect(observed.url).toBe(GRAPHQL_URL);
    expect(observed.requestBody).toContain("3f2a9c1e-5b6d-4a7f-8c9d-0e1f2a3b4c5d");
    expect(observed.responseBody).toContain("invoices");
    expect(observed.responseBody).toContain("in_1Pabc");
    expect(observed.responseBody).not.toContain("REDACTED");

    const draft = inferRecipe({ origin: "https://vendor.example", entries: [observed] });
    const invoices = draft?.recipe.invoices as { strategy: string; list: { items: string; map: Record<string, unknown> } };
    expect(invoices.strategy).toBe("network");
    expect(invoices.list.items).toBe("data.workspace.customer.invoices");
    expect(invoices.list.map.documentUrl).toBe("hostedURL");
  });

  it("is what the recorder's capture sanitizer cannot be used for", () => {
    // The recorder sanitizer is correct for its own job — a capture session a
    // person may share — and wrong as inference input. Keeping the contrast in a
    // test stops the two from being quietly merged again.
    const captured = buildEntry({
      url: GRAPHQL_URL,
      method: "POST",
      status: 200,
      contentType: "application/json",
      body: RESPONSE_BODY,
      requestBody: REQUEST_BODY,
      requestHeaders: { "content-type": "application/json" },
    });

    expect(captured.responseBody).not.toContain("invoices");
    expect(inferRecipe({ origin: "https://vendor.example", entries: [captured] })).toBeNull();
  });

  it("removes credentials, wherever they are carried", () => {
    const observed = entry({
      url: "https://api.vendor.example/invoices?access_token=abc123def456&year=2026",
      method: "GET",
      requestBody: undefined,
      body: JSON.stringify({
        session: { accessToken: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0" },
        apiKey: "sk_live_51PabcDEFghiJKLmnop",
        invoices: [{ id: "inv_1", issued_at: "2026-07-01", amount: 100, pdf_url: "/inv_1.pdf" }],
      }),
    });

    expect(observed.url).toBe("https://api.vendor.example/invoices?access_token=REDACTED&year=2026");
    expect(observed.responseBody).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(observed.responseBody).not.toContain("sk_live_51PabcDEFghiJKLmnop");
    // The invoice rows beside the credential are still evidence.
    expect(observed.responseBody).toContain("inv_1");
  });

  it("removes payment instrument data while keeping the row it sat on", () => {
    const observed = entry({
      method: "GET",
      requestBody: undefined,
      body: JSON.stringify({
        invoices: [{
          id: "inv_1",
          issued_at: "2026-07-01",
          amount: 100,
          pdf_url: "/inv_1.pdf",
          card_number: "4242424242424242",
          iban: "GB33BUKB20201555555555",
        }],
      }),
    });

    expect(observed.responseBody).not.toContain("4242424242424242");
    expect(observed.responseBody).not.toContain("GB33BUKB20201555555555");
    expect(observed.responseBody).toContain("inv_1");
  });

  it("drops a body it cannot inspect key by key", () => {
    expect(entry({ body: "not json at all" }).responseBody).toBeUndefined();
  });

  it("strips credentials from the authority and fragment of an observed URL", () => {
    expect(sanitizeDiscoveryUrl("https://user:secret@api.vendor.example/invoices?page=2#token=abc"))
      .toBe("https://api.vendor.example/invoices?page=2");
  });
});
