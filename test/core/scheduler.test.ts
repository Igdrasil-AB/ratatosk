import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSyncAlarm, setSchedulePeriod } from "../../collector/src/platform/scheduler";

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
    expect(create).toHaveBeenCalledWith("collector-sync", { periodInMinutes: 720, delayInMinutes: 1 });
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
});
