import { describe, expect, it } from "vitest";
import { decodePageResult, isPrimaryOrigin } from "../../collector/src/platform/page-fetch";

/**
 * The tab/executeScript machinery needs a real Chrome, but the routing and the
 * response-decoding are pure and worth locking down here.
 */
describe("page-fetch origin routing", () => {
  it("routes the primary origin through the page and everything else to the worker", () => {
    const primary = "https://claude.ai";
    expect(isPrimaryOrigin(primary, "https://claude.ai/api/stripe/x/invoices")).toBe(true);
    expect(isPrimaryOrigin(primary, "https://pay.stripe.com/invoice/x/pdf?s=ap")).toBe(false);
    expect(isPrimaryOrigin(primary, "not a url")).toBe(false);
  });
});

describe("decodePageResult", () => {
  it("decodes a base64 JSON body", async () => {
    const base64 = Buffer.from(JSON.stringify({ invoices: [{ id: 1 }] }), "utf8").toString("base64");
    const res = decodePageResult({ ok: true, status: 200, contentType: "application/json", base64 });

    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ invoices: [{ id: 1 }] });
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("round-trips binary bytes for a PDF", async () => {
    const original = [0x25, 0x50, 0x44, 0x46]; // %PDF
    const base64 = Buffer.from(Uint8Array.from(original)).toString("base64");
    const res = decodePageResult({ ok: true, status: 200, contentType: "application/pdf", base64 });

    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual(original);
  });
});
