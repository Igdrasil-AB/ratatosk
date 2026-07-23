import { describe, expect, it } from "vitest";
import {
  filterLedgerByDate,
  groupLedgerBySupplier,
  invoiceCountLabel,
  isRecentlyCollected,
  ledgerDateFilterLabel,
} from "../../collector/src/ui/popup/ledger-view";
import type { LedgerEntry } from "../../collector/src/platform/storage";

const entries: LedgerEntry[] = [
  entry("github", "GitHub", "2026-07-02", Date.UTC(2026, 6, 2)),
  entry("clickup", "clickup.com", undefined, Date.UTC(2026, 6, 19)),
  entry("github", "GitHub", "2026-06-02", Date.UTC(2026, 5, 2)),
  entry("github", "GitHub", "2026-05-02", Date.UTC(2026, 4, 2)),
];

describe("popup supplier ledger view", () => {
  it("groups entries by stable supplier id and orders groups by latest collection", () => {
    const groups = groupLedgerBySupplier(entries);

    expect(groups.map((group) => [group.vendorId, group.entries.length])).toEqual([
      ["clickup", 1],
      ["github", 3],
    ]);
    expect(groups[1].entries.map((item) => item.issuedAt)).toEqual([
      "2026-07-02",
      "2026-06-02",
      "2026-05-02",
    ]);
  });

  it("filters on invoice date and falls back to collection date", () => {
    const now = Date.UTC(2026, 6, 20);

    expect(filterLedgerByDate(entries, "30d", now).map((item) => item.vendorId)).toEqual(["github", "clickup"]);
    expect(filterLedgerByDate(entries, "90d", now)).toHaveLength(4);
    expect(filterLedgerByDate(entries, "year", now)).toHaveLength(4);
    expect(filterLedgerByDate(entries, "all", now)).toEqual(entries);
  });

  it("includes invoices issued today before local noon but excludes future dates", () => {
    const now = new Date(2026, 6, 21, 9, 0, 0).getTime();
    const today = entry("today", "Today", "2026-07-21", now);
    const tomorrow = entry("tomorrow", "Tomorrow", "2026-07-22", now);

    expect(filterLedgerByDate([today, tomorrow], "30d", now)).toEqual([today]);
    expect(filterLedgerByDate([today, tomorrow], "year", now)).toEqual([today]);
  });

  it("falls back to collection time for invalid calendar dates", () => {
    const now = new Date(2026, 6, 21, 9, 0, 0).getTime();
    const invalid = entry("invalid", "Invalid", "2026-02-30", now - 1_000);

    expect(filterLedgerByDate([invalid], "30d", now)).toEqual([invalid]);
  });

  it("only marks invoices collected in the last minute as new", () => {
    const now = Date.UTC(2026, 6, 21, 18, 0, 0);

    expect(isRecentlyCollected(now - 30_000, now)).toBe(true);
    expect(isRecentlyCollected(now - 7 * 60 * 60_000, now)).toBe(false);
  });

  it("uses concise history counts and human-readable date filter labels", () => {
    expect(invoiceCountLabel(21, 21)).toBe("21 invoices");
    expect(invoiceCountLabel(3, 21)).toBe("3 of 21");
    expect(ledgerDateFilterLabel("all")).toBe("All dates");
    expect(ledgerDateFilterLabel("30d")).toBe("Last 30 days");
  });
});

function entry(vendorId: string, vendorName: string, issuedAt: string | undefined, collectedAt: number): LedgerEntry {
  return { key: `${vendorId}-${issuedAt ?? collectedAt}`, vendorId, vendorName, issuedAt, collectedAt };
}
