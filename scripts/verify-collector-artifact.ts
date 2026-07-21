import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pkg from "../package.json";

export function collectorArtifactIssues(
  version: string,
  artifactsDirectory = "artifacts",
): string[] {
  const basename = `ratatosk-collector-v${version}.zip`;
  const archive = join(artifactsDirectory, basename);
  const checksumPath = `${archive}.sha256`;
  const issues: string[] = [];

  if (!existsSync(archive)) issues.push(`missing exact Collector artifact ${archive}`);
  if (!existsSync(checksumPath)) issues.push(`missing exact Collector checksum ${checksumPath}`);
  if (issues.length > 0) return issues;

  const checksum = readFileSync(checksumPath, "utf8");
  const match = /^([a-f0-9]{64}) {2}([^\r\n]+)\r?\n?$/.exec(checksum);
  if (!match || match[2] !== basename) {
    return [`${checksumPath} must contain exactly one SHA-256 entry for ${basename}`];
  }

  const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (actual !== match[1]) issues.push(`checksum mismatch for exact Collector artifact ${archive}`);
  return issues;
}

function main(): void {
  const issues = collectorArtifactIssues(pkg.version);
  if (issues.length > 0) throw new Error(`Collector artifact verification failed:\n- ${issues.join("\n- ")}`);
  console.log(`✓ verified artifacts/ratatosk-collector-v${pkg.version}.zip and its exact checksum`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
