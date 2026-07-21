import { describe, expect, it } from "vitest";
import { RecorderCommandQueue } from "../../studio/src/platform/recorder-command-queue";

describe("recorder command queue", () => {
  it("persists an entry before a later stop command can run", async () => {
    const queue = new RecorderCommandQueue();
    const order: string[] = [];
    let releaseEntry: (() => void) | undefined;
    const entryGate = new Promise<void>((resolve) => { releaseEntry = resolve; });

    const entry = queue.run(async () => {
      order.push("entry-start");
      await entryGate;
      order.push("entry-persisted");
      return true;
    });
    const stop = queue.run(async () => {
      order.push("stop");
      return "report";
    });
    await Promise.resolve();
    expect(order).toEqual(["entry-start"]);

    releaseEntry?.();
    await expect(Promise.all([entry, stop])).resolves.toEqual([true, "report"]);
    expect(order).toEqual(["entry-start", "entry-persisted", "stop"]);
  });

  it("continues processing after a rejected command", async () => {
    const queue = new RecorderCommandQueue();
    await expect(queue.run(async () => { throw new Error("write failed"); })).rejects.toThrow("write failed");
    await expect(queue.run(async () => "next")).resolves.toBe("next");
  });
});
