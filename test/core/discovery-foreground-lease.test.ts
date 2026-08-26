import { describe, expect, it, vi } from "vitest";
import { shouldRetryProbeInForeground } from "../../collector/src/platform/discovery";
import {
  withForegroundTabVisibility,
  type ForegroundTabsApi,
} from "../../collector/src/platform/tab-visibility";

const shellEvidence = {
  stats: {
    documentLinks: 0,
    semanticControls: 0,
    semanticSections: 0,
  },
};

describe("foreground visibility lease", () => {
  it("retries only a billing route or explicit cold entry replay that rendered as an empty shell", () => {
    expect(shouldRetryProbeInForeground(
      "https://vendor.example/dashboard/org/opaque/billing",
      shellEvidence,
    )).toBe(true);
    expect(shouldRetryProbeInForeground(
      "https://vendor.example/dashboard/org/opaque/projects",
      shellEvidence,
    )).toBe(false);
    expect(shouldRetryProbeInForeground(
      "https://vendor.example/dashboard/org/opaque/projects",
      shellEvidence,
      true,
    )).toBe(true);
    expect(shouldRetryProbeInForeground(
      "https://vendor.example/dashboard/org/opaque/billing",
      { stats: { ...shellEvidence.stats, semanticControls: 2 } },
    )).toBe(false);
  });

  it("activates the probe tab and restores the previous tab after the bounded probe", async () => {
    let activeTabId = 11;
    const update = vi.fn(async (tabId: number, properties: chrome.tabs.UpdateProperties) => {
      if (properties.active) activeTabId = tabId;
      return { id: tabId, windowId: 7 } as chrome.tabs.Tab;
    });
    const tabs: ForegroundTabsApi = {
      get: vi.fn(async () => ({ id: 42, windowId: 7 }) as chrome.tabs.Tab),
      query: vi.fn(async () => [{ id: activeTabId, windowId: 7 } as chrome.tabs.Tab]),
      update,
    };

    await expect(withForegroundTabVisibility(42, async () => {
      expect(activeTabId).toBe(42);
      return "captured";
    }, tabs)).resolves.toBe("captured");

    expect(activeTabId).toBe(11);
    expect(update).toHaveBeenNthCalledWith(1, 42, { active: true });
    expect(update).toHaveBeenNthCalledWith(2, 11, { active: true });
  });

  it("does not steal focus back when the user changes tabs during the probe", async () => {
    let activeTabId = 11;
    const update = vi.fn(async (tabId: number, properties: chrome.tabs.UpdateProperties) => {
      if (properties.active) activeTabId = tabId;
      return { id: tabId, windowId: 7 } as chrome.tabs.Tab;
    });
    const tabs: ForegroundTabsApi = {
      get: vi.fn(async () => ({ id: 42, windowId: 7 }) as chrome.tabs.Tab),
      query: vi.fn(async () => [{ id: activeTabId, windowId: 7 } as chrome.tabs.Tab]),
      update,
    };

    await withForegroundTabVisibility(42, async () => {
      activeTabId = 99;
    }, tabs);

    expect(activeTabId).toBe(99);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("restores the previous tab even when the foreground probe fails", async () => {
    let activeTabId = 11;
    const tabs: ForegroundTabsApi = {
      get: vi.fn(async () => ({ id: 42, windowId: 7 }) as chrome.tabs.Tab),
      query: vi.fn(async () => [{ id: activeTabId, windowId: 7 } as chrome.tabs.Tab]),
      update: vi.fn(async (tabId, properties) => {
        if (properties.active) activeTabId = tabId;
        return { id: tabId, windowId: 7 } as chrome.tabs.Tab;
      }),
    };

    await expect(withForegroundTabVisibility(42, async () => {
      throw new Error("probe failed");
    }, tabs)).rejects.toThrow("probe failed");

    expect(activeTabId).toBe(11);
  });

  it("does not activate the probe when the current tab cannot be preserved", async () => {
    const update = vi.fn();
    const tabs: ForegroundTabsApi = {
      get: vi.fn(async () => ({ id: 42, windowId: 7 }) as chrome.tabs.Tab),
      query: vi.fn(async () => []),
      update,
    };

    await expect(withForegroundTabVisibility(42, vi.fn(), tabs))
      .rejects.toThrow("active tab could not be preserved");
    expect(update).not.toHaveBeenCalled();
  });

  it("does not replace the primary result when restoration state is unavailable", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([{ id: 11, windowId: 7 } as chrome.tabs.Tab])
      .mockRejectedValueOnce(new Error("window closed"));
    const tabs: ForegroundTabsApi = {
      get: vi.fn(async () => ({ id: 42, windowId: 7 }) as chrome.tabs.Tab),
      query,
      update: vi.fn(async (tabId) => ({ id: tabId, windowId: 7 }) as chrome.tabs.Tab),
    };

    await expect(withForegroundTabVisibility(42, async () => "captured", tabs))
      .resolves.toBe("captured");
  });
});
