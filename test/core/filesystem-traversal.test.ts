import { describe, expect, it } from "vitest";
import { buildInvoicePath } from "../../collector/src/platform/filesystem-sink";

/**
 * Path-traversal safety: vendor names, dates, and filenames come from vendor data
 * and must never escape the Downloads subfolder. The property that matters is that
 * every value collapses to exactly ONE path segment with no `..`/`.` segment and
 * no injected separators — a segment merely CONTAINING ".." as text is a harmless
 * folder name, but chrome.downloads would resolve a bare ".." segment.
 */
describe("filesystem path — traversal is neutralized", () => {
  const cfg = { rootFolder: "InvoiceCollector", dateMode: "extraction" as const, extractionDate: "2026-01-01" };

  it("keeps a traversal attempt to exactly root/vendor/date/file", () => {
    const path = buildInvoicePath(cfg, {
      vendorId: "acme",
      vendorName: "../../etc",
      issuedAt: "2026-01-01",
      filename: "../../../etc/passwd",
    });
    const segs = path.split("/");
    expect(segs).toHaveLength(4);
    expect(segs).not.toContain("..");
    expect(segs).not.toContain(".");
  });

  it("neutralizes separators and control chars in names", () => {
    const path = buildInvoicePath(cfg, {
      vendorId: "acme",
      vendorName: "a/b\\c",
      issuedAt: "2026-01-01",
      filename: "in\\voice\0.pdf",
    });
    expect(path).not.toMatch(/[\\\0]/);
    expect(path.split("/")).toHaveLength(4);
  });

  it.each([".", "..", " . ", " .. "])("replaces bare navigation filename %j with a safe fallback", (filename) => {
    const path = buildInvoicePath(cfg, {
      vendorId: "acme",
      issuedAt: "2026-01-01",
      filename,
    });
    const segments = path.split("/");
    expect(segments).toHaveLength(4);
    expect(segments).not.toContain(".");
    expect(segments).not.toContain("..");
    expect(segments.at(-1)).toBe("invoice.pdf");
  });
});
