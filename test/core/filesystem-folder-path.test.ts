import { describe, expect, it } from "vitest";
import { buildInvoicePath, folderPath, folderSegments, MAX_ROOT_FOLDER_DEPTH } from "../../collector/src/platform/filesystem-sink";

/**
 * The destination folder is the one path component a person writes by hand, so
 * it is also the one that can contain anything. Nesting is allowed; escaping
 * the download root is not — `chrome.downloads` rejects a path containing a
 * navigation segment outright, which would turn a typo into a failed save.
 */
describe("configured save folder", () => {
  it("nests the folders a person separates with a slash", () => {
    expect(folderSegments("Accounting/2026/Invoices")).toEqual(["Accounting", "2026", "Invoices"]);
    expect(folderPath("Accounting/2026/Invoices")).toBe("Accounting/2026/Invoices");
  });

  it("accepts the separator people actually type", () => {
    expect(folderPath("Accounting\\2026")).toBe("Accounting/2026");
    expect(folderPath("/Accounting//2026/")).toBe("Accounting/2026");
    expect(folderPath("  Accounting / 2026  ")).toBe("Accounting/2026");
  });

  it("drops navigation segments instead of naming a folder after them", () => {
    expect(folderSegments("../../etc")).toEqual(["etc"]);
    expect(folderSegments("Accounting/../../..")).toEqual(["Accounting"]);
    expect(folderSegments("./Accounting/.")).toEqual(["Accounting"]);
    expect(folderPath("..")).toBe("InvoiceCollector");
  });

  it("never yields a segment chrome.downloads would resolve", () => {
    for (const input of ["..", "../..", "a/../b", ".", "...", "  ..  ", "\\..\\", "a/./b"]) {
      const segments = folderSegments(input);
      expect(segments).not.toContain("..");
      expect(segments).not.toContain(".");
      expect(segments.every((part) => part.length > 0)).toBe(true);
      expect(segments.join("/")).not.toMatch(/(?:^|\/)\.{1,2}(?:\/|$)/);
    }
  });

  it("bounds how deep a save path can nest", () => {
    const deep = Array.from({ length: 20 }, (_value, index) => `level${index}`).join("/");
    expect(folderSegments(deep)).toHaveLength(MAX_ROOT_FOLDER_DEPTH);
  });

  it("keeps a folder whose name resembles the fallback", () => {
    expect(folderSegments("unknown")).toEqual(["unknown"]);
  });

  it("builds the full invoice path beneath every configured folder", () => {
    const path = buildInvoicePath(
      { rootFolder: "Accounting/2026", dateMode: "extraction", extractionDate: "2026-08-06" },
      { vendorId: "clerk", vendorName: "Clerk", issuedAt: "2026-07-01", filename: "invoice.pdf" },
    );

    expect(path).toBe("Accounting/2026/Clerk/2026-08-06/invoice.pdf");
  });

  it("still neutralizes supplier-controlled names under a nested folder", () => {
    const path = buildInvoicePath(
      { rootFolder: "Accounting/2026", dateMode: "extraction", extractionDate: "2026-08-06" },
      { vendorId: "acme", vendorName: "../../etc", issuedAt: "2026-01-01", filename: "../../../etc/passwd" },
    );
    const segments = path.split("/");

    expect(segments).toHaveLength(5);
    expect(segments).not.toContain("..");
    expect(segments).not.toContain(".");
  });
});
