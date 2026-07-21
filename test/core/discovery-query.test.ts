import { describe, expect, it } from "vitest";
import { restoreSafeStaticQueryValues } from "../../src/core/discovery-query";

describe("discovery request URL replay", () => {
  it("restores only policy-approved static query values after capture sanitization", () => {
    expect(restoreSafeStaticQueryValues(
      "https://vendor.example/api/invoices?limit=100&status=paid&account_id=123456789&token=secret-value#fragment",
      "https://vendor.example/api/invoices?limit=REDACTED&status=REDACTED&account_id=REDACTED&token=REDACTED",
    )).toBe(
      "https://vendor.example/api/invoices?limit=100&status=paid&account_id=REDACTED&token=REDACTED",
    );
  });

  it("does not restore long, malformed, or unknown query values", () => {
    expect(restoreSafeStaticQueryValues(
      `https://vendor.example/api/invoices?limit=${"1".repeat(33)}&filter=paid`,
      "https://vendor.example/api/invoices?limit=REDACTED&filter=REDACTED",
    )).toBe("https://vendor.example/api/invoices?limit=REDACTED&filter=REDACTED");
  });
});
