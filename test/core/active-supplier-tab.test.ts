import { describe, expect, it, vi } from "vitest";
import {
  queryActiveSupplierTab,
  watchActiveSupplierTab,
  type ActiveTabApi,
} from "../../collector/src/ui/popup/active-supplier-tab";

function tabsApi(query: ActiveTabApi["query"]): {
  api: ActiveTabApi;
  activate: (tabId: number) => void;
  update: (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void;
} {
  let activated: ((info: chrome.tabs.TabActiveInfo) => void) | undefined;
  let updated: ((tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void) | undefined;
  return {
    api: {
      query,
      onActivated: {
        addListener: (listener) => { activated = listener; },
        removeListener: vi.fn(),
      },
      onUpdated: {
        addListener: (listener) => { updated = listener; },
        removeListener: vi.fn(),
      },
    },
    activate: (tabId) => activated?.({ tabId, windowId: 1 }),
    update: (tabId, changeInfo, tab) => updated?.(tabId, changeInfo, tab),
  };
}

describe("persistent side-panel active supplier context", () => {
  it("reads only a credential-free HTTPS origin from the active tab", async () => {
    const { api } = tabsApi(vi.fn(async () => [{
      id: 7,
      url: "https://github.com/settings/billing",
    } as chrome.tabs.Tab]));

    await expect(queryActiveSupplierTab(api)).resolves.toEqual({
      tabId: 7,
      origin: "https://github.com",
      hostname: "github.com",
    });
  });

  it("invalidates GitHub synchronously before resolving the newly active tab", async () => {
    const query = vi.fn(async () => [{
      id: 8,
      url: "https://app.clickup.com/123/settings/billing",
    } as chrome.tabs.Tab]);
    const { api, activate } = tabsApi(query);
    const invalidated = vi.fn();
    const changed = vi.fn();
    watchActiveSupplierTab(invalidated, changed, api);

    activate(8);
    expect(invalidated).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith({
      tabId: 8,
      origin: "https://app.clickup.com",
      hostname: "app.clickup.com",
    }));
  });

  it("ignores an older lookup that finishes after a newer tab switch", async () => {
    let resolveFirst: ((tabs: chrome.tabs.Tab[]) => void) | undefined;
    const first = new Promise<chrome.tabs.Tab[]>((resolve) => { resolveFirst = resolve; });
    const query = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce([{ id: 9, url: "https://example.com/billing" } as chrome.tabs.Tab]);
    const { api, activate } = tabsApi(query);
    const changed = vi.fn();
    watchActiveSupplierTab(vi.fn(), changed, api);

    activate(8);
    activate(9);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith({
      tabId: 9,
      origin: "https://example.com",
      hostname: "example.com",
    }));
    resolveFirst?.([{ id: 8, url: "https://github.com/settings/billing" } as chrome.tabs.Tab]);
    await Promise.resolve();

    expect(changed).toHaveBeenCalledTimes(1);
  });
});
