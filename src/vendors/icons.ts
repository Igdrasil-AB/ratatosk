/**
 * Brand-logo lookup. Thin runtime wrapper over the generated icon data so the
 * popup (and any future surface) resolves a vendor's logo from its `icon` slug
 * without importing the whole vendor registry.
 */
import { ICONS, type BrandIcon } from "./icons.generated";

export type { BrandIcon };

/** The brand icon for a slug, or undefined → the caller shows a letter avatar. */
export function brandIcon(slug: string | undefined): BrandIcon | undefined {
  return slug ? ICONS[slug] : undefined;
}

/** Every bundled slug — for a "browse vendors" gallery, tests, and tooling. */
export function iconSlugs(): string[] {
  return Object.keys(ICONS);
}
