import type { VendorRecipe } from "../../../src/core/types";

/**
 * Surface a "reconnect" nudge when a vendor session has expired. This is the UX
 * payoff of the typed `AuthExpired` error: a silent failure becomes a clear,
 * one-click prompt instead of a mysteriously stale source.
 */
export function notifyReconnect(recipe: VendorRecipe): void {
  chrome.notifications?.create(`reconnect:${recipe.id}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/128.png"),
    title: `${recipe.name} needs you to sign in`,
    message: `Your ${recipe.name} session expired. Reconnect to keep collecting invoices.`,
    priority: 1,
  });
}

/**
 * The same payoff, one level up: a destination whose credential was revoked or
 * expired. The vendor-scoped nudge could not express this, so an expired
 * Igdrasil connection stopped collection silently.
 */
export function notifyDestinationReconnect(companyName: string): void {
  chrome.notifications?.create(`destination-reconnect:${companyName}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/128.png"),
    title: `${companyName} needs reconnecting`,
    message: `Ratatosk's connection to ${companyName} expired. Reconnect it to keep delivering invoices.`,
    priority: 1,
  });
}

/** When the user clicks a reconnect notification, open the vendor's login page. */
export function openLoginFor(recipe: VendorRecipe): void {
  chrome.tabs?.create({ url: recipe.auth.loginUrl });
}
