import { describe, expect, it, vi } from "vitest";
import { exclusiveAction } from "../../studio/src/ui/exclusive-action";

describe("exclusive popup actions", () => {
  it("suppresses a second stop while the first response is pending", async () => {
    let release: (() => void) | undefined;
    const work = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const stop = exclusiveAction(work);

    const first = stop();
    const second = stop();
    expect(work).toHaveBeenCalledTimes(1);
    await expect(second).resolves.toBeUndefined();
    release?.();
    await first;
  });

  it("allows a later retry after the active action fails", async () => {
    const work = vi.fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(undefined);
    const action = exclusiveAction(work);

    await expect(action()).rejects.toThrow("temporary failure");
    await expect(action()).resolves.toBeUndefined();
    expect(work).toHaveBeenCalledTimes(2);
  });
});
