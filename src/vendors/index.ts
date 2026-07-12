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

export const VENDORS: readonly VendorRecipe[] = [anthropic, chatgpt, github, railway, slack, vercel];

/** Look up a recipe by its id. */
export function getVendor(id: string): VendorRecipe | undefined {
  return VENDORS.find((v) => v.id === id);
}

/** All host match patterns across every vendor — used to build manifest permissions. */
export function allHosts(): string[] {
  return [...new Set(VENDORS.flatMap((v) => v.hosts))].sort();
}
