import { describe, expect, it, vi } from "vitest";
import { runVendor, type StrategyMap } from "../../src/core/engine";
import { inferRecipe } from "../../src/core/recorder/infer";
import { mapListResponse } from "../../src/core/strategies/network";
import {
  createSyncMonthWindow,
  filterInvoiceRefsBySyncWindow,
  syncMonthWindowVars,
} from "../../src/core/sync-window";
import type { RunContext, VendorRecipe } from "../../src/core/types";

describe("month-bounded collection", () => {
  it("normalizes a user month into inclusive calendar-month template variables", () => {
    const range = createSyncMonthWindow("2026-01", new Date("2026-07-29T12:00:00Z"));

    expect(range).toEqual({
      granularity: "month",
      fromMonth: "2026-01",
      throughMonth: "2026-07",
    });
    expect(syncMonthWindowVars(range)).toMatchObject({
      syncFromYear: 2026,
      syncFromMonth: "01",
      syncFromYearMonth: "2026-01",
      syncFromDate: "2026-01-01",
      syncFromIso: "2026-01-01T00:00:00.000Z",
      syncThroughYearMonth: "2026-07",
      syncThroughDate: "2026-07-31",
      syncToExclusiveDate: "2026-08-01",
    });
  });

  it("rejects malformed and future months", () => {
    const now = new Date("2026-07-29T12:00:00Z");
    expect(() => createSyncMonthWindow("2026-7", now)).toThrow("YYYY-MM");
    expect(() => createSyncMonthWindow("2026-13", now)).toThrow("YYYY-MM");
    expect(() => createSyncMonthWindow("2026-08", now)).toThrow("in the future");
  });

  it("classifies references without fetching outside or beyond a trustworthy month", () => {
    const range = createSyncMonthWindow("2026-03", new Date("2026-07-29T12:00:00Z"));
    const result = filterInvoiceRefsBySyncWindow([
      { vendorInvoiceId: "old", issuedAt: "2026-02-28" },
      { vendorInvoiceId: "first", issuedAt: "2026-03-01" },
      { vendorInvoiceId: "last", issuedAt: "2026-07-31T23:59:59Z" },
      { vendorInvoiceId: "future", issuedAt: "2026-08-01" },
      {
        vendorInvoiceId: "dom-row",
        metadataEvidence: [{
          source: "dom-row",
          confidence: "high",
          issuedAt: "2026-04-15",
        }],
      },
      {
        vendorInvoiceId: "conflicting-months",
        metadataEvidence: [
          { source: "dom-row", confidence: "high", issuedAt: "2026-04-15" },
          { source: "network", confidence: "high", issuedAt: "2026-05-15" },
        ],
      },
      { vendorInvoiceId: "unknown" },
    ], range);

    expect(result.refs.map((ref) => ref.vendorInvoiceId)).toEqual(["first", "last", "dom-row"]);
    expect(result).toMatchObject({
      matched: 3,
      skippedBefore: 1,
      skippedAfter: 1,
      skippedUndated: 2,
    });
  });

  it("uses the date field inferred for an otherwise unknown supplier", () => {
    const payload = {
      invoices: [
        { id: "old", issued_at: "2026-02-15", total: 1000, currency: "sek", pdf_url: "https://vendor.example/old.pdf" },
        { id: "current", issued_at: "2026-04-15", total: 2000, currency: "sek", pdf_url: "https://vendor.example/current.pdf" },
      ],
    };
    const draft = inferRecipe({
      origin: "https://vendor.example",
      entries: [{
        url: "https://vendor.example/api/invoices",
        method: "GET",
        status: 200,
        contentType: "application/json",
        responseBody: JSON.stringify(payload),
      }],
    });
    const recipe = draft?.recipe as unknown as VendorRecipe | undefined;
    expect(recipe?.invoices.strategy).toBe("network");
    if (!recipe || recipe.invoices.strategy !== "network") throw new Error("expected an inferred network recipe");

    const refs = mapListResponse(recipe.id, recipe.invoices.list, payload);
    const result = filterInvoiceRefsBySyncWindow(
      refs,
      createSyncMonthWindow("2026-03", new Date("2026-07-29T12:00:00Z")),
    );

    expect(refs.map((ref) => ref.issuedAt)).toEqual(["2026-02-15", "2026-04-15"]);
    expect(result.refs.map((ref) => ref.vendorInvoiceId)).toEqual(["current"]);
  });

  it("enforces the month window before document materialization", async () => {
    const fetched: string[] = [];
    const recipe = testRecipe();
    const strategy = {
      list: vi.fn(async () => ({
        refs: [
          { vendorInvoiceId: "old", issuedAt: "2025-12-31", documentUrl: "https://vendor.example/old.pdf" },
          { vendorInvoiceId: "current", issuedAt: "2026-01-20", documentUrl: "https://vendor.example/current.pdf" },
          { vendorInvoiceId: "undated", documentUrl: "https://vendor.example/undated.pdf" },
        ],
        retrieval: {
          completeness: "complete" as const,
          termination: "explicit_end" as const,
          pagesVisited: 1,
          observedItems: 3,
          resolvedItems: 3,
          unresolvedItems: 0,
        },
      })),
      fetchDocument: vi.fn(async (_recipe: VendorRecipe, ref: { vendorInvoiceId: string }) => {
        fetched.push(ref.vendorInvoiceId);
        return {
          bytes: new Uint8Array([37, 80, 68, 70]).buffer,
          contentType: "application/pdf",
          filename: `${ref.vendorInvoiceId}.pdf`,
        };
      }),
    };
    const ctx: RunContext = {
      companyId: "company",
      vars: {},
      syncWindow: createSyncMonthWindow("2026-01", new Date("2026-07-29T12:00:00Z")),
      seen: {
        has: async () => false,
        claimIfAbsent: async () => crypto.randomUUID(),
        release: async () => undefined,
        add: async () => undefined,
      },
      fetch: vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
        headers: { get: () => "application/json" },
      })),
    };

    const result = await runVendor(recipe, ctx, {
      network: strategy,
      html: strategy,
      dom: strategy,
    } as StrategyMap);

    expect(fetched).toEqual(["current"]);
    expect(result.documents.map((document) => document.vendorInvoiceId)).toEqual(["current"]);
    expect(result.syncWindow).toMatchObject({
      matched: 1,
      skippedBefore: 1,
      skippedAfter: 0,
      skippedUndated: 1,
      complete: false,
    });
  });
});

function testRecipe(): VendorRecipe {
  return {
    id: "vendor",
    name: "Vendor",
    homepage: "https://vendor.example",
    hosts: ["https://vendor.example/*"],
    auth: {
      check: { request: { url: "https://vendor.example/me" }, expect: { statusIn: [200] } },
      loginUrl: "https://vendor.example/login",
    },
    invoices: {
      strategy: "network",
      list: {
        request: { url: "https://vendor.example/invoices" },
        items: "items",
        map: { id: "id", issuedAt: "issuedAt", documentUrl: "pdf" },
      },
      document: { contentType: "application/pdf" },
    },
  };
}
