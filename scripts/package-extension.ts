import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { zipSync, type Zippable } from "fflate";
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
  host_permissions?: string[];
  optional_host_permissions?: string[];
  content_scripts?: Array<{ matches?: string[] }>;
  content_security_policy?: { extension_pages?: string };
};
if (manifest.manifest_version !== 3) throw new Error(`${target} build is not Manifest V3`);
if (manifest.version !== pkg.version) throw new Error(`${target} manifest version ${manifest.version} does not match ${pkg.version}`);
if (target === "collector") validateCollectorManifest(manifest);
if (target === "studio") validateStudioManifest(manifest);

const files: Record<string, Uint8Array> = {};
for (const path of walk(root)) {
  const name = relative(root, path).replaceAll("\\", "/");
  if (name.endsWith(".map")) throw new Error(`source map must not ship: ${name}`);
  if (/(^|\/)\.env(?:\.|$)|(^|\/)(?:test|tests|fixtures?)(?:\/|$)/i.test(name)) {
    throw new Error(`repository-only file must not ship: ${name}`);
  }
  if (target === "studio" && /(^|\/)collector(?:\/|$)/i.test(name)) {
    throw new Error(`Collector file must not ship in Studio: ${name}`);
  }
  if (target === "collector" && /(^|\/)studio(?:\/|$)/i.test(name)) {
    throw new Error(`Studio file must not ship in Collector: ${name}`);
  }
  files[name] = new Uint8Array(readFileSync(path));
}
if (!files["manifest.json"]) throw new Error("manifest.json must be at the ZIP root");
if (target === "studio") assertStudioBundle(files);
if (target === "collector") assertCollectorBundle(files);

const deterministicFiles: Zippable = Object.fromEntries(
  Object.entries(files).map(([name, contents]) => [name, [contents, { mtime: "1980-01-01T00:00:00.000Z" }]]),
);
const bytes = zipSync(deterministicFiles, { level: 9 });
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

function validateStudioManifest(manifest: {
  name?: string;
  permissions?: string[];
  host_permissions?: string[];
  content_scripts?: Array<{ matches?: string[] }>;
  content_security_policy?: { extension_pages?: string };
}): void {
  if (manifest.name !== "Ratatosk Studio — Development Build") throw new Error("unexpected Studio name");

  const expected = ["activeTab", "debugger", "scripting", "storage"];
  const actual = [...(manifest.permissions ?? [])].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`unexpected Studio permissions: ${actual.join(", ")}`);
  }
  if ((manifest.host_permissions ?? []).length > 0) throw new Error("Studio must not have host permissions");
  if ((manifest.content_scripts ?? []).length > 0) throw new Error("Studio must not ship content scripts");
  if (manifest.content_security_policy?.extension_pages !== "script-src 'self'; object-src 'self'") {
    throw new Error("Studio CSP is not the reviewed strict policy");
  }
}

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
