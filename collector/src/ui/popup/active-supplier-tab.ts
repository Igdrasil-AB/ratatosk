export interface ActiveSupplierTab {
  tabId: number;
  origin: string;
  hostname: string;
}

type ActivatedListener = (activeInfo: chrome.tabs.TabActiveInfo) => void;
type UpdatedListener = (
  tabId: number,
  changeInfo: chrome.tabs.TabChangeInfo,
  tab: chrome.tabs.Tab,
) => void;

export interface ActiveTabApi {
  query(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
  onActivated: {
    addListener(listener: ActivatedListener): void;
    removeListener(listener: ActivatedListener): void;
  };
  onUpdated: {
    addListener(listener: UpdatedListener): void;
    removeListener(listener: UpdatedListener): void;
  };
}

export async function queryActiveSupplierTab(
  tabs: ActiveTabApi = chrome.tabs,
): Promise<ActiveSupplierTab | null> {
  try {
    const [tab] = await tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined || !tab.url) return null;
    const url = new URL(tab.url);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return {
      tabId: tab.id,
      origin: url.origin,
      hostname: url.hostname.replace(/^www\./, ""),
    };
  } catch {
    return null;
  }
}

/**
 * Keep a long-lived side panel bound to the browser's current tab. Context is
 * invalidated before the asynchronous lookup so a click can never act on the
 * origin of the tab the user just left. A revision token prevents late lookups
 * from restoring an older tab after rapid switching.
 */
export function watchActiveSupplierTab(
  onInvalidated: () => void,
  onChanged: (page: ActiveSupplierTab | null) => void,
  tabs: ActiveTabApi = chrome.tabs,
): () => void {
  let revision = 0;

  const refresh = (): void => {
    const expectedRevision = ++revision;
    onInvalidated();
    void queryActiveSupplierTab(tabs).then((page) => {
      if (revision === expectedRevision) onChanged(page);
    });
  };
  const onActivated: ActivatedListener = () => refresh();
  const onUpdated: UpdatedListener = (_tabId, changeInfo, tab) => {
    if (!tab.active || (!changeInfo.url && changeInfo.status !== "complete")) return;
    refresh();
  };

  tabs.onActivated.addListener(onActivated);
  tabs.onUpdated.addListener(onUpdated);
  return () => {
    revision += 1;
    tabs.onActivated.removeListener(onActivated);
    tabs.onUpdated.removeListener(onUpdated);
  };
}
