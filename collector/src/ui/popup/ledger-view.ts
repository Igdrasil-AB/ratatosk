import type { LedgerEntry } from "../../platform/storage";

export type LedgerDateFilter = "all" | "30d" | "90d" | "year";

const LEDGER_DATE_FILTER_LABELS: Record<LedgerDateFilter, string> = {
  all: "All dates",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  year: "This year",
};

export interface LedgerSupplierGroup {
  vendorId: string;
  vendorName: string;
  latestCollectedAt: number;
  entries: LedgerEntry[];
}

export function filterLedgerByDate(
  entries: readonly LedgerEntry[],
  filter: LedgerDateFilter,
  now = Date.now(),
): LedgerEntry[] {
  if (filter === "all") return [...entries];
  const current = new Date(now);
  const today = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
  const start = filter === "year"
    ? new Date(current.getFullYear(), 0, 1).getTime()
    : new Date(current.getFullYear(), current.getMonth(), current.getDate() - (filter === "30d" ? 30 : 90)).getTime();
  return entries.filter((entry) => {
    const issuedDate = ledgerIssuedDateTimestamp(entry);
    return issuedDate !== undefined
      ? issuedDate >= start && issuedDate <= today
      : entry.collectedAt >= start && entry.collectedAt <= now;
  });
}

export function groupLedgerBySupplier(entries: readonly LedgerEntry[]): LedgerSupplierGroup[] {
  const groups = new Map<string, LedgerSupplierGroup>();
  for (const entry of entries) {
    const existing = groups.get(entry.vendorId);
    if (existing) {
      existing.entries.push(entry);
      if (entry.collectedAt > existing.latestCollectedAt) {
        existing.latestCollectedAt = entry.collectedAt;
        existing.vendorName = entry.vendorName;
      }
    } else {
      groups.set(entry.vendorId, {
        vendorId: entry.vendorId,
        vendorName: entry.vendorName,
        latestCollectedAt: entry.collectedAt,
        entries: [entry],
      });
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      entries: [...group.entries].sort((left, right) =>
        ledgerDateTimestamp(right) - ledgerDateTimestamp(left) || right.collectedAt - left.collectedAt),
    }))
    .sort((left, right) => right.latestCollectedAt - left.latestCollectedAt || left.vendorName.localeCompare(right.vendorName));
}

export function isRecentlyCollected(collectedAt: number, now = Date.now()): boolean {
  return collectedAt >= now - 60_000 && collectedAt <= now;
}

export function invoiceCountLabel(visible: number, total: number): string {
  return visible === total ? `${total} invoice${total === 1 ? "" : "s"}` : `${visible} of ${total}`;
}

export function ledgerDateFilterLabel(filter: LedgerDateFilter): string {
  return LEDGER_DATE_FILTER_LABELS[filter];
}

function ledgerDateTimestamp(entry: LedgerEntry): number {
  return ledgerIssuedDateTimestamp(entry) ?? entry.collectedAt;
}

function ledgerIssuedDateTimestamp(entry: LedgerEntry): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(entry.issuedAt ?? "");
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return undefined;
  return date.getTime();
}
