import { describe, expect, it } from "vitest";
import { validateRecipe } from "../../src/core/schema";

/**
 * The recipe freeze (see `src/core/schema.ts`): recipes are declarative DATA,
 * never code. These tests are the enforcement contract that keeps the hot-loaded
 * recipe catalog on the allowed side of Chrome's remote-code policy — a future
 * schema change that loosens the freeze must break one of these.
 */

// A minimal valid network recipe we mutate to probe each guardrail.
function base(): Record<string, unknown> {
  return {
    id: "acme",
    name: "Acme",
    homepage: "https://acme.example",
    hosts: ["https://acme.example/*"],
    auth: {
      check: { request: { url: "https://acme.example/api/me" }, expect: { statusIn: [200] } },
      loginUrl: "https://acme.example/login",
    },
    invoices: {
      strategy: "network",
      list: {
        request: { url: "https://acme.example/api/invoices" },
        items: "invoices",
        map: { id: "id" },
      },
      document: {},
    },
  };
}

// Reach into invoices.list.map.total to attach a transform pipeline under test.
function withTotalTransforms(r: Record<string, unknown>, transforms: unknown): Record<string, unknown> {
  (r.invoices as any).list.map.total = { path: "total", transforms };
  return r;
}

describe("recipe freeze — recipes are declarative data, never code", () => {
  it("accepts the base declarative recipe", () => {
    expect(() => validateRecipe(base())).not.toThrow();
  });

  it("accepts the fixed, closed transform vocabulary", () => {
    const r = withTotalTransforms(base(), [{ kind: "divide", by: 100 }, { kind: "upper" }]);
    expect(() => validateRecipe(r)).not.toThrow();
  });

  it("REJECTS an unknown top-level field (no smuggled script/code)", () => {
    const r = base();
    r.script = "fetch('https://evil.example')";
    expect(() => validateRecipe(r)).toThrow(/script/i);
  });

  it("REJECTS an unknown field on a nested object (strict everywhere)", () => {
    const r = base();
    (r.invoices as any).list.request.eval = "x";
    expect(() => validateRecipe(r)).toThrow();
  });

  it("REJECTS an unknown transform kind (closed enum)", () => {
    const r = withTotalTransforms(base(), [{ kind: "exec", cmd: "rm -rf /" }]);
    expect(() => validateRecipe(r)).toThrow();
  });

  it("REJECTS a non-compiling regex pattern", () => {
    const r = withTotalTransforms(base(), [{ kind: "regex", pattern: "(" }]);
    expect(() => validateRecipe(r)).toThrow();
  });

  it("REJECTS an over-long pattern (bounded, not an interpreter)", () => {
    const r = withTotalTransforms(base(), [{ kind: "replace", pattern: "a".repeat(500), with: "b" }]);
    expect(() => validateRecipe(r)).toThrow();
  });

  it("REJECTS an over-long transform pipeline", () => {
    const many = Array.from({ length: 12 }, () => ({ kind: "trim" }));
    const r = withTotalTransforms(base(), many);
    expect(() => validateRecipe(r)).toThrow();
  });
});
