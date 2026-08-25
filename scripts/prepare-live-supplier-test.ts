import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import pkg from "../package.json";

const browser = option("--browser") ?? "chrome";
if (browser !== "chrome") throw new Error("live supplier testing currently requires --browser chrome");

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
if (resolve(root) !== resolve(process.cwd())) throw new Error(`run from the canonical checkout root: ${root}`);
const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" }).trim();
if (status) throw new Error(`live test source must be committed and clean:\n${status}`);
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("could not resolve the exact live-test commit");

const source = resolve("dist/collector");
const stable = resolve(process.env.RATATOSK_LIVE_EXTENSION_DIR ?? "artifacts/live/collector");
if (stable === resolve(root) || !stable.startsWith(`${resolve(root)}/artifacts/`)) {
  throw new Error("live extension directory must stay under this checkout's artifacts directory");
}
const manifest = JSON.parse(await readFile(resolve(source, "manifest.json"), "utf8")) as {
  version?: string;
  manifest_version?: number;
};
const serviceWorkerLoader = await readFile(resolve(source, "service-worker-loader.js"), "utf8");
const serviceWorkerChunk = /['"]\.\/(assets\/service-worker[^'"]+\.js)['"]/.exec(serviceWorkerLoader)?.[1];
if (!serviceWorkerChunk) throw new Error("built Collector service-worker chunk is missing");
const serviceWorkerSha256 = createHash("sha256")
  .update(await readFile(resolve(source, serviceWorkerChunk)))
  .digest("hex");
const discoveryEngine = await numericRevision(
  "collector/src/platform/discovery-explorer.ts", "DISCOVERY_ENGINE_REVISION",
);
const documentAcquisition = await numericRevision(
  "collector/src/platform/acquisition-revision.ts", "DOCUMENT_ACQUISITION_REVISION",
);
if (manifest.version !== pkg.version || manifest.manifest_version !== 3) {
  throw new Error("built Collector manifest does not match the package identity");
}
const checksumPath = resolve(`artifacts/ratatosk-collector-v${pkg.version}.zip.sha256`);
const checksum = (await readFile(checksumPath, "utf8")).trim().split(/\s+/, 1)[0];
if (!/^[0-9a-f]{64}$/.test(checksum)) throw new Error("Collector artifact checksum is missing or invalid");

await rm(stable, { recursive: true, force: true });
await mkdir(stable, { recursive: true });
await cp(source, stable, { recursive: true });
const sourceDigest = await directoryDigest(source);
const stableDigest = await directoryDigest(stable);
if (sourceDigest !== stableDigest) throw new Error("stable unpacked Collector does not match dist/collector");

const sessionPath = resolve("artifacts/live/session.json");
const session = {
  schema: "ratatosk.live-supplier-test.v1",
  state: "awaiting_reload",
  browser,
  commit,
  collectorVersion: pkg.version,
  discoveryEngine,
  documentAcquisition,
  artifactSha256: checksum,
  unpackedDigest: stableDigest,
  serviceWorkerChunk,
  serviceWorkerSha256,
  extensionPath: stable,
  preparedAt: new Date().toISOString(),
};
await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`);

console.info(`Prepared Collector ${pkg.version} from ${commit}`);
console.info(`SHA-256 ${checksum}`);
console.info(`Unpacked ${stable}`);
console.info(`Service worker ${serviceWorkerChunk} (${serviceWorkerSha256})`);
console.info(`Expected runtime v${pkg.version} discovery-engine=${discoveryEngine} document-acquisition=${documentAcquisition}`);
console.info("Existing Chrome handoff required: reload this unpacked folder, then run scripts/live-supplier-test.sh");

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function directoryDigest(directory: string): Promise<string> {
  const files = await listFiles(directory);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(directory, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function numericRevision(path: string, name: string): Promise<number> {
  const source = await readFile(resolve(path), "utf8");
  const match = new RegExp(`export const ${name} = (\\d+);`).exec(source);
  const value = Number(match?.[1]);
  if (!Number.isInteger(value) || value < 1 || value > 10_000) throw new Error(`invalid ${name}`);
  return value;
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  }));
  return files.flat().sort();
}
