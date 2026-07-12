import type { VendorRecipe } from "../core/types";

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

/** When the user clicks a reconnect notification, open the vendor's login page. */
export function openLoginFor(recipe: VendorRecipe): void {
  chrome.tabs?.create({ url: recipe.auth.loginUrl });
}
