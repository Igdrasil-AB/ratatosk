import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VendorRecipe } from "../../src/core/types";

const runtime = vi.hoisted(() => ({
  fetch: vi.fn(),
  dispose: vi.fn(async () => undefined),
  list: vi.fn(),
}));

vi.mock("../../collector/src/platform/runtime", () => ({
  buildRunContext: vi.fn(() => ({
    ctx: {
      companyId: "discovery-preview",
      vars: {},
      seen: { has: vi.fn(), claimIfAbsent: vi.fn(), release: vi.fn(), add: vi.fn() },
      fetch: runtime.fetch,
    },
    dispose: runtime.dispose,
  })),
  buildStrategies: vi.fn(() => ({
    dom: { list: runtime.list },
  })),
}));

import { previewCandidate } from "../../collector/src/platform/discovery";

const recipe: VendorRecipe = {
  id: "discovered-candidate",
  name: "GitHub",
  homepage: "https://github.com",
  hosts: ["https://github.com/*"],
  category: "discovered",
  fetchContext: "page",
  auth: {
    check: { request: { url: "https://github.com/account/billing/history" }, expect: { statusIn: [200] } },
    loginUrl: "https://github.com",
  },
  invoices: {
    strategy: "dom",
    list: {
      open: "https://github.com/account/billing/history",
      steps: [{ action: "extractAll", selector: 'a[href*="/account/receipt/"]', attr: "href", as: "documents" }],
      continuation: { mode: "auto", maxActions: 8, maxDocuments: 500, timeoutMs: 30_000, allowScroll: true },
      hrefsFrom: "documents",
    },
    document: { contentType: "application/pdf" },
  },
};

describe("candidate preview", () => {
  beforeEach(() => {
    runtime.fetch.mockReset();
    runtime.fetch.mockRejectedValue(new Error("page GET is unavailable"));
    runtime.list.mockReset();
    runtime.list.mockResolvedValue({
      refs: [{
        vendorInvoiceId: "ch_example",
        issuedAt: "",
        documentUrl: "https://github.com/account/receipt/ch_example",
      }],
      retrieval: {
        completeness: "complete",
        termination: "explicit_end",
        pagesVisited: 1,
        observedItems: 1,
        resolvedItems: 1,
        unresolvedItems: 0,
      },
    });
  });

  it("verifies a DOM candidate through its on-page document listing without a redundant page GET", async () => {
    await expect(previewCandidate(recipe)).resolves.toMatchObject({ count: 1 });
    expect(runtime.fetch).not.toHaveBeenCalled();
    expect(runtime.list).toHaveBeenCalledOnce();
    const previewRecipe = runtime.list.mock.calls[0][0] as VendorRecipe;
    expect(previewRecipe.invoices.strategy === "dom" ? previewRecipe.invoices.list.continuation : undefined).toBeUndefined();
  });
});
