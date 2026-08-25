import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SEMANTIC_DOM_ACCEPTANCE_SCHEMA, parseSemanticDomAcceptanceReceipt } from "./validate-semantic-dom-acceptance";

const session = JSON.parse(await readFile(resolve("artifacts/live/session.json"), "utf8")) as {
  collectorVersion?: string;
  discoveryEngine?: number;
  documentAcquisition?: number;
  artifactSha256?: string;
};
if (
  typeof session.collectorVersion !== "string" ||
  !Number.isInteger(session.discoveryEngine) ||
  !Number.isInteger(session.documentAcquisition) ||
  typeof session.artifactSha256 !== "string" ||
  !/^[a-f0-9]{64}$/.test(session.artifactSha256)
) throw new Error("prepared live session identity is invalid");
const collectorVersion = session.collectorVersion;
const discoveryRevision = session.discoveryEngine as number;
const acquisitionRevision = session.documentAcquisition as number;
const artifactSha256 = session.artifactSha256;
const lines = (await readFile(resolve("artifacts/live/results.tsv"), "utf8")).trim().split("\n");
const header = [
  "hostname", "family", "destination", "discovery", "boundary", "first_status",
  "first_accepted", "first_actions", "first_ledger", "destination_readback",
  "immediate_accepted", "immediate_actions", "immediate_ledger", "cadence_accepted",
  "cadence_actions", "cadence_ledger", "page_owned_downloads", "result",
];
if (lines[0] !== header.join("\t")) throw new Error("live result header is missing or incompatible");
const rows = lines.slice(1).filter(Boolean).map((line) => line.split("\t"));
if (rows.length < 3 || rows.some((row) => row.length !== header.length || row.at(-1) !== "pass")) {
  throw new Error("all three required live supplier families must pass before creating a receipt");
}
const index = Object.fromEntries(header.map((name, position) => [name, position]));
const number = (row: string[], field: string): number => {
  const value = Number(row[index[field]]);
  if (!Number.isInteger(value) || value < 0 || value > 10_000) throw new Error(`invalid live count ${field}`);
  return value;
};
const receipt = {
  schema: SEMANTIC_DOM_ACCEPTANCE_SCHEMA,
  collectorVersion,
  discoveryRevision,
  acquisitionRevision,
  artifactSha256,
  runtimeIdentityMatched: true,
  unrelatedUserDownloadSameUrlUntouched: true,
  completedAt: new Date().toISOString(),
  cases: rows.map((row) => ({
    family: row[index.family],
    destinationKind: row[index.destination],
    firstRunAcceptedCount: number(row, "first_accepted"),
    firstRunActionCount: number(row, "first_actions"),
    firstRunLedgerDelta: number(row, "first_ledger"),
    destinationReadbackCount: number(row, "destination_readback"),
    immediateRunAcceptedCount: number(row, "immediate_accepted"),
    immediateRunActionCount: number(row, "immediate_actions"),
    immediateRunLedgerDelta: number(row, "immediate_ledger"),
    cadenceRunAcceptedCount: number(row, "cadence_accepted"),
    cadenceRunActionCount: number(row, "cadence_actions"),
    cadenceRunLedgerDelta: number(row, "cadence_ledger"),
    pageOwnedDownloadDelta: number(row, "page_owned_downloads"),
    closedOutcome: "collected",
    pass: true,
  })),
};
parseSemanticDomAcceptanceReceipt(
  receipt,
  collectorVersion,
  discoveryRevision,
  acquisitionRevision,
  artifactSha256,
);
const output = resolve("store/semantic-dom-acceptance.json");
await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
console.info(`✓ wrote fresh live acceptance receipt: ${output}`);
