import { findDocLinks, inferRecipe } from "../../../../src/core/recorder/infer";
import { buildAgentReport } from "../../../../src/core/recorder/report";
import { buildSupplierFingerprint, type SupplierFingerprintV1 } from "../../../../src/core/recorder/supplier-fingerprint";
import type { DraftRecipe } from "../../../../src/core/recorder/types";
import type { RecorderProgress } from "../messaging";
import { beginSession, captureRecoveryFailed, captureStorageFailed, clearCurrentTab, endSession, getCurrentTab, getSession, setCurrentTab } from "./session-store";
import { startDebuggerCapture, stopDebuggerCapture, waitForDebuggerHydration } from "./debugger-capture";
import { startPageCapture } from "./page-capture";
import { captureDomSnapshot } from "./dom-snapshot";
import { isSecureRecordingPage } from "../recording-page";

/**
 * Coordinates a record session: pick a capture backend, accumulate, then infer a
 * draft recipe. `deep` = chrome.debugger (race-free, shows the banner). The
 * old page-visible `silent` relay is retained only as a fail-closed mode name
 * for stored callers; it cannot record raw page traffic.
 */
export type RecordMode = "silent" | "deep";
let lifecycleTail: Promise<void> = Promise.resolve();

/** What a stop returns — includes a capture summary so failures are diagnosable. */
export interface StopResult {
  draft: DraftRecipe | null;
  /** Backward-compatible alias for requestCount. */
  captured: number;
  /** Network requests captured. 0 still identifies a network-capture problem. */
  requestCount: number;
  /** Synthetic evidence entries such as the final rendered DOM snapshot. */
  artifactCount: number;
  /** Total request plus synthetic evidence entries analyzed. */
  evidenceCount: number;
  /** A few sanitized captured requests (`status contentType url`) for review. */
  samples: string[];
  /** Invoice/receipt links found in the page HTML — a hint when no draft was made. */
  docLinks: string[];
  /** One paste-ready block (recipe + notes + sanitized samples) for a coding agent. */
  report: string;
  /** Strict structural evidence suitable for explicit approval and future delivery. */
  fingerprint: SupplierFingerprintV1 | null;
}

export function startRecording(tabId: number, url: string, mode: RecordMode): Promise<void> {
  return serializeLifecycle(() => startRecordingInternal(tabId, url, mode));
}

async function startRecordingInternal(tabId: number, url: string, mode: RecordMode): Promise<void> {
  if (!isSecureRecordingPage(url)) throw new Error("Recorder requires an HTTPS page");
  const existing = await getCurrentTab();
  if (existing !== undefined) throw new Error("A recorder session is already active");
  await waitForDebuggerHydration();
  console.info(`[recorder] startRecording mode=${mode} tab=${tabId} origin=${safeOrigin(url) ?? "unknown"}`);
  await beginSession(tabId, safeOrigin(url) ?? "");
  await setCurrentTab(tabId);
  try {
    if (mode === "deep") {
      await startDebuggerCapture(tabId);
      // Reload so the invoice fetch fires FRESH and is captured. SPAs cache billing
      // data on client-side nav, so without this the request never re-fires. The
      // debugger survives the reload because it is attached to the tab.
      await chrome.tabs.reload(tabId, { bypassCache: true });
    } else {
      await startPageCapture(tabId);
    }
  } catch (error) {
    // A start is all-or-nothing: no stale current-tab pointer, session storage,
    // alias context, or debugger attachment may survive a failed setup.
    await stopDebuggerCapture(tabId);
    await endSession(tabId);
    if ((await getCurrentTab()) === tabId) await clearCurrentTab();
    throw error;
  }
}

export function stopRecording(): Promise<StopResult> {
  return serializeLifecycle(stopRecordingInternal);
}

async function stopRecordingInternal(): Promise<StopResult> {
  const tabId = await getCurrentTab();
  if (tabId === undefined) throw new Error("No active recorder session");

  await stopDebuggerCapture(tabId); // no-op for silent mode
  let session;
  try {
    session = await endSession(tabId);
  } finally {
    await clearCurrentTab();
  }

  // Snapshot the rendered page LAST (after detaching the debugger, before inferring).
  // It's the universal fallback: the invoice data the user sees is always in the DOM,
  // even when the network trace missed it (cached SPA, server-rendered HTML).
  if (session) {
    const snapshot = await captureDomSnapshot(tabId);
    if (snapshot) session.entries.push(snapshot);
  }

  const entries = session?.entries ?? [];
  const requests = entries.filter((entry) => entry.method !== "DOM");
  const requestCount = requests.length;
  const artifactCount = entries.length - requestCount;
  const samples = requests.slice(0, 10).map((e) => `${e.status} ${e.contentType || "?"} ${e.url}`);
  const draft = session ? inferRecipe(session) : null;
  const docLinks = findDocLinks(entries);
  const report = session
    ? buildAgentReport({ version: chrome.runtime.getManifest().version, session, draft, docLinks })
    : "";
  const fingerprint = session
    ? buildSupplierFingerprint({
        fingerprintId: `fp_${crypto.randomUUID().replaceAll("-", "")}`,
        capturedAt: new Date().toISOString(),
        studioVersion: chrome.runtime.getManifest().version,
        session,
        draft,
      })
    : null;

  console.info(
    `[recorder] stop tab ${tabId}: ${requestCount} requests, ${artifactCount} synthetic artifacts, ${entries.filter((e) => e.responseBody).length} with bodies, ${docLinks.length} doc-links, draft=${draft ? draft.confidence : "none"}`,
  );
  if (docLinks.length) console.info(`[recorder] ${docLinks.length} document link(s) found`);

  return {
    draft,
    captured: requestCount,
    requestCount,
    artifactCount,
    evidenceCount: entries.length,
    samples,
    docLinks,
    report,
    fingerprint,
  };
}

function serializeLifecycle<T>(work: () => Promise<T>): Promise<T> {
  const run = lifecycleTail.then(work, work);
  lifecycleTail = run.then(() => undefined, () => undefined);
  return run;
}

export async function isRecording(): Promise<boolean> {
  const tabId = await getCurrentTab();
  if (tabId === undefined) return false;
  return (await getSession(tabId)) !== undefined; // stale flag without a session ⇒ not recording
}

/** Live signals for the popup while a capture runs: how much is captured, whether
 * a PDF was fetched, and whether we've seen enough to stop. Cheap checks first;
 * the full inference only runs when nothing simpler has matched. */
export async function recordingProgress(): Promise<RecorderProgress> {
  const none = { recording: false, captured: 0, documents: 0, detected: false };
  const tabId = await getCurrentTab();
  if (tabId === undefined) return none;
  const session = await getSession(tabId);
  if (!session) return none;

  const entries = session.entries;
  const documents = entries.filter((e) => e.contentType.includes("pdf")).length;
  const detected = documents > 0 || findDocLinks(entries).length > 0 || inferRecipe(session) !== null;
  return {
    recording: true,
    captured: entries.length,
    documents,
    detected,
    storageFailed: captureStorageFailed(tabId),
    recoveryFailed: captureRecoveryFailed(tabId),
  };
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
