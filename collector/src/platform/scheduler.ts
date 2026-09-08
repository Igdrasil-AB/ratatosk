import { getConnections } from "./storage";

import {
  DEFAULT_SYNC_SCHEDULE,
  maxSyncGapMs,
  nextSyncTime,
  parseSyncSchedule,
  syncScheduleFromPeriodMinutes,
  type SyncSchedule,
} from "../../../src/core/sync-schedule";

/**
 * Durable local scheduling for the ephemeral MV3 service worker.
 *
 * Chrome alarms are wake-up hints, not the source of truth. The user's cadence
 * and a small versioned runtime record live in extension-local storage so a
 * missing alarm, browser restart, extension update, or interrupted run can be
 * reconciled without a queue or external scheduler.
 */
const SYNC_ALARM = "collector-sync";
const SCHEDULE_KEY = "syncScheduleV1";
const LEGACY_PERIOD_KEY = "schedulePeriodMinutes";
const RUNTIME_KEY = "scheduleRuntimeV1";
const MIN_WAKE_DELAY_MS = 60_000;
const RUN_LEASE_MS = 10 * 60_000;
const MAX_RUNTIME_FUTURE_MS = 32 * 24 * 60 * 60_000;
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000;
const ALARM_TOLERANCE_MS = 1_000;

interface ActiveScheduleRun {
  runId: string;
  startedAt: number;
  leaseUntil: number;
  fullSyncDue: boolean;
}

interface ScheduleRuntimeV1 {
  version: 1;
  nextFullSyncAt: number | null;
  activeRun?: ActiveScheduleRun;
}

export interface ScheduleClaim {
  runId: string;
  fullSyncDue: boolean;
}

export interface ScheduleWakeContext {
  retryDue: boolean;
  nextRetryAt: number | null;
  now?: number;
}

let schedulerOperations = Promise.resolve();

/** Reconcile persisted schedule state with the browser alarm. */
export function ensureSyncAlarm(nextRetryAt?: number | null, now = Date.now()): Promise<void> {
  return serialized(async () => {
    const existing = await chrome.alarms.get(SYNC_ALARM);
    const schedule = await readSchedule();
    const runtime = await readRuntime(schedule, now, existing);
    if (recoverExpiredRun(runtime, now)) await persistRuntime(runtime);
    await reconcileAlarm(schedule, runtime, nextRetryAt, now, existing);
  });
}

/**
 * Atomically claim due scheduled work in this service-worker instance. A short
 * persisted lease prevents a newly restarted worker from duplicating an active
 * run; an expired lease makes an interrupted full sweep due again.
 */
export function claimScheduledWake(context: ScheduleWakeContext): Promise<ScheduleClaim | null> {
  return serialized(async () => {
    const now = context.now ?? Date.now();
    const existing = await chrome.alarms.get(SYNC_ALARM);
    const schedule = await readSchedule();
    const runtime = await readRuntime(schedule, now, existing);
    const recovered = recoverExpiredRun(runtime, now);

    if (schedule.mode === "off") {
      if (runtime.nextFullSyncAt !== null || runtime.activeRun) {
        runtime.nextFullSyncAt = null;
        delete runtime.activeRun;
        await persistRuntime(runtime);
      } else if (recovered) await persistRuntime(runtime);
      await clearAlarm(existing);
      return null;
    }

    if (runtime.activeRun) {
      if (recovered) await persistRuntime(runtime);
      await reconcileAlarm(schedule, runtime, context.nextRetryAt, now, existing);
      return null;
    }

    const fullSyncDue = runtime.nextFullSyncAt === null || runtime.nextFullSyncAt <= now;
    if (!fullSyncDue && !context.retryDue) {
      if (recovered) await persistRuntime(runtime);
      await reconcileAlarm(schedule, runtime, context.nextRetryAt, now, existing);
      return null;
    }

    const runId = crypto.randomUUID();
    runtime.activeRun = { runId, startedAt: now, leaseUntil: now + RUN_LEASE_MS, fullSyncDue };
    if (fullSyncDue) runtime.nextFullSyncAt = nextSyncTime(schedule, new Date(now));
    await persistRuntime(runtime);
    await reconcileAlarm(schedule, runtime, context.nextRetryAt, now, existing);
    return { runId, fullSyncDue };
  });
}

/** Finish only the claim that is still active; stale completions are harmless. */
export function completeScheduledWake(
  claim: ScheduleClaim,
  nextRetryAt: number | null,
  now = Date.now(),
): Promise<void> {
  return serialized(async () => {
    const existing = await chrome.alarms.get(SYNC_ALARM);
    const schedule = await readSchedule();
    const runtime = await readRuntime(schedule, now, existing);
    if (runtime.activeRun?.runId === claim.runId) {
      delete runtime.activeRun;
      await persistRuntime(runtime);
    }
    await reconcileAlarm(schedule, runtime, nextRetryAt, now, existing);
  });
}

export function isSyncAlarm(name: string): boolean {
  return name === SYNC_ALARM;
}

/** Current calendar schedule and next wake, including retries. */
export async function getScheduleInfo(): Promise<{ schedule: SyncSchedule; nextRunAt: number | null }> {
  const schedule = await readSchedule();
  return { schedule, nextRunAt: (await chrome.alarms.get(SYNC_ALARM))?.scheduledTime ?? null };
}

export function setSyncSchedule(schedule: SyncSchedule, now = Date.now()): Promise<void> {
  const parsed = parseSyncSchedule(schedule);
  if (!parsed) return Promise.reject(new Error("unsupported sync schedule"));
  return serialized(async () => {
    await chrome.storage.local.set({ [SCHEDULE_KEY]: parsed });
    const runtime: ScheduleRuntimeV1 = { version: 1, nextFullSyncAt: nextSyncTime(parsed, new Date(now)) };
    await persistRuntime(runtime);
    await reconcileAlarm(parsed, runtime, null, now, await chrome.alarms.get(SYNC_ALARM));
  });
}

export function rearmSyncAlarm(): Promise<void> {
  return serialized(async () => {
    const schedule = await readSchedule();
    const runtime: ScheduleRuntimeV1 = { version: 1, nextFullSyncAt: nextSyncTime(schedule) };
    await persistRuntime(runtime);
    await reconcileAlarm(schedule, runtime, null, Date.now(), await chrome.alarms.get(SYNC_ALARM));
  });
}

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

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = schedulerOperations.then(operation, operation);
  schedulerOperations = result.then(() => undefined, () => undefined);
  return result;
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

async function readRuntime(
  schedule: SyncSchedule,
  now: number,
  existingAlarm?: chrome.alarms.Alarm,
): Promise<ScheduleRuntimeV1> {
  const values = await chrome.storage.local.get(RUNTIME_KEY);
  const parsed = parseRuntime(values[RUNTIME_KEY], schedule, now);
  if (parsed) return parsed;
  const existingWake = existingAlarm?.scheduledTime;
  const usableExistingWake = typeof existingWake === "number" && Number.isFinite(existingWake)
    && existingWake > 0 && existingWake <= now + MAX_RUNTIME_FUTURE_MS
    ? existingWake
    : undefined;
  const catchUpDue = isSyncCatchUpDue(await getConnections(), schedule, now);
  const runtime: ScheduleRuntimeV1 = {
    version: 1,
    nextFullSyncAt: schedule.mode !== "off" ? (catchUpDue ? now : usableExistingWake ?? nextSyncTime(schedule, new Date(now))) : null,
  };
  await persistRuntime(runtime);
  return runtime;
}

function parseRuntime(value: unknown, schedule: SyncSchedule, now: number): ScheduleRuntimeV1 | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  const allowed = new Set(["version", "nextFullSyncAt", "activeRun"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (schedule.mode === "off") {
    if (value.nextFullSyncAt !== null) return undefined;
  } else if (!isTimestamp(value.nextFullSyncAt) || value.nextFullSyncAt > now + MAX_RUNTIME_FUTURE_MS) {
    return undefined;
  }
  if (value.activeRun !== undefined && (!parseActiveRun(value.activeRun) || value.activeRun.leaseUntil > now + RUN_LEASE_MS + CLOCK_SKEW_TOLERANCE_MS)) return undefined;
  return structuredClone(value) as unknown as ScheduleRuntimeV1;
}

function parseActiveRun(value: unknown): value is ActiveScheduleRun {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 4
    && keys.every((key) => ["runId", "startedAt", "leaseUntil", "fullSyncDue"].includes(key))
    && typeof value.runId === "string"
    && /^[0-9a-f-]{36}$/i.test(value.runId)
    && isTimestamp(value.startedAt)
    && isTimestamp(value.leaseUntil)
    && value.leaseUntil > value.startedAt
    && value.leaseUntil - value.startedAt <= RUN_LEASE_MS
    && typeof value.fullSyncDue === "boolean";
}

function recoverExpiredRun(runtime: ScheduleRuntimeV1, now: number): boolean {
  const active = runtime.activeRun;
  if (!active || active.leaseUntil > now) return false;
  if (active.fullSyncDue) runtime.nextFullSyncAt = Math.min(runtime.nextFullSyncAt ?? now, now);
  delete runtime.activeRun;
  return true;
}

async function reconcileAlarm(
  schedule: SyncSchedule,
  runtime: ScheduleRuntimeV1,
  nextRetryAt: number | null | undefined,
  now: number,
  existing?: chrome.alarms.Alarm,
): Promise<void> {
  if (schedule.mode === "off") {
    await clearAlarm(existing);
    return;
  }
  const target = runtime.activeRun?.leaseUntil ?? earliest(runtime.nextFullSyncAt, validRetryAt(nextRetryAt, now));
  const when = Math.max(target ?? now + MIN_WAKE_DELAY_MS, now + MIN_WAKE_DELAY_MS);
  const earlierWakeIsStillUseful = nextRetryAt === undefined
    && existing?.periodInMinutes === undefined
    && existing !== undefined
    && existing.scheduledTime > now
    && existing.scheduledTime < when;
  if (earlierWakeIsStillUseful) return;
  const alreadyCorrect = existing
    && existing.periodInMinutes === undefined
    && Math.abs(existing.scheduledTime - when) <= ALARM_TOLERANCE_MS;
  if (alreadyCorrect) return;
  await clearAlarm(existing);
  await chrome.alarms.create(SYNC_ALARM, { when });
}

async function clearAlarm(existing?: chrome.alarms.Alarm): Promise<void> {
  if (existing) await chrome.alarms.clear(SYNC_ALARM);
}

function earliest(left: number | null, right: number | undefined): number | undefined {
  if (left === null) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function validRetryAt(value: number | null | undefined, now: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= now + MAX_RUNTIME_FUTURE_MS
    ? value
    : undefined;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function persistRuntime(runtime: ScheduleRuntimeV1): Promise<void> {
  await chrome.storage.local.set({ [RUNTIME_KEY]: runtime });
}
