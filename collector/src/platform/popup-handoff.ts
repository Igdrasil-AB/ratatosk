type ActionWithOptionalPopup = typeof chrome.action & {
  openPopup?: (options?: chrome.action.OpenPopupOptions) => Promise<void>;
};

export type PopupRevealResult = "opened" | "badged" | "unavailable";

/**
 * Return the user to Ratatosk after Chrome's native host-permission sheet has
 * dismissed the transient action popup. Chrome 127+ can reopen it directly;
 * older supported versions get a compact completion badge instead.
 */
export async function revealPopupAfterConnect(): Promise<PopupRevealResult> {
  const action = chrome.action as ActionWithOptionalPopup;
  if (typeof action.openPopup === "function") {
    try {
      await action.openPopup();
      return "opened";
    } catch {
      // Chrome can refuse when no suitable browser window is active. Fall back
      // to a badge so the completed handoff is still visible and recoverable.
    }
  }

  try {
    await Promise.all([
      action.setBadgeBackgroundColor({ color: "#a34e2d" }),
      action.setBadgeText({ text: "✓" }),
    ]);
    return "badged";
  } catch {
    return "unavailable";
  }
}

/** Clear the older-Chrome fallback as soon as the user returns to Ratatosk. */
export async function clearConnectBadge(): Promise<void> {
  try {
    await chrome.action.setBadgeText({ text: "" });
  } catch {
    // A missing action surface should never stop the popup from loading.
  }
}
