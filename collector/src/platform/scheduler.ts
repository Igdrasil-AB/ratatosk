import {
  DEFAULT_SYNC_SCHEDULE,
  maxSyncGapMs,
  nextSyncTime,
  parseSyncSchedule,
  syncScheduleFromPeriodMinutes,
  type SyncSchedule,
} from "../../../src/core/sync-schedule";

/**
 * Scheduling via `chrome.alarms`.
 *
 * The MV3 service worker is ephemeral — it sleeps between events. An alarm wakes
 * it to run the sync. This is the mechanism behind "near-unattended while the
 * browser is running": no tab, no window, just a scheduled wake.
 *
 * The alarm is one-shot rather than periodic. `periodInMinutes` can only express
 * a fixed interval, which cannot land on "every Monday" or "the 1st" — so each
 * run arms only the next occurrence, and re-arms once it fires. That also means
 * a missed occurrence is recovered on startup by `ensureSyncAlarm` instead of
 * silently sliding the whole series forward.
 */
const SYNC_ALARM = "collector-sync";
const SCHEDULE_KEY = "syncScheduleV1";
/** The interval schedule this replaced. Read once, to migrate. */
const LEGACY_PERIOD_KEY = "schedulePeriodMinutes";
let scheduleMutation: Promise<void> = Promise.resolve();

/** Restore the persisted schedule and make sure an alarm exists for it. */
export function ensureSyncAlarm(): Promise<void> {
  return mutateSchedule(async () => {
    const schedule = await readSchedule();
    await armAlarm(schedule);
  });
}

export function isSyncAlarm(name: string): boolean {
  return name === SYNC_ALARM;
}

/**
 * Arm the following occurrence. Called after the alarm fires, because a
 * one-shot alarm is spent once delivered.
 */
export function rearmSyncAlarm(): Promise<void> {
  return mutateSchedule(async () => {
    await armAlarm(await readSchedule(), { force: true });
  });
}

/** Current schedule + when the next background run fires (for the panel). */
export async function getScheduleInfo(): Promise<{ schedule: SyncSchedule; nextRunAt: number | null }> {
  const [schedule, alarm] = await Promise.all([readSchedule(), chrome.alarms.get(SYNC_ALARM)]);
  return { schedule, nextRunAt: alarm?.scheduledTime ?? null };
}

/**
 * Whether browser downtime or a busy worker caused at least one connected
 * supplier to miss its schedule. Connection time is the safe baseline before
 * the first attempt.
 */
export function isSyncCatchUpDue(
  connections: Readonly<Record<string, { connectedAt: number; lastAttemptAt?: number; lastRunAt?: number }>>,
  schedule: SyncSchedule,
  now = Date.now(),
): boolean {
  const gap = maxSyncGapMs(schedule);
  if (gap === null) return false;
  return Object.values(connections).some((connection) =>
    now - (connection.lastAttemptAt ?? connection.lastRunAt ?? connection.connectedAt) >= gap
  );
}

/** Change the schedule and re-arm at the new occurrence. */
export async function setSyncSchedule(schedule: SyncSchedule): Promise<void> {
  const parsed = parseSyncSchedule(schedule);
  if (!parsed) throw new Error("unsupported sync schedule");
  await mutateSchedule(async () => {
    await chrome.storage.local.set({ [SCHEDULE_KEY]: parsed });
    await armAlarm(parsed, { force: true });
  });
}

async function readSchedule(): Promise<SyncSchedule> {
  const values = await chrome.storage.local.get([SCHEDULE_KEY, LEGACY_PERIOD_KEY]);
  const stored = parseSyncSchedule(values[SCHEDULE_KEY]);
  if (stored) return stored;
  // First run under the calendar model: carry the interval choice across rather
  // than resetting someone who had deliberately turned auto-sync off.
  const migrated = syncScheduleFromPeriodMinutes(values[LEGACY_PERIOD_KEY]) ?? DEFAULT_SYNC_SCHEDULE;
  await chrome.storage.local.set({ [SCHEDULE_KEY]: migrated });
  await chrome.storage.local.remove(LEGACY_PERIOD_KEY);
  return migrated;
}

/**
 * Point the alarm at the next occurrence.
 *
 * Without `force`, an alarm already scheduled for a future instant is left
 * alone: a browser restart must not push the next run out, which is how an
 * alarm recreated on every startup could starve indefinitely.
 *
 * A *periodic* alarm is the exception. It is the interval schedule this
 * replaced, and it is always in the future by construction — so the guard above
 * would preserve the very thing the upgrade exists to remove, leaving someone
 * syncing on their old cadence while the panel reported the new one.
 */
async function armAlarm(schedule: SyncSchedule, options: { force?: boolean } = {}): Promise<void> {
  const existing = await chrome.alarms.get(SYNC_ALARM);
  const when = nextSyncTime(schedule);
  if (when === null) {
    if (existing) await chrome.alarms.clear(SYNC_ALARM);
    return;
  }
  const stale = existing?.periodInMinutes !== undefined;
  if (!options.force && !stale && existing && existing.scheduledTime > Date.now()) return;
  await chrome.alarms.clear(SYNC_ALARM);
  // A `when` in the past fires at once; the computed occurrence is always
  // ahead, and this keeps a clock change from producing an immediate wake.
  await chrome.alarms.create(SYNC_ALARM, { when: Math.max(when, Date.now() + 1_000) });
}

function mutateSchedule(mutation: () => Promise<void>): Promise<void> {
  const result = scheduleMutation.then(mutation, mutation);
  scheduleMutation = result.catch(() => undefined);
  return result;
}
