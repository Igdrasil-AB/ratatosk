export interface ForegroundTabsApi {
  get(tabId: number): Promise<chrome.tabs.Tab>;
  query(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
  update(tabId: number, updateProperties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab>;
}

export type ReleaseForegroundTab = () => Promise<void>;

/**
 * Temporarily select a tab while preserving user control. If the user changes
 * tabs during the lease, release never overrides that choice.
 */
export async function acquireForegroundTabVisibility(
  tabId: number,
  tabs: ForegroundTabsApi = chrome.tabs,
): Promise<ReleaseForegroundTab> {
  const probeTab = await tabs.get(tabId);
  if (probeTab.windowId === undefined) return async () => undefined;
  const [previous] = await tabs.query({ active: true, windowId: probeTab.windowId });
  if (previous?.id === tabId) return async () => undefined;
  if (previous?.id === undefined) throw new Error("active tab could not be preserved");

  await tabs.update(tabId, { active: true });
  return async () => {
    let current: chrome.tabs.Tab | undefined;
    try {
      [current] = await tabs.query({ active: true, windowId: probeTab.windowId });
    } catch {
      return;
    }
    if (current?.id === tabId) {
      await tabs.update(previous.id!, { active: true }).catch(() => undefined);
    }
  };
}

export async function withForegroundTabVisibility<T>(
  tabId: number,
  operation: () => Promise<T>,
  tabs: ForegroundTabsApi = chrome.tabs,
): Promise<T> {
  const release = await acquireForegroundTabVisibility(tabId, tabs);
  try {
    return await operation();
  } finally {
    await release();
  }
}
