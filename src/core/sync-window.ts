import type { InvoiceRef, SyncMonthWindow } from "./types";
import { resolveInvoiceMetadata } from "./invoice-metadata";

const YEAR_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const ISSUED_AT_MONTH = /^(\d{4})-(0[1-9]|1[0-2])(?:-\d{2}(?:T.*)?|$)/;
const EARLIEST_YEAR = 1970;

export interface SyncWindowFilterResult {
  refs: InvoiceRef[];
  matched: number;
  skippedBefore: number;
  skippedAfter: number;
  skippedUndated: number;
}

/** Parse the month-only user contract into a closed inclusive month window. */
export function createSyncMonthWindow(
  fromMonth: string,
  now = new Date(),
): SyncMonthWindow {
  const from = parseYearMonth(fromMonth);
  const throughMonth = yearMonth(now.getFullYear(), now.getMonth() + 1);
  if (from.year < EARLIEST_YEAR) throw new Error(`sync month cannot be earlier than ${EARLIEST_YEAR}-01`);
  if (fromMonth > throughMonth) throw new Error("sync month cannot be in the future");
  return Object.freeze({ granularity: "month", fromMonth, throughMonth });
}

/** Closed template variables for suppliers whose list APIs accept date bounds. */
export function syncMonthWindowVars(range: SyncMonthWindow): Record<string, string | number> {
  const from = parseYearMonth(range.fromMonth);
  const through = parseYearMonth(range.throughMonth);
  const fromStart = new Date(Date.UTC(from.year, from.month - 1, 1));
  const afterThrough = new Date(Date.UTC(through.year, through.month, 1));
  const throughEnd = new Date(afterThrough.getTime() - 1);

  return {
    syncFromYear: from.year,
    syncFromMonth: String(from.month).padStart(2, "0"),
    syncFromYearMonth: range.fromMonth,
    syncFromDate: isoDate(fromStart),
    syncFromIso: fromStart.toISOString(),
    syncFromEpochSeconds: Math.floor(fromStart.getTime() / 1_000),
    syncFromEpochMs: fromStart.getTime(),
    syncThroughYear: through.year,
    syncThroughMonth: String(through.month).padStart(2, "0"),
    syncThroughYearMonth: range.throughMonth,
    syncThroughDate: isoDate(throughEnd),
    syncThroughIso: throughEnd.toISOString(),
    syncToExclusiveDate: isoDate(afterThrough),
    syncToExclusiveIso: afterThrough.toISOString(),
    syncToExclusiveEpochSeconds: Math.floor(afterThrough.getTime() / 1_000),
    syncToExclusiveEpochMs: afterThrough.getTime(),
  };
}

/** Enforce the requested month before any PDF materialization begins. */
export function filterInvoiceRefsBySyncWindow(
  refs: readonly InvoiceRef[],
  range: SyncMonthWindow,
): SyncWindowFilterResult {
  const result: SyncWindowFilterResult = {
    refs: [],
    matched: 0,
    skippedBefore: 0,
    skippedAfter: 0,
    skippedUndated: 0,
  };

  for (const ref of refs) {
    // Network/HTML strategies expose issuedAt directly. DOM discovery carries
    // the same fact as provenance-bearing row evidence, so resolve the shared
    // metadata contract before applying the supplier-independent boundary.
    const month = invoiceMonth(resolveInvoiceMetadata(ref).issuedAt);
    if (!month) {
      result.skippedUndated += 1;
    } else if (month < range.fromMonth) {
      result.skippedBefore += 1;
    } else if (month > range.throughMonth) {
      result.skippedAfter += 1;
    } else {
      result.refs.push(ref);
      result.matched += 1;
    }
  }
  return result;
}

export function isSyncMonth(value: string, now = new Date()): boolean {
  try {
    createSyncMonthWindow(value, now);
    return true;
  } catch {
    return false;
  }
}

function invoiceMonth(value: string | undefined): string | undefined {
  const match = ISSUED_AT_MONTH.exec(value ?? "");
  if (!match) return undefined;
  return `${match[1]}-${match[2]}`;
}

function parseYearMonth(value: string): { year: number; month: number } {
  const match = YEAR_MONTH.exec(value);
  if (!match) throw new Error("sync month must use YYYY-MM");
  return { year: Number(match[1]), month: Number(match[2]) };
}

function yearMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
