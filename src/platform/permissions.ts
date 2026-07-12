import type { VendorRecipe } from "../core/types";

/**
 * Incremental host permissions.
 *
 * The manifest declares vendor hosts as *optional* permissions; we request them
 * at connect-time, only for the vendor the user is actually linking. This keeps
 * the install-time permission prompt minimal and the Web Store review surface
 * small — you never ask for a host until the user opts into that vendor.
 */
export function requestVendorPermissions(recipe: VendorRecipe): Promise<boolean> {
  return new Promise((resolve) =>
    chrome.permissions.request({ origins: recipe.hosts }, (granted) => resolve(Boolean(granted))),
  );
}

export function hasVendorPermissions(recipe: VendorRecipe): Promise<boolean> {
  return new Promise((resolve) =>
    chrome.permissions.contains({ origins: recipe.hosts }, (has) => resolve(Boolean(has))),
  );
}

/** Request the recipe's host permissions only if some are missing (e.g. after a recipe adds a host). */
export async function ensureVendorPermissions(recipe: VendorRecipe): Promise<boolean> {
  if (await hasVendorPermissions(recipe)) return true;
  return requestVendorPermissions(recipe);
}

export function revokeVendorPermissions(recipe: VendorRecipe): Promise<boolean> {
  return new Promise((resolve) =>
    chrome.permissions.remove({ origins: recipe.hosts }, (removed) => resolve(Boolean(removed))),
  );
}
