import type { OperationalOutcomeCode } from "../../../src/core/errors";
import type { Connection } from "./storage";

export const COLLECTOR_DIAGNOSTIC_SCHEMA = "ratatosk.collector-diagnostic.v1" as const;

export interface CollectorDiagnostic {
  schema: typeof COLLECTOR_DIAGNOSTIC_SCHEMA;
  vendorId: string;
  collectorVersion: string;
  lifecycleRevision: string;
  outcomeCode: OperationalOutcomeCode;
  recordedAt: string | null;
  counts: {
    collected: number;
    documentActions: number;
    failedScopes: number;
    emptyScopes: number;
  };
  nextEligibleAt: string | null;
}

export function buildCollectorDiagnostic(input: {
  vendorId: string;
  collectorVersion: string;
  lifecycleRevision: string;
  connection: Connection | undefined;
}): CollectorDiagnostic {
  const connection = input.connection;
  return {
    schema: COLLECTOR_DIAGNOSTIC_SCHEMA,
    vendorId: safeId(input.vendorId),
    collectorVersion: input.collectorVersion,
    lifecycleRevision: input.lifecycleRevision,
    outcomeCode: connection?.lastCode ?? "unknown",
    recordedAt: isoTimestamp(connection?.lastRunAt),
    counts: {
      collected: boundedCount(connection?.lastCount),
      documentActions: boundedCount(connection?.lastDocumentActionCount),
      failedScopes: boundedCount(connection?.lastFailedScopes),
      emptyScopes: boundedCount(connection?.lastEmptyScopes),
    },
    nextEligibleAt: isoTimestamp(connection?.nextEligibleRunAt),
  };
}

function safeId(value: string): string {
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(value) ? value : "unknown";
}

function boundedCount(value: number | undefined): number {
  return Number.isInteger(value) && value !== undefined && value >= 0 ? Math.min(value, 100_000) : 0;
}

function isoTimestamp(value: number | undefined): string | null {
  if (!Number.isFinite(value)) return null;
  const date = new Date(value!);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
