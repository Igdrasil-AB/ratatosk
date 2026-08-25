import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pkg from "../package.json";
import { DOCUMENT_ACQUISITION_REVISION } from "../collector/src/platform/acquisition-revision";

export const SEMANTIC_DOM_ACCEPTANCE_SCHEMA = "ratatosk.semantic-dom-acceptance.v2" as const;

const FAMILIES = [
  "opaque_semantic_spa",
  "server_rendered_documents",
  "structured_api",
] as const;
const DESTINATIONS = ["filesystem", "igdrasil"] as const;
type SupplierFamily = typeof FAMILIES[number];
type DestinationKind = typeof DESTINATIONS[number];

export interface SemanticDomAcceptanceCase {
  family: SupplierFamily;
  destinationKind: DestinationKind;
  firstRunAcceptedCount: number;
  firstRunActionCount: number;
  firstRunLedgerDelta: number;
  destinationReadbackCount: number;
  immediateRunAcceptedCount: 0;
  immediateRunActionCount: 0;
  immediateRunLedgerDelta: 0;
  cadenceRunAcceptedCount: 0;
  cadenceRunActionCount: 0;
  cadenceRunLedgerDelta: 0;
  pageOwnedDownloadDelta: 0;
  closedOutcome: "collected";
  pass: true;
}

export interface SemanticDomAcceptanceReceipt {
  schema: typeof SEMANTIC_DOM_ACCEPTANCE_SCHEMA;
  collectorVersion: string;
  discoveryRevision: number;
  acquisitionRevision: number;
  artifactSha256: string;
  runtimeIdentityMatched: true;
  unrelatedUserDownloadSameUrlUntouched: true;
  completedAt: string;
  cases: SemanticDomAcceptanceCase[];
}

export function parseSemanticDomAcceptanceReceipt(
  value: unknown,
  expectedVersion: string,
  expectedDiscoveryRevision: number,
  expectedAcquisitionRevision: number,
  expectedArtifactSha256: string,
): SemanticDomAcceptanceReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("receipt must be an object");
  const raw = value as Record<string, unknown>;
  exactKeys(raw, [
    "schema", "collectorVersion", "discoveryRevision", "acquisitionRevision",
    "artifactSha256", "runtimeIdentityMatched", "unrelatedUserDownloadSameUrlUntouched",
    "completedAt", "cases",
  ], "receipt");
  if (raw.schema !== SEMANTIC_DOM_ACCEPTANCE_SCHEMA) throw new Error("receipt schema is invalid");
  if (raw.collectorVersion !== expectedVersion) throw new Error(`receipt must match Collector ${expectedVersion}`);
  if (raw.discoveryRevision !== expectedDiscoveryRevision) {
    throw new Error(`receipt must match discovery revision ${expectedDiscoveryRevision}`);
  }
  if (raw.acquisitionRevision !== expectedAcquisitionRevision) {
    throw new Error(`receipt must match document acquisition revision ${expectedAcquisitionRevision}`);
  }
  if (
    typeof raw.artifactSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.artifactSha256) ||
    raw.artifactSha256 !== expectedArtifactSha256
  ) throw new Error("receipt must match the exact Collector artifact SHA-256");
  if (raw.runtimeIdentityMatched !== true) throw new Error("receipt must prove the prepared runtime identity");
  if (raw.unrelatedUserDownloadSameUrlUntouched !== true) {
    throw new Error("receipt must prove the same-URL unrelated user download remained untouched");
  }
  if (typeof raw.completedAt !== "string" || !isRecentIsoDate(raw.completedAt, 7)) {
    throw new Error("receipt completion date must be a valid ISO date from the last 7 days");
  }
  if (!Array.isArray(raw.cases) || raw.cases.length < 3 || raw.cases.length > 12) {
    throw new Error("receipt must contain 3 to 12 bounded live cases");
  }
  const cases = raw.cases.map(parseCase);
  for (const family of FAMILIES) {
    if (!cases.some((entry) => entry.family === family)) throw new Error(`missing ${family} live acceptance case`);
  }
  if (!cases.some((entry) => entry.destinationKind === "igdrasil")) {
    throw new Error("receipt must include an Igdrasil destination readback");
  }
  return {
    schema: SEMANTIC_DOM_ACCEPTANCE_SCHEMA,
    collectorVersion: expectedVersion,
    discoveryRevision: expectedDiscoveryRevision,
    acquisitionRevision: expectedAcquisitionRevision,
    artifactSha256: raw.artifactSha256,
    runtimeIdentityMatched: true,
    unrelatedUserDownloadSameUrlUntouched: true,
    completedAt: raw.completedAt,
    cases,
  };
}

function parseCase(value: unknown): SemanticDomAcceptanceCase {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("acceptance case is invalid");
  const raw = value as Record<string, unknown>;
  exactKeys(raw, [
    "family", "destinationKind", "firstRunAcceptedCount", "firstRunActionCount",
    "firstRunLedgerDelta", "destinationReadbackCount", "immediateRunAcceptedCount",
    "immediateRunActionCount", "immediateRunLedgerDelta", "cadenceRunAcceptedCount",
    "cadenceRunActionCount", "cadenceRunLedgerDelta", "pageOwnedDownloadDelta",
    "closedOutcome", "pass",
  ], "acceptance case");
  if (!FAMILIES.includes(raw.family as SupplierFamily)) throw new Error("acceptance family is invalid");
  if (!DESTINATIONS.includes(raw.destinationKind as DestinationKind)) throw new Error("acceptance destination is invalid");
  for (const field of [
    "firstRunAcceptedCount", "firstRunActionCount", "firstRunLedgerDelta",
    "destinationReadbackCount", "immediateRunAcceptedCount", "immediateRunActionCount",
    "immediateRunLedgerDelta", "cadenceRunAcceptedCount", "cadenceRunActionCount",
    "cadenceRunLedgerDelta", "pageOwnedDownloadDelta",
  ] as const) {
    if (!Number.isInteger(raw[field]) || Number(raw[field]) < 0 || Number(raw[field]) > 10_000) {
      throw new Error(`acceptance ${field} is invalid`);
    }
  }
  if (
    raw.pass !== true || raw.closedOutcome !== "collected" ||
    Number(raw.firstRunAcceptedCount) < 1 ||
    raw.firstRunLedgerDelta !== raw.firstRunAcceptedCount ||
    raw.destinationReadbackCount !== raw.firstRunAcceptedCount ||
    raw.immediateRunAcceptedCount !== 0 || raw.immediateRunActionCount !== 0 || raw.immediateRunLedgerDelta !== 0 ||
    raw.cadenceRunAcceptedCount !== 0 || raw.cadenceRunActionCount !== 0 || raw.cadenceRunLedgerDelta !== 0 ||
    raw.pageOwnedDownloadDelta !== 0
  ) throw new Error("acceptance case does not prove end-to-end idempotent collection");
  return raw as unknown as SemanticDomAcceptanceCase;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) {
    throw new Error(`${label} contains an unapproved or missing field`);
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
  const artifactPath = process.argv[3] || join("artifacts", `ratatosk-collector-v${pkg.version}.zip`);
  try {
    const artifactSha256 = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
    const receipt = parseSemanticDomAcceptanceReceipt(
      JSON.parse(readFileSync(path, "utf8")),
      pkg.version,
      sourceDiscoveryRevision(),
      DOCUMENT_ACQUISITION_REVISION,
      artifactSha256,
    );
    console.log(
      `✓ live acquisition acceptance: Collector ${receipt.collectorVersion}, discovery ${receipt.discoveryRevision}, acquisition ${receipt.acquisitionRevision}, ${receipt.cases.length} supplier families`,
    );
  } catch (error) {
    console.error(`✗ live acquisition acceptance: ${error instanceof Error ? error.message : "invalid receipt"}`);
    process.exit(1);
  }
}

function sourceDiscoveryRevision(): number {
  const source = readFileSync("collector/src/platform/discovery-explorer.ts", "utf8");
  const value = Number(/export const DISCOVERY_ENGINE_REVISION = (\d+);/.exec(source)?.[1]);
  if (!Number.isInteger(value) || value < 1 || value > 10_000) throw new Error("discovery revision source is invalid");
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
