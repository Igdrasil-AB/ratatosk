import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import pkg from "../package.json";
import {
  DOCUMENT_ACQUISITION_REVISION,
  DOCUMENT_ACQUISITION_RUNTIME_MARKER,
} from "../collector/src/platform/acquisition-revision";
import { zipDeterministically } from "./deterministic-zip";
import { assertPackageFileSafe, collectPackageFiles } from "./package-files";
import { validateCollectorManifest } from "./manifest-validation";

const target = process.argv[2];
if (target !== "collector") {
  throw new Error("usage: tsx scripts/package-extension.ts collector");
}

const root = join("dist", target);
const manifestPath = join(root, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  version?: string;
  manifest_version?: number;
  minimum_chrome_version?: string;
  name?: string;
  permissions?: string[];
  host_permissions?: string[];
  optional_permissions?: string[];
  optional_host_permissions?: string[];
  content_scripts?: Array<{ matches?: string[] }>;
  content_security_policy?: { extension_pages?: string };
  side_panel?: { default_path?: string };
  action?: { default_popup?: string };
};
if (manifest.manifest_version !== 3) throw new Error(`${target} build is not Manifest V3`);
if (manifest.version !== pkg.version) throw new Error(`${target} manifest version ${manifest.version} does not match ${pkg.version}`);
validateCollectorManifest(manifest);

const files: Record<string, Uint8Array> = {};
for (const path of collectPackageFiles(root)) {
  const name = relative(root, path).replaceAll("\\", "/");
  const contents = new Uint8Array(readFileSync(path));
  assertPackageFileSafe(name, contents);
  if (/(^|\/)studio(?:\/|$)/i.test(name)) {
    throw new Error(`Studio file must not ship in Collector: ${name}`);
  }
  files[name] = contents;
}
if (!files["manifest.json"]) throw new Error("manifest.json must be at the ZIP root");
assertCollectorBundle(files);

const bytes = zipDeterministically(files);
const artifacts = "artifacts";
mkdirSync(artifacts, { recursive: true });
const filename = `ratatosk-${target}-v${pkg.version}.zip`;
const destination = join(artifacts, filename);
writeFileSync(destination, bytes);
const sha256 = createHash("sha256").update(bytes).digest("hex");
// GitHub release assets are downloaded into a flat directory. Record only the
// asset basename so `shasum -c` works for both local artifacts and downloads.
writeFileSync(`${destination}.sha256`, `${sha256}  ${filename}\n`);
console.log(`Packaged ${destination} (${Object.keys(files).length} files)`);
console.log(`SHA-256 ${sha256}`);

function assertCollectorBundle(files: Record<string, Uint8Array>): void {
  const javascript = Object.entries(files)
    .filter(([name]) => name.endsWith(".js"))
    .map(([, contents]) => Buffer.from(contents).toString("utf8"))
    .join("\n");
  // Authoring capabilities were removed with the Studio build. These markers stay
  // as a permanent regression guard: the consumer ZIP must never regain a
  // debugger-backed recorder or a fingerprint delivery path.
  for (const authoringMarker of ["fingerprintOutboxGet", "recorderStart", "chrome.debugger"]) {
    if (javascript.includes(authoringMarker)) {
      throw new Error(`Collector bundle contains an authoring marker: ${authoringMarker}`);
    }
  }
  const acquisitionMarker = `document-acquisition=${DOCUMENT_ACQUISITION_REVISION}`;
  if (DOCUMENT_ACQUISITION_RUNTIME_MARKER !== acquisitionMarker) {
    throw new Error(`Collector runtime acquisition marker does not match revision ${DOCUMENT_ACQUISITION_REVISION}`);
  }
  if (!javascript.includes(acquisitionMarker)) {
    throw new Error(`Collector bundle is missing runtime identity ${acquisitionMarker}`);
  }
}
