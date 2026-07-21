import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSyncAlarm, getScheduleInfo, isSyncCatchUpDue, setSchedulePeriod } from "../../collector/src/platform/scheduler";

describe("collector schedule persistence", () => {
  let values: Record<string, unknown>;
  let alarm: chrome.alarms.Alarm | undefined;
  let create: ReturnType<typeof vi.fn>;
  let clear: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    values = {};
    alarm = undefined;
    create = vi.fn((name: string, info: chrome.alarms.AlarmCreateInfo) => {
      alarm = {
        name,
        periodInMinutes: info.periodInMinutes,
        scheduledTime: Date.now() + 60_000,
      };
    });
    clear = vi.fn(async () => {
      alarm = undefined;
      return true;
    });

    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: values[key] })),
          set: vi.fn(async (items: Record<string, unknown>) => Object.assign(values, items)),
        },
      },
      alarms: {
        get: vi.fn(async () => alarm),
        clear,
        create,
      },
    });
  });

  it("creates and persists the default schedule on first start", async () => {
    await ensureSyncAlarm();

    expect(values.schedulePeriodMinutes).toBe(720);
    expect(create).toHaveBeenCalledWith("collector-sync", { periodInMinutes: 720, delayInMinutes: 720 });
  });

  it("preserves an off schedule across service-worker restarts", async () => {
    values.schedulePeriodMinutes = 0;
    alarm = { name: "collector-sync", periodInMinutes: 720, scheduledTime: Date.now() };

    await ensureSyncAlarm();

    expect(clear).toHaveBeenCalledWith("collector-sync");
    expect(create).not.toHaveBeenCalled();
    expect(values.schedulePeriodMinutes).toBe(0);
  });

  it("persists off before clearing the active alarm", async () => {
    alarm = { name: "collector-sync", periodInMinutes: 720, scheduledTime: Date.now() };

    await setSchedulePeriod(0);

    expect(values.schedulePeriodMinutes).toBe(0);
    expect(clear).toHaveBeenCalledWith("collector-sync");
    expect(create).not.toHaveBeenCalled();
  });

  it("does not acknowledge a schedule update until Chrome confirms alarm creation", async () => {
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    create.mockImplementationOnce(async (name: string, info: chrome.alarms.AlarmCreateInfo) => {
      await createGate;
      alarm = { name, periodInMinutes: info.periodInMinutes, scheduledTime: Date.now() + 60_000 };
    });
    let settled = false;

    const update = setSchedulePeriod(360).then(() => { settled = true; });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    releaseCreate();
    await update;

    expect(settled).toBe(true);
    await expect(getScheduleInfo()).resolves.toMatchObject({ periodMinutes: 360 });
  });

  it("propagates alarm creation failures instead of reporting success", async () => {
    create.mockRejectedValueOnce(new Error("alarm unavailable"));

    await expect(setSchedulePeriod(360)).rejects.toThrow("alarm unavailable");
  });

  it("keeps an explicit off choice made while startup initialization is in flight", async () => {
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    vi.mocked(chrome.storage.local.get).mockImplementationOnce(async (key) => {
      await readGate;
      return { [key as string]: undefined };
    });

    const initializing = ensureSyncAlarm();
    await Promise.resolve();
    const disabling = setSchedulePeriod(0);
    releaseRead();
    await Promise.all([initializing, disabling]);

    expect(values.schedulePeriodMinutes).toBe(0);
    expect(alarm).toBeUndefined();
  });

  it("requests one catch-up only when a connected supplier missed the cadence", () => {
    const now = 10_000_000;
    expect(isSyncCatchUpDue({
      stale: { connectedAt: 1, lastAttemptAt: now - 721 * 60_000 },
    }, 720, now)).toBe(true);
    expect(isSyncCatchUpDue({
      current: { connectedAt: 1, lastAttemptAt: now - 719 * 60_000 },
    }, 720, now)).toBe(false);
    expect(isSyncCatchUpDue({ stale: { connectedAt: 1 } }, null, now)).toBe(false);
  });
});
