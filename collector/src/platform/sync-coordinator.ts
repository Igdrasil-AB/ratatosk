import { runAllConnected, runVendorById, type SyncTrigger, type VendorRunSummary } from "./collector";
import { claimScheduledWake, completeScheduledWake, ensureSyncAlarm } from "./scheduler";
import { getConnections, type Connection } from "./storage";

type SyncRequest =
  | { trigger: "alarm" | "startup" }
  | { trigger: "manual" | "connect"; vendorId?: string };

const MAX_RETRY_LOOKAHEAD_MS = 2 * 24 * 60 * 60_000;
let scheduledSync: Promise<VendorRunSummary[]> | undefined;

/** Every service-worker trigger enters through this coordinator. */
export function requestSync(request: SyncRequest): Promise<VendorRunSummary[]> {
  switch (request.trigger) {
    case "alarm":
    case "startup":
      return requestScheduledSync();
    case "manual":
    case "connect":
      return requestImmediateSync(request.trigger, request.vendorId);
  }
}

function requestScheduledSync(): Promise<VendorRunSummary[]> {
  if (scheduledSync) return scheduledSync;
  const task = executeScheduledSync().finally(() => {
    if (scheduledSync === task) scheduledSync = undefined;
  });
  scheduledSync = task;
  return task;
}

async function executeScheduledSync(): Promise<VendorRunSummary[]> {
  const now = Date.now();
  const before = await getConnections();
  const retry = retrySnapshot(before, now);
  const claim = await claimScheduledWake({ retryDue: retry.dueVendorIds.length > 0, nextRetryAt: retry.nextRetryAt ?? null, now });
  if (!claim) return [];

  try {
    const vendorIds = claim.fullSyncDue
      ? Object.values(before).filter((connection) => connection.lastStatus !== "auth_expired").map((connection) => connection.vendorId)
      : retry.dueVendorIds;
    return await runVendors(vendorIds, "scheduled");
  } finally {
    const after = await getConnections();
    await completeScheduledWake(claim, retrySnapshot(after, Date.now()).nextRetryAt ?? null);
  }
}

async function requestImmediateSync(trigger: "manual" | "connect", vendorId?: string): Promise<VendorRunSummary[]> {
  const summaries = vendorId
    ? [await runVendorById(vendorId, trigger)]
    : await runAllConnected(trigger);
  const retry = retrySnapshot(await getConnections(), Date.now());
  await ensureSyncAlarm(retry.nextRetryAt ?? null);
  return summaries;
}

async function runVendors(vendorIds: readonly string[], trigger: SyncTrigger): Promise<VendorRunSummary[]> {
  const summaries: VendorRunSummary[] = [];
  for (const vendorId of [...new Set(vendorIds)]) summaries.push(await runVendorById(vendorId, trigger));
  return summaries;
}

function retrySnapshot(connections: Record<string, Connection>, now: number): {
  dueVendorIds: string[];
  nextRetryAt?: number;
} {
  const dueVendorIds: string[] = [];
  let nextRetryAt: number | undefined;
  for (const connection of Object.values(connections)) {
    const retryAt = connection.nextEligibleRunAt;
    if (typeof retryAt !== "number" || !Number.isFinite(retryAt) || retryAt <= 0) continue;
    if (retryAt <= now) dueVendorIds.push(connection.vendorId);
    else if (retryAt <= now + MAX_RETRY_LOOKAHEAD_MS) nextRetryAt = Math.min(nextRetryAt ?? retryAt, retryAt);
  }
  return { dueVendorIds, ...(nextRetryAt ? { nextRetryAt } : {}) };
}
