export interface CollectorManifestBoundary {
  name?: string;
  permissions?: string[];
  host_permissions?: string[];
  optional_permissions?: string[];
  optional_host_permissions?: string[];
  content_scripts?: Array<{ matches?: string[] }>;
  content_security_policy?: { extension_pages?: string };
  side_panel?: { default_path?: string };
  action?: { default_popup?: string };
}

export interface StudioManifestBoundary {
  name?: string;
  permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  content_scripts?: Array<{ matches?: string[] }>;
  content_security_policy?: { extension_pages?: string };
}

export function validateCollectorManifest(manifest: CollectorManifestBoundary): void {
  if (manifest.name !== "Ratatosk — Invoice Collector") throw new Error("unexpected Collector name");

  const expected = ["activeTab", "alarms", "downloads", "notifications", "scripting", "sidePanel", "storage", "webRequest"];
  const actual = [...(manifest.permissions ?? [])].sort();
  if (!sameStringSet(actual, expected)) {
    throw new Error(`unexpected Collector permissions: ${actual.join(", ")}`);
  }

  const forbidden = new Set(["debugger", "tabs", "cookies", "webRequestBlocking"]);
  if (actual.some((permission) => forbidden.has(permission))) throw new Error("Collector contains an authoring permission");
  if (!sameStringSet(manifest.host_permissions, ["https://accounting.igdrasil.se/*"])) {
    throw new Error(`unexpected Collector required host permissions: ${(manifest.host_permissions ?? []).join(", ")}`);
  }
  if (!sameStringSet(manifest.optional_host_permissions, ["https://*/*"])) {
    throw new Error("Collector must declare only the reviewed HTTPS optional-host envelope");
  }
  if (!sameStringSet(manifest.optional_permissions, ["tabs"])) {
    throw new Error(`unexpected Collector optional permissions: ${(manifest.optional_permissions ?? []).join(", ")}`);
  }
  if (manifest.side_panel?.default_path !== "collector/src/ui/popup/popup.html") {
    throw new Error("Collector must ship the reviewed persistent side-panel entry");
  }
  if (manifest.action?.default_popup) throw new Error("Collector action must open the side panel, not a transient popup");

  const contentMatches = manifest.content_scripts?.flatMap((script) => script.matches ?? []) ?? [];
  if (!sameStringSet(contentMatches, ["https://accounting.igdrasil.se/*"])) {
    throw new Error(`unexpected Collector content-script matches: ${contentMatches.join(", ")}`);
  }
  if (manifest.content_security_policy?.extension_pages !== "script-src 'self'; object-src 'self'") {
    throw new Error("Collector CSP is not the reviewed strict policy");
  }
}

export function validateStudioManifest(manifest: StudioManifestBoundary): void {
  if (manifest.name !== "Ratatosk Studio — Development Build") throw new Error("unexpected Studio name");

  if (!sameStringSet(manifest.permissions, ["activeTab", "debugger", "scripting", "storage"])) {
    throw new Error(`unexpected Studio permissions: ${(manifest.permissions ?? []).join(", ")}`);
  }
  if (!sameStringSet(manifest.host_permissions, ["https://svala.igdrasil.se/*"])) {
    throw new Error(`unexpected Studio host permissions: ${(manifest.host_permissions ?? []).join(", ")}`);
  }
  if ((manifest.optional_host_permissions ?? []).length > 0) {
    throw new Error(`Studio must not declare optional host permissions: ${(manifest.optional_host_permissions ?? []).join(", ")}`);
  }
  if ((manifest.content_scripts ?? []).length > 0) throw new Error("Studio must not ship content scripts");
  if (manifest.content_security_policy?.extension_pages !== "script-src 'self'; object-src 'self'") {
    throw new Error("Studio CSP is not the reviewed strict policy");
  }
}

function sameStringSet(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
  return JSON.stringify([...(actual ?? [])].sort()) === JSON.stringify([...expected].sort());
}
