import { describe, expect, it, vi } from "vitest";
import { mapConcurrentInSettleOrder } from "../../src/core/concurrency";

/**
 * The point of this primitive is what a caller may stop waiting for. Ordering
 * and abandonment are therefore the contract, not an implementation detail.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function collect<T>(source: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}

describe("mapConcurrentInSettleOrder", () => {
  it("yields by when a task finished, not where it was queued", async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const outcomes = collect(mapConcurrentInSettleOrder([0, 1, 2], { limit: 3 }, (index) => gates[index].promise));

    gates[2].resolve("third");
    gates[0].resolve("first");
    gates[1].resolve("second");

    expect((await outcomes).map((outcome) => outcome.index)).toEqual([2, 0, 1]);
  });

  it("reports the original index with every outcome", async () => {
    const outcomes = await collect(mapConcurrentInSettleOrder(
      ["a", "b", "c"],
      { limit: 3 },
      async (item, index) => `${index}:${item}`,
    ));

    expect(outcomes.map((outcome) => outcome.status === "fulfilled" && outcome.value).sort())
      .toEqual(["0:a", "1:b", "2:c"]);
  });

  it("delivers a failure as an outcome rather than ending the run", async () => {
    const outcomes = await collect(mapConcurrentInSettleOrder([0, 1], { limit: 2 }, async (index) => {
      if (index === 0) throw new Error("probe failed");
      return "ok";
    }));

    expect(outcomes).toHaveLength(2);
    expect(outcomes.find((outcome) => outcome.index === 0)).toMatchObject({ status: "rejected" });
    expect(outcomes.find((outcome) => outcome.index === 1)).toMatchObject({ status: "fulfilled", value: "ok" });
  });

  it("lets a caller stop at the first answer without waiting for the rest", async () => {
    const slow = deferred<string>();
    const fast = deferred<string>();
    let stopped = false;

    const run = (async () => {
      for await (const outcome of mapConcurrentInSettleOrder([slow, fast], { limit: 2 }, (item) => item.promise)) {
        if (outcome.status === "fulfilled") break;
      }
      stopped = true;
    })();

    fast.resolve("answer");
    await run;

    // The slow task has not settled and is not being awaited.
    expect(stopped).toBe(true);
    slow.resolve("too late");
  });

  it("absorbs a rejection from work nobody is waiting for any more", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const abandoned = deferred<string>();
    const answered = deferred<string>();

    const run = (async () => {
      for await (const outcome of mapConcurrentInSettleOrder([abandoned, answered], { limit: 2 }, (item) => item.promise)) {
        if (outcome.status === "fulfilled") break;
      }
    })();
    answered.resolve("answer");
    await run;
    abandoned.reject(new Error("abandoned probe failed"));
    // Two turns: one for the rejection to propagate, one for Node to report it.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", unhandled);

    expect(unhandled).not.toHaveBeenCalled();
  });

  it("never runs more than the limit at once", async () => {
    let active = 0;
    let peak = 0;
    await collect(mapConcurrentInSettleOrder(Array.from({ length: 12 }, (_value, index) => index), { limit: 3 }, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
    }));

    expect(peak).toBeLessThanOrEqual(3);
  });

  it("starts a queued task as soon as a slot frees", async () => {
    const started: number[] = [];
    const outcomes = await collect(mapConcurrentInSettleOrder(
      [0, 1, 2, 3],
      { limit: 2 },
      async (index) => { started.push(index); return index; },
    ));

    expect(started).toEqual([0, 1, 2, 3]);
    expect(outcomes).toHaveLength(4);
  });

  it("yields nothing for no work", async () => {
    expect(await collect(mapConcurrentInSettleOrder([], { limit: 4 }, async () => "unused"))).toEqual([]);
  });
});
