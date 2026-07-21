/** Keep the toolbar action attached to Ratatosk's persistent global side panel. */
export async function configureSidePanelAction(): Promise<boolean> {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    return true;
  } catch (error) {
    console.error("[collector] side panel action setup failed", error);
    return false;
  }
}
