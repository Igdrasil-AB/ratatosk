import { z } from "zod";
import { isPublicHostname } from "./origin-policy";

export const LIVE_ACCEPTANCE_SNAPSHOT_SCHEMA = "ratatosk.live-acceptance-snapshot.v1" as const;

const runtime = z.object({
  collectorVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  discoveryRevision: z.number().int().min(1).max(10_000),
  acquisitionRevision: z.number().int().min(1).max(10_000),
}).strict();
const envelope = z.object({
  schema: z.literal(LIVE_ACCEPTANCE_SNAPSHOT_SCHEMA),
  runtime,
  hostname: z.string().trim().toLowerCase().refine(isPublicHostname),
  capturedAt: z.string().datetime(),
  sessionNonce: z.string().regex(/^[a-f0-9]{32}$/),
  vendorId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
});
const planKind = z.enum(["network", "embedded", "exact_dom", "typed_dom", "semantic_dom"]);
const boundedCount = z.number().int().min(0).max(100_000);

export const liveAcceptanceSnapshotSchema = z.discriminatedUnion("stage", [
  envelope.extend({
    stage: z.literal("preview"),
    planCount: z.number().int().min(1).max(3),
    planKinds: z.array(planKind).min(1).max(3),
    invoiceClueCount: z.number().int().min(1).max(500),
    baselineLedgerCount: boundedCount,
  }).strict(),
  envelope.extend({
    stage: z.literal("connected"),
    selectedPlanKind: planKind,
    destinationKind: z.enum(["filesystem", "igdrasil"]),
    destinationToken: z.string().regex(/^[a-f0-9]{24}$/),
    run: z.object({
      recordedAt: z.string().datetime(),
      status: z.enum(["ok", "partial", "auth_expired", "rate_limited", "error"]),
      acceptedCount: boundedCount,
      actionCount: boundedCount,
      ledgerCount: boundedCount,
      pageOwnedDownloadDelta: boundedCount,
    }).strict(),
  }).strict(),
]);

export type LiveAcceptanceSnapshot = z.infer<typeof liveAcceptanceSnapshotSchema>;

export function parseLiveAcceptanceSnapshot(value: unknown): LiveAcceptanceSnapshot {
  return liveAcceptanceSnapshotSchema.parse(value);
}
