import { describe, expect, it, vi } from "vitest";
import { runVendor } from "../../src/core/engine";
import { makeDomStrategy, type DomDriver } from "../../src/core/strategies/dom";
import { idempotencyKey } from "../../src/core/dedup";
import type { VendorRecipe } from "../../src/core/types";

const recipe: VendorRecipe = {
  id: "transaction-test",
  name: "Transaction Test",
  homepage: "https://vendor.example",
  hosts: ["https://vendor.example/*"],
  auth: {
    check: {
      request: { url: "https://vendor.example/account" },
      expect: { statusIn: [200] },
    },
    loginUrl: "https://vendor.example/login",
  },
  invoices: {
    strategy: "dom",
    list: {
      open: "https://vendor.example/billing",
      steps: [{ action: "extractSemanticDownloads", as: "documents", maxActions: 8 }],
      hrefsFrom: "documents",
    },
    document: {},
  },
};

describe("DOM acquisition transaction", () => {
  it("reserves the stable supplier identity before activating its document control", async () => {
    const events: string[] = [];
    const driver: DomDriver = {
      run: vi.fn(async () => {
        return {
          collected: { documents: [] },
          actions: [{
            vendorInvoiceId: "semantic-stable-invoice-1",
            handle: "run-scoped-handle",
          }],
          retrieval: {
            completeness: "complete" as const,
            termination: "explicit_end" as const,
            pagesVisited: 1,
            observedItems: 1,
            resolvedItems: 1,
            unresolvedItems: 0,
          },
        };
      }),
      resolve: vi.fn(async () => {
        events.push("document-action");
        return {
          kind: "bytes" as const,
          bytes: new TextEncoder().encode("%PDF-1.7 transaction").buffer,
          contentType: "application/pdf",
        };
      }),
      download: vi.fn(async () => ({
        bytes: new TextEncoder().encode("%PDF-1.7 direct").buffer,
        contentType: "application/pdf",
      })),
    };
    const strategy = makeDomStrategy(driver);

    await runVendor(recipe, {
      companyId: "company",
      vars: {},
      seen: {
        has: async () => false,
        claimIfAbsent: async () => {
          events.push("identity-claim");
          return crypto.randomUUID();
        },
        release: async () => undefined,
        add: async () => undefined,
      },
      fetch: vi.fn(),
    }, { dom: strategy, network: strategy, html: strategy });

    expect(events.indexOf("identity-claim")).toBeLessThan(events.indexOf("document-action"));
    expect(driver.resolve).toHaveBeenCalledOnce();
    expect(driver.download).not.toHaveBeenCalled();
  });

  it("does not activate an already accepted semantic identity on a later sync", async () => {
    const vendorInvoiceId = "semantic-stable-invoice-1";
    const acceptedKey = await idempotencyKey(
      "company",
      `ext:${recipe.id}`,
      vendorInvoiceId,
    );
    let accepted = false;
    const resolve = vi.fn(async () => ({
      kind: "bytes" as const,
      bytes: new TextEncoder().encode("%PDF-1.7 transaction").buffer,
      contentType: "application/pdf",
    }));
    const driver: DomDriver = {
      run: vi.fn(async () => ({
        collected: { documents: [] },
        actions: [{ vendorInvoiceId, handle: crypto.randomUUID() }],
        retrieval: {
          completeness: "complete" as const,
          termination: "explicit_end" as const,
          pagesVisited: 1,
          observedItems: 1,
          resolvedItems: 1,
          unresolvedItems: 0,
        },
      })),
      resolve,
      download: vi.fn(),
    };
    const strategy = makeDomStrategy(driver);
    const context = {
      companyId: "company",
      vars: {},
      seen: {
        has: async (key: string) => accepted && key === acceptedKey,
        claimIfAbsent: async () => crypto.randomUUID(),
        release: async () => undefined,
        add: async () => undefined,
      },
      fetch: vi.fn(),
    };

    await runVendor(recipe, context, { dom: strategy, network: strategy, html: strategy });
    expect(resolve).toHaveBeenCalledOnce();

    accepted = true;
    await runVendor(recipe, context, { dom: strategy, network: strategy, html: strategy });
    expect(resolve).toHaveBeenCalledOnce();
  });
});
