import { describe, expect, it, vi } from "vitest";
import { streamVendor, type StrategyMap } from "../../src/core/engine";
import { DocumentPermissionRequired, RateLimited, RetrievalIncomplete } from "../../src/core/errors";
import { createInvoiceListResult } from "../../src/core/retrieval";
import type { InvoiceRef, RunContext, VendorRecipe } from "../../src/core/types";

const recipe: VendorRecipe = {
  id: "stream-test",
  name: "Stream Test",
  homepage: "https://vendor.example",
  hosts: ["https://vendor.example/*"],
  auth: { check: { request: { url: "https://vendor.example/session" }, expect: { statusIn: [200] } }, loginUrl: "https://vendor.example" },
  invoices: {
    strategy: "network",
    list: { request: { url: "https://vendor.example/invoices" }, items: "items", map: { id: "id", documentUrl: "url" } },
    document: { contentType: "application/pdf" },
  },
};

describe("streaming vendor engine", () => {
  it("fetches a bounded batch concurrently but emits in stable source order", async () => {
    const order: string[] = [];
    let active = 0;
    let maximum = 0;
    const strategy = {
      list: vi.fn(async () => completeList(Array.from({ length: 5 }, (_, index) => ({
        vendorInvoiceId: `invoice-${index + 1}`,
        issuedAt: "",
        documentUrl: `https://vendor.example/${index + 1}.pdf`,
      })))),
      fetchDocument: vi.fn(async (_recipe: VendorRecipe, ref: { vendorInvoiceId: string }) => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, ref.vendorInvoiceId === "invoice-1" ? 20 : 1));
        active--;
        return { bytes: new TextEncoder().encode(`%PDF ${ref.vendorInvoiceId}`).buffer, contentType: "application/pdf", filename: `${ref.vendorInvoiceId}.pdf` };
      }),
    };
    const strategies = { network: strategy, html: strategy, dom: strategy } as StrategyMap;

    const result = await streamVendor(recipe, context(), strategies, async (document) => {
      order.push(`emit:${document.vendorInvoiceId}`);
    });

    expect(maximum).toBe(3);
    expect(order).toEqual([
      "emit:invoice-1", "emit:invoice-2", "emit:invoice-3", "emit:invoice-4", "emit:invoice-5",
    ]);
    expect(result.documentCount).toBe(5);
    expect(result.scopes.failed).toBe(0);
  });

  it("continues sibling document downloads after one local document failure", async () => {
    const strategy = {
      list: vi.fn(async () => completeList(Array.from({ length: 3 }, (_, index) => ({
        vendorInvoiceId: `invoice-${index + 1}`,
        issuedAt: "",
        documentUrl: `https://vendor.example/${index + 1}.pdf`,
      })))),
      fetchDocument: vi.fn(async (_recipe: VendorRecipe, ref: { vendorInvoiceId: string }) => {
        if (ref.vendorInvoiceId === "invoice-2") throw new Error("one stale document");
        return { bytes: new TextEncoder().encode(`%PDF ${ref.vendorInvoiceId}`).buffer, contentType: "application/pdf", filename: `${ref.vendorInvoiceId}.pdf` };
      }),
    };
    const strategies = { network: strategy, html: strategy, dom: strategy } as StrategyMap;
    const emitted: string[] = [];

    const result = await streamVendor(recipe, context(), strategies, async (document) => {
      emitted.push(document.vendorInvoiceId);
    });

    expect(emitted).toEqual(["invoice-1", "invoice-3"]);
    expect(result.documentCount).toBe(2);
    expect(result.retrieval).toBe("complete");
    expect(result.scopes.succeeded).toBe(0);
    expect(result.scopes.failed).toBe(1);
  });

  it("emits identical PDF bytes only once even when supplier identities drift", async () => {
    const bytes = new TextEncoder().encode("%PDF exact invoice").buffer;
    const strategy = {
      list: vi.fn(async () => completeList([
        { vendorInvoiceId: "old-signed-url", issuedAt: "", documentUrl: "https://vendor.example/old.pdf" },
        { vendorInvoiceId: "new-signed-url", issuedAt: "", documentUrl: "https://vendor.example/new.pdf" },
      ])),
      fetchDocument: vi.fn(async () => ({ bytes, contentType: "application/pdf", filename: "invoice.pdf" })),
    };
    const strategies = { network: strategy, html: strategy, dom: strategy } as StrategyMap;
    const emitted: string[] = [];

    const result = await streamVendor(recipe, context(), strategies, async (document) => {
      emitted.push(document.vendorInvoiceId);
    });

    expect(emitted).toEqual(["old-signed-url"]);
    expect(result.documentCount).toBe(1);
  });

  it("reserves every stable identity alias before concurrent document retrieval", async () => {
    const fetchDocument = vi.fn(async (_recipe: VendorRecipe, ref: { vendorInvoiceId: string }) => ({
      bytes: new TextEncoder().encode(`%PDF ${ref.vendorInvoiceId}`).buffer,
      contentType: "application/pdf",
      filename: `${ref.vendorInvoiceId}.pdf`,
    }));
    const strategy = {
      list: vi.fn(async () => completeList([
        {
          vendorInvoiceId: "new-invoice-id",
          issuedAt: "",
          documentUrl: "https://vendor.example/new.pdf",
          identityAliases: ["legacy-invoice-id"],
        },
        {
          vendorInvoiceId: "legacy-invoice-id",
          issuedAt: "",
          documentUrl: "https://vendor.example/legacy.pdf",
        },
      ])),
      fetchDocument,
    };
    const strategies = { network: strategy, html: strategy, dom: strategy } as StrategyMap;
    const emitted: string[] = [];

    const result = await streamVendor(recipe, context(), strategies, async (document) => {
      emitted.push(document.vendorInvoiceId);
    });

    expect(fetchDocument).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual(["new-invoice-id"]);
    expect(result.documentCount).toBe(1);
  });

  it("does not swallow a destination emission failure as a scope failure", async () => {
    const strategy = {
      list: vi.fn(async () => completeList([{ vendorInvoiceId: "invoice-1", issuedAt: "", documentUrl: "https://vendor.example/1.pdf" }])),
      fetchDocument: vi.fn(async () => ({ bytes: new TextEncoder().encode("%PDF").buffer, contentType: "application/pdf", filename: "invoice.pdf" })),
    };
    const strategies = { network: strategy, html: strategy, dom: strategy } as StrategyMap;

    await expect(streamVendor(recipe, context(), strategies, async () => {
      throw new Error("destination unavailable");
    })).rejects.toThrow("destination unavailable");
  });

  it("atomically emits once across concurrent runs sharing a seen store", async () => {
    const strategy = {
      list: vi.fn(async () => completeList([{
        vendorInvoiceId: "shared-invoice",
        issuedAt: "",
        documentUrl: "https://vendor.example/shared.pdf",
      }])),
      fetchDocument: vi.fn(async () => ({
        bytes: new TextEncoder().encode("%PDF shared invoice").buffer,
        contentType: "application/pdf",
        filename: "shared.pdf",
      })),
    };
    const strategies = { network: strategy, html: strategy, dom: strategy } as StrategyMap;
    const accepted = new Set<string>();
    const reservations = new Map<string, string>();
    const seen: RunContext["seen"] = {
      has: async (key) => accepted.has(key) || reservations.has(key),
      claimIfAbsent: async (key) => {
        if (accepted.has(key) || reservations.has(key)) return undefined;
        const reservationId = `claim-${reservations.size + 1}`;
        reservations.set(key, reservationId);
        return reservationId;
      },
      release: async (key, reservationId) => {
        if (reservations.get(key) === reservationId) reservations.delete(key);
      },
      add: async (key) => { reservations.delete(key); accepted.add(key); },
    };
    const emit = vi.fn(async (document) => {
      await seen.add(document.idempotencyKey, document.source);
      await seen.add(document.contentIdempotencyKey, document.source);
    });
    const shared = { ...context(), seen };

    const results = await Promise.all([
      streamVendor(recipe, shared, strategies, emit),
      streamVendor(recipe, shared, strategies, emit),
    ]);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(strategy.fetchDocument).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.documentCount).sort()).toEqual([0, 1]);
  });

  it("repairs the primary seen key when accepted content survives a partial commit", async () => {
    const strategy = {
      list: vi.fn(async () => completeList([{
        vendorInvoiceId: "repair-invoice",
        issuedAt: "",
        documentUrl: "https://vendor.example/repair.pdf",
      }])),
      fetchDocument: vi.fn(async () => ({
        bytes: new TextEncoder().encode("%PDF repair invoice").buffer,
        contentType: "application/pdf",
        filename: "repair.pdf",
      })),
    };
    const strategies = { network: strategy, html: strategy, dom: strategy } as StrategyMap;
    const accepted = new Set<string>();
    const reservations = new Map<string, string>();
    const seen: RunContext["seen"] = {
      has: async (key) => accepted.has(key) || reservations.has(key),
      isAccepted: async (key) => accepted.has(key),
      claimIfAbsent: async (key) => {
        if (accepted.has(key) || reservations.has(key)) return undefined;
        const reservationId = `claim-${reservations.size + 1}`;
        reservations.set(key, reservationId);
        return reservationId;
      },
      release: async (key, reservationId) => {
        if (reservations.get(key) === reservationId) reservations.delete(key);
      },
      add: async (key) => { reservations.delete(key); accepted.add(key); },
    };
    const shared = { ...context(), seen };
    let primaryKey = "";
    const firstEmit = vi.fn(async (document) => {
      primaryKey = document.idempotencyKey;
      await seen.add(document.contentIdempotencyKey, document.source);
      throw new Error("primary seen unavailable");
    });

    await expect(streamVendor(recipe, shared, strategies, firstEmit)).rejects.toThrow("primary seen unavailable");
    expect(primaryKey).not.toBe("");
    expect(accepted.has(primaryKey)).toBe(false);

    const retryEmit = vi.fn();
    await expect(streamVendor(recipe, shared, strategies, retryEmit)).resolves.toMatchObject({ documentCount: 0 });
    expect(retryEmit).not.toHaveBeenCalled();
    expect(accepted.has(primaryKey)).toBe(true);

    await streamVendor(recipe, shared, strategies, retryEmit);
    expect(strategy.fetchDocument).toHaveBeenCalledTimes(2);
  });

  it("propagates provider permission drift instead of treating one invoice as stale", async () => {
    const permission = new DocumentPermissionRequired("stripe", [
      "https://stripe-upload-api.s3.eu-north-1.amazonaws.com/*",
    ]);
    const strategy = {
      list: vi.fn(async () => completeList([
        { vendorInvoiceId: "invoice-1", issuedAt: "", documentUrl: "https://pay.stripe.com/new/path" },
        { vendorInvoiceId: "invoice-2", issuedAt: "", documentUrl: "https://pay.stripe.com/other/path" },
      ])),
      fetchDocument: vi.fn(async () => { throw permission; }),
    };
    const strategies = { network: strategy, html: strategy, dom: strategy } as StrategyMap;

    await expect(streamVendor(recipe, context(), strategies, vi.fn())).rejects.toBe(permission);
  });

  it("aborts in-flight document retrieval after a fatal supplier failure", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const strategy = {
      list: vi.fn(async () => completeList([
        { vendorInvoiceId: "fatal", issuedAt: "", documentUrl: "https://vendor.example/fatal.pdf" },
        { vendorInvoiceId: "sibling-one", issuedAt: "", documentUrl: "https://vendor.example/one.pdf" },
        { vendorInvoiceId: "sibling-two", issuedAt: "", documentUrl: "https://vendor.example/two.pdf" },
      ])),
      fetchDocument: vi.fn(async (
        _recipe: VendorRecipe,
        ref: { vendorInvoiceId: string },
        _vars: Record<string, unknown>,
        _ctx: RunContext,
        signal?: AbortSignal,
      ) => {
        if (ref.vendorInvoiceId === "fatal") {
          await Promise.resolve();
          throw new RateLimited(1_000);
        }
        signals.push(signal);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          bytes: new TextEncoder().encode(`%PDF ${ref.vendorInvoiceId}`).buffer,
          contentType: "application/pdf",
          filename: `${ref.vendorInvoiceId}.pdf`,
        };
      }),
    };
    const strategies = { network: strategy, html: strategy, dom: strategy } as StrategyMap;

    await expect(streamVendor(recipe, context(), strategies, vi.fn())).rejects.toBeInstanceOf(RateLimited);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
  });

  it("never emits a fulfilled sibling from a batch containing a fatal rejection", async () => {
    let releaseFatal!: () => void;
    const fatalReady = new Promise<void>((resolve) => { releaseFatal = resolve; });
    const strategy = {
      list: vi.fn(async () => completeList([
        { vendorInvoiceId: "controlled-bytes", issuedAt: "", documentUrl: "https://vendor.example/bytes.pdf" },
        { vendorInvoiceId: "fatal", issuedAt: "", documentUrl: "https://vendor.example/fatal.pdf" },
      ])),
      fetchDocument: vi.fn(async (
        _recipe: VendorRecipe,
        ref: { vendorInvoiceId: string },
      ) => {
        if (ref.vendorInvoiceId === "fatal") {
          await fatalReady;
          throw new RateLimited(1_000);
        }
        // Fulfil first. The engine must still inspect the complete batch for a
        // fatal sibling before allowing this controlled document into the sink.
        releaseFatal();
        return {
          bytes: new TextEncoder().encode("%PDF controlled").buffer,
          contentType: "application/pdf",
          filename: "controlled.pdf",
        };
      }),
    };
    const strategies = { network: strategy, html: strategy, dom: strategy } as StrategyMap;
    const emit = vi.fn(async () => undefined);

    await expect(streamVendor(recipe, context(), strategies, emit)).rejects.toBeInstanceOf(RateLimited);
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not fetch or emit documents from an incomplete candidate path", async () => {
    const fetchDocument = vi.fn(async () => ({
      bytes: new TextEncoder().encode("%PDF").buffer,
      contentType: "application/pdf",
      filename: "invoice.pdf",
    }));
    const strategy = {
      list: vi.fn(async () => createInvoiceListResult([
        { vendorInvoiceId: "invoice-1", issuedAt: "", documentUrl: "https://vendor.example/1.pdf" },
      ], {
        termination: "page_cap",
        pagesVisited: 20,
        observedItems: 1,
        resolvedItems: 1,
        unresolvedItems: 0,
      })),
      fetchDocument,
    };
    const strategies = { network: strategy, html: strategy, dom: strategy } as StrategyMap;
    const emit = vi.fn(async () => undefined);

    await expect(streamVendor(recipe, context(), strategies, emit, {
      requireCompleteRetrieval: true,
    })).rejects.toBeInstanceOf(RetrievalIncomplete);
    expect(fetchDocument).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});

function completeList(refs: InvoiceRef[]) {
  return createInvoiceListResult(refs, {
    termination: "explicit_end",
    pagesVisited: 1,
    observedItems: refs.length,
    resolvedItems: refs.length,
    unresolvedItems: 0,
  });
}

function context(): RunContext {
  return {
    companyId: "company",
    vars: {},
    seen: { has: async () => false, claimIfAbsent: async () => "test-reservation", release: async () => undefined, add: async () => undefined },
    fetch: async () => ({
      status: 200,
      ok: true,
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: { get: () => "application/json" },
    }),
  };
}
