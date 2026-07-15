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

/** Restore the user's persisted schedule. A stored 0 must survive restarts. */
export async function ensureSyncAlarm(): Promise<void> {
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
    chrome.alarms.create(SYNC_ALARM, { periodInMinutes: periodMinutes, delayInMinutes: 1 });
  }
}

export function isSyncAlarm(name: string): boolean {
  return name === SYNC_ALARM;
}

/** Current cadence + when the next background run fires (for the popup's status line). */
export async function getScheduleInfo(): Promise<{ periodMinutes: number | null; nextRunAt: number | null }> {
  const alarm = await chrome.alarms.get(SYNC_ALARM);
  return { periodMinutes: alarm?.periodInMinutes ?? null, nextRunAt: alarm?.scheduledTime ?? null };
}

/** Change the cadence. 0 turns auto-sync off; otherwise re-arms at the new period. */
export async function setSchedulePeriod(periodMinutes: number): Promise<void> {
  if (!ALLOWED_PERIODS.has(periodMinutes)) throw new Error("unsupported schedule period");
  await chrome.storage.local.set({ [SCHEDULE_KEY]: periodMinutes });
  await chrome.alarms.clear(SYNC_ALARM);
  if (periodMinutes > 0) {
    chrome.alarms.create(SYNC_ALARM, { periodInMinutes: periodMinutes, delayInMinutes: periodMinutes });
  }
}
