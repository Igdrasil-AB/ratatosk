/**
 * Scheduling via `chrome.alarms`.
 *
 * The MV3 service worker is ephemeral — it sleeps between events. An alarm wakes
 * it on a cadence to run the sync. This is the mechanism behind "near-unattended
 * while the browser is running": no tab, no window, just a periodic wake.
 */
const SYNC_ALARM = "collector-sync";
const DEFAULT_PERIOD_MINUTES = 720; // twice a day

/** Create the periodic sync alarm if it doesn't already exist. */
export function ensureSyncAlarm(periodMinutes = DEFAULT_PERIOD_MINUTES): void {
  chrome.alarms.get(SYNC_ALARM, (existing) => {
    if (!existing) {
      chrome.alarms.create(SYNC_ALARM, { periodInMinutes: periodMinutes, delayInMinutes: 1 });
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

/** Change the cadence. 0 turns auto-sync off; otherwise re-arms at the new period. */
export async function setSchedulePeriod(periodMinutes: number): Promise<void> {
  await chrome.alarms.clear(SYNC_ALARM);
  if (periodMinutes > 0) {
    chrome.alarms.create(SYNC_ALARM, { periodInMinutes: periodMinutes, delayInMinutes: periodMinutes });
  }
}
