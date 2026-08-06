/**
 * When the background sync should next run.
 *
 * The previous model was a fixed interval, which `chrome.alarms` supports
 * directly but people do not think in: "every 720 minutes" drifts against the
 * calendar and cannot express "the 1st of the month", which is when invoices
 * are actually filed. A calendar schedule has to be computed one occurrence at
 * a time and re-armed after each run, so the arithmetic lives here — pure, and
 * testable without a browser.
 *
 * All times are local. A person choosing "Monday" means Monday where they are,
 * and building the instant from local calendar parts makes daylight-saving
 * shifts resolve to the same wall-clock hour on either side of the change.
 */

/** The hour background syncs run at. Stated in the panel rather than chosen:
 * one more control would not earn its place, but a hidden time would surprise. */
export const SYNC_HOUR = 9;

export type SyncSchedule =
  | { mode: "off" }
  | { mode: "daily" }
  /** 0 = Sunday … 6 = Saturday, matching `Date.prototype.getDay`. */
  | { mode: "weekly"; weekday: number }
  /** 1–31. Months too short for the chosen day use their last day. */
  | { mode: "monthly"; day: number };

export const DEFAULT_SYNC_SCHEDULE: SyncSchedule = { mode: "daily" };

const DAY_MS = 24 * 60 * 60_000;

export function parseSyncSchedule(value: unknown): SyncSchedule | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.mode === "off" || raw.mode === "daily") return { mode: raw.mode };
  if (raw.mode === "weekly") {
    const weekday = Number(raw.weekday);
    return Number.isInteger(weekday) && weekday >= 0 && weekday <= 6 ? { mode: "weekly", weekday } : undefined;
  }
  if (raw.mode === "monthly") {
    const day = Number(raw.day);
    return Number.isInteger(day) && day >= 1 && day <= 31 ? { mode: "monthly", day } : undefined;
  }
  return undefined;
}

/**
 * The next instant the schedule calls for, strictly after `now`.
 *
 * Strictly: re-arming happens immediately after a run, and an occurrence at the
 * current instant would otherwise schedule the run that just finished, looping.
 */
export function nextSyncTime(schedule: SyncSchedule, now: Date = new Date()): number | null {
  if (schedule.mode === "off") return null;
  if (schedule.mode === "daily") {
    const today = atSyncHour(now.getFullYear(), now.getMonth(), now.getDate());
    return today > now.getTime() ? today : atSyncHour(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  }
  if (schedule.mode === "weekly") {
    // Days until the chosen weekday; 0 means today, which only counts if the
    // hour has not passed yet.
    const ahead = (schedule.weekday - now.getDay() + 7) % 7;
    const candidate = atSyncHour(now.getFullYear(), now.getMonth(), now.getDate() + ahead);
    return candidate > now.getTime() ? candidate : candidate + 7 * DAY_MS;
  }
  const thisMonth = atSyncHour(now.getFullYear(), now.getMonth(), clampDay(now.getFullYear(), now.getMonth(), schedule.day));
  if (thisMonth > now.getTime()) return thisMonth;
  const year = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
  const month = (now.getMonth() + 1) % 12;
  return atSyncHour(year, month, clampDay(year, month, schedule.day));
}

/**
 * How long a supplier may go unchecked before the schedule has been missed.
 *
 * Used to decide whether browser downtime needs a catch-up run. It is the
 * schedule's longest ordinary gap, not its average: a monthly schedule spans 31
 * days at its widest, and treating that as overdue would sync every startup.
 */
export function maxSyncGapMs(schedule: SyncSchedule): number | null {
  switch (schedule.mode) {
    case "off": return null;
    case "daily": return DAY_MS;
    case "weekly": return 7 * DAY_MS;
    case "monthly": return 31 * DAY_MS;
  }
}

/** Migrate the interval schedule this replaced. Every non-zero interval ran at
 * least daily, so daily is the closest calendar equivalent — and never a
 * surprise increase in how often a supplier is contacted. */
export function syncScheduleFromPeriodMinutes(periodMinutes: unknown): SyncSchedule | undefined {
  if (typeof periodMinutes !== "number" || !Number.isFinite(periodMinutes)) return undefined;
  return periodMinutes <= 0 ? { mode: "off" } : { mode: "daily" };
}

/** Days in a month, via the zeroth day of the next one. */
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function clampDay(year: number, month: number, day: number): number {
  return Math.min(day, daysInMonth(year, month));
}

function atSyncHour(year: number, month: number, day: number): number {
  return new Date(year, month, day, SYNC_HOUR, 0, 0, 0).getTime();
}

// ---- labels ---------------------------------------------------------------

const WEEKDAY_REFERENCE = Date.UTC(2024, 0, 7); // a Sunday, so index 0 is Sunday

/** Weekday names in the viewer's locale, Sunday first to match `getDay`. */
export function weekdayNames(format: "long" | "short" = "long"): string[] {
  const formatter = new Intl.DateTimeFormat(undefined, { weekday: format, timeZone: "UTC" });
  return Array.from({ length: 7 }, (_value, index) =>
    formatter.format(new Date(WEEKDAY_REFERENCE + index * DAY_MS)));
}

/** "3rd", "21st" — the ordinal a person reads back as a date. */
export function ordinalDay(day: number): string {
  const suffix = day % 100 >= 11 && day % 100 <= 13
    ? "th"
    : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[day % 10] ?? "th";
  return `${day}${suffix}`;
}

/** One line stating exactly when this schedule runs. */
export function syncScheduleLabel(schedule: SyncSchedule): string {
  switch (schedule.mode) {
    case "off": return "Off";
    case "daily": return "Every day";
    case "weekly": return `Every ${weekdayNames()[schedule.weekday]}`;
    case "monthly": return `The ${ordinalDay(schedule.day)} of each month`;
  }
}
