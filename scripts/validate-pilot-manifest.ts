import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pkg from "../package.json";
import { parsePilotManifest, type PilotManifest } from "../src/core/pilot-manifest";
import { VENDORS } from "../src/vendors";
import { releaseLifecycleIssues } from "../src/vendors/lifecycle";
import { assertCleanReleaseSource } from "./assert-release-source";

function main(): void {
  const path = process.argv.find((argument) => argument.endsWith(".json"));
  const ready = process.argv.includes("--ready");
  if (!path) throw new Error("usage: npm run validate:pilot -- <pilot-manifest.json> [--ready]");

  const manifest = parsePilotManifest(JSON.parse(readFileSync(path, "utf8")));
  if (ready) {
    const failures: string[] = [];
    try {
      assertCleanReleaseSource();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "release source is dirty");
    }
    if (manifest.status !== "ready" && manifest.status !== "evaluated") failures.push("manifest status is not ready");
    failures.push(...pilotWindowReadinessIssues(manifest, new Date()));
    if (manifest.collectorVersion !== pkg.version) failures.push(`Collector version must be ${pkg.version}`);
    const claimed = [...manifest.supplierIds].sort();
    const publicIds = VENDORS.map((vendor) => vendor.id).sort();
    if (JSON.stringify(claimed) !== JSON.stringify(publicIds)) failures.push("supplier claims must exactly match the public registry");
    failures.push(...releaseLifecycleIssues(manifest.supplierIds, { collectorVersion: manifest.collectorVersion }));

    const artifact = `artifacts/ratatosk-collector-v${manifest.collectorVersion}.zip`;
    if (!existsSync(artifact)) failures.push(`missing reviewed artifact ${artifact}`);
    else if (sha256(readFileSync(artifact)) !== manifest.collectorSha256) failures.push("Collector artifact checksum does not match manifest");
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (commit !== manifest.commitSha) failures.push("pilot commit does not match HEAD");
    failures.push(...rollbackArtifactIssues(manifest.rollback, manifest.collectorVersion));
    if (failures.length) throw new Error(`pilot is not ready:\n- ${failures.join("\n- ")}`);
  }

  console.log(`✓ ${path}: valid ${manifest.status} pilot manifest (${manifest.supplierIds.length} supplier claims, no participant identities).`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Verify that a ready pilot can actually roll back to the retained artifact. */
export function rollbackArtifactIssues(
  rollback: PilotManifest["rollback"],
  currentVersion: string,
  artifactsDirectory = "artifacts",
): string[] {
  const failures: string[] = [];
  const artifact = join(artifactsDirectory, `ratatosk-collector-v${rollback.collectorVersion}.zip`);
  if (/^0+$/.test(rollback.collectorSha256)) failures.push("rollback artifact checksum is still a template value");
  if (compareCollectorVersions(rollback.collectorVersion, currentVersion) >= 0) {
    failures.push("rollback version must be a previous known-good release");
  }
  if (!existsSync(artifact)) failures.push(`missing rollback artifact ${artifact}`);
  else if (sha256(readFileSync(artifact)) !== rollback.collectorSha256) {
    failures.push("rollback artifact checksum does not match manifest");
  }
  return failures;
}

export function pilotWindowReadinessIssues(
  manifest: Pick<PilotManifest, "status" | "window">,
  now = new Date(),
): string[] {
  if (manifest.status === "ready" && Date.parse(manifest.window.endsAt) <= now.getTime()) {
    return ["ready pilot window has expired; create and review a new manifest"];
  }
  return [];
}

/** Strict numeric ordering for the release versions accepted by the pilot
 * schema. A stable release sorts after its prerelease of the same tuple. */
export function compareCollectorVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z0-9.-]+))?$/.exec(value);
    if (!match) throw new Error(`invalid collector version: ${value}`);
    return { numbers: match.slice(1, 4).map(Number), prerelease: match[4]?.split(".") ?? [] };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < a.numbers.length; index++) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return compareNumericIdentifier(leftIdentifier, rightIdentifier);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier.localeCompare(rightIdentifier);
  }
  return 0;
}

function compareNumericIdentifier(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+/, "") || "0";
  const normalizedRight = right.replace(/^0+/, "") || "0";
  return normalizedLeft.length === normalizedRight.length
    ? normalizedLeft.localeCompare(normalizedRight)
    : normalizedLeft.length - normalizedRight.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
