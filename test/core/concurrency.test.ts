import { describe, expect, it } from "vitest";
import { CollectionRunCoordinator, DEFAULT_SAFE_CONCURRENCY, mapConcurrentOrdered } from "../../src/core/concurrency";

describe("bounded concurrency", () => {
  it("keeps speculative work bounded and commits exclusive", () => {
    expect(DEFAULT_SAFE_CONCURRENCY).toEqual({
      routeProbes: 4,
      frameProbes: 2,
      candidatePreviews: 2,
      documentFetches: 3,
      sinkCommits: 1,
    });
  });

  it("caps active work and returns outcomes in input order", async () => {
    let active = 0;
    let maximum = 0;
    const outcomes = await mapConcurrentOrdered([30, 5, 20, 1], { limit: 2 }, async (delay, index) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active--;
      return `item-${index}`;
    });

    expect(maximum).toBe(2);
    expect(outcomes).toEqual([
      { status: "fulfilled", index: 0, value: "item-0" },
      { status: "fulfilled", index: 1, value: "item-1" },
      { status: "fulfilled", index: 2, value: "item-2" },
      { status: "fulfilled", index: 3, value: "item-3" },
    ]);
  });

  it("stops scheduling after a fatal error and types untouched work as cancelled", async () => {
    const started: number[] = [];
    const outcomes = await mapConcurrentOrdered([0, 1, 2, 3], {
      limit: 1,
      stopOnError: (error) => error instanceof Error && error.message === "fatal",
    }, async (_item, index) => {
      started.push(index);
      if (index === 1) throw new Error("fatal");
      return index;
    });

    expect(started).toEqual([0, 1]);
    expect(outcomes[0]).toEqual({ status: "fulfilled", index: 0, value: 0 });
    expect(outcomes[1]).toMatchObject({ status: "rejected", index: 1 });
    expect(outcomes.slice(2)).toEqual([
      { status: "cancelled", index: 2, reason: "fatal_error" },
      { status: "cancelled", index: 3, reason: "fatal_error" },
    ]);
  });

  it("types a cooperatively aborted sibling as cancelled instead of rejected", async () => {
    const outcomes = await mapConcurrentOrdered([0, 1, 2], {
      limit: 2,
      stopOnError: (error) => error instanceof Error && error.message === "fatal",
    }, async (_item, index, signal) => {
      if (index === 0) throw new Error("fatal");
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return index;
    });

    expect(outcomes[0]).toMatchObject({ status: "rejected", index: 0 });
    expect(outcomes[1]).toEqual({ status: "cancelled", index: 1, reason: "fatal_error" });
    expect(outcomes[2]).toEqual({ status: "cancelled", index: 2, reason: "fatal_error" });
  });

  it("keeps the first fatal cancellation cause when the parent aborts afterward", async () => {
    const parent = new AbortController();
    const outcomes = await mapConcurrentOrdered([0, 1, 2], {
      limit: 2,
      signal: parent.signal,
      stopOnError: (error) => error instanceof Error && error.message === "fatal",
    }, async (_item, index, signal) => {
      if (index === 0) throw new Error("fatal");
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          parent.abort("later external abort");
          reject(signal.reason);
        }, { once: true });
      });
      return index;
    });

    expect(outcomes[0]).toMatchObject({ status: "rejected", index: 0 });
    expect(outcomes.slice(1)).toEqual([
      { status: "cancelled", index: 1, reason: "fatal_error" },
      { status: "cancelled", index: 2, reason: "fatal_error" },
    ]);
  });
});

describe("collection run coordination", () => {
  it("queues one scheduled batch while an interactive collection is active", async () => {
    const coordinator = new CollectionRunCoordinator();
    let releaseInteractive!: () => void;
    const interactiveGate = new Promise<void>((resolve) => { releaseInteractive = resolve; });
    const interactive = coordinator.runInteractive(async () => {
      await interactiveGate;
      return "interactive";
    });
    const scheduled = coordinator.runScheduled(async () => "scheduled");

    releaseInteractive();
    await expect(Promise.all([interactive, scheduled])).resolves.toEqual(["interactive", "scheduled"]);
  });

  it("coalesces additional scheduled triggers while one is queued", async () => {
    const coordinator = new CollectionRunCoordinator();
    let releaseInteractive!: () => void;
    const interactiveGate = new Promise<void>((resolve) => { releaseInteractive = resolve; });
    const interactive = coordinator.runInteractive(async () => interactiveGate);
    const first = coordinator.runScheduled(async () => "scheduled");
    const second = coordinator.runScheduled(async () => "duplicate");

    await expect(second).resolves.toBeUndefined();
    releaseInteractive();
    await interactive;
    await expect(first).resolves.toBe("scheduled");
  });

  it("queues one follow-up trigger after a scheduled task has started", async () => {
    const coordinator = new CollectionRunCoordinator();
    const order: string[] = [];
    let started!: () => void;
    const startedGate = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const runGate = new Promise<void>((resolve) => { release = resolve; });
    const first = coordinator.runScheduled(async () => {
      order.push("first-start");
      started();
      await runGate;
      order.push("first-end");
      return "first";
    });
    await startedGate;

    const followup = coordinator.runScheduled(async () => {
      order.push("followup");
      return "followup";
    });
    const coalesced = coordinator.runScheduled(async () => "duplicate");
    await expect(coalesced).resolves.toBeUndefined();

    release();
    await expect(Promise.all([first, followup])).resolves.toEqual(["first", "followup"]);
    expect(order).toEqual(["first-start", "first-end", "followup"]);
  });

  it("queues an interactive collection behind an already-running scheduled batch", async () => {
    const coordinator = new CollectionRunCoordinator();
    const order: string[] = [];
    let releaseScheduled!: () => void;
    const scheduledGate = new Promise<void>((resolve) => { releaseScheduled = resolve; });
    const scheduled = coordinator.runScheduled(async () => {
      order.push("scheduled-start");
      await scheduledGate;
      order.push("scheduled-end");
      return "scheduled";
    });
    const interactive = coordinator.runInteractive(async () => {
      order.push("interactive");
      return "interactive";
    });

    await Promise.resolve();
    expect(order).toEqual(["scheduled-start"]);
    releaseScheduled();
    await expect(Promise.all([scheduled, interactive])).resolves.toEqual(["scheduled", "interactive"]);
    expect(order).toEqual(["scheduled-start", "scheduled-end", "interactive"]);
  });

  it("keeps a scheduled follow-up behind an interactive run already in the queue", async () => {
    const coordinator = new CollectionRunCoordinator();
    const order: string[] = [];
    let started!: () => void;
    const startedGate = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const scheduledGate = new Promise<void>((resolve) => { release = resolve; });
    const first = coordinator.runScheduled(async () => {
      order.push("scheduled-one");
      started();
      await scheduledGate;
    });
    await startedGate;
    const interactive = coordinator.runInteractive(async () => { order.push("interactive"); });
    const followup = coordinator.runScheduled(async () => { order.push("scheduled-two"); });

    release();
    await Promise.all([first, interactive, followup]);
    expect(order).toEqual(["scheduled-one", "interactive", "scheduled-two"]);
  });
});
