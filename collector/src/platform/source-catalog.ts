import type { VendorRecipe } from "../../../src/core/types";
import { getVendor, VENDORS, VENDOR_LIFECYCLE_BY_ID } from "../../../src/vendors";
import type { VendorLifecycleEntry } from "../../../src/vendors/lifecycle";
import { getDiscoveredSupplier, getDiscoveredSuppliers } from "./discovered-suppliers";

export type CollectorSource = {
  kind: "official" | "discovered";
  recipe: VendorRecipe;
  lifecycle?: VendorLifecycleEntry;
  primaryOrigin: string;
};

export async function listCollectorSources(): Promise<CollectorSource[]> {
  const official: CollectorSource[] = VENDORS.map((recipe) => ({
    kind: "official",
    recipe,
    lifecycle: VENDOR_LIFECYCLE_BY_ID[recipe.id],
    primaryOrigin: originOf(recipe.homepage),
  }));
  const discovered = Object.values(await getDiscoveredSuppliers())
    .sort((left, right) => left.displayName.localeCompare(right.displayName))
    .map<CollectorSource>((profile) => ({
      kind: "discovered",
      recipe: profile.recipe,
      primaryOrigin: profile.primaryOrigin,
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
    };
  }
  const discovered = await getDiscoveredSupplier(id);
  return discovered
    ? { kind: "discovered", recipe: discovered.recipe, primaryOrigin: discovered.primaryOrigin }
    : undefined;
}

export async function officialSourceForOrigin(origin: string): Promise<CollectorSource | undefined> {
  return (await listCollectorSources()).find((source) => source.kind === "official" && source.primaryOrigin === origin);
}

function originOf(value: string): string {
  try { return new URL(value).origin; } catch { return ""; }
}
