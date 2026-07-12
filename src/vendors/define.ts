import type { VendorRecipe } from "../core/types";
import { validateRecipe } from "../core/schema";

/**
 * Declare a vendor recipe.
 *
 * This is the ONLY function a contributor calls. It validates the recipe against
 * the schema at module-load time — so a typo fails the build/test, not a user's
 * 3am sync — and returns the typed, frozen recipe. Recipes are pure data, so the
 * object returned here is exactly what can be serialized and hot-served from a
 * backend (see `scripts/export-recipes.ts`).
 *
 *   // src/vendors/acme.ts
 *   export default defineVendor({ id: "acme", ... });
 */
export function defineVendor(recipe: VendorRecipe): VendorRecipe {
  return Object.freeze(validateRecipe(recipe));
}
