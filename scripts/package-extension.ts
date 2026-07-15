import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { zipSync } from "fflate";
import pkg from "../package.json";

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
  optional_host_permissions?: string[];
  content_scripts?: Array<{ matches?: string[] }>;
  content_security_policy?: { extension_pages?: string };
};
if (manifest.manifest_version !== 3) throw new Error(`${target} build is not Manifest V3`);
if (manifest.version !== pkg.version) throw new Error(`${target} manifest version ${manifest.version} does not match ${pkg.version}`);
if (target === "collector") validateCollectorManifest(manifest);

const files: Record<string, Uint8Array> = {};
for (const path of walk(root)) {
  const name = relative(root, path).replaceAll("\\", "/");
  if (name.endsWith(".map")) throw new Error(`source map must not ship: ${name}`);
  files[name] = new Uint8Array(readFileSync(path));
}
if (!files["manifest.json"]) throw new Error("manifest.json must be at the ZIP root");

const bytes = zipSync(files, { level: 9 });
const artifacts = "artifacts";
mkdirSync(artifacts, { recursive: true });
const filename = `ratatosk-${target}-v${pkg.version}.zip`;
const destination = join(artifacts, filename);
writeFileSync(destination, bytes);
const sha256 = createHash("sha256").update(bytes).digest("hex");
writeFileSync(`${destination}.sha256`, `${sha256}  ${destination}\n`);
console.log(`Packaged ${destination} (${Object.keys(files).length} files)`);
console.log(`SHA-256 ${sha256}`);

function walk(directory: string): string[] {
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
}

function validateCollectorManifest(manifest: {
  name?: string;
  permissions?: string[];
  optional_host_permissions?: string[];
  content_scripts?: Array<{ matches?: string[] }>;
  content_security_policy?: { extension_pages?: string };
}): void {
  if (manifest.name !== "Ratatosk — Invoice Collector") throw new Error("unexpected Collector name");

  const expected = ["alarms", "downloads", "notifications", "scripting", "storage"];
  const actual = [...(manifest.permissions ?? [])].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`unexpected Collector permissions: ${actual.join(", ")}`);
  }

  const forbidden = new Set(["debugger", "tabs", "activeTab", "cookies", "webRequest", "webRequestBlocking"]);
  if (actual.some((permission) => forbidden.has(permission))) throw new Error("Collector contains an authoring permission");
  if ((manifest.optional_host_permissions ?? []).includes("<all_urls>")) throw new Error("Collector requests <all_urls>");

  const contentMatches = manifest.content_scripts?.flatMap((script) => script.matches ?? []) ?? [];
  if (JSON.stringify(contentMatches) !== JSON.stringify(["https://accounting.igdrasil.se/*"])) {
    throw new Error(`unexpected Collector content-script matches: ${contentMatches.join(", ")}`);
  }
  if (manifest.content_security_policy?.extension_pages !== "script-src 'self'; object-src 'self'") {
    throw new Error("Collector CSP is not the reviewed strict policy");
  }
}
