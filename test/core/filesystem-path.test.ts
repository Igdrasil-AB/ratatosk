import { describe, expect, it } from "vitest";
import { buildInvoicePath } from "../../collector/src/platform/filesystem-sink";

/**
 * The folder scheme is <root>/<supplier>/<date>/<file>. `buildInvoicePath` is
 * pure so the scheme — and its dedup-relevant determinism — is testable without
 * Chrome.
 */
const doc = {
  vendorName: "Anthropic (Claude)",
  vendorId: "anthropic",
  issuedAt: "2026-06-27",
  filename: "anthropic-2026-06-27-1782543567.pdf",
};

describe("buildInvoicePath", () => {
  it("extraction mode: root / supplier / date-collected / file", () => {
    const identity = "c".repeat(64);
    const path = buildInvoicePath(
      { rootFolder: "InvoiceCollector", dateMode: "extraction", extractionDate: "2026-07-12" },
      { ...doc, idempotencyKey: identity },
    );
    expect(path).toBe(`InvoiceCollector/Anthropic (Claude)/2026-07-12/anthropic-2026-06-27-1782543567--${identity}.pdf`);
  });

  it("invoice mode uses the invoice date → deterministic path", () => {
    const path = buildInvoicePath(
      { rootFolder: "InvoiceCollector", dateMode: "invoice", extractionDate: "2026-07-12" },
      doc,
    );
    expect(path).toBe("InvoiceCollector/Anthropic (Claude)/2026-06-27/anthropic-2026-06-27-1782543567.pdf");
  });

  it("adds the delivery identity when invoice-mode documents share a filename and date", () => {
    const cfg = { rootFolder: "InvoiceCollector", dateMode: "invoice" as const, extractionDate: "2026-07-12" };
    const firstKey = "a".repeat(64);
    const secondKey = "b".repeat(64);
    const first = buildInvoicePath(cfg, { ...doc, idempotencyKey: firstKey });
    const second = buildInvoicePath(cfg, { ...doc, idempotencyKey: secondKey });

    expect(first).toBe(`InvoiceCollector/Anthropic (Claude)/2026-06-27/anthropic-2026-06-27-1782543567--${firstKey}.pdf`);
    expect(second).toBe(`InvoiceCollector/Anthropic (Claude)/2026-06-27/anthropic-2026-06-27-1782543567--${secondKey}.pdf`);
    expect(first).not.toBe(second);
  });

  it("does not turn sanitized or truncated non-digest identities into overwrite targets", () => {
    const cfg = { rootFolder: "InvoiceCollector", dateMode: "invoice" as const, extractionDate: "2026-07-12" };
    const collidingPrefix = "a".repeat(80);
    expect(buildInvoicePath(cfg, { ...doc, idempotencyKey: "a/b" })).toMatch(/anthropic-2026-06-27-1782543567\.pdf$/);
    expect(buildInvoicePath(cfg, { ...doc, idempotencyKey: "a:b" })).toMatch(/anthropic-2026-06-27-1782543567\.pdf$/);
    expect(buildInvoicePath(cfg, { ...doc, idempotencyKey: `${collidingPrefix}1` })).toMatch(/anthropic-2026-06-27-1782543567\.pdf$/);
    expect(buildInvoicePath(cfg, { ...doc, idempotencyKey: `${collidingPrefix}2` })).toMatch(/anthropic-2026-06-27-1782543567\.pdf$/);
  });

  it("keeps spaces/parens but sanitizes path-breaking characters in supplier names", () => {
    const path = buildInvoicePath(
      { rootFolder: "X", dateMode: "extraction", extractionDate: "2026-07-12" },
      { ...doc, vendorName: "A/B: C" },
    );
    expect(path).toBe("X/A-B- C/2026-07-12/anthropic-2026-06-27-1782543567.pdf");
  });

  it("falls back to the vendor id when there is no display name", () => {
    const path = buildInvoicePath(
      { rootFolder: "X", dateMode: "extraction", extractionDate: "2026-07-12" },
      { vendorId: "vercel", issuedAt: "2026-06-30", filename: "f.pdf" },
    );
    expect(path).toBe("X/vercel/2026-07-12/f.pdf");
  });

  it.each([".", "..", "..."])("does not allow bare dot filename %s", (filename) => {
    const path = buildInvoicePath(
      { rootFolder: "X", dateMode: "invoice", extractionDate: "2026-07-12" },
      { ...doc, filename },
    );
    expect(path).toBe("X/Anthropic (Claude)/2026-06-27/invoice.pdf");
  });
});
