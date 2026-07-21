import { describe, expect, it } from "vitest";
import { parseVerificationMaxAgeDays, vendorFileIssues } from "../../scripts/vendor-validation-files";

describe("vendor validation files", () => {
  it("does not accept a test filename without a vendor-specific fixture", () => {
    const files = new Set(["test/vendors/acme.test.ts"]);
    expect(vendorFileIssues("acme", (path) => files.has(path))).toEqual([
      expect.stringMatching(/missing required invoice fixture/),
    ]);
  });

  it.each(["json", "html"])("accepts a test with a %s invoice fixture", (extension) => {
    const files = new Set([
      "test/vendors/acme.test.ts",
      `test/vendors/fixtures/acme.invoices.${extension}`,
    ]);
    expect(vendorFileIssues("acme", (path) => files.has(path))).toEqual([]);
  });

  it("parses a bounded whole-day release policy and defaults only when absent", () => {
    expect(parseVerificationMaxAgeDays(undefined)).toBeUndefined();
    expect(parseVerificationMaxAgeDays("30")).toBe(30);
    expect(parseVerificationMaxAgeDays("365")).toBe(365);
  });

  it.each(["", "30oops", "30.5", "0", "-1", "366", "999999"])(
    "rejects malformed or unsafe release policy %j",
    (value) => expect(() => parseVerificationMaxAgeDays(value)).toThrow(/1 to 365/),
  );
});
