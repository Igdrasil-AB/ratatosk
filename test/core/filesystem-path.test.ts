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
    const path = buildInvoicePath(
      { rootFolder: "InvoiceCollector", dateMode: "extraction", extractionDate: "2026-07-12" },
      doc,
    );
    expect(path).toBe("InvoiceCollector/Anthropic (Claude)/2026-07-12/anthropic-2026-06-27-1782543567.pdf");
  });

  it("invoice mode uses the invoice date → deterministic path (re-save overwrites, no dupes)", () => {
    const path = buildInvoicePath(
      { rootFolder: "InvoiceCollector", dateMode: "invoice", extractionDate: "2026-07-12" },
      doc,
    );
    expect(path).toBe("InvoiceCollector/Anthropic (Claude)/2026-06-27/anthropic-2026-06-27-1782543567.pdf");
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
});
