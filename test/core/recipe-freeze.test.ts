import { describe, expect, it } from "vitest";
import { MAX_CONFIG_OPTIONS, validateRecipe } from "../../src/core/schema";
import { defineVendor } from "../../src/vendors/define";
import { ALL_VENDORS, EXPERIMENTAL_VENDORS, VENDORS } from "../../src/vendors";
import type { VendorRecipe } from "../../src/core/types";

/**
 * The recipe freeze (see `src/core/schema.ts`): recipes are declarative DATA,
 * never code. These tests are the enforcement contract that keeps the packaged
 * recipe vocabulary narrow; a future schema change that loosens the freeze must
 * break one of these.
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

  it("bounds the number of configuration dimensions", () => {
    const r = base();
    r.config = Array.from({ length: MAX_CONFIG_OPTIONS + 1 }, (_, index) => ({
      id: `scope${index}`,
      discover: { request: { url: "https://acme.example/scopes" }, value: "id" },
    }));
    expect(() => validateRecipe(r)).toThrow(/config/i);
  });

  it("rejects token and configuration names the template renderer cannot resolve", () => {
    const badToken = base();
    (badToken.auth as any).token = {
      request: { url: "https://acme.example/api/token" },
      value: "accessToken",
      as: "access-token",
    };
    expect(() => validateRecipe(badToken)).toThrow(/template variable/i);

    const badConfig = base();
    badConfig.config = [{
      id: "account-id",
      discover: { request: { url: "https://acme.example/accounts" }, value: "id" },
    }];
    expect(() => validateRecipe(badConfig)).toThrow(/template variable/i);
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

  it("REJECTS unsafe regex constructs over supplier-controlled values", () => {
    for (const pattern of ["^(a+)+$", "^(a|aa)+$", "(a)\\1", "a(?=b)"]) {
      const r = withTotalTransforms(base(), [{ kind: "regex", pattern }]);
      expect(() => validateRecipe(r)).toThrow(/safe regular expression/i);
    }
  });

  it("REJECTS an unsafe whole-page row regex", () => {
    const r = base();
    r.invoices = {
      strategy: "html",
      list: {
        request: { url: "https://acme.example/billing" },
        rowRegex: "^(?<documentUrl>(a+)+)$",
        map: { id: "documentUrl", documentUrl: "documentUrl" },
      },
      document: {},
    };

    expect(() => validateRecipe(r)).toThrow(/safe regular expression/i);
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

  it("REJECTS vacuous authentication predicates", () => {
    for (const expectPredicate of [{ and: [] }, { or: [] }]) {
      const r = base();
      (r.auth as any).check.expect = expectPredicate;
      expect(() => validateRecipe(r)).toThrow(/at least/i);
    }
  });

  it("deep-freezes registered recipes and registry arrays", () => {
    const recipe = defineVendor(withTotalTransforms(base(), [{ kind: "trim" }]) as any);
    const list = (recipe.invoices as any).list;
    expect(Object.isFrozen(recipe)).toBe(true);
    expect(Object.isFrozen(recipe.hosts)).toBe(true);
    expect(Object.isFrozen(recipe.auth.check.request)).toBe(true);
    expect(Object.isFrozen(recipe.invoices)).toBe(true);
    expect(Object.isFrozen(list.map)).toBe(true);
    expect(Object.isFrozen(list.map.total.transforms)).toBe(true);
    expect(Object.isFrozen(list.map.total.transforms[0])).toBe(true);
    expect(() => (recipe.hosts as string[]).push("https://attacker.example/*")).toThrow();
    expect(() => { (recipe.auth.check.request as any).url = "https://attacker.example"; }).toThrow();
    expect(() => { list.map.id = "attackerId"; }).toThrow();
    expect(() => list.map.total.transforms.push({ kind: "lower" })).toThrow();
    expect(() => { list.map.total.transforms[0].kind = "lower"; }).toThrow();
    expect(Object.isFrozen(VENDORS)).toBe(true);
    expect(Object.isFrozen(EXPERIMENTAL_VENDORS)).toBe(true);
    expect(Object.isFrozen(ALL_VENDORS)).toBe(true);
    expect(() => (VENDORS as VendorRecipe[]).push(recipe)).toThrow();
    expect(() => (EXPERIMENTAL_VENDORS as VendorRecipe[]).splice(0, 1)).toThrow();
    expect(() => { (ALL_VENDORS as VendorRecipe[])[0] = recipe; }).toThrow();
  });
});
