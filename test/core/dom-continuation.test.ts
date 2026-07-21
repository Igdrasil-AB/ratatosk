import { describe, expect, it } from "vitest";
import {
  DOM_CONTINUATION_LABEL_PATTERN,
  normalizeDomContinuation,
  safeContinuationUrl,
} from "../../collector/src/platform/dom-continuation";

describe("bounded DOM continuation policy", () => {
  it("accepts exact-origin pagination URLs without exposing them to recipe storage", () => {
    const origin = "https://vendor.example";
    expect(safeContinuationUrl(`${origin}/account/billing?page=2`, origin)).toBe(`${origin}/account/billing?page=2`);
    expect(safeContinuationUrl(`${origin}/account/billing?after=opaque-cursor`, origin)).toBe(`${origin}/account/billing?after=opaque-cursor`);
  });

  it("rejects cross-origin, credential-bearing, fragment, and non-pagination navigation", () => {
    const origin = "https://vendor.example";
    expect(safeContinuationUrl("https://attacker.example/account/billing?page=2", origin)).toBeUndefined();
    expect(safeContinuationUrl(`${origin}/account/billing?token=secret`, origin)).toBeUndefined();
    expect(safeContinuationUrl(`${origin}/settings/team?page=2`, origin)).toBeUndefined();
    expect(safeContinuationUrl(`${origin}/account/billing?page=2#payment`, origin)).toBeUndefined();
  });

  it("caps every continuation dimension", () => {
    expect(normalizeDomContinuation({
      mode: "auto",
      maxActions: 999,
      maxDocuments: 9999,
      timeoutMs: 999999,
      allowScroll: true,
    })).toEqual({ mode: "auto", maxActions: 12, maxDocuments: 500, timeoutMs: 60_000, allowScroll: true });
  });

  it("recognizes bounded pagination labels across common supplier locales", () => {
    const pattern = new RegExp(DOM_CONTINUATION_LABEL_PATTERN, "i");
    expect(pattern.test("Load more invoices")).toBe(true);
    expect(pattern.test("Visa fler fakturor")).toBe(true);
    expect(pattern.test("Nächste Seite")).toBe(true);
    expect(pattern.test("Afficher plus de factures")).toBe(true);
    expect(pattern.test("Mostrar más facturas")).toBe(true);
    expect(pattern.test("Pay invoice")).toBe(false);
    expect(pattern.test("Cancel subscription")).toBe(false);
  });
});
