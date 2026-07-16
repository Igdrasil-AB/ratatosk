import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import pkg from "../package.json";
import { parsePilotManifest } from "../src/core/pilot-manifest";
import { VENDORS } from "../src/vendors";
import { releaseLifecycleIssues } from "../src/vendors/lifecycle";

const path = process.argv.find((argument) => argument.endsWith(".json"));
const ready = process.argv.includes("--ready");
if (!path) throw new Error("usage: npm run validate:pilot -- <pilot-manifest.json> [--ready]");

const manifest = parsePilotManifest(JSON.parse(readFileSync(path, "utf8")));
if (ready) {
  const failures: string[] = [];
  if (manifest.status !== "ready" && manifest.status !== "evaluated") failures.push("manifest status is not ready");
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
  if (/^0+$/.test(manifest.rollback.collectorSha256)) failures.push("rollback artifact checksum is still a template value");
  if (manifest.rollback.collectorVersion === manifest.collectorVersion) failures.push("rollback version must be a previous known-good release");
  if (failures.length) throw new Error(`pilot is not ready:\n- ${failures.join("\n- ")}`);
}

console.log(`✓ ${path}: valid ${manifest.status} pilot manifest (${manifest.supplierIds.length} supplier claims, no participant identities).`);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
