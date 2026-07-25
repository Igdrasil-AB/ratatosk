import { z } from "zod";
import type { VendorRecipe } from "../core/types";
import { deepFreeze } from "../core/immutable";

export const VENDOR_LIFECYCLE_SCHEMA = "ratatosk.vendor-lifecycle.v1" as const;
export const DEFAULT_VERIFICATION_MAX_AGE_DAYS = 90;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;

const lifecycleEntrySchema = z.object({
  vendorId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  stage: z.enum(["experimental", "pilot", "supported", "degraded", "retired"]),
  ownerTeam: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/),
  recipeRevision: z.string().regex(/^r[1-9][0-9]*$/),
  lastLiveVerifiedAt: z.string().datetime().nullable(),
  collectorVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/).nullable(),
  chromeMajor: z.number().int().min(116).max(999).nullable(),
  evidenceRef: z.string().regex(/^(?:pr|release|receipt):[A-Za-z0-9._/-]{1,120}$/).nullable(),
  nextReviewAt: z.string().datetime().nullable(),
  healthReason: z.enum([
    "experimental_unverified",
    "needs_verification",
    "healthy",
    "verification_stale",
    "vendor_change",
    "rate_limited",
    "security_hold",
    "retired",
  ]),
}).strict();

const lifecycleManifestSchema = z.object({
  schema: z.literal(VENDOR_LIFECYCLE_SCHEMA),
  vendors: z.array(lifecycleEntrySchema).min(1).max(500),
}).strict().superRefine((manifest, ctx) => {
  const seen = new Set<string>();
  for (const [index, entry] of manifest.vendors.entries()) {
    if (seen.has(entry.vendorId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["vendors", index, "vendorId"], message: "duplicate vendor lifecycle id" });
    }
    seen.add(entry.vendorId);
  }
});

export type VendorLifecycleEntry = z.infer<typeof lifecycleEntrySchema>;
export type VendorLifecycleManifest = z.infer<typeof lifecycleManifestSchema>;

const lifecycleSource: VendorLifecycleManifest = {
  schema: VENDOR_LIFECYCLE_SCHEMA,
  vendors: [
    unverified("github", "experimental"),
    unverified("railway", "pilot"),
    unverified("slack", "experimental"),
    unverified("vercel", "experimental"),
  ],
};

export const VENDOR_LIFECYCLE_MANIFEST = parseVendorLifecycleManifest(lifecycleSource);
export const VENDOR_LIFECYCLE_BY_ID: Readonly<Record<string, VendorLifecycleEntry>> = Object.freeze(
  Object.fromEntries(VENDOR_LIFECYCLE_MANIFEST.vendors.map((entry) => [entry.vendorId, entry])),
);

export function parseVendorLifecycleManifest(value: unknown, now = new Date()): VendorLifecycleManifest {
  const parsed = lifecycleManifestSchema.parse(value);
  for (const entry of parsed.vendors) {
    if (entry.lastLiveVerifiedAt && Date.parse(entry.lastLiveVerifiedAt) > now.getTime() + FUTURE_TOLERANCE_MS) {
      throw new Error(`${entry.vendorId}: last live verification cannot be in the future`);
    }
    const verificationFields = [entry.lastLiveVerifiedAt, entry.collectorVersion, entry.chromeMajor, entry.evidenceRef, entry.nextReviewAt];
    const completeVerification = verificationFields.every((field) => field !== null);
    const emptyVerification = verificationFields.every((field) => field === null);
    if (!completeVerification && !emptyVerification) throw new Error(`${entry.vendorId}: verification evidence must be complete or empty`);
    if (entry.stage === "experimental" && entry.healthReason !== "experimental_unverified") {
      throw new Error(`${entry.vendorId}: experimental vendors must use experimental_unverified`);
    }
    if (entry.stage === "retired" && entry.healthReason !== "retired") {
      throw new Error(`${entry.vendorId}: retired vendors must use retired`);
    }
    if (entry.healthReason === "retired" && entry.stage !== "retired") {
      throw new Error(`${entry.vendorId}: retired health reason requires retired stage`);
    }
    if (entry.healthReason === "healthy" && !completeVerification) {
      throw new Error(`${entry.vendorId}: healthy status requires complete live verification evidence`);
    }
    if (entry.lastLiveVerifiedAt && entry.nextReviewAt && Date.parse(entry.nextReviewAt) <= Date.parse(entry.lastLiveVerifiedAt)) {
      throw new Error(`${entry.vendorId}: next review must follow live verification`);
    }
  }
  return deepFreeze(parsed);
}

export function lifecycleCoverageIssues(recipes: readonly VendorRecipe[], manifest = VENDOR_LIFECYCLE_MANIFEST): string[] {
  const recipeIdCounts = new Map<string, number>();
  for (const recipe of recipes) recipeIdCounts.set(recipe.id, (recipeIdCounts.get(recipe.id) ?? 0) + 1);
  const recipeIds = new Set(recipeIdCounts.keys());
  const lifecycleIds = new Set(manifest.vendors.map((entry) => entry.vendorId));
  return [
    ...[...recipeIdCounts].filter(([, count]) => count > 1).map(([id]) => `${id}: duplicate recipe id`),
    ...[...recipeIds].filter((id) => !lifecycleIds.has(id)).map((id) => `${id}: missing lifecycle entry`),
    ...[...lifecycleIds].filter((id) => !recipeIds.has(id)).map((id) => `${id}: lifecycle entry has no recipe`),
  ];
}

export function publicVendorCapabilityIssues(recipes: readonly VendorRecipe[]): string[] {
  return recipes.flatMap((recipe) => recipe.invoices.strategy === "dom"
    ? [`${recipe.id}: public recipe requires unsupported DOM runtime strategy`]
    : []);
}

export function releaseLifecycleIssues(
  publicVendorIds: readonly string[],
  options: { now?: Date; collectorVersion: string; maxAgeDays?: number },
  lifecycle = VENDOR_LIFECYCLE_BY_ID,
): string[] {
  const now = options.now ?? new Date();
  const maxAgeMs = (options.maxAgeDays ?? DEFAULT_VERIFICATION_MAX_AGE_DAYS) * 24 * 60 * 60 * 1_000;
  return publicVendorIds.flatMap((vendorId) => {
    const entry = lifecycle[vendorId];
    if (!entry) return [`${vendorId}: missing lifecycle entry`];
    const issues: string[] = [];
    if (entry.stage !== "pilot" && entry.stage !== "supported") issues.push(`${vendorId}: stage ${entry.stage} cannot ship as a public claim`);
    if (entry.stage === "pilot") {
      if (!isRunnablePilotHealth(entry.healthReason)) {
        issues.push(`${vendorId}: health reason ${entry.healthReason} is not release-ready`);
      }
      return issues;
    }
    if (entry.healthReason !== "healthy") issues.push(`${vendorId}: health reason ${entry.healthReason} is not release-ready`);
    if (!entry.lastLiveVerifiedAt || !entry.evidenceRef || !entry.nextReviewAt || !entry.chromeMajor || !entry.collectorVersion) {
      issues.push(`${vendorId}: complete sanitized live-verification evidence is required`);
      return issues;
    }
    const verifiedAt = Date.parse(entry.lastLiveVerifiedAt);
    if (now.getTime() - verifiedAt > maxAgeMs) issues.push(`${vendorId}: live verification is older than ${maxAgeMs / 86_400_000} days`);
    if (Date.parse(entry.nextReviewAt) < now.getTime()) issues.push(`${vendorId}: next review date has passed`);
    if (entry.collectorVersion !== options.collectorVersion) issues.push(`${vendorId}: verified Collector ${entry.collectorVersion} does not match ${options.collectorVersion}`);
    return issues;
  });
}

function isRunnablePilotHealth(reason: VendorLifecycleEntry["healthReason"]): boolean {
  return reason === "needs_verification" || reason === "healthy" || reason === "verification_stale";
}

export function isLifecycleRunnable(
  entry: VendorLifecycleEntry,
  now = new Date(),
  maxAgeDays = DEFAULT_VERIFICATION_MAX_AGE_DAYS,
): boolean {
  // Bundled pilot recipes are reviewed code and may run without operational
  // attestation metadata. Explicit health holds still block execution, while
  // supported recipes retain the stricter freshness contract.
  if (entry.stage === "pilot") return isRunnablePilotHealth(entry.healthReason);
  if (entry.stage !== "supported") return false;
  if (entry.healthReason !== "healthy") return false;
  if (!entry.lastLiveVerifiedAt || !entry.collectorVersion || !entry.chromeMajor || !entry.evidenceRef || !entry.nextReviewAt) {
    return false;
  }
  return isVerificationFresh(entry, now, maxAgeDays);
}

export function vendorLifecycleLabel(
  entry: VendorLifecycleEntry,
  now = new Date(),
  maxAgeDays = DEFAULT_VERIFICATION_MAX_AGE_DAYS,
): string {
  if (entry.stage === "retired") return "Retired";
  if (entry.stage === "experimental") return "Experimental · not in Collector";
  if (entry.stage === "degraded") return `Degraded · ${reasonLabel(entry.healthReason)}`;
  if (entry.stage === "pilot") {
    if (!isRunnablePilotHealth(entry.healthReason)) return `Pilot · ${reasonLabel(entry.healthReason)}`;
    if (entry.healthReason === "healthy" && isVerificationFresh(entry, now, maxAgeDays)) return "Pilot · live verified";
    return "Pilot · bundled recipe";
  }
  const stage = "Supported";
  if (!entry.lastLiveVerifiedAt) return `${stage} · verification needed`;
  if (!isVerificationFresh(entry, now, maxAgeDays)) return `${stage} · verification stale`;
  return `${stage} · live verified`;
}

export function isVerificationFresh(
  entry: Pick<VendorLifecycleEntry, "lastLiveVerifiedAt" | "nextReviewAt">,
  now = new Date(),
  maxAgeDays = DEFAULT_VERIFICATION_MAX_AGE_DAYS,
): boolean {
  if (!entry.lastLiveVerifiedAt || !entry.nextReviewAt) return false;
  const verifiedAt = Date.parse(entry.lastLiveVerifiedAt);
  const reviewAt = Date.parse(entry.nextReviewAt);
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1_000;
  return Number.isFinite(verifiedAt) && Number.isFinite(reviewAt)
    && verifiedAt <= now.getTime()
    && now.getTime() - verifiedAt <= maxAgeMs
    && reviewAt >= now.getTime();
}

function unverified(vendorId: string, stage: "experimental" | "pilot"): VendorLifecycleEntry {
  return {
    vendorId,
    stage,
    ownerTeam: "integrations",
    recipeRevision: "r1",
    lastLiveVerifiedAt: null,
    collectorVersion: null,
    chromeMajor: null,
    evidenceRef: null,
    nextReviewAt: null,
    healthReason: stage === "experimental" ? "experimental_unverified" : "needs_verification",
  };
}

function reasonLabel(reason: VendorLifecycleEntry["healthReason"]): string {
  return reason.replaceAll("_", " ");
}

export { lifecycleEntrySchema, lifecycleManifestSchema };
