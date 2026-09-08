import { describe, expect, it } from "vitest";
import { isTransientRetryCode, nextTransientRetryAt } from "../../collector/src/platform/retry-policy";

describe("Collector transient retry policy", () => {
  const now = Date.parse("2026-07-17T08:00:00.000Z");

  it("uses bounded 5 minute, 30 minute, and 2 hour delays", () => {
    expect(nextTransientRetryAt("unknown", 1, now)).toBe(now + 5 * 60_000);
    expect(nextTransientRetryAt("unknown", 2, now)).toBe(now + 30 * 60_000);
    expect(nextTransientRetryAt("destination_unavailable", 3, now)).toBe(now + 2 * 60 * 60_000);
    expect(nextTransientRetryAt("destination_unavailable", 100, now)).toBe(now + 2 * 60 * 60_000);
  });

  it("does not automatically retry failures requiring user or recipe changes", () => {
    expect(isTransientRetryCode("unknown")).toBe(true);
    expect(nextTransientRetryAt("auth_expired", 1, now)).toBeUndefined();
    expect(nextTransientRetryAt("rate_limited", 1, now)).toBeUndefined();
    expect(nextTransientRetryAt("recipe_incompatible", 1, now)).toBeUndefined();
    expect(nextTransientRetryAt("document_invalid", 1, now)).toBeUndefined();
  });
});
