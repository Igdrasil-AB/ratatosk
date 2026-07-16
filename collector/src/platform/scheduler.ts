/**
 * Durable local scheduling for the ephemeral MV3 service worker.
 *
 * Chrome alarms are wake-up hints, not the source of truth. The user's cadence
 * and a small versioned runtime record live in extension-local storage so a
 * missing alarm, browser restart, extension update, or interrupted run can be
 * reconciled without a queue or external scheduler.
 */
const SYNC_ALARM = "collector-sync";
const DEFAULT_PERIOD_MINUTES = 720;
const SCHEDULE_KEY = "schedulePeriodMinutes";
const RUNTIME_KEY = "scheduleRuntimeV1";
const ALLOWED_PERIODS = new Set([0, 360, 720, 1440]);
const MIN_WAKE_DELAY_MS = 60_000;
const RUN_LEASE_MS = 10 * 60_000;
const MAX_RUNTIME_FUTURE_MS = 2 * 24 * 60 * 60_000;
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
    const periodMinutes = await readPeriodMinutes();
    const runtime = await readRuntime(periodMinutes, now, existing);
    if (recoverExpiredRun(runtime, now)) await persistRuntime(runtime);
    await reconcileAlarm(periodMinutes, runtime, nextRetryAt, now, existing);
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
    const periodMinutes = await readPeriodMinutes();
    const runtime = await readRuntime(periodMinutes, now, existing);
    const recovered = recoverExpiredRun(runtime, now);

    if (periodMinutes === 0) {
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
      await reconcileAlarm(periodMinutes, runtime, context.nextRetryAt, now, existing);
      return null;
    }

    const fullSyncDue = runtime.nextFullSyncAt === null || runtime.nextFullSyncAt <= now;
    if (!fullSyncDue && !context.retryDue) {
      if (recovered) await persistRuntime(runtime);
      await reconcileAlarm(periodMinutes, runtime, context.nextRetryAt, now, existing);
      return null;
    }

    const runId = crypto.randomUUID();
    runtime.activeRun = { runId, startedAt: now, leaseUntil: now + RUN_LEASE_MS, fullSyncDue };
    if (fullSyncDue) runtime.nextFullSyncAt = now + periodMinutes * 60_000;
    await persistRuntime(runtime);
    await reconcileAlarm(periodMinutes, runtime, context.nextRetryAt, now, existing);
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
    const periodMinutes = await readPeriodMinutes();
    const runtime = await readRuntime(periodMinutes, now, existing);
    if (runtime.activeRun?.runId === claim.runId) {
      delete runtime.activeRun;
      await persistRuntime(runtime);
    }
    await reconcileAlarm(periodMinutes, runtime, nextRetryAt, now, existing);
  });
}

export function isSyncAlarm(name: string): boolean {
  return name === SYNC_ALARM;
}

/** Current cadence plus the next actual wake, including an earlier retry. */
export async function getScheduleInfo(): Promise<{ periodMinutes: number | null; nextRunAt: number | null }> {
  const periodMinutes = await readPeriodMinutes();
  let alarm = await chrome.alarms.get(SYNC_ALARM);
  if (periodMinutes > 0 && !alarm) {
    await ensureSyncAlarm();
    alarm = await chrome.alarms.get(SYNC_ALARM);
  }
  return {
    periodMinutes: periodMinutes > 0 ? periodMinutes : null,
    nextRunAt: alarm?.scheduledTime ?? null,
  };
}

/** Change cadence and reset only scheduler runtime, never vendor run history. */
export function setSchedulePeriod(periodMinutes: number, now = Date.now()): Promise<void> {
  if (!ALLOWED_PERIODS.has(periodMinutes)) return Promise.reject(new Error("unsupported schedule period"));
  return serialized(async () => {
    await chrome.storage.local.set({ [SCHEDULE_KEY]: periodMinutes });
    const runtime: ScheduleRuntimeV1 = {
      version: 1,
      nextFullSyncAt: periodMinutes > 0 ? now + periodMinutes * 60_000 : null,
    };
    await persistRuntime(runtime);
    const existing = await chrome.alarms.get(SYNC_ALARM);
    await reconcileAlarm(periodMinutes, runtime, null, now, existing);
  });
}

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = schedulerOperations.then(operation, operation);
  schedulerOperations = result.then(() => undefined, () => undefined);
  return result;
}

async function readPeriodMinutes(): Promise<number> {
  const values = await chrome.storage.local.get(SCHEDULE_KEY);
  const stored = values[SCHEDULE_KEY];
  if (typeof stored === "number" && ALLOWED_PERIODS.has(stored)) return stored;
  await chrome.storage.local.set({ [SCHEDULE_KEY]: DEFAULT_PERIOD_MINUTES });
  return DEFAULT_PERIOD_MINUTES;
}

async function readRuntime(
  periodMinutes: number,
  now: number,
  existingAlarm?: chrome.alarms.Alarm,
): Promise<ScheduleRuntimeV1> {
  const values = await chrome.storage.local.get(RUNTIME_KEY);
  const parsed = parseRuntime(values[RUNTIME_KEY], periodMinutes, now);
  if (parsed) return parsed;
  const existingWake = existingAlarm?.scheduledTime;
  const usableExistingWake = typeof existingWake === "number" && Number.isFinite(existingWake)
    && existingWake > now && existingWake <= now + MAX_RUNTIME_FUTURE_MS
    ? existingWake
    : undefined;
  const runtime: ScheduleRuntimeV1 = {
    version: 1,
    nextFullSyncAt: periodMinutes > 0 ? usableExistingWake ?? now + MIN_WAKE_DELAY_MS : null,
  };
  await persistRuntime(runtime);
  return runtime;
}

function parseRuntime(value: unknown, periodMinutes: number, now: number): ScheduleRuntimeV1 | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  const allowed = new Set(["version", "nextFullSyncAt", "activeRun"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (periodMinutes === 0) {
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
  periodMinutes: number,
  runtime: ScheduleRuntimeV1,
  nextRetryAt: number | null | undefined,
  now: number,
  existing?: chrome.alarms.Alarm,
): Promise<void> {
  if (periodMinutes === 0) {
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
  chrome.alarms.create(SYNC_ALARM, { when });
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
