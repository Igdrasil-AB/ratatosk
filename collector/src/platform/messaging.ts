import type { Connection, Destination, DestinationId, DestinationMap, LedgerEntry } from "./storage";
import type { VendorRunSummary } from "./collector";
import type { VendorLifecycleEntry } from "../../../src/vendors/lifecycle";
import type { CollectorDiagnostic } from "./diagnostics";
import type { DiscoveryStatusView } from "./discovery-state";
import type { DiscoveryDiagnosticV1 } from "./discovery-diagnostic";
import type { SyncSchedule } from "../../../src/core/sync-schedule";
import type { LiveAcceptanceSnapshot } from "../../../src/core/live-acceptance";
export type { LiveAcceptanceSnapshot } from "../../../src/core/live-acceptance";
export type { DiscoveryStatusView } from "./discovery-state";
export type { SyncSchedule } from "../../../src/core/sync-schedule";

/**
 * The popup ↔ service-worker message contract. One discriminated union in, one
 * out, so both sides stay type-checked against the same shapes.
 */
export type Message =
  | { type: "listSources" }
  | { type: "getDestinations" }
  | { type: "setLocalDestination"; destination: Extract<Destination, { kind: "filesystem" }> }
  | { type: "bindSupplier"; vendorId: string; destinationId: DestinationId }
  | { type: "disconnectCompany"; companyId: string }
  | { type: "beginIgdrasilConnect" }
  | { type: "beginConnect"; vendorId: string; destinationId: DestinationId }
  | { type: "completeConnect"; vendorId: string }
  | { type: "cancelConnect"; vendorId: string }
  | { type: "getDiscoveryStatus" }
  | { type: "getDiscoveryDiagnostic" }
  | { type: "beginDiscovery"; tabId: number; origin: string }
  | { type: "completeDiscovery" }
  | { type: "continueDiscovery" }
  | { type: "cancelDiscovery" }
  | { type: "beginDiscoveryConnect"; vendorId: string; destinationId: DestinationId; fromMonth?: string }
  | { type: "completeDiscoveryConnect"; vendorId: string }
  | { type: "cancelDiscoveryConnect" }
  | { type: "dismissDiscovery" }
  | { type: "connect"; vendorId: string }
  | { type: "disconnect"; vendorId: string }
  | { type: "forgetVendorHistory"; vendorId: string }
  | { type: "runNow"; vendorId?: string; fromMonth?: string }
  | { type: "getVendorDiagnostic"; vendorId: string }
  | { type: "getLiveAcceptanceSnapshot"; hostname: string; sessionNonce: string }
  | { type: "getLedger" }
  | { type: "getSchedule" }
  | { type: "setSchedule"; schedule: SyncSchedule }
  | { type: "getRouteMemory" }
  | { type: "clearRouteMemory" };

export interface ScheduleInfo {
  schedule: SyncSchedule;
  nextRunAt: number | null;
}

export interface SourceView {
  kind: "official" | "discovered";
  id: string;
  name: string;
  category?: string;
  /** simple-icons slug for the brand logo; resolved to SVG in the popup. */
  icon?: string;
  /** Preloaded so the popup can request access directly inside the Connect click gesture. */
  hosts: readonly string[];
  /** Recipe hosts added after connection, or permissions the user later revoked. */
  missingHosts: readonly string[];
  lifecycle?: VendorLifecycleEntry;
  primaryOrigin: string;
  runnable: boolean;
  connection: Connection | null;
}

export type Response =
  | { ok: true; sources: SourceView[] }
  | { ok: true; summaries: VendorRunSummary[] }
  | { ok: true; diagnostic: CollectorDiagnostic }
  | { ok: true; acceptanceSnapshot: LiveAcceptanceSnapshot }
  | { ok: true; destinations: DestinationMap }
  | { ok: true; unboundVendorIds: string[] }
  | { ok: true; ledger: LedgerEntry[] }
  | { ok: true; schedule: ScheduleInfo }
  | { ok: true; rememberedRoutes: number }
  | { ok: true; connectUrl: string }
  | { ok: true; discovery: DiscoveryStatusView }
  | { ok: true; discoveryDiagnostic: DiscoveryDiagnosticV1 }
  | { ok: true }
  | { ok: false; error: string };

/** Typed wrapper so the popup never hand-rolls `chrome.runtime.sendMessage`. */
export function send(message: Message): Promise<Response> {
  return chrome.runtime.sendMessage(message) as Promise<Response>;
}
