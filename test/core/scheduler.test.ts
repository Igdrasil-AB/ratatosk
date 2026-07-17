import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimScheduledWake,
  completeScheduledWake,
  ensureSyncAlarm,
  getScheduleInfo,
  setSchedulePeriod,
} from "../../collector/src/platform/scheduler";

const NOW = Date.parse("2026-07-17T08:00:00.000Z");
const RUN_ID = "01234567-89ab-4def-8123-456789abcdef";

describe("collector durable local scheduler", () => {
  let values: Record<string, unknown>;
  let alarm: chrome.alarms.Alarm | undefined;
  let create: ReturnType<typeof vi.fn>;
  let clear: ReturnType<typeof vi.fn>;
  let storageSet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    values = {};
    alarm = undefined;
    create = vi.fn((name: string, info: chrome.alarms.AlarmCreateInfo) => {
      alarm = {
        name,
        ...(info.periodInMinutes === undefined ? {} : { periodInMinutes: info.periodInMinutes }),
        scheduledTime: info.when ?? NOW + (info.delayInMinutes ?? 1) * 60_000,
      };
    });
    clear = vi.fn(async () => {
      alarm = undefined;
      return true;
    });
    storageSet = vi.fn(async (items: Record<string, unknown>) => Object.assign(values, structuredClone(items)));

    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => RUN_ID) });
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: structuredClone(values[key]) })),
          set: storageSet,
        },
      },
      alarms: {
        get: vi.fn(async () => alarm),
        clear,
        create,
      },
    });
  });

  it("creates a versioned runtime and a recoverable one-shot alarm", async () => {
    await ensureSyncAlarm(undefined, NOW);

    expect(values.schedulePeriodMinutes).toBe(720);
    expect(values.scheduleRuntimeV1).toEqual({ version: 1, nextFullSyncAt: NOW + 60_000 });
    expect(create).toHaveBeenCalledWith("collector-sync", { when: NOW + 60_000 });
  });

  it("does not rewrite healthy runtime state on an ordinary worker boot", async () => {
    await ensureSyncAlarm(undefined, NOW);
    storageSet.mockClear();
    create.mockClear();

    await ensureSyncAlarm(undefined, NOW + 1_000);

    expect(storageSet).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("migrates an existing repeating alarm without changing its next wake", async () => {
    values.schedulePeriodMinutes = 720;
    alarm = { name: "collector-sync", periodInMinutes: 720, scheduledTime: NOW + 2 * 60 * 60_000 };

    await ensureSyncAlarm(undefined, NOW);

    expect(values.scheduleRuntimeV1).toEqual({ version: 1, nextFullSyncAt: NOW + 2 * 60 * 60_000 });
    expect(clear).toHaveBeenCalledWith("collector-sync");
    expect(create).toHaveBeenCalledWith("collector-sync", { when: NOW + 2 * 60 * 60_000 });
  });

  it("fails closed to a near-term wake when runtime state is corrupted", async () => {
    values.schedulePeriodMinutes = 360;
    values.scheduleRuntimeV1 = { version: 1, nextFullSyncAt: "far away", capturedBody: "must not survive" };

    await ensureSyncAlarm(undefined, NOW);

    expect(values.scheduleRuntimeV1).toEqual({ version: 1, nextFullSyncAt: NOW + 60_000 });
    expect(create).toHaveBeenCalledWith("collector-sync", { when: NOW + 60_000 });
  });

  it("preserves an off schedule across service-worker restarts", async () => {
    values.schedulePeriodMinutes = 0;
    values.scheduleRuntimeV1 = { version: 1, nextFullSyncAt: null };
    alarm = { name: "collector-sync", periodInMinutes: 720, scheduledTime: NOW };

    await ensureSyncAlarm(undefined, NOW);

    expect(clear).toHaveBeenCalledWith("collector-sync");
    expect(create).not.toHaveBeenCalled();
    expect(values.schedulePeriodMinutes).toBe(0);
  });

  it("persists a schedule change before replacing its alarm", async () => {
    alarm = { name: "collector-sync", periodInMinutes: 720, scheduledTime: NOW };

    await setSchedulePeriod(360, NOW);

    expect(values.schedulePeriodMinutes).toBe(360);
    expect(values.scheduleRuntimeV1).toEqual({ version: 1, nextFullSyncAt: NOW + 360 * 60_000 });
    expect(clear).toHaveBeenCalledWith("collector-sync");
    expect(create).toHaveBeenCalledWith("collector-sync", { when: NOW + 360 * 60_000 });
  });

  it("joins scheduled work through a persisted lease and completes its exact claim", async () => {
    values.schedulePeriodMinutes = 360;
    values.scheduleRuntimeV1 = { version: 1, nextFullSyncAt: NOW - 1 };

    const claim = await claimScheduledWake({ retryDue: false, nextRetryAt: null, now: NOW });
    expect(claim).toEqual({ runId: RUN_ID, fullSyncDue: true });
    expect(values.scheduleRuntimeV1).toMatchObject({
      nextFullSyncAt: NOW + 360 * 60_000,
      activeRun: { runId: RUN_ID, leaseUntil: NOW + 10 * 60_000, fullSyncDue: true },
    });
    await expect(claimScheduledWake({ retryDue: true, nextRetryAt: null, now: NOW + 1_000 })).resolves.toBeNull();

    await completeScheduledWake(claim!, null, NOW + 2_000);
    expect(values.scheduleRuntimeV1).toMatchObject({ nextFullSyncAt: NOW + 360 * 60_000 });
    expect((values.scheduleRuntimeV1 as any).activeRun).toBeUndefined();
  });

  it("recovers an interrupted full sweep after its lease expires", async () => {
    values.schedulePeriodMinutes = 360;
    values.scheduleRuntimeV1 = {
      version: 1,
      nextFullSyncAt: NOW + 360 * 60_000,
      activeRun: {
        runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        startedAt: NOW - 11 * 60_000,
        leaseUntil: NOW - 60_000,
        fullSyncDue: true,
      },
    };

    await expect(claimScheduledWake({ retryDue: false, nextRetryAt: null, now: NOW })).resolves.toEqual({
      runId: RUN_ID,
      fullSyncDue: true,
    });
  });

  it("can claim an earlier retry without advancing the normal cadence", async () => {
    values.schedulePeriodMinutes = 360;
    values.scheduleRuntimeV1 = { version: 1, nextFullSyncAt: NOW + 360 * 60_000 };

    await expect(claimScheduledWake({ retryDue: true, nextRetryAt: null, now: NOW })).resolves.toEqual({
      runId: RUN_ID,
      fullSyncDue: false,
    });
    expect((values.scheduleRuntimeV1 as any).nextFullSyncAt).toBe(NOW + 360 * 60_000);
  });

  it("does not replace a known earlier retry when schedule info is read", async () => {
    values.schedulePeriodMinutes = 360;
    values.scheduleRuntimeV1 = { version: 1, nextFullSyncAt: NOW + 360 * 60_000 };
    alarm = { name: "collector-sync", scheduledTime: NOW + 5 * 60_000 };

    await expect(getScheduleInfo()).resolves.toEqual({ periodMinutes: 360, nextRunAt: NOW + 5 * 60_000 });
    expect(create).not.toHaveBeenCalled();
  });
});
