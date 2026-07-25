import type { VendorRecipe } from "../../../src/core/types";
import { getVendor, VENDORS, VENDOR_LIFECYCLE_BY_ID } from "../../../src/vendors";
import type { VendorLifecycleEntry } from "../../../src/vendors/lifecycle";
import { knownSupplierIcon } from "../../../src/vendors/brand-catalog";
import { getDiscoveredSupplier, getDiscoveredSuppliers } from "./discovered-suppliers";

export type CollectorSource = {
  kind: "official" | "discovered";
  recipe: VendorRecipe;
  lifecycle?: VendorLifecycleEntry;
  primaryOrigin: string;
  presentationIcon?: string;
};

export async function listCollectorSources(): Promise<CollectorSource[]> {
  const official: CollectorSource[] = VENDORS.map((recipe) => ({
    kind: "official",
    recipe,
    lifecycle: VENDOR_LIFECYCLE_BY_ID[recipe.id],
    primaryOrigin: originOf(recipe.homepage),
    presentationIcon: recipe.icon,
  }));
  const discovered = Object.values(await getDiscoveredSuppliers())
    .sort((left, right) => left.displayName.localeCompare(right.displayName))
    .map<CollectorSource>((profile) => ({
      kind: "discovered",
      recipe: profile.recipe,
      primaryOrigin: profile.primaryOrigin,
      presentationIcon: knownSupplierIcon(profile.primaryOrigin),
    }));
  return [...official, ...discovered];
}

export async function resolveCollectorSource(id: string): Promise<CollectorSource | undefined> {
  const official = getVendor(id);
  if (official) {
    return {
      kind: "official",
      recipe: official,
      lifecycle: VENDOR_LIFECYCLE_BY_ID[id],
      primaryOrigin: originOf(official.homepage),
      presentationIcon: official.icon,
    };
  }
  const discovered = await getDiscoveredSupplier(id);
  return discovered
    ? {
        kind: "discovered",
        recipe: discovered.recipe,
        primaryOrigin: discovered.primaryOrigin,
        presentationIcon: knownSupplierIcon(discovered.primaryOrigin),
      }
    : undefined;
}

function originOf(value: string): string {
  try { return new URL(value).origin; } catch { return ""; }
}
