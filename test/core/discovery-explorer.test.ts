import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  capExplorationProbeOptions,
  createExplorationCheckpoint,
  EXPLORATION_DEADLINE_MS,
  EXPLORATION_BUDGETS,
  MAX_EXPLORATION_DEPTH,
  MAX_EXPLORATION_PAGES,
  explorationProbeOptions,
  explorationProbeTiming,
  planExplorationTargets,
  runWithinExplorationBudget,
  explorationTargetKey,
  parseExplorationCheckpoint,
  safeExplorationUrl,
} from "../../collector/src/platform/discovery-explorer";

const explorerSource = readFileSync("collector/src/platform/discovery-explorer.ts", "utf8");

describe("bounded same-origin discovery exploration", () => {
  it("uses the reviewed best-first search budget", () => {
    expect(MAX_EXPLORATION_PAGES).toBe(15);
    expect(MAX_EXPLORATION_DEPTH).toBe(3);
    expect(EXPLORATION_DEADLINE_MS).toBe(10_000);
  });

  it("keeps a substantially broader, still bounded deep coverage envelope", () => {
    expect(EXPLORATION_BUDGETS.deep).toEqual({ pages: 40, depth: 4, durationMs: 45_000, slices: 1 });
    expect(EXPLORATION_BUDGETS.self_heal).toEqual({ pages: 60, depth: 5, durationMs: 120_000, slices: 5 });
  });

  it("ranks only application-exposed routes by billing words in their path or accessible name", () => {
    const origin = "https://vendor.example";
    const targets = planExplorationTargets({
      origin,
      links: [
        { url: `${origin}/surface/r7`, label: "Billing and invoices" },
        { url: `${origin}/settings/team`, label: "Workspace settings" },
        `${origin}/account/invoices?token=must-not-survive#latest`,
        "https://other.example/invoices",
      ],
      visited: new Set([`${origin}/`]),
      nextDepth: 1,
    });

    expect(targets[0]).toMatchObject({ url: `${origin}/account/invoices`, source: "linked", depth: 1 });
    expect(targets[1]).toMatchObject({ url: `${origin}/surface/r7`, source: "linked", depth: 1 });
    expect(targets[2]).toMatchObject({ url: `${origin}/settings/team`, source: "linked", depth: 1 });
    expect(targets.every((target) => new URL(target.url).origin === origin)).toBe(true);
    expect(JSON.stringify(targets)).not.toContain("token");
    expect(targets.length).toBeLessThanOrEqual(MAX_EXPLORATION_PAGES - 1);
  });

  it("does not invent a route when the application exposes none", () => {
    expect(planExplorationTargets({
      origin: "https://github.com",
      links: [],
      visited: new Set(["https://github.com/"]),
      nextDepth: 1,
    })).toEqual([]);
    expect(explorerSource).not.toContain("COMMON_BILLING_PATHS");
    expect(explorerSource).not.toContain("CONTEXTUAL_BILLING_SUFFIXES");
    expect(explorerSource).not.toContain('"/settings/billing"');
  });

  it("checkpoints only a structural route key and rejects raw routes or malformed progress", () => {
    const target = {
      url: "https://app.vendor.example/9012345678/settings/billing?token=secret",
      source: "linked" as const,
      family: "observed_navigation" as const,
      depth: 1,
      score: 100,
    };
    const key = explorationTargetKey(target);
    expect(key).toBe("observed_navigation|/:id/settings/billing");
    const checkpoint = createExplorationCheckpoint({
      mode: "deep",
      pagesAttempted: 3,
      linkedPagesAttempted: 1,
      commonRoutePagesAttempted: 0,
      elapsedMs: 1_200,
      frontier: [{ key, family: "observed_navigation", score: 100, depth: 1 }],
      completedTargetKeys: [key],
      attemptedFamilies: ["exact_entry", "observed_navigation"],
      slicesCompleted: 0,
    });
    expect(JSON.stringify(checkpoint)).not.toMatch(/9012345678|token|https?:/i);
    expect(parseExplorationCheckpoint(checkpoint)).toEqual(checkpoint);
    expect(parseExplorationCheckpoint({ ...checkpoint, completedTargetKeys: ["observed_navigation|https://app.vendor.example/private"] })).toBeUndefined();
  });

  it("does not collapse distinct replayable routes that share one diagnostic shape", () => {
    const first = explorationTargetKey({
      url: "https://app.vendor.example/surface/r7",
      source: "linked",
      family: "observed_navigation",
    });
    const second = explorationTargetKey({
      url: "https://app.vendor.example/surface/x2",
      source: "linked",
      family: "observed_navigation",
    });

    expect(first).not.toBe(second);
    expect(first).toBe("observed_navigation|/surface/r7");
    expect(second).toBe("observed_navigation|/surface/x2");
  });

  it("gives an observed SPA route an adaptive evidence budget without naming its path", () => {
    const target = {
      url: "https://app.vendor.example/surface/r7",
      source: "linked" as const,
      hintSource: "semantic_navigation" as const,
      depth: 1,
      score: 105,
    };
    expect(explorationProbeOptions(target)).toEqual({ settleMs: 2_600, maxResources: 12, deadlineMs: 4_200 });
  });

  it("caps each probe and the whole wave to the remaining global budget", async () => {
    expect(capExplorationProbeOptions(
      { settleMs: 5_000, maxResources: 12, deadlineMs: 7_000 },
      900,
    )).toEqual({ settleMs: 900, maxResources: 12, deadlineMs: 900 });

    vi.useFakeTimers();
    let settled = false;
    const slowProbe = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 7_000));
    const bounded = runWithinExplorationBudget(slowProbe, 900).then(
      () => undefined,
      (error: unknown) => {
      settled = true;
        return error;
      },
    );
    await vi.advanceTimersByTimeAsync(899);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(bounded).resolves.toMatchObject({ message: expect.stringMatching(/deadline/) });
    vi.useRealTimers();
  });

  it("reserves time for a page probe to return before its outer watchdog fires", async () => {
    const timing = explorationProbeTiming(
      { settleMs: 2_600, maxResources: 12, deadlineMs: 4_200 },
      10_000,
    );
    expect(timing).toEqual({
      probeOptions: { settleMs: 2_600, maxResources: 12, deadlineMs: 3_600 },
      watchdogMs: 4_200,
    });

    vi.useFakeTimers();
    const serializedEvidence = new Promise<string>((resolve) => setTimeout(() => resolve("evidence"), 4_100));
    const bounded = runWithinExplorationBudget(serializedEvidence, timing.watchdogMs);
    await vi.advanceTimersByTimeAsync(4_100);
    await expect(bounded).resolves.toBe("evidence");
    vi.useRealTimers();
  });

  it("uses safe Settings routes as low-confidence bridges to hidden billing pages", () => {
    const origin = "https://vendor.example";
    const targets = planExplorationTargets({
      origin,
      links: [
        { url: `${origin}/app/preferences`, label: "Workspace settings" },
        { url: `${origin}/app/section/42`, context: "Billing and invoices" },
      ],
      visited: new Set([`${origin}/home`]),
      nextDepth: 1,
    });

    expect(targets.map((target) => target.url)).toEqual([
      `${origin}/app/section/42`,
      `${origin}/app/preferences`,
    ]);
    expect(planExplorationTargets({
      origin,
      links: [{ url: `${origin}/app/preferences/delete`, label: "Workspace settings" }],
      visited: new Set(),
      nextDepth: 1,
    })).toEqual([]);
  });

  it("rejects off-origin, non-billing, and action-like navigation", () => {
    const origin = "https://vendor.example";
    expect(safeExplorationUrl("https://other.example/billing", origin)).toBeUndefined();
    expect(safeExplorationUrl(`${origin}/settings/team`, origin)).toBeUndefined();
    expect(safeExplorationUrl(`${origin}/billing/cancel`, origin)).toBeUndefined();
    expect(safeExplorationUrl(`${origin}/checkout/invoice`, origin)).toBeUndefined();
    expect(safeExplorationUrl(`${origin}/billing/history?tab=invoices#latest`, origin)).toBe(`${origin}/billing/history`);
    expect(safeExplorationUrl(`${origin}/billing/history?page=2&per_page=25`, origin)).toBe(`${origin}/billing/history?page=2&per_page=25`);
    expect(safeExplorationUrl(`${origin}/billing/history?after=opaque-cursor`, origin)).toBe(`${origin}/billing/history`);
    expect(safeExplorationUrl(`${origin}/account/invoiceHistory`, origin)).toBe(`${origin}/account/invoiceHistory`);
    expect(safeExplorationUrl(`${origin}/account/billingPortal`, origin)).toBe(`${origin}/account/billingPortal`);
    expect(safeExplorationUrl(`${origin}/account/invoiceHistory/deleteDocument`, origin)).toBeUndefined();
    expect(safeExplorationUrl(`${origin}/account/createInvoice`, origin)).toBeUndefined();
    expect(safeExplorationUrl(`${origin}/account/paymentMethods`, origin)).toBeUndefined();
    for (const encodedAction of [
      "/billing/%63ancel",
      "/billing/%2563ancel",
      "/billing/%6Co%67out",
      "/billing/%64elete",
      "/billing/%63heckout",
      "/billing/%61uthorize",
      "/billing/%64ownload/invoice",
      "/billing/invoice%2Epdf",
      "/billing%2Fcancel",
    ]) {
      expect(safeExplorationUrl(`${origin}${encodedAction}`, origin)).toBeUndefined();
    }
  });

  it("uses a semantic invoice label to admit an otherwise opaque exact-origin route", () => {
    const origin = "https://vendor.example";
    const opaqueRoute = `${origin}/app/section/42`;
    const targets = planExplorationTargets({
      origin,
      links: [{ url: opaqueRoute, label: "Invoices" }],
      visited: new Set([`${origin}/home`]),
      nextDepth: 1,
    });

    expect(targets[0]).toMatchObject({ url: opaqueRoute, source: "linked", depth: 1 });
    expect(planExplorationTargets({
      origin,
      links: [opaqueRoute],
      visited: new Set(),
      nextDepth: 1,
    })).toEqual([]);
    expect(planExplorationTargets({
      origin,
      links: [{ url: opaqueRoute, label: "Delete invoices" }],
      visited: new Set(),
      nextDepth: 1,
    })).toEqual([]);
  });

  it("admits an opaque route only when same-document navigation actually exposed it", () => {
    const origin = "https://portal.example";
    const targets = planExplorationTargets({
      origin,
      links: [{ url: `${origin}/surface/r7`, hintSource: "semantic_navigation" }],
      visited: new Set([`${origin}/home`]),
      nextDepth: 1,
    });

    expect(targets).toContainEqual(expect.objectContaining({
      url: `${origin}/surface/r7`,
      hintSource: "semantic_navigation",
    }));
    expect(planExplorationTargets({
      origin,
      links: [{ url: `${origin}/surface/r7` }],
      visited: new Set([`${origin}/home`]),
      nextDepth: 1,
    })).toEqual([]);
    expect(planExplorationTargets({
      origin,
      links: [{ url: `${origin}/surface/delete-account`, hintSource: "semantic_navigation" }],
      visited: new Set(),
      nextDepth: 1,
    })).toEqual([]);
  });

  it("keeps direct documents as evidence without navigating them as exploration pages", () => {
    const origin = "https://github.com";
    expect(safeExplorationUrl(`${origin}/account/receipt/ch_example`, origin)).toBeUndefined();
    expect(safeExplorationUrl(`${origin}/account/receipt/ch_example.pdf`, origin)).toBeUndefined();
    expect(safeExplorationUrl(`${origin}/billing/invoice.pdf`, origin)).toBeUndefined();
    expect(safeExplorationUrl(`${origin}/billing/download/invoice`, origin)).toBeUndefined();
  });

  it("can follow a best-first keyword route graph through three levels", () => {
    const origin = "https://vendor.example";
    const visited = new Set([`${origin}/home`]);
    const billing = planExplorationTargets({
      origin,
      links: [`${origin}/account/billingPortal`],
      visited,
      nextDepth: 1,
    })[0];
    expect(billing).toMatchObject({ url: `${origin}/account/billingPortal`, depth: 1, source: "linked" });
    visited.add(billing.url);

    const history = planExplorationTargets({
      origin,
      links: [`${origin}/account/billingPortal/invoiceHistory`],
      visited,
      nextDepth: 2,
    })[0];
    expect(history).toMatchObject({ url: `${origin}/account/billingPortal/invoiceHistory`, depth: 2 });
    visited.add(history.url);

    const detail = planExplorationTargets({
      origin,
      links: [`${origin}/account/billingPortal/invoiceHistory/invoice_123`],
      visited,
      nextDepth: 3,
    })[0];
    expect(detail).toMatchObject({ url: `${origin}/account/billingPortal/invoiceHistory/invoice_123`, depth: 3 });
  });

  it("does not plan beyond depth three or revisit a canonical route", () => {
    const origin = "https://vendor.example";
    expect(planExplorationTargets({ origin, links: [`${origin}/billing/invoiceHistory`], visited: new Set(), nextDepth: 3 })).toHaveLength(1);
    expect(planExplorationTargets({ origin, links: [`${origin}/billing`], visited: new Set(), nextDepth: 4 })).toEqual([]);
    expect(planExplorationTargets({
      origin,
      links: [`${origin}/billing?from=home`],
      visited: new Set([`${origin}/billing`]),
      nextDepth: 2,
    })).toEqual([]);
  });
});
