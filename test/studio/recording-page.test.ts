import { describe, expect, it } from "vitest";
import { isSecureRecordingPage } from "../../studio/src/platform/recording-page";

describe("Studio recording page policy", () => {
  it("accepts HTTPS billing pages", () => {
    expect(isSecureRecordingPage("https://vendor.example/billing")).toBe(true);
  });

  it("rejects HTTP and non-web or malformed URLs", () => {
    expect(isSecureRecordingPage("http://vendor.example/billing")).toBe(false);
    expect(isSecureRecordingPage("file:///tmp/invoice.html")).toBe(false);
    expect(isSecureRecordingPage("https-not-really:vendor.example")).toBe(false);
    expect(isSecureRecordingPage(undefined)).toBe(false);
  });
});
