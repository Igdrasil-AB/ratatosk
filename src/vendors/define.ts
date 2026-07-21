import type { VendorRecipe } from "../core/types";
import { validateRecipe } from "../core/schema";
import { deepFreeze } from "../core/immutable";

/**
 * Declare a vendor recipe.
 *
 * This is the ONLY function a contributor calls. It validates the recipe against
 * the schema at module-load time — so a typo fails the build/test, not a user's
 * scheduled sync — and returns the typed, frozen recipe. Recipes are pure data,
 * but Collector executes only recipes bundled in its reviewed package.
 *
 *   // src/vendors/acme.ts
 *   export default defineVendor({ id: "acme", ... });
 */
export function defineVendor(recipe: VendorRecipe): VendorRecipe {
  return deepFreeze(validateRecipe(recipe));
}
