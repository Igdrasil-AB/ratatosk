import { describe, expect, it } from "vitest";
import { isSafeStaticDiscoveryQueryValue } from "../../src/core/discovery-query";

describe("discovery request URL replay", () => {
  it("recognizes the bounded static query controls a discovered recipe may replay", () => {
    expect(isSafeStaticDiscoveryQueryValue("limit", "100")).toBe(true);
    expect(isSafeStaticDiscoveryQueryValue("status", "paid")).toBe(true);
    expect(isSafeStaticDiscoveryQueryValue("page", "2")).toBe(true);
  });

  it("does not recognize unknown keys or unbounded values as static controls", () => {
    expect(isSafeStaticDiscoveryQueryValue("account_id", "123456789")).toBe(false);
    expect(isSafeStaticDiscoveryQueryValue("token", "secret-value")).toBe(false);
    expect(isSafeStaticDiscoveryQueryValue("limit", "1".repeat(33))).toBe(false);
  });
});
