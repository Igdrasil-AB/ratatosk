import { z } from "zod";

export const PILOT_MANIFEST_SCHEMA = "ratatosk.collector-pilot.v1" as const;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
const instant = z.string().datetime();

export const pilotManifestSchema = z.object({
  schema: z.literal(PILOT_MANIFEST_SCHEMA),
  status: z.enum(["template", "ready", "evaluated"]),
  collectorVersion: version,
  collectorSha256: sha256,
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  supplierIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/)).min(1).max(20),
  regions: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(20),
  cohortSizeTarget: z.object({ min: z.number().int().min(1).max(100), max: z.number().int().min(1).max(100) }).strict(),
  supportOwner: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/),
  window: z.object({ startsAt: instant, endsAt: instant }).strict(),
  rollback: z.object({ collectorVersion: version, collectorSha256: sha256 }).strict(),
  exitThresholds: z.object({
    maxUnresolvedHighSeverity: z.literal(0),
    maxUnresolvedOperationalIssues: z.number().int().min(0).max(20),
    minimumSuccessfulTesters: z.number().int().min(1).max(100),
    requireCurrentSupplierClaims: z.literal(true),
    requireSupportAndDeletionExercise: z.literal(true),
  }).strict(),
  decision: z.enum(["continue_unlisted", "remediate", "prepare_public_launch_plan"]).nullable(),
}).strict().superRefine((manifest, ctx) => {
  if (new Set(manifest.supplierIds).size !== manifest.supplierIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["supplierIds"], message: "supplier IDs must be unique" });
  }
  if (new Set(manifest.regions).size !== manifest.regions.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["regions"], message: "regions must be unique" });
  }
  if (manifest.cohortSizeTarget.min > manifest.cohortSizeTarget.max) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cohortSizeTarget"], message: "minimum cannot exceed maximum" });
  }
  if (Date.parse(manifest.window.endsAt) <= Date.parse(manifest.window.startsAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["window"], message: "pilot end must follow start" });
  }
  if (manifest.exitThresholds.minimumSuccessfulTesters > manifest.cohortSizeTarget.max) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["exitThresholds", "minimumSuccessfulTesters"], message: "threshold exceeds cohort maximum" });
  }
  if (manifest.status === "evaluated" && manifest.decision === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["decision"], message: "evaluated pilots require a decision" });
  }
  if (manifest.status !== "evaluated" && manifest.decision !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["decision"], message: "decision is allowed only after evaluation" });
  }
});

export type PilotManifest = z.infer<typeof pilotManifestSchema>;

export function parsePilotManifest(value: unknown): PilotManifest {
  return pilotManifestSchema.parse(value);
}
