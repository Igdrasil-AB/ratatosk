import {
  exactOriginPattern,
  parseDiscoveredSupplierCandidateSet,
  parseDiscoveredSupplierProfile,
  requiredCandidateOrigins,
  extendCandidateDocumentOrigins,
  type DiscoveredSupplierCandidateSetV1,
  type DiscoveredSupplierProfileV1,
} from "../../../src/core/discovery";
import { OPERATIONAL_OUTCOME_CODES, operationalOutcomeLabel } from "../../../src/core/errors";
import { parseDiscoveryDiagnostic, type DiscoveryDiagnosticV1 } from "./discovery-diagnostic";
import {
  continueExplorationCheckpoint,
  explorationBudget,
  parseExplorationCheckpoint,
  type ExplorationCheckpoint,
} from "./discovery-explorer";
import { isSyncMonth } from "../../../src/core/sync-window";
import { LOCAL_DESTINATION_ID, type DestinationId } from "./storage";

const KEY = "supplierDiscovery.v1";
const ACTIVE_TTL_MS = 15 * 60_000;
const RESULT_TTL_MS = 24 * 60 * 60_000;
/**
 * A success card only has to confirm what already happened. The supplier is in
 * the list by then, carrying its own invoice count, so the card is redundant
 * within a minute — and keeping it for a day meant reopening the panel
 * tomorrow to a stale "connected" banner that had to be clicked away.
 */
const SUCCESS_TTL_MS = 45_000;
let transitionTail: Promise<void> = Promise.resolve();

export const DISCOVERY_FAILURE_MESSAGES = {
  notFoundPage: "No reusable invoice path was found on this page. Open the supplier's billing or invoice page and try again.",
  notFoundApp: "No reusable invoice path was found after checking this app's likely billing pages.",
  pageChanged: "The supplier page changed before Ratatosk could inspect it. Reopen the billing page and try again.",
  verificationFailed: "Ratatosk could not verify invoice downloads from this supplier.",
  alreadySupported: "This supplier is already supported. Connect it from the list above.",
  authExpired: "Ratatosk found a possible invoice source, but this supplier session has expired. Sign in and try again.",
  scopeDenied: "Ratatosk found a possible invoice source, but this account does not have billing access.",
  authBlocked: "Ratatosk found a possible invoice source, but the supplier blocked its session check. Keep the billing page open and try again.",
  transportFailed: "The supplier could not be reached reliably during verification. Keep the app open and try again.",
  timeCap: "Ratatosk reached its safe search-time limit before it could verify an invoice source.",
  pageCap: "Ratatosk checked its safe page limit without verifying an invoice source.",
  capacity: "Ratatosk has reached its local discovered-supplier limit. Disconnect one discovered supplier and try again.",
  monthRangeEmpty: "No invoices were available from that month. Choose an earlier month or leave it empty to collect all history.",
} as const;

type DiscoveryState =
  | { stage: "awaiting_permission" | "scanning"; runId: string; tabId: number; origin: string; checkpoint?: ExplorationCheckpoint; updatedAt: number }
  | { stage: "preview"; runId: string; candidates: DiscoveredSupplierCandidateSetV1; diagnostic: DiscoveryDiagnosticV1; updatedAt: number }
  | { stage: "confirming"; runId: string; candidates: DiscoveredSupplierCandidateSetV1; diagnostic: DiscoveryDiagnosticV1; fromMonth?: string; destinationId?: DestinationId; updatedAt: number }
  | { stage: "complete"; runId: string; vendorId: string; name: string; count: number; monthFallbackAll?: boolean; updatedAt: number }
  | {
    stage: "failed";
    runId: string;
    message: string;
    origins: string[];
    diagnostic?: DiscoveryDiagnosticV1;
    tabId?: number;
    origin?: string;
    checkpoint?: ExplorationCheckpoint;
    updatedAt: number;
  };

export interface PendingSupplierDiscovery {
  runId: string;
  candidates: DiscoveredSupplierCandidateSetV1;
  fromMonth?: string;
  /** The destination the user chose for this supplier before granting access. */
  destinationId?: DestinationId;
}

export type DiscoveryStatusView =
  | { stage: "idle" }
  | { stage: "scanning"; origin: string }
  | {
    stage: "preview";
    vendorId: string;
    name: string;
    origin: string;
    candidateCount: number;
    adapterId: DiscoveredSupplierProfileV1["adapter"]["id"];
    requiredOrigins: readonly string[];
    /** A retained plan re-mints the short-lived token this site issues to
     * itself. The person approving access is told before they grant it. */
    usesSessionToken: boolean;
  }
  | { stage: "connecting"; name: string }
  | { stage: "complete"; vendorId: string; name: string; count: number; monthFallbackAll?: boolean }
  | {
    stage: "failed";
    message: string;
    reason: "not_found" | "limit_reached" | "failed";
    diagnosticAvailable: boolean;
    canSearchDeeper?: true;
    deepRemainingMs?: number;
    origin?: string;
  };

export async function beginSupplierDiscovery(tabId: number, origin: string): Promise<string> {
  return transition(async () => {
    assertTabId(tabId);
    exactOriginPattern(origin);
    const runId = crypto.randomUUID();
    await write({ stage: "awaiting_permission", runId, tabId, origin, updatedAt: Date.now() });
    return runId;
  });
}

export async function markSupplierDiscoveryScanning(): Promise<{ runId: string; tabId: number; origin: string; checkpoint?: ExplorationCheckpoint } | undefined> {
  return transition(async () => {
    const state = await read();
    if (!state || (state.stage !== "awaiting_permission" && state.stage !== "scanning")) return undefined;
    await write({ ...state, stage: "scanning", updatedAt: Date.now() });
    return { runId: state.runId, tabId: state.tabId, origin: state.origin, ...(state.checkpoint ? { checkpoint: state.checkpoint } : {}) };
  });
}

/** Store only the validated structural scheduler state while a scan is active. */
export async function checkpointSupplierDiscovery(
  runId: string,
  checkpoint: ExplorationCheckpoint,
): Promise<boolean> {
  return transition(async () => {
    const state = await read();
    if (!state || state.stage !== "scanning" || state.runId !== runId) return false;
    const safeCheckpoint = parseExplorationCheckpoint(checkpoint);
    if (!safeCheckpoint) return false;
    await write({ ...state, checkpoint: safeCheckpoint, updatedAt: Date.now() });
    return true;
  });
}

export async function setSupplierDiscoveryPreview(
  runId: string,
  candidates: DiscoveredSupplierCandidateSetV1,
  diagnostic: DiscoveryDiagnosticV1,
): Promise<boolean> {
  return transition(async () => {
    const state = await read();
    if (!state || state.runId !== runId || state.stage !== "scanning") return false;
    await write({
    stage: "preview",
    runId,
    candidates: parseDiscoveredSupplierCandidateSet(candidates),
    diagnostic: parseDiscoveryDiagnostic(diagnostic),
    updatedAt: Date.now(),
    });
    return true;
  });
}

export async function beginSupplierDiscoveryConnect(
  vendorId: string,
  fromMonth?: string,
  destinationId?: DestinationId,
): Promise<PendingSupplierDiscovery | undefined> {
  return transition(async () => {
    const state = await read();
    if (!state || state.stage !== "preview" || state.candidates.id !== vendorId) return undefined;
    if (fromMonth && !isSyncMonth(fromMonth)) return undefined;
    await write({
      stage: "confirming",
      runId: state.runId,
      candidates: state.candidates,
      diagnostic: state.diagnostic,
      ...(fromMonth ? { fromMonth } : {}),
      ...(destinationId ? { destinationId } : {}),
      updatedAt: Date.now(),
    });
    return {
      runId: state.runId,
      candidates: state.candidates,
      ...(fromMonth ? { fromMonth } : {}),
      ...(destinationId ? { destinationId } : {}),
    };
  });
}

export async function getPendingSupplierDiscoveryConnect(): Promise<PendingSupplierDiscovery | undefined> {
  const state = await read();
  return state?.stage === "confirming"
    ? {
      runId: state.runId,
      candidates: state.candidates,
      ...(state.fromMonth ? { fromMonth: state.fromMonth } : {}),
      ...(state.destinationId ? { destinationId: state.destinationId } : {}),
    }
    : undefined;
}

export async function getPendingSupplierDiscoveryDiagnostic(runId: string): Promise<DiscoveryDiagnosticV1 | undefined> {
  const state = await read();
  return state?.stage === "confirming" && state.runId === runId ? state.diagnostic : undefined;
}

export async function restoreSupplierDiscoveryPreview(runId: string): Promise<boolean> {
  return transition(async () => {
    const state = await read();
    if (!state || state.runId !== runId || state.stage !== "confirming") return false;
    await write({
      stage: "preview",
      runId: state.runId,
      candidates: state.candidates,
      diagnostic: state.diagnostic,
      updatedAt: Date.now(),
    });
    return true;
  });
}

export async function requireSupplierDiscoveryDocumentOrigins(runId: string, origins: readonly string[]): Promise<boolean> {
  return transition(async () => {
    const state = await read();
    if (!state || state.runId !== runId || state.stage !== "confirming") return false;
    const candidates = extendCandidateDocumentOrigins(state.candidates, origins);
    await write({
    stage: "preview",
    runId,
    candidates,
    diagnostic: state.diagnostic,
    updatedAt: Date.now(),
    });
    return true;
  });
}

export async function completeSupplierDiscovery(
  runId: string,
  vendorId: string,
  name: string,
  count: number,
  monthFallbackAll = false,
): Promise<boolean> {
  return transition(async () => {
    const state = await read();
    if (!state || state.runId !== runId || state.stage !== "confirming") return false;
    await write({
      stage: "complete",
      runId,
      vendorId: safeId(vendorId),
      name: safeName(name),
      count: Math.max(0, Math.min(500, Math.trunc(count))),
      ...(monthFallbackAll ? { monthFallbackAll: true } : {}),
      updatedAt: Date.now(),
    });
    return true;
  });
}

export async function failSupplierDiscovery(
  runId: string | undefined,
  message: string,
  origins: readonly string[] = [],
  diagnostic?: DiscoveryDiagnosticV1,
): Promise<boolean> {
  return transition(async () => {
  let resumable: { tabId: number; origin: string; checkpoint: ExplorationCheckpoint } | undefined;
  if (runId) {
    const state = await read();
    if (!state || state.runId !== runId || (state.stage !== "scanning" && state.stage !== "confirming")) return false;
    if (state.stage === "scanning" && state.checkpoint) {
      resumable = { tabId: state.tabId, origin: state.origin, checkpoint: state.checkpoint };
    }
  }
  await write({
    stage: "failed",
    runId: runId ?? crypto.randomUUID(),
    message: safeMessage(message),
    origins: safeOrigins(origins),
    diagnostic: diagnostic ? parseDiscoveryDiagnostic(diagnostic) : undefined,
    ...(resumable ? { tabId: resumable.tabId, origin: resumable.origin, checkpoint: resumable.checkpoint } : {}),
    updatedAt: Date.now(),
  });
  return true;
  });
}

/** Restart only the unfinished frontier under the explicit deep envelope. */
export async function continueSupplierDiscovery(): Promise<{ runId: string; tabId: number; origin: string; checkpoint: ExplorationCheckpoint } | undefined> {
  return transition(async () => {
    const state = await read();
    if (
      !state || state.stage !== "failed" || state.diagnostic?.result !== "limit_reached" ||
      state.tabId === undefined || !state.origin || !state.checkpoint
    ) return undefined;
    const checkpoint = continueExplorationCheckpoint(state.checkpoint);
    if (!checkpoint) return undefined;
    await write({
      stage: "scanning",
      runId: state.runId,
      tabId: state.tabId,
      origin: state.origin,
      checkpoint,
      updatedAt: Date.now(),
    });
    return { runId: state.runId, tabId: state.tabId, origin: state.origin, checkpoint };
  });
}

export async function getSupplierDiscoveryDiagnostic(): Promise<DiscoveryDiagnosticV1 | undefined> {
  const state = await read();
  return state?.stage === "failed" && state.diagnostic ? parseDiscoveryDiagnostic(state.diagnostic) : undefined;
}

export async function clearSupplierDiscovery(): Promise<void> {
  await transition(() => chrome.storage.session.remove(KEY));
}

export async function cancelSupplierDiscovery(): Promise<readonly string[]> {
  return transition(async () => {
  const state = await read();
  const origins = state?.stage === "awaiting_permission" || state?.stage === "scanning"
    ? [`${state.origin}/*`]
    : state?.stage === "preview" || state?.stage === "confirming"
      ? requiredCandidateOrigins(state.candidates)
      : state?.stage === "failed" ? state.origins : [];
  await chrome.storage.session.remove(KEY);
  return origins;
  });
}

export async function getSupplierDiscoveryStatus(): Promise<DiscoveryStatusView> {
  const state = await read();
  if (!state) return { stage: "idle" };
  switch (state.stage) {
    case "awaiting_permission":
    case "scanning": return { stage: "scanning", origin: state.origin };
    case "preview": return {
      stage: "preview",
      vendorId: state.candidates.id,
      name: state.candidates.displayName,
      origin: state.candidates.primaryOrigin,
      candidateCount: state.candidates.candidates[0].candidateCount,
      adapterId: state.candidates.candidates[0].adapter.id,
      requiredOrigins: requiredCandidateOrigins(state.candidates),
      // Any retained candidate may be the one that runs, so the disclosure
      // covers the whole set rather than only the highest-ranked plan.
      usesSessionToken: state.candidates.candidates.some((candidate) => Boolean(candidate.recipe.auth.token)),
    };
    case "confirming": return { stage: "connecting", name: state.candidates.displayName };
    case "complete": return {
      stage: "complete",
      vendorId: state.vendorId,
      name: state.name,
      count: state.count,
      ...(state.monthFallbackAll ? { monthFallbackAll: true } : {}),
    };
    case "failed": return {
      ...(state.checkpoint?.mode === "fast" && state.diagnostic?.result === "limit_reached" && state.origin && state.tabId !== undefined
        ? {
          canSearchDeeper: true as const,
          deepRemainingMs: Math.max(0, explorationBudget("deep").durationMs - state.checkpoint.elapsedMs),
          origin: state.origin,
        }
        : {}),
      stage: "failed",
      message: state.message,
      reason: state.diagnostic?.result === "not_found" || state.diagnostic?.result === "limit_reached"
        ? state.diagnostic.result
        : "failed",
      diagnosticAvailable: Boolean(state.diagnostic),
    };
  }
}

async function read(): Promise<DiscoveryState | undefined> {
  const raw = (await chrome.storage.session.get(KEY))[KEY];
  const state = parseState(raw);
  if (!state) {
    if (raw !== undefined) await chrome.storage.session.remove(KEY);
    return undefined;
  }
  // A failure keeps its full window: its diagnostic is the only record of why,
  // and a person may come back for it. A success has nothing left to offer.
  const ttl = state.stage === "complete"
    ? SUCCESS_TTL_MS
    : state.stage === "failed" ? RESULT_TTL_MS : ACTIVE_TTL_MS;
  if (Date.now() - state.updatedAt > ttl) {
    await chrome.storage.session.remove(KEY);
    return undefined;
  }
  return state;
}

function parseState(value: unknown): DiscoveryState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!Number.isFinite(raw.updatedAt) || Number(raw.updatedAt) <= 0 || typeof raw.stage !== "string") return undefined;
  const updatedAt = Number(raw.updatedAt);
  if (typeof raw.runId !== "string" || !/^[0-9a-f-]{36}$/i.test(raw.runId)) return undefined;
  if (raw.stage === "awaiting_permission" || raw.stage === "scanning") {
    if (!Number.isInteger(raw.tabId) || Number(raw.tabId) < 0 || typeof raw.origin !== "string") return undefined;
    try { exactOriginPattern(raw.origin); } catch { return undefined; }
    const checkpoint = raw.checkpoint === undefined ? undefined : parseExplorationCheckpoint(raw.checkpoint);
    if (raw.checkpoint !== undefined && !checkpoint) return undefined;
    return { stage: raw.stage, runId: raw.runId, tabId: Number(raw.tabId), origin: raw.origin, ...(checkpoint ? { checkpoint } : {}), updatedAt };
  }
  if (raw.stage === "preview" || raw.stage === "confirming") {
    try {
      const fromMonth = raw.stage === "confirming" && typeof raw.fromMonth === "string"
        ? raw.fromMonth
        : undefined;
      if (raw.stage === "confirming" && raw.fromMonth !== undefined && (!fromMonth || !isSyncMonth(fromMonth))) {
        return undefined;
      }
      // A destination is an identity, so a persisted one is re-parsed rather
      // than trusted: a malformed value drops the binding and the connect flow
      // asks again, instead of admitting a supplier to an unknown destination.
      const destinationId = raw.stage === "confirming" ? parseDestinationId(raw.destinationId) : undefined;
      if (raw.stage === "confirming" && raw.destinationId !== undefined && !destinationId) return undefined;
      return {
        stage: raw.stage,
        runId: raw.runId, candidates: parseDiscoveredSupplierCandidateSet(raw.candidates),
        diagnostic: parseDiscoveryDiagnostic(raw.diagnostic),
        ...(fromMonth ? { fromMonth } : {}),
        ...(destinationId ? { destinationId } : {}),
        updatedAt,
      };
    } catch {
      // Discard an interrupted pre-candidate-set handoff rather than broadening
      // or guessing its permissions after an extension update.
      return undefined;
    }
  }
  if (raw.stage === "complete") {
    if (typeof raw.vendorId !== "string" || typeof raw.name !== "string" || !Number.isFinite(raw.count)) return undefined;
    if (raw.monthFallbackAll !== undefined && raw.monthFallbackAll !== true) return undefined;
    try {
      return {
        stage: raw.stage,
        runId: raw.runId,
        vendorId: safeId(raw.vendorId),
        name: safeName(raw.name),
        count: Math.max(0, Math.min(500, Math.trunc(Number(raw.count)))),
        ...(raw.monthFallbackAll === true ? { monthFallbackAll: true } : {}),
        updatedAt,
      };
    } catch {
      return undefined;
    }
  }
  if (raw.stage === "failed" && typeof raw.message === "string") {
    try {
      const checkpoint = raw.checkpoint === undefined ? undefined : parseExplorationCheckpoint(raw.checkpoint);
      if (raw.checkpoint !== undefined && !checkpoint) return undefined;
      const hasContinuation = raw.tabId !== undefined || raw.origin !== undefined || checkpoint !== undefined;
      if (hasContinuation) {
        if (!Number.isInteger(raw.tabId) || Number(raw.tabId) < 0 || typeof raw.origin !== "string" || !checkpoint) return undefined;
        exactOriginPattern(raw.origin);
      }
      return {
        stage: raw.stage,
        runId: raw.runId, message: safeMessage(raw.message),
        origins: safeOrigins(raw.origins),
        diagnostic: raw.diagnostic === undefined ? undefined : parseDiscoveryDiagnostic(raw.diagnostic),
        ...(hasContinuation ? { tabId: Number(raw.tabId), origin: raw.origin as string, checkpoint: checkpoint! } : {}),
        updatedAt,
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function write(state: DiscoveryState): Promise<void> {
  await chrome.storage.session.set({ [KEY]: state });
}

/** Chrome storage has no compare-and-swap. A service-worker-local FIFO makes
 * each read/verify/write lifecycle transition atomic relative to every other
 * transition in this worker; durable run IDs reject results after restart. */
function transition<T>(operation: () => Promise<T>): Promise<T> {
  const task = transitionTail.then(operation, operation);
  transitionTail = task.then(() => undefined, () => undefined);
  return task;
}

function assertTabId(value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new Error("A normal supplier tab is required.");
}

function safeId(value: string): string {
  if (!/^discovered-[a-z0-9-]{1,78}$/.test(value)) throw new Error("Invalid discovered supplier id.");
  return value;
}

function safeName(value: string): string {
  const name = value.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name) throw new Error("Invalid discovered supplier name.");
  return name;
}

function safeMessage(value: string): string {
  const known = [
    ...Object.values(DISCOVERY_FAILURE_MESSAGES),
    ...OPERATIONAL_OUTCOME_CODES.map(operationalOutcomeLabel),
  ];
  return known.includes(value) ? value : DISCOVERY_FAILURE_MESSAGES.verificationFailed;
}

function safeOrigins(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error("Invalid discovery origins.");
  return [...new Set(value.map((origin) => {
    if (typeof origin !== "string" || !origin.endsWith("/*")) throw new Error("Invalid discovery origin.");
    return exactOriginPattern(new URL(origin.slice(0, -2)).origin);
  }))];
}

/** Narrow a persisted destination id without trusting the stored string. */
function parseDestinationId(value: unknown): DestinationId | undefined {
  if (typeof value !== "string") return undefined;
  if (value === LOCAL_DESTINATION_ID) return LOCAL_DESTINATION_ID;
  return value.startsWith("igdrasil:") && value.length > "igdrasil:".length && value.length <= 240
    ? value as DestinationId
    : undefined;
}
