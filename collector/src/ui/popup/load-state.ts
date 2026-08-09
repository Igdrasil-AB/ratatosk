import type { DiscoveryStatusView, Response, ScheduleInfo, SourceView } from "../../platform/messaging";
import type { DestinationMap, LedgerEntry } from "../../platform/storage";

export class PopupLoadError extends Error {
  constructor(label: string) {
    super(`Ratatosk couldn’t load ${label} from the background service.`);
    this.name = "PopupLoadError";
  }
}

export interface InitialBackgroundState {
  sources: SourceView[];
  ledger: LedgerEntry[];
  schedule: ScheduleInfo;
  discovery: DiscoveryStatusView;
}

export function parseInitialBackgroundState(input: {
  sourceResponse: Response;
  ledgerResponse: Response;
  scheduleResponse: Response;
  discoveryResponse: Response;
}): InitialBackgroundState {
  return {
    sources: requireField<SourceView[]>(input.sourceResponse, "sources", "saved vendors"),
    ledger: requireField<LedgerEntry[]>(input.ledgerResponse, "ledger", "invoice history"),
    schedule: requireField<ScheduleInfo>(input.scheduleResponse, "schedule", "sync schedule"),
    discovery: requireField<DiscoveryStatusView>(input.discoveryResponse, "discovery", "supplier search status"),
  };
}

export function parseDestinationsResponse(response: Response): DestinationMap {
  return requireField<DestinationMap>(response, "destinations", "destination settings");
}

function requireField<T>(response: Response, field: string, label: string): T {
  if (!response.ok || !(field in response)) throw new PopupLoadError(label);
  return (response as unknown as Record<string, unknown>)[field] as T;
}
