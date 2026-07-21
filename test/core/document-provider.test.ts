import { describe, expect, it } from "vitest";
import {
  canonicalDocumentProviderUrl,
  documentProviderForUrl,
  exactDocumentProviderOrigin,
  STRIPE_DOCUMENT_HOSTS,
} from "../../src/core/document-provider";

describe("document provider policy", () => {
  it("recognizes any normal HTTPS path on Stripe capability origins", () => {
    for (const value of [
      "https://invoice.stripe.com/i/acct/token?s=ap",
      "https://pay.stripe.com/invoice/acct/token/pdf?s=ap",
      "https://pay.stripe.com/a/future/document/path?opaque=value",
      "https://files.stripe.com/links/example",
    ]) {
      expect(documentProviderForUrl(value)?.id).toBe("stripe");
    }
  });

  it("canonicalizes only the proven hosted-invoice shape and preserves its capability query", () => {
    expect(canonicalDocumentProviderUrl("https://invoice.stripe.com/i/acct/token?s=ap")).toBe(
      "https://pay.stripe.com/invoice/acct/token/pdf?s=ap",
    );
    expect(canonicalDocumentProviderUrl("https://invoice.stripe.com/future/acct/token?s=ap")).toBe(
      "https://invoice.stripe.com/future/acct/token?s=ap",
    );
    for (const pathname of ["/i/", "/i/acct", "/i/acct/token/extra"]) {
      const value = `https://invoice.stripe.com${pathname}?s=ap`;
      expect(canonicalDocumentProviderUrl(value)).toBe(value);
    }
  });

  it("accepts the fixed Stripe upload bucket across regions without trusting arbitrary S3", () => {
    for (const value of [
      "https://stripe-upload-api.s3.amazonaws.com/file-api/object?signature=secret",
      "https://stripe-upload-api.s3.us-west-1.amazonaws.com/file-api/object?signature=secret",
      "https://stripe-upload-api.s3-eu-west-1.amazonaws.com/file-api/object?signature=secret",
    ]) {
      expect(documentProviderForUrl(value)?.id).toBe("stripe");
      expect(exactDocumentProviderOrigin(value)).toMatch(/^https:\/\/stripe-upload-api\.s3/);
    }
    for (const value of [
      "https://other-bucket.s3.us-west-1.amazonaws.com/file.pdf",
      "https://stripe-upload-api.s3.us-west-1.amazonaws.com.evil.test/file.pdf",
      "http://pay.stripe.com/invoice/acct/token/pdf",
      "https://user:password@pay.stripe.com/invoice/acct/token/pdf",
    ]) {
      expect(documentProviderForUrl(value)).toBeUndefined();
      expect(exactDocumentProviderOrigin(value)).toBeUndefined();
    }
  });

  it("rejects trusted hostnames on non-default HTTPS ports", () => {
    const value = "https://pay.stripe.com:444/invoice/acct/token/pdf";
    expect(documentProviderForUrl(value)).toBeUndefined();
    expect(exactDocumentProviderOrigin(value)).toBeUndefined();
    expect(() => canonicalDocumentProviderUrl(value)).toThrow(/normal HTTPS/);
  });

  it("exposes stable exact-origin permission patterns without an Amazon-wide wildcard", () => {
    expect(STRIPE_DOCUMENT_HOSTS).toEqual([
      "https://invoice.stripe.com/*",
      "https://pay.stripe.com/*",
      "https://files.stripe.com/*",
    ]);
    expect(STRIPE_DOCUMENT_HOSTS.join(" ")).not.toContain("amazonaws.com");
  });
});
