import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureSyncAlarm,
  getScheduleInfo,
  isSyncCatchUpDue,
  rearmSyncAlarm,
  setSyncSchedule,
} from "../../collector/src/platform/scheduler";

describe("collector schedule persistence", () => {
  let values: Record<string, unknown>;
  let alarm: chrome.alarms.Alarm | undefined;
  let create: ReturnType<typeof vi.fn>;
  let clear: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    values = {};
    alarm = undefined;
    create = vi.fn((name: string, info: chrome.alarms.AlarmCreateInfo) => {
      alarm = { name, scheduledTime: info.when ?? Date.now() + 60_000 };
    });
    clear = vi.fn(async () => {
      alarm = undefined;
      return true;
    });

    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (keys: string | string[]) => Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]]),
          )),
          set: vi.fn(async (items: Record<string, unknown>) => Object.assign(values, items)),
          remove: vi.fn(async (key: string) => { delete values[key]; }),
        },
      },
      alarms: { get: vi.fn(async () => alarm), clear, create },
    });
  });

  it("creates and persists the default schedule on first start", async () => {
    await ensureSyncAlarm();

    expect(values.syncScheduleV1).toEqual({ mode: "daily" });
    expect(create).toHaveBeenCalledOnce();
    // A calendar occurrence, not a repeating interval.
    const [, info] = create.mock.calls[0] as [string, chrome.alarms.AlarmCreateInfo];
    expect(info.periodInMinutes).toBeUndefined();
    expect(info.when).toBeGreaterThan(Date.now());
  });

  it("carries an interval schedule across to the calendar model", async () => {
    values.schedulePeriodMinutes = 360;

    await ensureSyncAlarm();

    expect(values.syncScheduleV1).toEqual({ mode: "daily" });
    // The superseded key is not left behind to be re-read later.
    expect(values.schedulePeriodMinutes).toBeUndefined();
  });

  it("keeps auto-sync off for someone who had turned the interval off", async () => {
    values.schedulePeriodMinutes = 0;

    await ensureSyncAlarm();

    expect(values.syncScheduleV1).toEqual({ mode: "off" });
    expect(create).not.toHaveBeenCalled();
  });

  it("preserves an off schedule across service-worker restarts", async () => {
    values.syncScheduleV1 = { mode: "off" };
    alarm = { name: "collector-sync", scheduledTime: Date.now() + 60_000 };

    await ensureSyncAlarm();

    expect(clear).toHaveBeenCalledWith("collector-sync");
    expect(create).not.toHaveBeenCalled();
    expect(values.syncScheduleV1).toEqual({ mode: "off" });
  });

  it("does not push the next run out when the browser restarts", async () => {
    // A pending occurrence must survive startup: re-arming on every launch is
    // how a schedule can starve on a machine that is opened and closed often.
    values.syncScheduleV1 = { mode: "weekly", weekday: 1 };
    const scheduledTime = Date.now() + 3 * 24 * 60 * 60_000;
    alarm = { name: "collector-sync", scheduledTime };

    await ensureSyncAlarm();

    expect(create).not.toHaveBeenCalled();
    expect(alarm.scheduledTime).toBe(scheduledTime);
  });

  it("arms the following occurrence once the alarm has fired", async () => {
    values.syncScheduleV1 = { mode: "daily" };
    alarm = { name: "collector-sync", scheduledTime: Date.now() - 1_000 };

    await rearmSyncAlarm();

    expect(create).toHaveBeenCalledOnce();
    const [, info] = create.mock.calls[0] as [string, chrome.alarms.AlarmCreateInfo];
    expect(info.when!).toBeGreaterThan(Date.now());
  });

  it("persists off before clearing the active alarm", async () => {
    alarm = { name: "collector-sync", scheduledTime: Date.now() };

    await setSyncSchedule({ mode: "off" });

    expect(values.syncScheduleV1).toEqual({ mode: "off" });
    expect(clear).toHaveBeenCalledWith("collector-sync");
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a schedule it cannot represent", async () => {
    await expect(setSyncSchedule({ mode: "weekly", weekday: 9 } as never)).rejects.toThrow("unsupported sync schedule");
    await expect(setSyncSchedule({ mode: "monthly", day: 0 } as never)).rejects.toThrow("unsupported sync schedule");
    expect(values.syncScheduleV1).toBeUndefined();
  });

  it("does not acknowledge a schedule update until Chrome confirms alarm creation", async () => {
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    create.mockImplementationOnce(async (name: string, info: chrome.alarms.AlarmCreateInfo) => {
      await createGate;
      alarm = { name, scheduledTime: info.when ?? Date.now() + 60_000 };
    });
    let settled = false;

    const update = setSyncSchedule({ mode: "weekly", weekday: 2 }).then(() => { settled = true; });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    releaseCreate();
    await update;

    expect(settled).toBe(true);
    await expect(getScheduleInfo()).resolves.toMatchObject({ schedule: { mode: "weekly", weekday: 2 } });
  });

  it("propagates alarm creation failures instead of reporting success", async () => {
    create.mockRejectedValueOnce(new Error("alarm unavailable"));

    await expect(setSyncSchedule({ mode: "daily" })).rejects.toThrow("alarm unavailable");
  });

  it("keeps an explicit off choice made while startup initialization is in flight", async () => {
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    vi.mocked(chrome.storage.local.get).mockImplementationOnce(async () => {
      await readGate;
      return {};
    });

    const initializing = ensureSyncAlarm();
    await Promise.resolve();
    const disabling = setSyncSchedule({ mode: "off" });
    releaseRead();
    await Promise.all([initializing, disabling]);

    expect(values.syncScheduleV1).toEqual({ mode: "off" });
    expect(alarm).toBeUndefined();
  });

  it("requests one catch-up only when a connected supplier missed its schedule", () => {
    const now = 10_000_000_000;
    const day = 24 * 60 * 60_000;

    expect(isSyncCatchUpDue(
      { stale: { connectedAt: 1, lastAttemptAt: now - day - 60_000 } },
      { mode: "daily" },
      now,
    )).toBe(true);
    expect(isSyncCatchUpDue(
      { current: { connectedAt: 1, lastAttemptAt: now - day + 60_000 } },
      { mode: "daily" },
      now,
    )).toBe(false);
    // A monthly schedule is not overdue after a day, or every startup would sync.
    expect(isSyncCatchUpDue(
      { current: { connectedAt: 1, lastAttemptAt: now - 2 * day } },
      { mode: "monthly", day: 1 },
      now,
    )).toBe(false);
    expect(isSyncCatchUpDue({ stale: { connectedAt: 1 } }, { mode: "off" }, now)).toBe(false);
  });
});
