import type { VendorRecipe } from "../../../src/core/types";
import type { Connection } from "./storage";

/**
 * Incremental host permissions.
 *
 * The manifest declares vendor hosts as *optional* permissions; we request them
 * at connect-time, only for the vendor the user is actually linking. This keeps
 * the install-time permission prompt minimal and the Web Store review surface
 * small — you never ask for a host until the user opts into that vendor.
 */
/**
 * Start an optional-origin request immediately. Call this synchronously inside
 * the popup's click handler: Chrome rejects requests that have crossed an await,
 * timer, or message boundary because the original user gesture is then gone.
 */
export function requestHostPermissions(origins: readonly string[]): Promise<boolean> {
  return chrome.permissions.request({ origins: [...origins] });
}

/** Optional metadata-only permission that lets the persistent side panel read
 * the active tab URL after the user switches tabs. It does not grant access to
 * page contents; supplier inspection still requires an exact host permission. */
export function requestTabAwarenessPermission(): Promise<boolean> {
  return chrome.permissions.request({ permissions: ["tabs"] });
}

export function hasTabAwarenessPermission(): Promise<boolean> {
  return new Promise((resolve) =>
    chrome.permissions.contains({ permissions: ["tabs"] }, (has) => resolve(Boolean(has))),
  );
}

export function revokeTabAwarenessPermission(): Promise<boolean> {
  return new Promise((resolve) =>
    chrome.permissions.remove({ permissions: ["tabs"] }, (removed) => resolve(Boolean(removed))),
  );
}

export function hasVendorPermissions(recipe: VendorRecipe, connection?: Connection | null): Promise<boolean> {
  return hasHostPermissions(vendorPermissionOrigins(recipe, connection));
}

export function vendorPermissionOrigins(recipe: VendorRecipe, connection?: Connection | null): string[] {
  return [...new Set([...recipe.hosts, ...(connection?.documentOrigins ?? [])])];
}

export function hasHostPermissions(origins: readonly string[]): Promise<boolean> {
  return new Promise((resolve) =>
    chrome.permissions.contains({ origins: [...origins] }, (has) => resolve(Boolean(has))),
  );
}

/** Exact current recipe origins that an existing connection has not granted. */
export async function missingHostPermissions(origins: readonly string[]): Promise<string[]> {
  const checks = await Promise.all(origins.map(async (origin) => ({
    origin,
    granted: await hasHostPermissions([origin]),
  })));
  return checks.filter((check) => !check.granted).map((check) => check.origin);
}

export function revokeVendorPermissions(recipe: VendorRecipe, connection?: Connection | null): Promise<boolean> {
  return revokeHostPermissions(vendorPermissionOrigins(recipe, connection));
}

export function revokeHostPermissions(origins: readonly string[]): Promise<boolean> {
  if (!origins.length) return Promise.resolve(false);
  return new Promise((resolve) =>
    chrome.permissions.remove({ origins: [...origins] }, (removed) => resolve(Boolean(removed))),
  );
}
