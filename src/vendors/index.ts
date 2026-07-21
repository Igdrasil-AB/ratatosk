/**
 * The vendor registry.
 *
 * To add a vendor: create `./<id>.ts` exporting `defineVendor({...})`, then add
 * one import + one array entry here. That is the entire wiring — everything else
 * (permissions, scheduling, UI listing) derives from this array.
 *
 * Keep the list alphabetical.
 */
import type { VendorRecipe } from "../core/types";

import anthropic from "./anthropic";
import chatgpt from "./chatgpt";
import github from "./github";
import railway from "./railway";
import slack from "./slack";
import vercel from "./vercel";
import { isLifecycleRunnable, VENDOR_LIFECYCLE_BY_ID } from "./lifecycle";

/**
 * Recipes exposed by the public Collector.
 *
 * Only recipes authored from real captures and suitable for pilot verification
 * belong here. Illustrative recipes stay available to contributors, but cannot
 * appear as working integrations in the consumer extension.
 */
export const VENDORS: readonly VendorRecipe[] = Object.freeze([anthropic, chatgpt, railway]);

/** Recipes retained as authoring examples; never shipped by Collector. */
export const EXPERIMENTAL_VENDORS: readonly VendorRecipe[] = Object.freeze([github, slack, vercel]);

/** CI validates both production and experimental recipes. */
export const ALL_VENDORS: readonly VendorRecipe[] = Object.freeze([...VENDORS, ...EXPERIMENTAL_VENDORS]);

/** Look up an execution-ready recipe by its id. The optional lifecycle map is
 * retained for callers that load a reviewed manifest independently. */
export function getVendor(
  id: string,
  lifecycleById: Readonly<Record<string, import("./lifecycle").VendorLifecycleEntry>> = VENDOR_LIFECYCLE_BY_ID,
): VendorRecipe | undefined {
  const recipe = VENDORS.find((v) => v.id === id);
  const lifecycle = lifecycleById[id];
  return recipe && lifecycle && isLifecycleRunnable(lifecycle) ? recipe : undefined;
}

export { VENDOR_LIFECYCLE_BY_ID } from "./lifecycle";

/** All host match patterns across every vendor — used to build manifest permissions. */
export function allHosts(): string[] {
  return [...new Set(VENDORS.flatMap((v) => v.hosts))].sort();
}
