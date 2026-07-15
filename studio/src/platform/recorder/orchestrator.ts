import { findDocLinks, inferRecipe } from "../../../../src/core/recorder/infer";
import { buildAgentReport } from "../../../../src/core/recorder/report";
import type { DraftRecipe } from "../../../../src/core/recorder/types";
import type { RecorderProgress } from "../messaging";
import { beginSession, clearCurrentTab, endSession, getCurrentTab, getSession, setCurrentTab } from "./session-store";
import { startDebuggerCapture, stopDebuggerCapture } from "./debugger-capture";
import { startPageCapture } from "./page-capture";
import { captureDomSnapshot } from "./dom-snapshot";

/**
 * Coordinates a record session: pick a capture backend, accumulate, then infer a
 * draft recipe. `silent` = MAIN-world interceptor (no banner); `deep` =
 * chrome.debugger (race-free, shows the banner).
 */
export type RecordMode = "silent" | "deep";

/** What a stop returns — includes a capture summary so failures are diagnosable. */
export interface StopResult {
  draft: DraftRecipe | null;
  /** How many requests were captured. 0 ⇒ a capture problem, not an inference one. */
  captured: number;
  /** A few sanitized captured requests (`status contentType url`) for review. */
  samples: string[];
  /** Invoice/receipt links found in the page HTML — a hint when no draft was made. */
  docLinks: string[];
  /** One paste-ready block (recipe + notes + sanitized samples) for a coding agent. */
  report: string;
}

export async function startRecording(tabId: number, url: string, mode: RecordMode): Promise<void> {
  console.info(`[recorder] startRecording mode=${mode} tab=${tabId} origin=${safeOrigin(url) ?? "unknown"}`);
  await beginSession(tabId, safeOrigin(url) ?? "");
  await setCurrentTab(tabId);
  if (mode === "deep") {
    await startDebuggerCapture(tabId);
    // Reload so the invoice fetch fires FRESH and is captured. SPAs cache billing
    // data on client-side nav, so without this the request never re-fires. The
    // debugger survives the reload (it's attached to the tab). Silent mode can't
    // reload — its in-page interceptor would be wiped by the new document.
    await chrome.tabs.reload(tabId, { bypassCache: true });
  } else {
    await startPageCapture(tabId);
  }
}

export async function stopRecording(): Promise<StopResult> {
  const tabId = await getCurrentTab();
  if (tabId === undefined) return { draft: null, captured: 0, samples: [], docLinks: [], report: "" };

  await stopDebuggerCapture(tabId); // no-op for silent mode
  const session = await endSession(tabId);
  await clearCurrentTab();

  // Snapshot the rendered page LAST (after detaching the debugger, before inferring).
  // It's the universal fallback: the invoice data the user sees is always in the DOM,
  // even when the network trace missed it (cached SPA, server-rendered HTML).
  if (session) {
    const snapshot = await captureDomSnapshot(tabId);
    if (snapshot) session.entries.push(snapshot);
  }

  const entries = session?.entries ?? [];
  const samples = entries.slice(0, 10).map((e) => `${e.status} ${e.contentType || "?"} ${e.url}`);
  const draft = session ? inferRecipe(session) : null;
  const docLinks = findDocLinks(entries);
  const report = session
    ? buildAgentReport({ version: chrome.runtime.getManifest().version, session, draft, docLinks })
    : "";

  console.info(
    `[recorder] stop tab ${tabId}: ${entries.length} captured, ${entries.filter((e) => e.responseBody).length} with bodies, ${docLinks.length} doc-links, draft=${draft ? draft.confidence : "none"}`,
  );
  if (docLinks.length) console.info(`[recorder] ${docLinks.length} document link(s) found`);

  return { draft, captured: entries.length, samples, docLinks, report };
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
  return { recording: true, captured: entries.length, documents, detected };
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
