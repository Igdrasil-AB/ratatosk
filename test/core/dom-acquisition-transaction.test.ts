import { afterEach, describe, expect, it, vi } from "vitest";
import { runVendor, streamVendor } from "../../src/core/engine";
import { makeDomStrategy, type DomDriver } from "../../src/core/strategies/dom";
import { idempotencyKey } from "../../src/core/dedup";
import type { FetchedDocument, SeenStore, VendorRecipe } from "../../src/core/types";
import { FilesystemSink } from "../../collector/src/platform/filesystem-sink";
import { createIgdrasilSink } from "../../src/ingest/igdrasil-sink";

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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

  it("activates once across repeated filesystem delivery runs", async () => {
    const downloads: chrome.downloads.DownloadOptions[] = [];
    const storage: Record<string, unknown> = {};
    vi.stubGlobal("chrome", {
      runtime: {},
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
          set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(storage, items); }),
        },
      },
      downloads: {
        download: vi.fn((options: chrome.downloads.DownloadOptions, callback: (id: number) => void) => {
          downloads.push(options);
          callback(downloads.length);
        }),
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
        search: vi.fn((_query: unknown, callback: (items: Array<{ state: string }>) => void) => {
          callback([{ state: "complete" }]);
        }),
      },
    });
    const sink = new FilesystemSink({ rootFolder: "Ratatosk-test", dateMode: "extraction" });

    const proof = await runRepeatedDelivery(async (document) => {
      const result = await sink.send(document);
      expect(result.accepted).toBe(true);
    });

    expect(proof.resolve).toHaveBeenCalledOnce();
    expect(downloads).toHaveLength(1);
  });

  it("activates once across repeated Igdrasil delivery runs", async () => {
    const upload = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ document_id: "document-1" }),
    } as unknown as Response);
    const sink = createIgdrasilSink({
      baseUrl: "https://accounting.igdrasil.se",
      companyId: "company",
      getToken: async () => "rat_".padEnd(68, "a"),
    });

    const proof = await runRepeatedDelivery(async (document) => {
      const result = await sink.send(document);
      expect(result.accepted).toBe(true);
    });

    expect(proof.resolve).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledOnce();
  });
});

async function runRepeatedDelivery(
  send: (document: FetchedDocument) => Promise<void>,
): Promise<{ resolve: ReturnType<typeof vi.fn> }> {
  const vendorInvoiceId = "semantic-stable-invoice-destination";
  const resolve = vi.fn(async () => ({
    kind: "bytes" as const,
    bytes: new TextEncoder().encode("%PDF-1.7 transaction destination").buffer,
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
  const seen = inMemorySeenStore();
  const context = { companyId: "company", vars: {}, seen, fetch: vi.fn() };
  const emit = async (document: FetchedDocument): Promise<void> => {
    await send(document);
    await seen.add(document.contentIdempotencyKey, document.source);
    await seen.add(document.idempotencyKey, document.source);
  };

  await expect(streamVendor(
    recipe,
    context,
    { dom: strategy, network: strategy, html: strategy },
    emit,
  )).resolves.toMatchObject({ documentCount: 1 });
  await expect(streamVendor(
    recipe,
    context,
    { dom: strategy, network: strategy, html: strategy },
    emit,
  )).resolves.toMatchObject({ documentCount: 0 });
  return { resolve };
}

function inMemorySeenStore(): SeenStore {
  const accepted = new Set<string>();
  const reservations = new Map<string, string>();
  return {
    has: async (key) => accepted.has(key),
    isAccepted: async (key) => accepted.has(key),
    claimIfAbsent: async (key) => {
      if (accepted.has(key) || reservations.has(key)) return undefined;
      const reservation = crypto.randomUUID();
      reservations.set(key, reservation);
      return reservation;
    },
    release: async (key, reservation) => {
      if (reservations.get(key) === reservation) reservations.delete(key);
    },
    add: async (key) => {
      accepted.add(key);
      reservations.delete(key);
    },
  };
}
