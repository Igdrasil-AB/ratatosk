import { buildEntry, createCaptureRedactionContext, type CaptureRedactionContext } from "../../../../src/core/recorder/cdp";
import type { CaptureSession, CapturedEntry } from "../../../../src/core/recorder/types";

/**
 * Holds the in-progress capture for a tab in `chrome.storage.session` (survives
 * service-worker restarts, cleared when the browser closes). Appends are
 * serialized per tab so bursts of captured requests don't clobber each other via
 * read-modify-write races.
 */
const key = (tabId: number) => `recorder:session:${tabId}`;
const CURRENT = "recorder:current";
const MAX_ENTRIES = 500;
const MAX_SESSION_BYTES = 4 * 1024 * 1024;

const chains = new Map<number, Promise<void>>();
const failures = new Map<number, CaptureStorageError | CaptureRecoveryError>();
const closed = new Set<number>();
const redactionContexts = new Map<number, CaptureRedactionContext>();

export class CaptureStorageError extends Error {
  constructor() {
    super("Capture storage failed; the recording may be incomplete");
    this.name = "CaptureStorageError";
  }
}

export class CaptureRecoveryError extends Error {
  constructor() {
    super("The recorder worker restarted; retry the recording to preserve identifier correlation");
    this.name = "CaptureRecoveryError";
  }
}

// The single in-progress recording's tab id — so stop/status find it regardless
// of which tab is active when the popup reopens.
export const setCurrentTab = (tabId: number) => set(CURRENT, tabId);
export const getCurrentTab = () => get<number>(CURRENT);
export const clearCurrentTab = () => remove(CURRENT);

/** Tab ids that currently have a capture session (used to re-seed after a worker restart). */
export async function activeSessionTabIds(): Promise<number[]> {
  const all = await new Promise<Record<string, unknown>>((resolve) =>
    chrome.storage.session.get(null, (o) => resolve(o)),
  );
  return Object.keys(all)
    .map((k) => /^recorder:session:(\d+)$/.exec(k))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
}

export async function beginSession(tabId: number, origin: string): Promise<void> {
  closed.delete(tabId);
  failures.delete(tabId);
  redactionContexts.set(tabId, createCaptureRedactionContext());
  await set(key(tabId), { origin, entries: [] } satisfies CaptureSession);
}

/** Sanitizes a raw capture with the tab's ephemeral correlation aliases. */
export function buildSessionEntry(
  tabId: number,
  input: Parameters<typeof buildEntry>[0],
): CapturedEntry {
  return buildEntry({ ...input, redactionContext: redactionContexts.get(tabId) });
}

/** Returns true only after the entry has been persisted in the active session. */
export function appendEntry(tabId: number, entry: CapturedEntry): Promise<boolean> {
  if (closed.has(tabId)) return Promise.resolve(false);
  const prev = chains.get(tabId) ?? Promise.resolve();
  const next = prev.then(() => appendRaw(tabId, entry));
  chains.set(
    tabId,
    next.then(
      () => undefined,
      () => {
        failures.set(tabId, new CaptureStorageError());
      },
    ),
  );
  return next;
}

export function captureStorageFailed(tabId: number): boolean {
  return failures.get(tabId) instanceof CaptureStorageError;
}

export function captureRecoveryFailed(tabId: number): boolean {
  return failures.get(tabId) instanceof CaptureRecoveryError;
}

/** Fail closed after a worker restart rather than persisting raw identifiers or
 * testable identifier derivatives solely to rebuild the ephemeral alias map. */
export function markSessionRecovered(tabId: number): void {
  if (!redactionContexts.has(tabId)) redactionContexts.set(tabId, createCaptureRedactionContext());
  if (!failures.has(tabId)) failures.set(tabId, new CaptureRecoveryError());
}

export function getSession(tabId: number): Promise<CaptureSession | undefined> {
  return get<CaptureSession>(key(tabId));
}

export async function endSession(tabId: number): Promise<CaptureSession | undefined> {
  closed.add(tabId);
  await chains.get(tabId);
  let session: CaptureSession | undefined;
  let failure = failures.get(tabId);
  try {
    session = await get<CaptureSession>(key(tabId));
  } catch {
    failure = new CaptureStorageError();
  }
  try {
    await remove(key(tabId));
  } catch {
    failure = new CaptureStorageError();
  } finally {
    chains.delete(tabId);
    failures.delete(tabId);
    redactionContexts.delete(tabId);
  }
  if (failure) throw failure;
  return session;
}

/** Wipe any leftover recording state — called on extension reload so a session
 * that never cleanly stopped doesn't wedge the popup into "recording". */
export async function clearAllRecorderState(): Promise<void> {
  const all = await new Promise<Record<string, unknown>>((resolve) =>
    chrome.storage.session.get(null, (o) => resolve(o)),
  );
  const stale = Object.keys(all).filter((k) => k === CURRENT || k.startsWith("recorder:session:"));
  if (stale.length) await new Promise<void>((resolve) => chrome.storage.session.remove(stale, () => resolve()));
  chains.clear();
  failures.clear();
  closed.clear();
  redactionContexts.clear();
}

async function appendRaw(tabId: number, entry: CapturedEntry): Promise<boolean> {
  const session = await get<CaptureSession>(key(tabId));
  // `closed` is the admission cutoff in appendEntry. Work that passed that
  // cutoff is already part of this tab's chain, and endSession waits for the
  // chain before removing storage, so it must be allowed to drain.
  if (!session) throw new CaptureStorageError();
  session.entries.push(entry);
  if (session.entries.length > MAX_ENTRIES) session.entries.splice(0, session.entries.length - MAX_ENTRIES);
  if (new TextEncoder().encode(JSON.stringify(session)).byteLength > MAX_SESSION_BYTES) {
    throw new CaptureStorageError();
  }
  await set(key(tabId), session);
  return true;
}

async function get<T>(k: string): Promise<T | undefined> {
  const values = await chrome.storage.session.get(k);
  return values[k] as T | undefined;
}
async function set(k: string, v: unknown): Promise<void> {
  await chrome.storage.session.set({ [k]: v });
}
async function remove(k: string): Promise<void> {
  await chrome.storage.session.remove(k);
}
