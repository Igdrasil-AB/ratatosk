import { describe, expect, it } from "vitest";
import { createRetrievalProof } from "../../src/core/retrieval";

describe("retrieval completeness", () => {
  it("allows a single resolved invoice to be a complete retrieval", () => {
    expect(createRetrievalProof({
      termination: "explicit_end",
      pagesVisited: 1,
      observedItems: 1,
      resolvedItems: 1,
      unresolvedItems: 0,
    })).toMatchObject({ completeness: "complete", resolvedItems: 1 });
  });

  it("allows a genuinely empty path when traversal reaches its end", () => {
    expect(createRetrievalProof({
      termination: "stable_end",
      pagesVisited: 1,
      observedItems: 0,
      resolvedItems: 0,
      unresolvedItems: 0,
    })).toMatchObject({ completeness: "complete", resolvedItems: 0 });
  });

  it("does not call a capped or unresolved path complete regardless of count", () => {
    expect(createRetrievalProof({
      termination: "page_cap",
      pagesVisited: 20,
      observedItems: 20,
      resolvedItems: 20,
      unresolvedItems: 0,
    }).completeness).toBe("partial");
    expect(createRetrievalProof({
      termination: "explicit_end",
      pagesVisited: 1,
      observedItems: 3,
      resolvedItems: 2,
      unresolvedItems: 1,
    }).completeness).toBe("partial");
  });

  it("does not call contradictory item counts complete", () => {
    expect(createRetrievalProof({
      termination: "explicit_end",
      pagesVisited: 1,
      observedItems: 1,
      resolvedItems: 2,
      unresolvedItems: 0,
    })).toMatchObject({
      completeness: "partial",
      observedItems: 1,
      resolvedItems: 0,
      unresolvedItems: 1,
    });
  });

  it("normalizes impossible counts to a coherent conservative partition", () => {
    for (const proof of [
      createRetrievalProof({
        termination: "explicit_end",
        pagesVisited: 1,
        observedItems: 1,
        resolvedItems: 1,
        unresolvedItems: 10_000,
      }),
      createRetrievalProof({
        termination: "explicit_end",
        pagesVisited: 1,
        observedItems: 4,
        resolvedItems: 3,
        unresolvedItems: 2,
      }),
    ]) {
      expect(proof.completeness).toBe("partial");
      expect(proof.resolvedItems + proof.unresolvedItems).toBe(proof.observedItems);
      expect(proof.resolvedItems).toBe(0);
    }
  });

  it("treats invalid or capped source counts as partial even when display counts clamp", () => {
    for (const metrics of [
      { observedItems: 2, resolvedItems: 2, unresolvedItems: -1 },
      { observedItems: 10_001, resolvedItems: 10_000, unresolvedItems: 0 },
    ]) {
      expect(createRetrievalProof({
        termination: "explicit_end",
        pagesVisited: 1,
        ...metrics,
      })).toMatchObject({ completeness: "partial", unresolvedItems: expect.any(Number) });
    }
  });
});
