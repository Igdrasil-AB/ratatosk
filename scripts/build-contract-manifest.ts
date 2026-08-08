/**
 * Regenerate the shared contract checksum manifest.
 *
 * The manifest is what makes the two repositories one contract rather than two
 * copies: each side hashes its own fixture files and asserts the result matches
 * these bytes, so a change made in Ratatosk and not mirrored into Igdrasil (or
 * the reverse) fails both suites instead of drifting for three weeks the way
 * `examples/igdrasil-connect-client.ts` did.
 *
 *   npx tsx scripts/build-contract-manifest.ts
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CONTRACT_FIXTURE_DIR = "test/fixtures/igdrasil-connect";
export const CONTRACT_MANIFEST_FILE = "manifest.json";

export interface ContractManifest {
  version: number;
  protocol: number;
  files: Record<string, string>;
}

export function contractFileHashes(directory: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(directory)
      .filter((name) => name.endsWith(".json") && name !== CONTRACT_MANIFEST_FILE)
      .sort()
      .map((name) => [name, createHash("sha256").update(readFileSync(join(directory, name))).digest("hex")]),
  );
}

export function readContractManifest(directory: string): ContractManifest {
  return JSON.parse(readFileSync(join(directory, CONTRACT_MANIFEST_FILE), "utf8")) as ContractManifest;
}

function main(): void {
  const manifest = readContractManifest(CONTRACT_FIXTURE_DIR);
  const next = { ...manifest, files: contractFileHashes(CONTRACT_FIXTURE_DIR) };
  writeFileSync(join(CONTRACT_FIXTURE_DIR, CONTRACT_MANIFEST_FILE), `${JSON.stringify(next, null, 2)}\n`);
  console.info(`[contract] wrote ${Object.keys(next.files).length} checksum(s)`);
  console.info("[contract] mirror this directory into the Igdrasil repository under services/engine-api/tests/fixtures/igdrasil-connect/");
}

if (process.argv[1]?.endsWith("build-contract-manifest.ts")) main();
