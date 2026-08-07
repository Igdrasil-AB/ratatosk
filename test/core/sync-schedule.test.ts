import { describe, expect, it } from "vitest";
import {
  DEFAULT_SYNC_SCHEDULE,
  maxSyncGapMs,
  nextSyncTime,
  ordinalDay,
  parseSyncSchedule,
  syncScheduleFromPeriodMinutes,
  syncScheduleLabel,
  SYNC_HOUR,
  weekdayNames,
  type SyncSchedule,
} from "../../src/core/sync-schedule";

/**
 * Calendar arithmetic, which is where a scheduler quietly goes wrong: the 31st
 * of a 30-day month, the hour a clock change removes, and an occurrence landing
 * exactly on the instant it is being computed from.
 */

function at(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute);
}

function parts(timestamp: number) {
  const date = new Date(timestamp);
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    weekday: date.getDay(),
  };
}

describe("sync schedule", () => {
  it("never runs when off", () => {
    expect(nextSyncTime({ mode: "off" }, at(2026, 8, 6, 12))).toBeNull();
    expect(maxSyncGapMs({ mode: "off" })).toBeNull();
  });

  it("runs later today, or tomorrow once the hour has passed", () => {
    expect(parts(nextSyncTime({ mode: "daily" }, at(2026, 8, 6, SYNC_HOUR - 1))!))
      .toMatchObject({ year: 2026, month: 8, day: 6, hour: SYNC_HOUR });
    expect(parts(nextSyncTime({ mode: "daily" }, at(2026, 8, 6, SYNC_HOUR + 1))!))
      .toMatchObject({ year: 2026, month: 8, day: 7, hour: SYNC_HOUR });
  });

  it("treats an occurrence at the current instant as already served", () => {
    // Re-arming happens right after a run. Accepting "now" would schedule the
    // run that just finished, and the series would spin.
    const now = at(2026, 8, 6, SYNC_HOUR);
    expect(parts(nextSyncTime({ mode: "daily" }, now)!).day).toBe(7);
    expect(nextSyncTime({ mode: "daily" }, now)!).toBeGreaterThan(now.getTime());
  });

  it("lands on the chosen weekday", () => {
    // 2026-08-06 is a Thursday.
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      const next = nextSyncTime({ mode: "weekly", weekday }, at(2026, 8, 6, 12))!;
      expect(parts(next).weekday).toBe(weekday);
      expect(parts(next).hour).toBe(SYNC_HOUR);
      expect(next).toBeGreaterThan(at(2026, 8, 6, 12).getTime());
      // Always within the week ahead, never skipping one.
      expect(next).toBeLessThanOrEqual(at(2026, 8, 13, 23, 59).getTime());
    }
  });

  it("waits a full week when today is the day but the hour has gone", () => {
    const thursday = 4;
    const next = nextSyncTime({ mode: "weekly", weekday: thursday }, at(2026, 8, 6, SYNC_HOUR + 1))!;
    expect(parts(next)).toMatchObject({ month: 8, day: 13, weekday: thursday });
  });

  it("lands on the chosen day of the month", () => {
    expect(parts(nextSyncTime({ mode: "monthly", day: 15 }, at(2026, 8, 6, 12))!))
      .toMatchObject({ year: 2026, month: 8, day: 15, hour: SYNC_HOUR });
    expect(parts(nextSyncTime({ mode: "monthly", day: 1 }, at(2026, 8, 6, 12))!))
      .toMatchObject({ year: 2026, month: 9, day: 1 });
  });

  it("uses the last day of a month too short for the choice", () => {
    expect(parts(nextSyncTime({ mode: "monthly", day: 31 }, at(2026, 2, 1, 12))!))
      .toMatchObject({ year: 2026, month: 2, day: 28 });
    // 2028 is a leap year.
    expect(parts(nextSyncTime({ mode: "monthly", day: 30 }, at(2028, 2, 1, 12))!))
      .toMatchObject({ year: 2028, month: 2, day: 29 });
    expect(parts(nextSyncTime({ mode: "monthly", day: 31 }, at(2026, 4, 1, 12))!))
      .toMatchObject({ month: 4, day: 30 });
  });

  it("rolls into the next year from December", () => {
    expect(parts(nextSyncTime({ mode: "monthly", day: 5 }, at(2026, 12, 20, 12))!))
      .toMatchObject({ year: 2027, month: 1, day: 5 });
  });

  it("keeps the same wall-clock hour across a daylight-saving change", () => {
    // Both windows straddle a European clock change. The offset assertion is
    // what makes this test mean anything: in a zone without daylight saving it
    // would otherwise pass while exercising nothing, which is exactly how it
    // read on UTC runners before `TZ` was pinned in vitest.config.ts.
    for (const now of [at(2026, 3, 27, 12), at(2026, 10, 23, 12)]) {
      const offsets = new Set<number>();
      for (let step = 0; step < 8; step += 1) {
        const from = new Date(now.getTime() + step * 24 * 60 * 60_000);
        offsets.add(from.getTimezoneOffset());
        const next = nextSyncTime({ mode: "daily" }, from)!;
        // The hour is local, so it must not drift with the offset.
        expect(parts(next).hour).toBe(SYNC_HOUR);
        expect(next).toBeGreaterThan(from.getTime());
      }
      expect(offsets.size).toBe(2);
    }
  });

  it("does not skip or repeat a day when the clocks change", () => {
    // A schedule that lands twice on the same date, or steps over one, is the
    // classic daylight-saving bug: the interval between two runs is a day of
    // wall-clock time, not a fixed 24 hours.
    for (const start of [at(2026, 3, 27, 12), at(2026, 10, 23, 12)]) {
      const seen: number[] = [];
      let cursor = start;
      for (let step = 0; step < 6; step += 1) {
        const next = nextSyncTime({ mode: "daily" }, cursor)!;
        seen.push(new Date(next).getDate());
        cursor = new Date(next);
      }
      const gaps = seen.slice(1).map((day, index) => day - seen[index]);
      // Consecutive calendar days, allowing the wrap at a month boundary.
      expect(gaps.every((gap) => gap === 1 || gap < 0)).toBe(true);
    }
  });

  it("always produces an instant in the future", () => {
    const schedules: SyncSchedule[] = [
      { mode: "daily" },
      ...Array.from({ length: 7 }, (_value, weekday) => ({ mode: "weekly" as const, weekday })),
      ...Array.from({ length: 31 }, (_value, index) => ({ mode: "monthly" as const, day: index + 1 })),
    ];
    for (const schedule of schedules) {
      for (const month of [1, 2, 4, 8, 12]) {
        for (const hour of [0, SYNC_HOUR, SYNC_HOUR + 1, 23]) {
          const now = at(2026, month, 28, hour, 30);
          expect(nextSyncTime(schedule, now)!).toBeGreaterThan(now.getTime());
        }
      }
    }
  });

  it("bounds how long a supplier may go unchecked", () => {
    expect(maxSyncGapMs({ mode: "daily" })).toBe(24 * 60 * 60_000);
    expect(maxSyncGapMs({ mode: "weekly", weekday: 1 })).toBe(7 * 24 * 60 * 60_000);
    expect(maxSyncGapMs({ mode: "monthly", day: 1 })).toBe(31 * 24 * 60 * 60_000);
  });

  it("accepts only schedules it can act on", () => {
    expect(parseSyncSchedule({ mode: "weekly", weekday: 0 })).toEqual({ mode: "weekly", weekday: 0 });
    expect(parseSyncSchedule({ mode: "monthly", day: 31 })).toEqual({ mode: "monthly", day: 31 });
    for (const invalid of [
      undefined, null, "daily", { mode: "hourly" }, { mode: "weekly" }, { mode: "weekly", weekday: 7 },
      { mode: "weekly", weekday: -1 }, { mode: "monthly", day: 0 }, { mode: "monthly", day: 32 },
      { mode: "monthly", day: 1.5 },
    ]) {
      expect(parseSyncSchedule(invalid)).toBeUndefined();
    }
  });

  it("migrates every interval to a cadence no more frequent than before", () => {
    expect(syncScheduleFromPeriodMinutes(0)).toEqual({ mode: "off" });
    for (const minutes of [360, 720, 1440]) {
      expect(syncScheduleFromPeriodMinutes(minutes)).toEqual(DEFAULT_SYNC_SCHEDULE);
    }
    expect(syncScheduleFromPeriodMinutes(undefined)).toBeUndefined();
    expect(syncScheduleFromPeriodMinutes("720")).toBeUndefined();
  });

  it("states the schedule in words a person chose it in", () => {
    expect(syncScheduleLabel({ mode: "off" })).toBe("Off");
    expect(syncScheduleLabel({ mode: "daily" })).toBe("Every day");
    expect(syncScheduleLabel({ mode: "weekly", weekday: 1 })).toBe(`Every ${weekdayNames()[1]}`);
    expect(syncScheduleLabel({ mode: "monthly", day: 3 })).toBe("The 3rd of each month");
  });

  it("names weekdays from Sunday so the index matches getDay", () => {
    const names = weekdayNames();
    expect(names).toHaveLength(7);
    expect(new Set(names).size).toBe(7);
    // Index 0 must be whatever this locale calls the day a Sunday date falls on.
    const sunday = new Date(Date.UTC(2024, 0, 7));
    expect(names[0]).toBe(new Intl.DateTimeFormat(undefined, { weekday: "long", timeZone: "UTC" }).format(sunday));
  });

  it("writes day numbers the way they are read aloud", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinalDay))
      .toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "31st"]);
  });
});
