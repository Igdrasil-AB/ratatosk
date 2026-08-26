import { afterEach, describe, expect, it } from "vitest";
import { discoverSupplierInTab, SupplierDiscoveryError } from "../../collector/src/platform/discovery";
import { createExplorationCheckpoint, EXPLORATION_BUDGETS } from "../../collector/src/platform/discovery-explorer";
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
    expect(simulation.trace.elapsedMs).toBeLessThanOrEqual(TARGET_MS);
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

  it("checkpoints an unfinished semantic lane instead of reporting not found", async () => {
    const portal: Portal = {
      name: "portal whose fourth menu exceeds the fast lane",
      origin: "https://app.semantic-lane.example",
      entryPath: "/home",
      routes: [{
        path: "/home",
        title: "Home | Semantic Lane",
        hydrateMs: 100,
        semanticRevealMs: 9_000,
        html: "<html><body><h1>Home</h1></body></html>",
      }],
    };
    const simulation = createSimulation(portal);
    const checkpoints: ReturnType<typeof createExplorationCheckpoint>[] = [];
    active = simulation;
    simulation.install();
    try {
      let failure: unknown;
      try {
        await discoverSupplierInTab(simulation.entryTabId, portal.origin, {
          mode: "fast",
          onCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint); },
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(SupplierDiscoveryError);
      expect((failure as SupplierDiscoveryError).diagnostic).toMatchObject({
        result: "limit_reached",
        termination: "time_cap",
      });
      expect(checkpoints.at(-1)?.frontier).toContainEqual(expect.objectContaining({
        source: "entry_replay",
        route: "/home",
      }));
      expect((failure as SupplierDiscoveryError).diagnostic.attempts).toContainEqual(expect.objectContaining({
        source: "entry_replay",
        evidence: expect.objectContaining({ semanticNavigationStatus: "time_cap" }),
      }));
    } finally {
      simulation.restore();
      active = undefined;
    }
  });

  it("finds an arbitrary invoice route only after the app exposes it through safe SPA navigation", async () => {
    const observedNavigation: Portal = {
      name: "same-document invoice navigation",
      origin: "https://app.navigation.example",
      entryPath: "/home",
      routes: [
        {
          path: "/home",
          title: "Home | Navigation",
          hydrateMs: 200,
          semanticRevealMs: 100,
          // This path is intentionally meaningless. It is safe only because a
          // user-visible, non-mutating navigation control exposed it.
          navigations: [{ href: "/surface/r7", label: "Billing and invoices" }],
          html: "<html><head><title>Home | Navigation</title></head><body><div id=app></div></body></html>",
        },
        {
          path: "/surface/r7",
          title: "Documents | Navigation",
          hydrateMs: 450,
          html: '<html><head><title>Documents | Navigation</title></head><body><h1>Statements</h1><a href="/documents/2026-07.pdf">Download</a><a href="/documents/2026-06.pdf">Download</a></body></html>',
        },
      ],
    };

    const { result, trace } = await discover(observedNavigation);

    expect(result.candidates.candidates[0].adapter.id).toBe("dom-links");
    expect(trace.probes.map((probe) => new URL(probe.url).pathname)).toContain("/surface/r7");
    expect(trace.probes.map((probe) => new URL(probe.url).pathname)).not.toContain("/billing");
    const activeEntry = trace.probes.findIndex((probe) => probe.foreground && new URL(probe.url).pathname === "/home");
    const coldReplay = trace.probes.findIndex((probe) => !probe.foreground && new URL(probe.url).pathname === "/home");
    expect(trace.probePhases[activeEntry].semanticRevealMs).toBe(0);
    expect(trace.probePhases[coldReplay].semanticRevealMs).toBeGreaterThan(0);
    expect(trace.probePhases).toContainEqual(expect.objectContaining({
      semanticRevealMs: expect.any(Number),
      observerQuiescenceMs: expect.any(Number),
      mutationSettleMs: expect.any(Number),
      scrollMs: expect.any(Number),
      resourceTimingMs: expect.any(Number),
    }));
  });

  it("caps every modeled evidence phase within its target deadline", async () => {
    const portal: Portal = {
      name: "bounded phased evidence",
      origin: "https://phased.example",
      entryPath: "/billing",
      routes: [{
        path: "/billing",
        hydrateMs: 100,
        semanticRevealMs: 100,
        mutationSettleMs: 100,
        scrollMs: 100,
        resourceTimingMs: 100,
        html: '<html><body><h1>Invoices</h1><a href="/documents/july.pdf">Download</a></body></html>',
      }],
    };
    const { trace } = await discover(portal);
    for (const [index, probe] of trace.probes.entries()) {
      const phases = trace.probePhases[index];
      const total = phases.semanticRevealMs + phases.observerQuiescenceMs + phases.mutationSettleMs + phases.scrollMs + phases.resourceTimingMs;
      expect(total).toBeLessThanOrEqual(probe.deadlineMs);
      expect(probe.costMs).toBeLessThanOrEqual(probe.deadlineMs);
    }
  });

  it("resumes only the saved replayable frontier instead of repeating completed pages", async () => {
    const portal: Portal = {
      name: "resumable invoice surface",
      origin: "https://resume.example",
      entryPath: "/home",
      routes: [
        { path: "/home", title: "Home | Resume", html: "<html><body>Home</body></html>" },
        {
          path: "/surface/r7",
          title: "Invoices | Resume",
          hydrateMs: 500,
          html: '<html><body><h1>Invoices</h1><a href="/documents/july.pdf">Download</a><a href="/documents/june.pdf">Download</a></body></html>',
        },
      ],
    };
    const checkpoint = createExplorationCheckpoint({
      mode: "deep",
      pagesAttempted: 2,
      linkedPagesAttempted: 1,
      commonRoutePagesAttempted: 0,
      elapsedMs: 1_000,
      frontier: [{
        key: "observed_navigation|/:segment/:segment",
        family: "observed_navigation",
        score: 160,
        depth: 1,
        route: "/surface/r7",
        source: "linked",
        hintSource: "semantic_navigation",
      }],
      completedTargetKeys: ["exact_entry|/home"],
      attemptedFamilies: ["exact_entry"],
      slicesCompleted: 0,
    });
    const simulation = createSimulation(portal);
    active = simulation;
    simulation.install();
    try {
      const result = await discoverSupplierInTab(simulation.entryTabId, portal.origin, { mode: "deep", checkpoint });
      expect(result.candidates.candidates[0].adapter.id).toBe("dom-links");
      expect(simulation.trace.probes.map((probe) => new URL(probe.url).pathname)).toEqual(["/surface/r7"]);
    } finally {
      simulation.restore();
      active = undefined;
    }
  });

  it("templates a root tenant route only when this run proves a typed runtime scope", async () => {
    const tenant = "9012345678901";
    const origin = "https://app.template.example";
    const portal: Portal = {
      name: "typed tenant invoice route",
      origin,
      entryPath: `/${tenant}/home`,
      routes: [
        {
          path: `/${tenant}/home`,
          title: "Home | Template",
          hydrateMs: 150,
          navigations: [{ href: `/${tenant}/surface/r7`, label: "Billing and invoices" }],
          html: "<html><body>Home</body></html>",
        },
        {
          path: `/${tenant}/surface/r7`,
          title: "Invoices | Template",
          hydrateMs: 350,
          calls: [{ url: `${origin}/api/session`, requestHeaders: {}, body: JSON.stringify({ workspaceId: tenant }) }],
          html: '<html><body><h1>Invoices</h1><a href="/documents/july.pdf">Download</a><a href="/documents/june.pdf">Download</a></body></html>',
        },
      ],
    };

    const { result } = await discover(portal);
    const profile = result.candidates.candidates.find((candidate) => candidate.adapter.id === "dom-links")!;
    expect(profile.entryUrl).toBe(`${origin}/`);
    expect(profile.recipe.invoices).toMatchObject({
      strategy: "dom",
      list: { open: `${origin}/{workspaceId}/surface/r7` },
    });
    expect(profile.recipe.config).toEqual([{
      id: "workspaceId",
      discover: { request: { url: `${origin}/api/session` }, value: "workspaceId" },
    }]);
    expect(JSON.stringify(profile)).not.toContain(tenant);
  });

  it("templates an opaque route from an observed cross-origin read-only GraphQL scope", async () => {
    const tenant = "9012345678901";
    const origin = "https://app.graphql-scope.example";
    const scopeUrl = "https://api.graphql-scope.example/graphql?operationName=Workspace";
    const requestBody = JSON.stringify({ query: "query Workspace { viewer { workspace { id } } }", operationName: "Workspace" });
    const scopeBody = JSON.stringify({ data: { viewer: { workspace: { id: tenant } } } });
    const portal: Portal = {
      name: "opaque route with cross-origin GraphQL scope",
      origin,
      entryPath: `/${tenant}/home`,
      routes: [
        {
          path: `/${tenant}/home`,
          hydrateMs: 100,
          navigations: [{ href: `/${tenant}/surface/r7`, label: "Billing and invoices" }],
          html: "<html><body>Home</body></html>",
        },
        {
          path: `/${tenant}/surface/r7`,
          title: "Invoices | GraphQL Scope",
          hydrateMs: 300,
          calls: [{
            url: scopeUrl,
            method: "POST",
            requestBody,
            requestHeaders: { "content-type": "application/json" },
            body: scopeBody,
          }],
          html: '<html><body><h1>Invoices</h1><a href="/documents/july.pdf">Download</a></body></html>',
        },
      ],
      endpoint: (request) => request.url === scopeUrl && request.method === "POST"
        ? { body: scopeBody }
        : undefined,
    };

    const { result } = await discover(portal);
    const profile = result.candidates.candidates.find((candidate) => candidate.adapter.id === "dom-links")!;
    expect(profile.recipe.invoices).toMatchObject({
      strategy: "dom",
      list: { open: `${origin}/{workspace}/surface/r7` },
    });
    expect(profile.recipe.config).toEqual([{
      id: "workspace",
      discover: {
        request: {
          url: scopeUrl,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: requestBody,
        },
        value: "data.viewer.workspace.id",
      },
    }]);
    expect(JSON.stringify(profile)).not.toContain(tenant);
  });

  it("does not preview a root tenant DOM route when typed scope provenance is absent", async () => {
    const tenant = "9012345678901";
    const portal: Portal = {
      name: "unbound root tenant route",
      origin: "https://app.unbound.example",
      entryPath: `/${tenant}/home`,
      routes: [
        {
          path: `/${tenant}/home`,
          hydrateMs: 100,
          navigations: [{ href: `/${tenant}/surface/r7`, label: "Billing and invoices" }],
          html: "<html><body>Home</body></html>",
        },
        {
          path: `/${tenant}/surface/r7`,
          hydrateMs: 200,
          html: '<html><body><h1>Invoices</h1><a href="/documents/july.pdf">Download</a></body></html>',
        },
      ],
    };
    const simulation = createSimulation(portal);
    active = simulation;
    simulation.install();
    try {
      let failure: unknown;
      try {
        await discoverSupplierInTab(simulation.entryTabId, portal.origin, { mode: "fast" });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(SupplierDiscoveryError);
      expect((failure as SupplierDiscoveryError).diagnostic.attempts.map((attempt) => attempt.result))
        .toContain("route_not_replayable");
    } finally {
      simulation.restore();
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

  it("does not hang a resumed deep search on active-tab observer adoption", async () => {
    const portal: Portal = {
      name: "resumed deep search with an unresponsive active document",
      origin: "https://deep-resume.example",
      entryPath: "/home",
      entryObserverAdoptHangs: true,
      routes: [{ path: "/home", html: "<html><body>Home</body></html>" }],
    };
    const checkpoint = createExplorationCheckpoint({
      mode: "deep",
      pagesAttempted: 10,
      linkedPagesAttempted: 8,
      commonRoutePagesAttempted: 0,
      elapsedMs: 10_000,
      frontier: [],
      completedTargetKeys: ["exact_entry|/home"],
      attemptedFamilies: ["exact_entry", "observed_navigation"],
      slicesCompleted: 0,
    });
    const simulation = createSimulation(portal);
    active = simulation;
    simulation.install();
    try {
      const outcome = await Promise.race([
        discoverSupplierInTab(simulation.entryTabId, portal.origin, { mode: "deep", checkpoint })
          .then(() => "resolved" as const, (error: unknown) => error),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100)),
      ]);

      expect(outcome).toBeInstanceOf(SupplierDiscoveryError);
    } finally {
      simulation.restore();
      active = undefined;
    }
  });
});
