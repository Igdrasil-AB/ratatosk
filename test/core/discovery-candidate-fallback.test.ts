import { describe, expect, it, vi } from "vitest";
import { collectFirstWorkingCandidate } from "../../collector/src/platform/discovery-candidates";
import { createDiscoveredSupplierCandidateSet, createDiscoveredSupplierProfile } from "../../src/core/discovery";
import type { VendorRecipe } from "../../src/core/types";

describe("discovered candidate fallback", () => {
  it("falls through candidate-local PDF failures and returns the first proven candidate", async () => {
    const candidates = set();
    const run = vi.fn()
      .mockResolvedValueOnce({ vendorId: candidates.id, status: "error", count: 0, code: "document_invalid" })
      .mockResolvedValueOnce({ vendorId: candidates.id, status: "ok", count: 2, retrieval: "complete", failedScopes: 0, emptyScopes: 0 });

    const result = await collectFirstWorkingCandidate(candidates, run);

    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.profile).toBe(candidates.candidates[1]);
    expect(result.outcomes).toEqual([
      { candidate: 1, adapter: "dom-links", result: "document_invalid", verifiedDocuments: 0 },
      { candidate: 2, adapter: "dom-links", result: "collected", verifiedDocuments: 2 },
    ]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not let an unclassified candidate failure suppress retained fallbacks", async () => {
    const candidates = set();
    const run = vi.fn()
      .mockResolvedValueOnce({ vendorId: candidates.id, status: "error", count: 0, code: "unknown" })
      .mockResolvedValueOnce({ vendorId: candidates.id, status: "ok", count: 1, retrieval: "complete", failedScopes: 0, emptyScopes: 0 });

    const result = await collectFirstWorkingCandidate(candidates, run);

    expect(result.kind).toBe("success");
    if (result.kind === "success") expect(result.profile).toBe(candidates.candidates[1]);
    expect(result.outcomes).toEqual([
      { candidate: 1, adapter: "dom-links", result: "unknown", verifiedDocuments: 0 },
      { candidate: 2, adapter: "dom-links", result: "collected", verifiedDocuments: 1 },
    ]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("normalizes an omitted failure code to candidate-local unknown", async () => {
    const candidates = set();
    const run = vi.fn()
      .mockResolvedValueOnce({ vendorId: candidates.id, status: "error", count: 0 })
      .mockResolvedValueOnce({ vendorId: candidates.id, status: "ok", count: 1, retrieval: "complete" });

    const result = await collectFirstWorkingCandidate(candidates, run);

    expect(result).toMatchObject({ kind: "success", attempted: 2 });
    expect(result.outcomes).toEqual([
      { candidate: 1, adapter: "dom-links", result: "unknown", verifiedDocuments: 0 },
      { candidate: 2, adapter: "dom-links", result: "collected", verifiedDocuments: 1 },
    ]);
  });

  it("does not treat plausible candidates as verified when every candidate returns no documents", async () => {
    const candidates = set();
    const run = vi.fn().mockResolvedValue({
      vendorId: candidates.id,
      status: "ok",
      count: 0,
      retrieval: "complete",
      failedScopes: 0,
      emptyScopes: 1,
    });

    const result = await collectFirstWorkingCandidate(candidates, run);

    expect(result.kind).toBe("exhausted");
    expect(result.outcomes).toEqual([
      { candidate: 1, adapter: "dom-links", result: "no_documents", verifiedDocuments: 0 },
      { candidate: 2, adapter: "dom-links", result: "no_documents", verifiedDocuments: 0 },
    ]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("continues to another retained candidate when an all-history date fallback still finds no document", async () => {
    const candidates = set();
    const run = vi.fn()
      .mockResolvedValueOnce({
        vendorId: candidates.id,
        status: "ok",
        count: 0,
        retrieval: "complete",
        code: "month_range_fallback_all",
      })
      .mockResolvedValueOnce({
        vendorId: candidates.id,
        status: "ok",
        count: 1,
        retrieval: "complete",
      });

    const result = await collectFirstWorkingCandidate(candidates, run);

    expect(result).toMatchObject({ kind: "success", attempted: 2 });
    expect(result.outcomes[0]).toEqual({
      candidate: 1,
      adapter: "dom-links",
      result: "month_range_fallback_all",
      verifiedDocuments: 0,
    });
  });

  it("carries bounded traversal evidence into candidate diagnostics", async () => {
    const candidates = set();
    const retrievalProof = {
      completeness: "complete" as const,
      termination: "explicit_end" as const,
      pagesVisited: 1,
      observedItems: 0,
      resolvedItems: 0,
      unresolvedItems: 0,
    };
    const run = vi.fn().mockResolvedValue({
      vendorId: candidates.id,
      status: "ok",
      count: 0,
      retrieval: "complete",
      retrievalProof,
      failedScopes: 0,
      emptyScopes: 1,
    });

    const result = await collectFirstWorkingCandidate(candidates, run);

    expect(result.outcomes[0]).toEqual({
      candidate: 1,
      adapter: "dom-links",
      result: "no_documents",
      verifiedDocuments: 0,
      retrieval: {
        termination: "explicit_end",
        pagesVisited: 1,
        observedItems: 0,
        resolvedItems: 0,
        unresolvedItems: 0,
      },
    });
  });

  it("carries a closed failure stage and cause into candidate diagnostics", async () => {
    const candidates = set();
    const run = vi.fn().mockResolvedValue({
      vendorId: candidates.id,
      status: "error",
      count: 0,
      code: "recipe_incompatible",
      failure: {
        stage: "document_fetch",
        cause: "unexpected_response",
        httpStatus: 403,
      },
    });

    const result = await collectFirstWorkingCandidate(candidates, run);

    expect(result.outcomes[0]).toEqual({
      candidate: 1,
      adapter: "dom-links",
      result: "recipe_incompatible",
      verifiedDocuments: 0,
      failure: {
        stage: "document_fetch",
        cause: "unexpected_response",
        httpStatus: 403,
      },
    });
  });

  it("accepts one invoice when its retrieval path is complete", async () => {
    const candidates = set();
    const run = vi.fn().mockResolvedValue({
      vendorId: candidates.id,
      status: "ok",
      count: 1,
      retrieval: "complete",
      failedScopes: 0,
      emptyScopes: 0,
    });

    const result = await collectFirstWorkingCandidate(candidates, run);

    expect(result).toMatchObject({ kind: "success", attempted: 1 });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("continues after a non-empty but incomplete retrieval without delivering from it", async () => {
    const candidates = set();
    const run = vi.fn()
      .mockResolvedValueOnce({
        vendorId: candidates.id,
        status: "error",
        count: 0,
        retrieval: "partial",
        code: "retrieval_incomplete",
      })
      .mockResolvedValueOnce({
        vendorId: candidates.id,
        status: "ok",
        count: 1,
        retrieval: "complete",
        failedScopes: 0,
        emptyScopes: 0,
      });

    const result = await collectFirstWorkingCandidate(candidates, run);

    expect(result).toMatchObject({ kind: "success", attempted: 2 });
    expect(result.outcomes).toEqual([
      { candidate: 1, adapter: "dom-links", result: "retrieval_incomplete", verifiedDocuments: 0 },
      { candidate: 2, adapter: "dom-links", result: "collected", verifiedDocuments: 1 },
    ]);
  });

  it("never falls through after a document was durably delivered", async () => {
    const candidates = set();
    const run = vi.fn().mockResolvedValue({
      vendorId: candidates.id,
      status: "partial",
      count: 1,
      code: "destination_unavailable",
    });

    const result = await collectFirstWorkingCandidate(candidates, run);

    expect(result).toMatchObject({ kind: "success", attempted: 1 });
    expect(run).toHaveBeenCalledTimes(1);
  });

  for (const failure of [
    { status: "error", code: "destination_unavailable" },
    { status: "error", code: "connection_persistence_failed" },
    { status: "auth_expired", code: "auth_expired" },
    { status: "rate_limited", code: "rate_limited" },
  ] as const) {
    it(`stops immediately on the global ${failure.code} outcome`, async () => {
      const candidates = set();
      const run = vi.fn().mockResolvedValue({
        vendorId: candidates.id,
        status: failure.status,
        count: 0,
        code: failure.code,
      });

      const result = await collectFirstWorkingCandidate(candidates, run);

      expect(result).toMatchObject({ kind: "fatal", attempted: 1 });
      expect(run).toHaveBeenCalledTimes(1);
    });
  }

  for (const code of ["destination_unavailable", "connection_persistence_failed"] as const) {
    it(`preserves and stops on partial zero-document ${code}`, async () => {
      const candidates = set();
      const run = vi.fn().mockResolvedValue({
        vendorId: candidates.id,
        status: "partial",
        count: 0,
        verifiedCount: 0,
        code,
      });

      const result = await collectFirstWorkingCandidate(candidates, run);

      expect(result).toMatchObject({ kind: "fatal", attempted: 1 });
      expect(result.outcomes).toEqual([
        { candidate: 1, adapter: "dom-links", result: code, verifiedDocuments: 0 },
      ]);
      expect(run).toHaveBeenCalledTimes(1);
    });
  }
});

function set() {
  const first = profile("https://vendor.example/billing", "dom-links");
  const second = profile("https://vendor.example/receipts", "dom-links");
  return createDiscoveredSupplierCandidateSet([first, second]);
}

function profile(page: string, adapterId: "dom-links") {
  return createDiscoveredSupplierProfile({
    primaryOrigin: "https://vendor.example",
    entryUrl: page,
    displayName: "Vendor",
    nameSource: "domain",
    nameConfidence: "low",
    adapterId,
    candidateCount: 2,
    recipe: recipe(page),
  });
}

function recipe(page: string): VendorRecipe {
  return {
    id: "candidate",
    name: "Vendor",
    homepage: "https://vendor.example",
    hosts: ["https://vendor.example/*"],
    fetchContext: "page",
    auth: { check: { request: { url: page }, expect: { statusIn: [200] } }, loginUrl: "https://vendor.example" },
    invoices: {
      strategy: "dom",
      list: {
        open: page,
        steps: [{ action: "extractAll", selector: 'a[href$=".pdf"]', attr: "href", as: "documents" }],
        hrefsFrom: "documents",
      },
      document: { contentType: "application/pdf" },
    },
  };
}
