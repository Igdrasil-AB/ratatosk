import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SEMANTIC_DOM_ACCEPTANCE_SCHEMA, parseSemanticDomAcceptanceReceipt } from "./validate-semantic-dom-acceptance";
import { parseLiveAcceptanceSnapshot, type LiveAcceptanceSnapshot } from "../src/core/live-acceptance";

const session = JSON.parse(await readFile(resolve("artifacts/live/session.json"), "utf8")) as {
  collectorVersion?: string;
  discoveryEngine?: number;
  documentAcquisition?: number;
  artifactSha256?: string;
  commit?: string;
  state?: string;
  runtimeMatchedAt?: string;
  acceptanceSalt?: string;
  acceptanceNonce?: string;
};
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" }).trim();
if (
  typeof session.collectorVersion !== "string" ||
  !Number.isInteger(session.discoveryEngine) ||
  !Number.isInteger(session.documentAcquisition) ||
  typeof session.artifactSha256 !== "string" ||
  !/^[a-f0-9]{64}$/.test(session.artifactSha256) ||
  session.commit !== head || status || session.state !== "runtime_matched" ||
  typeof session.runtimeMatchedAt !== "string" || !isRecent(session.runtimeMatchedAt) ||
  typeof session.acceptanceSalt !== "string" || !/^[a-f0-9]{64}$/.test(session.acceptanceSalt) ||
  typeof session.acceptanceNonce !== "string" || !/^[a-f0-9]{32}$/.test(session.acceptanceNonce)
) throw new Error("prepared live session identity is invalid");
const collectorVersion = session.collectorVersion;
const discoveryRevision = session.discoveryEngine as number;
const acquisitionRevision = session.documentAcquisition as number;
const artifactSha256 = session.artifactSha256;
const acceptanceSalt = session.acceptanceSalt;
const acceptanceNonce = session.acceptanceNonce;
const runtimeMatchedAt = Date.parse(session.runtimeMatchedAt);
const artifactPath = resolve(`artifacts/ratatosk-collector-v${collectorVersion}.zip`);
const actualArtifactSha256 = createHash("sha256").update(await readFile(artifactPath)).digest("hex");
if (actualArtifactSha256 !== artifactSha256) throw new Error("prepared live session does not match the exact artifact");
const lines = (await readFile(resolve("artifacts/live/results.tsv"), "utf8")).trim().split("\n");
const header = ["hostname", "family", "destination_readback", "result", "boundary"];
if (lines[0] !== header.join("\t")) throw new Error("live result header is missing or incompatible");
const rows = lines.slice(1).filter(Boolean).map((line) => line.split("\t"));
if (rows.length < 3 || rows.some((row) => row.length !== header.length || row[3] !== "captured" || row[4] !== "none")) {
  throw new Error("all three required live supplier families must pass before creating a receipt");
}
const index = Object.fromEntries(header.map((name, position) => [name, position]));
const hosts = rows.map((row) => row[index.hostname]);
if (
  new Set(hosts).size !== hosts.length ||
  hosts.some((host) => !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) ||
  rows.some((row) => !/^(?:opaque_semantic_spa|server_rendered_documents|structured_api)$/.test(row[index.family]))
) throw new Error("live supplier rows are duplicated or structurally invalid");
const snapshots = (await readFile(resolve("artifacts/live/snapshots.ndjson"), "utf8"))
  .trim().split("\n").filter(Boolean).map((line) => parseLiveAcceptanceSnapshot(JSON.parse(line)));
if (snapshots.length !== rows.length * 4 || snapshots.some((snapshot) => !hosts.includes(snapshot.hostname))) {
  throw new Error("each approved supplier requires one preview and three connected snapshots");
}
const receipt = {
  schema: SEMANTIC_DOM_ACCEPTANCE_SCHEMA,
  collectorVersion,
  discoveryRevision,
  acquisitionRevision,
  artifactSha256,
  runtimeIdentityMatched: true,
  clickupAccepted: hosts.includes("app.clickup.com"),
  completedAt: new Date().toISOString(),
  cases: rows.map((row) => acceptanceCase(row, snapshots)),
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
console.info(`Session totals: ${JSON.stringify({ approved: rows.length, passed: receipt.cases.length, failed: 0, blocked: 0 })}`);

function acceptanceCase(row: string[], all: LiveAcceptanceSnapshot[]) {
  const hostname = row[index.hostname];
  const supplier = all.filter((snapshot) => snapshot.hostname === hostname);
  const preview = supplier[0];
  const connected = supplier.slice(1);
  if (preview?.stage !== "preview" || connected.length !== 3 || connected.some((snapshot) => snapshot.stage !== "connected")) {
    throw new Error(`live snapshot order is invalid for ${hostname}`);
  }
  const [first, immediate, cadence] = connected as Array<Extract<LiveAcceptanceSnapshot, { stage: "connected" }>>;
  const runtimeMatches = supplier.every((snapshot) =>
    snapshot.runtime.collectorVersion === collectorVersion &&
    snapshot.runtime.discoveryRevision === discoveryRevision &&
    snapshot.runtime.acquisitionRevision === acquisitionRevision &&
    snapshot.sessionNonce === acceptanceNonce &&
    Date.parse(snapshot.capturedAt) >= runtimeMatchedAt && isRecent(snapshot.capturedAt));
  const sameRunIdentity = connected.every((snapshot) => snapshot.stage === "connected" &&
    snapshot.vendorId === preview.vendorId &&
    snapshot.selectedPlanKind === first.selectedPlanKind &&
    snapshot.destinationKind === first.destinationKind &&
    snapshot.destinationToken === first.destinationToken);
  const ordered = Date.parse(first.run.recordedAt) < Date.parse(immediate.run.recordedAt) &&
    Date.parse(immediate.run.recordedAt) < Date.parse(cadence.run.recordedAt) &&
    [first, immediate, cadence].every((snapshot) => Date.parse(snapshot.run.recordedAt) >= runtimeMatchedAt && isRecent(snapshot.run.recordedAt));
  const destinationReadbackCount = Number(row[index.destination_readback]);
  const firstLedgerDelta = first.run.ledgerCount - preview.baselineLedgerCount;
  const immediateLedgerDelta = immediate.run.ledgerCount - first.run.ledgerCount;
  const cadenceLedgerDelta = cadence.run.ledgerCount - immediate.run.ledgerCount;
  if (
    !runtimeMatches || !sameRunIdentity || !ordered || !preview.planKinds.includes(first.selectedPlanKind) ||
    !/^(?:ok|partial)$/.test(first.run.status) || !/^(?:ok|partial)$/.test(immediate.run.status) || !/^(?:ok|partial)$/.test(cadence.run.status) ||
    first.run.acceptedCount < 1 || firstLedgerDelta !== first.run.acceptedCount ||
    !Number.isInteger(destinationReadbackCount) || destinationReadbackCount !== first.run.acceptedCount ||
    immediate.run.acceptedCount !== 0 || immediate.run.actionCount !== 0 || immediateLedgerDelta !== 0 ||
    cadence.run.acceptedCount !== 0 || cadence.run.actionCount !== 0 || cadenceLedgerDelta !== 0
  ) throw new Error(`live acceptance did not pass for ${hostname}`);
  return {
    supplierToken: createHash("sha256").update(`${acceptanceSalt}\0${hostname}`).digest("hex").slice(0, 24),
    family: row[index.family],
    planCount: preview.planCount,
    planKinds: preview.planKinds,
    selectedPlanKind: first.selectedPlanKind,
    destinationKind: first.destinationKind,
    destinationToken: first.destinationToken,
    firstRunAcceptedCount: first.run.acceptedCount,
    firstRunActionCount: first.run.actionCount,
    firstRunLedgerDelta: firstLedgerDelta,
    destinationReadbackCount,
    immediateRunAcceptedCount: immediate.run.acceptedCount,
    immediateRunActionCount: immediate.run.actionCount,
    immediateRunLedgerDelta: immediateLedgerDelta,
    cadenceRunAcceptedCount: cadence.run.acceptedCount,
    cadenceRunActionCount: cadence.run.actionCount,
    cadenceRunLedgerDelta: cadenceLedgerDelta,
    pageOwnedDownloadDelta: first.run.pageOwnedDownloadDelta + immediate.run.pageOwnedDownloadDelta + cadence.run.pageOwnedDownloadDelta,
    closedOutcome: "collected",
    pass: true,
  };
}

function isRecent(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value &&
    Date.now() - timestamp >= 0 && Date.now() - timestamp <= 24 * 60 * 60_000;
}
