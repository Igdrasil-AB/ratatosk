/**
 * Scheduling via `chrome.alarms`.
 *
 * The MV3 service worker is ephemeral — it sleeps between events. An alarm wakes
 * it on a cadence to run the sync. This is the mechanism behind "near-unattended
 * while the browser is running": no tab, no window, just a periodic wake.
 */
const SYNC_ALARM = "collector-sync";
const DEFAULT_PERIOD_MINUTES = 720; // twice a day
const SCHEDULE_KEY = "schedulePeriodMinutes";
const ALLOWED_PERIODS = new Set([0, 360, 720, 1440]);
let scheduleMutation: Promise<void> = Promise.resolve();

/** Restore the user's persisted schedule. A stored 0 must survive restarts. */
export function ensureSyncAlarm(): Promise<void> {
  return mutateSchedule(async () => {
    const values = await chrome.storage.local.get(SCHEDULE_KEY);
    const stored = values[SCHEDULE_KEY];
    const periodMinutes = typeof stored === "number" && ALLOWED_PERIODS.has(stored) ? stored : DEFAULT_PERIOD_MINUTES;
    if (stored === undefined) await chrome.storage.local.set({ [SCHEDULE_KEY]: periodMinutes });

    const existing = await chrome.alarms.get(SYNC_ALARM);
    if (periodMinutes === 0) {
      if (existing) await chrome.alarms.clear(SYNC_ALARM);
      return;
    }
    if (!existing || existing.periodInMinutes !== periodMinutes) {
      await chrome.alarms.clear(SYNC_ALARM);
      // Extension reloads may discard alarms. Recreating one must preserve the
      // selected cadence instead of causing an unrelated all-vendor run one
      // minute after a developer reload or browser update.
      await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: periodMinutes, delayInMinutes: periodMinutes });
    }
  });
}

export function isSyncAlarm(name: string): boolean {
  return name === SYNC_ALARM;
}

/** Current cadence + when the next background run fires (for the popup's status line). */
export async function getScheduleInfo(): Promise<{ periodMinutes: number | null; nextRunAt: number | null }> {
  const alarm = await chrome.alarms.get(SYNC_ALARM);
  return { periodMinutes: alarm?.periodInMinutes ?? null, nextRunAt: alarm?.scheduledTime ?? null };
}

/** Whether browser downtime or a busy worker caused at least one connected
 * supplier to miss its selected cadence. Connection time is the safe baseline
 * before the first attempt. */
export function isSyncCatchUpDue(
  connections: Readonly<Record<string, { connectedAt: number; lastAttemptAt?: number; lastRunAt?: number }>>,
  periodMinutes: number | null,
  now = Date.now(),
): boolean {
  if (!periodMinutes || periodMinutes <= 0) return false;
  const cadenceMs = periodMinutes * 60_000;
  return Object.values(connections).some((connection) =>
    now - (connection.lastAttemptAt ?? connection.lastRunAt ?? connection.connectedAt) >= cadenceMs
  );
}

/** Change the cadence. 0 turns auto-sync off; otherwise re-arms at the new period. */
export async function setSchedulePeriod(periodMinutes: number): Promise<void> {
  if (!ALLOWED_PERIODS.has(periodMinutes)) throw new Error("unsupported schedule period");
  await mutateSchedule(async () => {
    await chrome.storage.local.set({ [SCHEDULE_KEY]: periodMinutes });
    await chrome.alarms.clear(SYNC_ALARM);
    if (periodMinutes > 0) {
      await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: periodMinutes, delayInMinutes: periodMinutes });
    }
  });
}

function mutateSchedule(mutation: () => Promise<void>): Promise<void> {
  const result = scheduleMutation.then(mutation, mutation);
  scheduleMutation = result.catch(() => undefined);
  return result;
}
