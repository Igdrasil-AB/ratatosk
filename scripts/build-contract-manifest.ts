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
export const CONTRACT_CLIENT_FILE = "shared-client.ts.txt";
export const DROP_IN_CLIENT_FILE = "examples/igdrasil-connect-client.ts";

export interface ContractManifest {
  version: number;
  protocol: number;
  files: Record<string, string>;
}

export function contractFileHashes(directory: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(directory)
      .filter((name) => name !== CONTRACT_MANIFEST_FILE)
      .sort()
      .map((name) => [name, createHash("sha256").update(readFileSync(join(directory, name))).digest("hex")]),
  );
}

/**
 * The mirrored region of the drop-in client, between its explicit markers.
 *
 * Both repositories extract the SAME region — Ratatosk from the example,
 * Igdrasil from the client it actually ships — and check it against the copy
 * committed as `shared-client.ts.txt`.
 */
export function sharedClientRegion(source: string): string {
  const start = source.indexOf("// ---8<--- shared:");
  const end = source.indexOf("// ---8<--- end shared ---8<---");
  if (start < 0 || end < 0) throw new Error("shared client region markers are missing");
  return `${source.slice(source.indexOf("\n", start) + 1, end).trim()}\n`;
}

export function readContractManifest(directory: string): ContractManifest {
  return JSON.parse(readFileSync(join(directory, CONTRACT_MANIFEST_FILE), "utf8")) as ContractManifest;
}

function main(): void {
  // The canonical client region is committed as a fixture so the Igdrasil side
  // — which cannot read this repository — has something to compare against.
  writeFileSync(
    join(CONTRACT_FIXTURE_DIR, CONTRACT_CLIENT_FILE),
    sharedClientRegion(readFileSync(DROP_IN_CLIENT_FILE, "utf8")),
  );
  const manifest = readContractManifest(CONTRACT_FIXTURE_DIR);
  const next = { ...manifest, files: contractFileHashes(CONTRACT_FIXTURE_DIR) };
  writeFileSync(join(CONTRACT_FIXTURE_DIR, CONTRACT_MANIFEST_FILE), `${JSON.stringify(next, null, 2)}\n`);
  console.info(`[contract] wrote ${Object.keys(next.files).length} checksum(s)`);
  console.info("[contract] mirror this directory into the Igdrasil repository under services/engine-api/tests/fixtures/igdrasil-connect/");
}

if (process.argv[1]?.endsWith("build-contract-manifest.ts")) main();
