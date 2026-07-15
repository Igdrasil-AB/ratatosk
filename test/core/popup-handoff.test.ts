import { afterEach, describe, expect, it, vi } from "vitest";
import { clearConnectBadge, revealPopupAfterConnect } from "../../collector/src/platform/popup-handoff";

describe("vendor permission popup handoff", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reopens the action popup when Chrome supports it", async () => {
    const openPopup = vi.fn().mockResolvedValue(undefined);
    const setBadgeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      action: {
        openPopup,
        setBadgeText,
        setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
      },
    });

    await expect(revealPopupAfterConnect()).resolves.toBe("opened");
    expect(openPopup).toHaveBeenCalledOnce();
    expect(setBadgeText).not.toHaveBeenCalled();
  });

  it("falls back to a completion badge when the popup cannot be opened", async () => {
    const setBadgeText = vi.fn().mockResolvedValue(undefined);
    const setBadgeBackgroundColor = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      action: {
        openPopup: vi.fn().mockRejectedValue(new Error("popup unavailable")),
        setBadgeText,
        setBadgeBackgroundColor,
      },
    });

    await expect(revealPopupAfterConnect()).resolves.toBe("badged");
    expect(setBadgeBackgroundColor).toHaveBeenCalledWith({ color: "#a34e2d" });
    expect(setBadgeText).toHaveBeenCalledWith({ text: "✓" });
  });

  it("clears the completion badge when the popup is opened manually", async () => {
    const setBadgeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", { action: { setBadgeText } });

    await clearConnectBadge();

    expect(setBadgeText).toHaveBeenCalledWith({ text: "" });
  });
});
