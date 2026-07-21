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

const KEY = "supplierDiscovery.v1";
const ACTIVE_TTL_MS = 15 * 60_000;
const RESULT_TTL_MS = 24 * 60 * 60_000;
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
} as const;

type DiscoveryState =
  | { stage: "awaiting_permission" | "scanning"; runId: string; tabId: number; origin: string; updatedAt: number }
  | { stage: "preview" | "confirming"; runId: string; candidates: DiscoveredSupplierCandidateSetV1; diagnostic: DiscoveryDiagnosticV1; updatedAt: number }
  | { stage: "complete"; runId: string; vendorId: string; name: string; count: number; updatedAt: number }
  | { stage: "failed"; runId: string; message: string; origins: string[]; diagnostic?: DiscoveryDiagnosticV1; updatedAt: number };

export interface PendingSupplierDiscovery {
  runId: string;
  candidates: DiscoveredSupplierCandidateSetV1;
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
  }
  | { stage: "connecting"; name: string }
  | { stage: "complete"; vendorId: string; name: string; count: number }
  | { stage: "failed"; message: string; diagnosticAvailable: boolean };

export async function beginSupplierDiscovery(tabId: number, origin: string): Promise<string> {
  return transition(async () => {
    assertTabId(tabId);
    exactOriginPattern(origin);
    const runId = crypto.randomUUID();
    await write({ stage: "awaiting_permission", runId, tabId, origin, updatedAt: Date.now() });
    return runId;
  });
}

export async function markSupplierDiscoveryScanning(): Promise<{ runId: string; tabId: number; origin: string } | undefined> {
  return transition(async () => {
    const state = await read();
    if (!state || (state.stage !== "awaiting_permission" && state.stage !== "scanning")) return undefined;
    await write({ ...state, stage: "scanning", updatedAt: Date.now() });
    return { runId: state.runId, tabId: state.tabId, origin: state.origin };
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

export async function beginSupplierDiscoveryConnect(vendorId: string): Promise<PendingSupplierDiscovery | undefined> {
  return transition(async () => {
    const state = await read();
    if (!state || state.stage !== "preview" || state.candidates.id !== vendorId) return undefined;
    await write({
    stage: "confirming",
    runId: state.runId,
    candidates: state.candidates,
    diagnostic: state.diagnostic,
    updatedAt: Date.now(),
    });
    return { runId: state.runId, candidates: state.candidates };
  });
}

export async function getPendingSupplierDiscoveryConnect(): Promise<PendingSupplierDiscovery | undefined> {
  const state = await read();
  return state?.stage === "confirming" ? { runId: state.runId, candidates: state.candidates } : undefined;
}

export async function getPendingSupplierDiscoveryDiagnostic(runId: string): Promise<DiscoveryDiagnosticV1 | undefined> {
  const state = await read();
  return state?.stage === "confirming" && state.runId === runId ? state.diagnostic : undefined;
}

export async function restoreSupplierDiscoveryPreview(runId: string): Promise<boolean> {
  return transition(async () => {
    const state = await read();
    if (!state || state.runId !== runId || state.stage !== "confirming") return false;
    await write({ ...state, stage: "preview", updatedAt: Date.now() });
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

export async function completeSupplierDiscovery(runId: string, vendorId: string, name: string, count: number): Promise<boolean> {
  return transition(async () => {
    const state = await read();
    if (!state || state.runId !== runId || state.stage !== "confirming") return false;
    await write({
    stage: "complete",
    runId,
    vendorId: safeId(vendorId),
    name: safeName(name),
    count: Math.max(0, Math.min(500, Math.trunc(count))),
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
  if (runId) {
    const state = await read();
    if (!state || state.runId !== runId || (state.stage !== "scanning" && state.stage !== "confirming")) return false;
  }
  await write({
    stage: "failed",
    runId: runId ?? crypto.randomUUID(),
    message: safeMessage(message),
    origins: safeOrigins(origins),
    diagnostic: diagnostic ? parseDiscoveryDiagnostic(diagnostic) : undefined,
    updatedAt: Date.now(),
  });
  return true;
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
    };
    case "confirming": return { stage: "connecting", name: state.candidates.displayName };
    case "complete": return { stage: "complete", vendorId: state.vendorId, name: state.name, count: state.count };
    case "failed": return { stage: "failed", message: state.message, diagnosticAvailable: Boolean(state.diagnostic) };
  }
}

async function read(): Promise<DiscoveryState | undefined> {
  const raw = (await chrome.storage.session.get(KEY))[KEY];
  const state = parseState(raw);
  if (!state) {
    if (raw !== undefined) await chrome.storage.session.remove(KEY);
    return undefined;
  }
  const ttl = state.stage === "complete" || state.stage === "failed" ? RESULT_TTL_MS : ACTIVE_TTL_MS;
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
    return { stage: raw.stage, runId: raw.runId, tabId: Number(raw.tabId), origin: raw.origin, updatedAt };
  }
  if (raw.stage === "preview" || raw.stage === "confirming") {
    try {
      return {
        stage: raw.stage,
        runId: raw.runId, candidates: parseDiscoveredSupplierCandidateSet(raw.candidates),
        diagnostic: parseDiscoveryDiagnostic(raw.diagnostic),
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
    try { return { stage: raw.stage, runId: raw.runId, vendorId: safeId(raw.vendorId), name: safeName(raw.name), count: Math.max(0, Math.min(500, Math.trunc(Number(raw.count)))), updatedAt }; } catch { return undefined; }
  }
  if (raw.stage === "failed" && typeof raw.message === "string") {
    try {
      return {
        stage: raw.stage,
        runId: raw.runId, message: safeMessage(raw.message),
        origins: safeOrigins(raw.origins),
        diagnostic: raw.diagnostic === undefined ? undefined : parseDiscoveryDiagnostic(raw.diagnostic),
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
