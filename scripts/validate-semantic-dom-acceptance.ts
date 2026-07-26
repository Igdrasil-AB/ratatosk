import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pkg from "../package.json";
import { DOCUMENT_ACQUISITION_REVISION } from "../collector/src/platform/acquisition-revision";

export const SEMANTIC_DOM_ACCEPTANCE_SCHEMA = "ratatosk.semantic-dom-acceptance.v1" as const;

const SITE_CLASSES = [
  "supabase",
  "additional-semantic-supplier",
  "synthetic-local-native-download",
] as const;
const DESTINATION_KINDS = ["filesystem", "igdrasil"] as const;
const OUTCOMES = [
  "collected",
  "browser_download_unsupported",
  "document_action_side_effect",
] as const;

type SiteClass = typeof SITE_CLASSES[number];
type DestinationKind = typeof DESTINATION_KINDS[number];
type ClosedOutcome = typeof OUTCOMES[number];

export interface SemanticDomAcceptanceCase {
  siteClass: SiteClass;
  destinationKind: DestinationKind;
  firstRunAcceptedCount: number;
  secondRunActionCount: number;
  secondRunAcceptedCount: number;
  cadenceRunActionCount: number;
  cadenceRunAcceptedCount: number;
  pageOwnedDownloadDelta: number;
  closedOutcome: ClosedOutcome;
  pass: true;
}

export interface SemanticDomAcceptanceReceipt {
  schema: typeof SEMANTIC_DOM_ACCEPTANCE_SCHEMA;
  collectorVersion: string;
  acquisitionRevision: number;
  completedAt: string;
  cases: SemanticDomAcceptanceCase[];
}

export function parseSemanticDomAcceptanceReceipt(
  value: unknown,
  expectedVersion = pkg.version,
  expectedRevision = DOCUMENT_ACQUISITION_REVISION,
): SemanticDomAcceptanceReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("receipt must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.schema !== SEMANTIC_DOM_ACCEPTANCE_SCHEMA) throw new Error("receipt schema is invalid");
  if (raw.collectorVersion !== expectedVersion) throw new Error(`receipt must match Collector ${expectedVersion}`);
  if (raw.acquisitionRevision !== expectedRevision) {
    throw new Error(`receipt must match document acquisition revision ${expectedRevision}`);
  }
  if (typeof raw.completedAt !== "string" || !isRecentIsoDate(raw.completedAt, 30)) {
    throw new Error("receipt completion date must be a valid ISO date from the last 30 days");
  }
  if (!Array.isArray(raw.cases) || raw.cases.length < 5 || raw.cases.length > 12) {
    throw new Error("receipt must contain 5 to 12 bounded acceptance cases");
  }
  const cases = raw.cases.map(parseCase);
  requireCase(cases, "supabase", "filesystem", "collected");
  for (const destination of DESTINATION_KINDS) {
    requireCase(cases, "additional-semantic-supplier", destination, "collected");
    requireCase(cases, "synthetic-local-native-download", destination, "browser_download_unsupported");
  }
  return {
    schema: SEMANTIC_DOM_ACCEPTANCE_SCHEMA,
    collectorVersion: expectedVersion,
    acquisitionRevision: expectedRevision,
    completedAt: raw.completedAt,
    cases,
  };
}

function parseCase(value: unknown): SemanticDomAcceptanceCase {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("acceptance case is invalid");
  const raw = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "siteClass",
    "destinationKind",
    "firstRunAcceptedCount",
    "secondRunActionCount",
    "secondRunAcceptedCount",
    "cadenceRunActionCount",
    "cadenceRunAcceptedCount",
    "pageOwnedDownloadDelta",
    "closedOutcome",
    "pass",
  ]);
  if (Object.keys(raw).some((key) => !allowedKeys.has(key))) {
    throw new Error("acceptance case contains an unapproved field");
  }
  if (!SITE_CLASSES.includes(raw.siteClass as SiteClass)) throw new Error("acceptance site class is invalid");
  if (!DESTINATION_KINDS.includes(raw.destinationKind as DestinationKind)) throw new Error("acceptance destination is invalid");
  if (!OUTCOMES.includes(raw.closedOutcome as ClosedOutcome)) throw new Error("acceptance outcome is invalid");
  for (const field of [
    "firstRunAcceptedCount",
    "secondRunActionCount",
    "secondRunAcceptedCount",
    "cadenceRunActionCount",
    "cadenceRunAcceptedCount",
    "pageOwnedDownloadDelta",
  ] as const) {
    if (!Number.isInteger(raw[field]) || Number(raw[field]) < 0 || Number(raw[field]) > 10_000) {
      throw new Error(`acceptance ${field} is invalid`);
    }
  }
  if (
    raw.pass !== true ||
    raw.secondRunActionCount !== 0 ||
    raw.secondRunAcceptedCount !== 0 ||
    raw.cadenceRunActionCount !== 0 ||
    raw.cadenceRunAcceptedCount !== 0 ||
    raw.pageOwnedDownloadDelta !== 0
  ) {
    throw new Error("acceptance case does not prove idempotent, browser-file-free collection");
  }
  if (raw.closedOutcome === "collected" && Number(raw.firstRunAcceptedCount) < 1) {
    throw new Error("collected acceptance case must accept at least one document on its first run");
  }
  if (raw.closedOutcome !== "collected" && raw.firstRunAcceptedCount !== 0) {
    throw new Error("closed failure acceptance case cannot accept a document");
  }
  return raw as unknown as SemanticDomAcceptanceCase;
}

function requireCase(
  cases: readonly SemanticDomAcceptanceCase[],
  siteClass: SiteClass,
  destinationKind: DestinationKind,
  outcome: ClosedOutcome,
): void {
  if (!cases.some((entry) =>
    entry.siteClass === siteClass &&
    entry.destinationKind === destinationKind &&
    entry.closedOutcome === outcome
  )) {
    throw new Error(`missing ${siteClass}/${destinationKind}/${outcome} acceptance case`);
  }
}

function isRecentIsoDate(value: string, maximumAgeDays: number): boolean {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return false;
  const age = Date.now() - parsed;
  return age >= 0 && age <= maximumAgeDays * 24 * 60 * 60 * 1_000;
}

function main(): void {
  const path = process.argv[2] || "store/semantic-dom-acceptance.json";
  try {
    const receipt = parseSemanticDomAcceptanceReceipt(JSON.parse(readFileSync(path, "utf8")));
    console.log(
      `✓ semantic DOM acceptance: Collector ${receipt.collectorVersion}, acquisition ${receipt.acquisitionRevision}, ${receipt.cases.length} cases`,
    );
  } catch (error) {
    console.error(`✗ semantic DOM acceptance: ${error instanceof Error ? error.message : "invalid receipt"}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
