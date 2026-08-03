import { afterEach, describe, expect, it } from "vitest";
import { discoverSupplierInTab, SupplierDiscoveryError } from "../../collector/src/platform/discovery";
import { EXPLORATION_BUDGETS } from "../../collector/src/platform/discovery-explorer";
import { PORTAL_CORPUS } from "../support/portal-corpus";
import { createSimulation, type Portal } from "../support/portal-simulator";

/**
 * The end-to-end gate for supplier discovery.
 *
 * Every portal here is run through the real `discoverSupplierInTab` against a
 * simulated Chrome and a virtual clock, so a regression shows up as either a
 * lost candidate or a slower search rather than as a changed constant.
 *
 * The time assertion is the product promise: a person clicks Find Invoices and
 * waits seconds, not minutes. It is modelled from the same navigation and
 * hydration delays that decide whether evidence is found at all, so nothing can
 * pass it by simply waiting less.
 */

const INTERACTIVE_BUDGET_MS = EXPLORATION_BUDGETS.fast.durationMs;
const TARGET_MS = 10_000;

let active: { restore(): void } | undefined;

afterEach(() => {
  active?.restore();
  active = undefined;
});

async function discover(portal: Portal) {
  const simulation = createSimulation(portal);
  active = simulation;
  simulation.install();
  try {
    const result = await discoverSupplierInTab(simulation.entryTabId, portal.origin, { mode: "fast" });
    return { result, trace: simulation.trace };
  } finally {
    simulation.restore();
    active = undefined;
  }
}

describe("supplier discovery across portal shapes", () => {
  for (const entry of PORTAL_CORPUS) {
    it(`finds invoices on a ${entry.portal.name}`, async () => {
      const { result, trace } = await discover(entry.portal);

      expect(result.candidates.candidates.length).toBeGreaterThanOrEqual(1);
      expect(result.candidates.candidates[0].adapter.id).toBe(entry.expectedAdapter);
      expect(result.candidates.candidates[0].candidateCount).toBeGreaterThanOrEqual(1);
      expect(result.diagnostic.result).toBe("candidates_found");
      expect(trace.elapsedMs).toBeLessThanOrEqual(TARGET_MS);
    });
  }

  it("keeps every shape inside the interactive envelope", async () => {
    const timings: Array<{ name: string; elapsedMs: number; pages: number }> = [];
    for (const entry of PORTAL_CORPUS) {
      const { result, trace } = await discover(entry.portal);
      timings.push({ name: entry.portal.name, elapsedMs: trace.elapsedMs, pages: result.diagnostic.pages.attempted });
    }
    const worst = Math.max(...timings.map((timing) => timing.elapsedMs));
    const median = [...timings].sort((left, right) => left.elapsedMs - right.elapsedMs)[Math.floor(timings.length / 2)];

    console.info(`[discovery] worst=${worst}ms median=${median.elapsedMs}ms`);
    for (const timing of timings) console.info(`[discovery] ${timing.elapsedMs}ms ${timing.pages}p ${timing.name}`);

    expect(worst).toBeLessThanOrEqual(TARGET_MS);
    expect(worst).toBeLessThanOrEqual(INTERACTIVE_BUDGET_MS);
    // A search that stops on proof should usually be far inside the ceiling.
    expect(median.elapsedMs).toBeLessThanOrEqual(6_000);
  });

  it("stops as soon as a structured candidate is proven instead of spending the page budget", async () => {
    const { result, trace } = await discover(PORTAL_CORPUS[0].portal);

    expect(result.diagnostic.pages.attempted).toBeLessThanOrEqual(2);
    expect(trace.elapsedMs).toBeLessThanOrEqual(5_000);
  });

  it("fails fast, and labels the failure so the caller knows a deeper pass is still owed", async () => {
    const barren: Portal = {
      name: "portal with no billing surface",
      origin: "https://app.barren.example",
      entryPath: "/home",
      routes: [{ path: "/home", title: "Home | Barren", hydrateMs: 200, html: "<html><body><h1>Home</h1></body></html>" }],
    };
    const simulation = createSimulation(barren);
    active = simulation;
    simulation.install();
    try {
      await expect(discoverSupplierInTab(simulation.entryTabId, barren.origin, { mode: "fast" }))
        .rejects.toBeInstanceOf(SupplierDiscoveryError);
    } catch (error) {
      throw error;
    } finally {
      simulation.restore();
      active = undefined;
    }
    expect(simulation.trace.elapsedMs).toBeLessThanOrEqual(TARGET_MS + EXPLORATION_BUDGETS.fast.durationMs);
  });

  it("resolves a portal too slow for the interactive envelope on the deeper pass", async () => {
    const glacial: Portal = {
      name: "portal that hydrates billing after five seconds",
      origin: "https://app.glacial.example",
      entryPath: "/home",
      routes: [
        {
          path: "/home",
          title: "Home | Glacial",
          hydrateMs: 200,
          html: '<html><head><title>Home | Glacial</title></head><body><a href="/account/billing">Billing</a></body></html>',
          links: [{ href: "/account/billing", label: "Billing" }],
        },
        {
          path: "/account/billing",
          title: "Billing | Glacial",
          hydrateMs: 5_000,
          html: '<html><head><title>Billing | Glacial</title></head><body><h1>Invoices</h1><a href="/documents/inv-1.pdf">Invoice</a></body></html>',
        },
      ],
    };

    const fast = createSimulation(glacial);
    active = fast;
    fast.install();
    let fastError: unknown;
    try {
      await discoverSupplierInTab(fast.entryTabId, glacial.origin, { mode: "fast" });
    } catch (error) {
      fastError = error;
    } finally {
      fast.restore();
      active = undefined;
    }
    expect(fastError).toBeInstanceOf(SupplierDiscoveryError);
    expect((fastError as SupplierDiscoveryError).diagnostic.coverage?.mode).toBe("fast");

    const deep = createSimulation(glacial);
    active = deep;
    deep.install();
    try {
      const result = await discoverSupplierInTab(deep.entryTabId, glacial.origin, { mode: "deep" });
      expect(result.candidates.candidates[0].adapter.id).toBe("dom-links");
    } finally {
      deep.restore();
      active = undefined;
    }
  });

  it("replays a cross-origin GraphQL list through a runtime-discovered workspace scope", async () => {
    const { result } = await discover(PORTAL_CORPUS[0].portal);
    const recipe = result.candidates.candidates[0].recipe;

    expect(recipe.invoices.strategy).toBe("network");
    if (recipe.invoices.strategy !== "network") throw new Error("expected a network candidate");
    expect(recipe.invoices.list.request.method).toBe("POST");
    expect(recipe.invoices.list.request.body).toContain("{workspaceId}");
    expect(recipe.invoices.list.request.body).not.toContain("REDACTED");
    expect(recipe.config?.[0]?.id).toBe("workspaceId");
    // The provider's hosted invoice page is rewritten to the direct document.
    expect(JSON.stringify(recipe.invoices.list.map.documentUrl)).toContain("pay.stripe.com");
  });
});
