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

const chains = new Map<number, Promise<void>>();
const closed = new Set<number>();

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
  await set(key(tabId), { origin, entries: [] } satisfies CaptureSession);
}

export function appendEntry(tabId: number, entry: CapturedEntry): Promise<void> {
  if (closed.has(tabId)) return Promise.resolve();
  const prev = chains.get(tabId) ?? Promise.resolve();
  const next = prev.then(() => appendRaw(tabId, entry));
  chains.set(
    tabId,
    next.catch(() => undefined),
  );
  return next;
}

export function getSession(tabId: number): Promise<CaptureSession | undefined> {
  return get<CaptureSession>(key(tabId));
}

export async function endSession(tabId: number): Promise<CaptureSession | undefined> {
  closed.add(tabId);
  await chains.get(tabId);
  const session = await get<CaptureSession>(key(tabId));
  await remove(key(tabId));
  chains.delete(tabId);
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
  closed.clear();
}

async function appendRaw(tabId: number, entry: CapturedEntry): Promise<void> {
  const session = await get<CaptureSession>(key(tabId));
  if (!session) return; // recording already stopped
  session.entries.push(entry);
  if (session.entries.length > MAX_ENTRIES) session.entries.splice(0, session.entries.length - MAX_ENTRIES);
  await set(key(tabId), session);
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
