import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import pkg from "../package.json";
import { zipDeterministically } from "./deterministic-zip";
import { assertPackageFileSafe, collectPackageFiles } from "./package-files";
import { validateCollectorManifest, validateStudioManifest } from "./manifest-validation";

const target = process.argv[2];
if (target !== "collector" && target !== "studio") {
  throw new Error("usage: tsx scripts/package-extension.ts <collector|studio>");
}

const root = join("dist", target);
const manifestPath = join(root, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  version?: string;
  manifest_version?: number;
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
if (target === "collector") validateCollectorManifest(manifest);
if (target === "studio") validateStudioManifest(manifest);

const files: Record<string, Uint8Array> = {};
for (const path of collectPackageFiles(root)) {
  const name = relative(root, path).replaceAll("\\", "/");
  const contents = new Uint8Array(readFileSync(path));
  assertPackageFileSafe(name, contents);
  if (target === "studio" && /(^|\/)collector(?:\/|$)/i.test(name)) {
    throw new Error(`Collector file must not ship in Studio: ${name}`);
  }
  if (target === "collector" && /(^|\/)studio(?:\/|$)/i.test(name)) {
    throw new Error(`Studio file must not ship in Collector: ${name}`);
  }
  files[name] = contents;
}
if (!files["manifest.json"]) throw new Error("manifest.json must be at the ZIP root");
if (target === "studio") assertStudioBundle(files);
if (target === "collector") assertCollectorBundle(files);

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

function assertStudioBundle(files: Record<string, Uint8Array>): void {
  const javascript = Object.entries(files)
    .filter(([name]) => name.endsWith(".js"))
    .map(([, contents]) => Buffer.from(contents).toString("utf8"))
    .join("\n");
  for (const messageType of ["fingerprintOutboxList", "fingerprintOutboxGet"]) {
    if (!javascript.includes(messageType)) {
      throw new Error(`Studio bundle does not contain required recovery message: ${messageType}`);
    }
  }
}

function assertCollectorBundle(files: Record<string, Uint8Array>): void {
  const javascript = Object.entries(files)
    .filter(([name]) => name.endsWith(".js"))
    .map(([, contents]) => Buffer.from(contents).toString("utf8"))
    .join("\n");
  for (const studioMarker of ["fingerprintOutboxGet", "recorderStart", "chrome.debugger"]) {
    if (javascript.includes(studioMarker)) throw new Error(`Collector bundle contains Studio marker: ${studioMarker}`);
  }
}
