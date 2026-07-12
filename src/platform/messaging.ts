import type { Connection, LedgerEntry, SinkConfig } from "./storage";
import type { VendorRunSummary } from "./collector";
import type { DraftRecipe } from "../core/recorder/types";

/**
 * The popup ↔ service-worker message contract. One discriminated union in, one
 * out, so both sides stay type-checked against the same shapes.
 */
export type Message =
  | { type: "listSources" }
  | { type: "getConfig" }
  | { type: "setConfig"; config: SinkConfig }
  | { type: "setToken"; token: string }
  | { type: "connect"; vendorId: string }
  | { type: "disconnect"; vendorId: string }
  | { type: "runNow"; vendorId?: string }
  | { type: "recorderStart"; mode: "silent" | "deep" }
  | { type: "recorderStop" }
  | { type: "recorderStatus" }
  | { type: "getLedger" }
  | { type: "getSchedule" }
  | { type: "setSchedule"; periodMinutes: number }
  | { type: "recorderProgress" };

export interface ScheduleInfo {
  periodMinutes: number | null;
  nextRunAt: number | null;
}

/** Live signals from an in-progress capture, so the popup can say "got it, stop now". */
export interface RecorderProgress {
  recording: boolean;
  captured: number;
  /** PDFs the page fetched during recording (a receipt/invoice the user opened). */
  documents: number;
  /** An invoice list / doc-links / PDF has been seen — safe to stop. */
  detected: boolean;
}

export interface RecorderStopResult {
  draft: DraftRecipe | null;
  captured: number;
  samples: string[];
  /** Invoice/receipt links seen in the page HTML — a hint when no draft was made. */
  docLinks: string[];
  /** One paste-ready block for a coding agent (recipe + notes + samples + HTML excerpt). */
  report: string;
}

export interface SourceView {
  id: string;
  name: string;
  category?: string;
  /** simple-icons slug for the brand logo; resolved to SVG in the popup. */
  icon?: string;
  connection: Connection | null;
}

export type Response =
  | { ok: true; sources: SourceView[] }
  | { ok: true; summaries: VendorRunSummary[] }
  | { ok: true; config: SinkConfig | null }
  | ({ ok: true } & RecorderStopResult)
  | { ok: true; recording: boolean }
  | { ok: true; ledger: LedgerEntry[] }
  | { ok: true; schedule: ScheduleInfo }
  | { ok: true; progress: RecorderProgress }
  | { ok: true }
  | { ok: false; error: string };

/** Typed wrapper so the popup never hand-rolls `chrome.runtime.sendMessage`. */
export function send(message: Message): Promise<Response> {
  return chrome.runtime.sendMessage(message) as Promise<Response>;
}
