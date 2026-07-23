import { describe, expect, it, vi } from "vitest";
import {
  capExplorationProbeOptions,
  createExplorationCheckpoint,
  EXPLORATION_DEADLINE_MS,
  EXPLORATION_BUDGETS,
  MAX_EXPLORATION_DEPTH,
  MAX_EXPLORATION_PAGES,
  explorationProbeOptions,
  planExplorationTargets,
  rankExplorationQueue,
  runWithinExplorationBudget,
  explorationTargetKey,
  parseExplorationCheckpoint,
  safeExplorationUrl,
} from "../../collector/src/platform/discovery-explorer";

describe("bounded same-origin discovery exploration", () => {
  it("uses the reviewed best-first search budget", () => {
    expect(MAX_EXPLORATION_PAGES).toBe(15);
    expect(MAX_EXPLORATION_DEPTH).toBe(3);
    expect(EXPLORATION_DEADLINE_MS).toBe(30_000);
  });

  it("keeps a substantially broader, still bounded deep coverage envelope", () => {
    expect(EXPLORATION_BUDGETS.deep).toEqual({ pages: 60, depth: 5, durationMs: 180_000, slices: 1 });
    expect(EXPLORATION_BUDGETS.self_heal).toEqual({ pages: 80, depth: 5, durationMs: 300_000, slices: 5 });
  });

  it("keeps linked invoice evidence first while guaranteeing a common-route turn", () => {
    const origin = "https://vendor.example";
    const targets = planExplorationTargets({
      origin,
      links: [
        `${origin}/settings/team`,
        `${origin}/billing`,
        `${origin}/account/invoices?token=must-not-survive#latest`,
        "https://other.example/invoices",
      ],
      visited: new Set([`${origin}/`]),
      nextDepth: 1,
      includeCommonRoutes: true,
    });

    expect(targets[0]).toMatchObject({ url: `${origin}/account/invoices`, source: "linked", depth: 1 });
    expect(targets[1]).toMatchObject({ source: "common_route", family: "common_billing_route", depth: 1 });
    expect(targets.every((target) => new URL(target.url).origin === origin)).toBe(true);
    expect(JSON.stringify(targets)).not.toContain("token");
    expect(targets.length).toBeLessThanOrEqual(MAX_EXPLORATION_PAGES - 1);
  });

  it("includes GitHub's common billing-history shape when the home page has no billing link", () => {
    const targets = planExplorationTargets({
      origin: "https://github.com",
      links: [],
      visited: new Set(["https://github.com/"]),
      nextDepth: 1,
      includeCommonRoutes: true,
    });
    expect(targets[0]).toMatchObject({
      url: "https://github.com/account/billing/history",
      source: "common_route",
    });
  });

  it("reserves a common-route slot when linked billing guesses saturate the page budget", () => {
    const origin = "https://github.com";
    const targets = planExplorationTargets({
      origin,
      links: Array.from({ length: MAX_EXPLORATION_PAGES - 1 }, (_, index) =>
        `${origin}/settings/billing/invoices-${index + 1}`),
      visited: new Set([`${origin}/`]),
      nextDepth: 1,
      includeCommonRoutes: true,
    });

    expect(targets).toHaveLength(MAX_EXPLORATION_PAGES - 1);
    expect(targets).toContainEqual(expect.objectContaining({
      url: "https://github.com/account/billing/history",
      source: "common_route",
    }));
    expect(targets.findIndex((target) => target.source === "common_route")).toBeLessThanOrEqual(2);
  });

  it("preserves the common-route reservation after global frontier ranking", () => {
    const origin = "https://github.com";
    const ranked = rankExplorationQueue([
      ...Array.from({ length: MAX_EXPLORATION_PAGES - 1 }, (_, index) => ({
        url: `${origin}/organizations/example/settings/billing/${index}`,
        source: "linked" as const,
        depth: 2,
        score: 118 - index,
      })),
      {
        url: `${origin}/account/billing/history`,
        source: "common_route" as const,
        depth: 1,
        score: 85,
      },
    ]);

    expect(ranked.findIndex((target) => target.source === "common_route")).toBeLessThanOrEqual(2);
    expect(ranked.slice(0, 3)).toContainEqual(expect.objectContaining({
      url: `${origin}/account/billing/history`,
    }));
  });

  it("does not let observed navigation starve tenant-aware or common billing families", () => {
    const origin = "https://app.vendor.example";
    const ranked = rankExplorationQueue([
      ...Array.from({ length: 12 }, (_, index) => ({
        url: `${origin}/settings/billing/invoices-${index}`,
        source: "linked" as const,
        depth: 2,
        score: 120 - index,
      })),
      {
        url: `${origin}/123456789/settings/billing`,
        source: "common_route" as const,
        family: "tenant_contextual_route" as const,
        depth: 1,
        score: 90,
      },
      {
        url: `${origin}/account/billing/history`,
        source: "common_route" as const,
        family: "common_billing_route" as const,
        depth: 1,
        score: 80,
      },
    ]);

    expect(ranked.slice(0, 4).map((target) => target.family ?? target.source)).toEqual([
      "linked", "tenant_contextual_route", "common_billing_route", "linked",
    ]);
  });

  it("checkpoints only a structural route key and rejects raw routes or malformed progress", () => {
    const target = {
      url: "https://app.vendor.example/9012345678/settings/billing?token=secret",
      source: "common_route" as const,
      family: "tenant_contextual_route" as const,
      depth: 1,
      score: 100,
    };
    const key = explorationTargetKey(target);
    expect(key).toBe("tenant_contextual_route|/:id/settings/billing");
    const checkpoint = createExplorationCheckpoint({
      mode: "deep",
      pagesAttempted: 3,
      linkedPagesAttempted: 1,
      commonRoutePagesAttempted: 1,
      elapsedMs: 1_200,
      frontier: [{ key, family: "tenant_contextual_route", score: 100, depth: 1 }],
      completedTargetKeys: [key],
      attemptedFamilies: ["exact_entry", "tenant_contextual_route"],
      slicesCompleted: 0,
    });
    expect(JSON.stringify(checkpoint)).not.toMatch(/9012345678|token|https?:/i);
    expect(parseExplorationCheckpoint(checkpoint)).toEqual(checkpoint);
    expect(parseExplorationCheckpoint({ ...checkpoint, completedTargetKeys: ["tenant_contextual_route|https://app.vendor.example/private"] })).toBeUndefined();
  });

  it("preserves an account prefix when planning common billing routes", () => {
    const origin = "https://dash.cloudflare.com";
    const account = "a473171df3249291b4be6fca57bb8444";
    const targets = planExplorationTargets({
      origin,
      contextUrl: `${origin}/${account}/home`,
      links: [],
      visited: new Set([`${origin}/${account}/home`]),
      nextDepth: 1,
      includeCommonRoutes: true,
    });

    expect(targets.map((target) => target.url)).toContain(`${origin}/${account}/billing/subscriptions`);
    expect(targets.find((target) => target.url.includes(account))).toMatchObject({ source: "common_route" });
  });

  it("prioritizes tenant-scoped Settings/Billing over speculative tenant history routes", () => {
    const origin = "https://app.vendor.example";
    const workspace = "123456789";
    const targets = planExplorationTargets({
      origin,
      contextUrl: `${origin}/${workspace}/home`,
      links: [],
      visited: new Set([`${origin}/${workspace}/home`]),
      nextDepth: 1,
      includeCommonRoutes: true,
    });

    expect(targets[0]).toMatchObject({
      url: `${origin}/${workspace}/settings/billing`,
      source: "common_route",
    });
  });

  it("keeps a typed tenant prefix behind a safe dashboard/org route shape", () => {
    const origin = "https://supabase.com";
    const organization = "123456789";
    const targets = planExplorationTargets({
      origin,
      contextUrl: `${origin}/dashboard/org/${organization}/billing`,
      links: [],
      visited: new Set([`${origin}/dashboard/org/${organization}/billing`]),
      nextDepth: 1,
      includeCommonRoutes: true,
    });

    expect(targets.map((target) => target.url)).toContain(`${origin}/dashboard/org/${organization}/settings/billing`);
  });

  it("binds an opaque tenant only when its exact route position is behind a trusted container", () => {
    const origin = "https://supabase.com";
    const organization = "opaqueorganizationid";
    const targets = planExplorationTargets({
      origin,
      contextUrl: `${origin}/dashboard/org/${organization}/billing`,
      links: [],
      visited: new Set([`${origin}/dashboard/org/${organization}/billing`]),
      nextDepth: 1,
      includeCommonRoutes: true,
    });

    expect(targets.map((target) => target.url)).toContain(
      `${origin}/dashboard/org/${organization}/settings/billing`,
    );
    const unsafe = planExplorationTargets({
      origin,
      contextUrl: `${origin}/dashboard/settings/billing`,
      links: [],
      visited: new Set(),
      nextDepth: 1,
      includeCommonRoutes: true,
    });
    expect(unsafe.some((target) => target.url.includes("/dashboard/settings/"))).toBe(false);
  });

  it("gives a tenant-scoped ClickUp billing route an adaptive SPA evidence budget", () => {
    const target = {
      url: "https://app.clickup.com/9012345678/settings/billing",
      source: "common_route" as const,
      depth: 1,
      score: 105,
    };
    expect(explorationProbeOptions(target)).toEqual({ settleMs: 5_000, maxResources: 12, deadlineMs: 7_000 });
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
