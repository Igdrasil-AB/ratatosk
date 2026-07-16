import type { Connection, LedgerEntry, SinkConfig } from "./storage";
import type { VendorRunSummary } from "./collector";
import type { VendorLifecycleEntry } from "../../../src/vendors/lifecycle";
import type { CollectorDiagnostic } from "./diagnostics";

/**
 * The popup ↔ service-worker message contract. One discriminated union in, one
 * out, so both sides stay type-checked against the same shapes.
 */
export type Message =
  | { type: "listSources" }
  | { type: "getConfig" }
  | { type: "setConfig"; config: SinkConfig }
  | { type: "beginIgdrasilConnect" }
  | { type: "beginConnect"; vendorId: string }
  | { type: "completeConnect"; vendorId: string }
  | { type: "cancelConnect"; vendorId: string }
  | { type: "connect"; vendorId: string }
  | { type: "disconnect"; vendorId: string }
  | { type: "runNow"; vendorId?: string }
  | { type: "getVendorDiagnostic"; vendorId: string }
  | { type: "getLedger" }
  | { type: "getSchedule" }
  | { type: "setSchedule"; periodMinutes: number };

export interface ScheduleInfo {
  periodMinutes: number | null;
  nextRunAt: number | null;
}

export interface SourceView {
  id: string;
  name: string;
  category?: string;
  /** simple-icons slug for the brand logo; resolved to SVG in the popup. */
  icon?: string;
  /** Preloaded so the popup can request access directly inside the Connect click gesture. */
  hosts: readonly string[];
  lifecycle: VendorLifecycleEntry;
  runnable: boolean;
  connection: Connection | null;
}

export type Response =
  | { ok: true; sources: SourceView[] }
  | { ok: true; summaries: VendorRunSummary[] }
  | { ok: true; diagnostic: CollectorDiagnostic }
  | { ok: true; config: SinkConfig | null }
  | { ok: true; ledger: LedgerEntry[] }
  | { ok: true; schedule: ScheduleInfo }
  | { ok: true; connectUrl: string }
  | { ok: true }
  | { ok: false; error: string };

/** Typed wrapper so the popup never hand-rolls `chrome.runtime.sendMessage`. */
export function send(message: Message): Promise<Response> {
  return chrome.runtime.sendMessage(message) as Promise<Response>;
}
