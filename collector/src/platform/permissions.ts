import type { VendorRecipe } from "../../../src/core/types";

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

export function hasVendorPermissions(recipe: VendorRecipe): Promise<boolean> {
  return new Promise((resolve) =>
    chrome.permissions.contains({ origins: recipe.hosts }, (has) => resolve(Boolean(has))),
  );
}

export function revokeVendorPermissions(recipe: VendorRecipe): Promise<boolean> {
  return new Promise((resolve) =>
    chrome.permissions.remove({ origins: recipe.hosts }, (removed) => resolve(Boolean(removed))),
  );
}
