import { afterEach, describe, expect, it } from "vitest";
import { discoverSupplierInTab } from "../../collector/src/platform/discovery";
import { planExplorationTargets } from "../../collector/src/platform/discovery-explorer";
import { createSimulation, type Portal } from "../support/portal-simulator";

let active: { restore(): void } | undefined;

afterEach(() => {
  active?.restore();
  active = undefined;
});

describe("evidence-first discovery mutation corpus", () => {
  for (const [name, route, hydrateMs] of [
    ["renamed surface", "/surface/r7", 350],
    ["nested renamed surface", "/ledger-zone/p1", 900],
    ["delayed renamed surface", "/archive/x2", 2_400],
  ] as const) {
    it(`finds invoices after ${name} without a route dictionary change`, async () => {
      const origin = `https://${name.replace(/\s+/g, "-")}.example`;
      const portal: Portal = {
        name,
        origin,
        entryPath: "/home",
        routes: [
          {
            path: "/home",
            hydrateMs: 120,
            navigations: [{ href: route, label: "Billing and invoices" }],
            html: "<html><body><div id=app></div></body></html>",
          },
          {
            path: route,
            hydrateMs,
            html: '<html><body><h1>Statements</h1><a href="/documents/july.pdf">Download</a><a href="/documents/june.pdf">Download</a></body></html>',
          },
        ],
      };
      const simulation = createSimulation(portal);
      active = simulation;
      simulation.install();
      try {
        const result = await discoverSupplierInTab(simulation.entryTabId, origin, { mode: "fast" });
        expect(result.candidates.candidates[0].adapter.id).toBe("dom-links");
        expect(simulation.trace.elapsedMs).toBeLessThanOrEqual(10_000);
        expect(simulation.trace.probes.map((probe) => new URL(probe.url).pathname)).toContain(route);
        expect(simulation.trace.probes.map((probe) => new URL(probe.url).pathname)).not.toContain("/billing");
      } finally {
        simulation.restore();
        active = undefined;
      }
    });
  }

  for (const [seed, wrapper, label, documentLabel, hydrateMs] of [
    [17, "section", "Payment history", "Get receipt", 180],
    [41, "article", "Statements", "Download statement", 650],
    [73, "div", "Billing documents", "Download invoice", 1_300],
  ] as const) {
    const left = (Math.imul(seed, 2_654_435_761) >>> 0).toString(36);
    const right = (Math.imul(seed + 11, 1_597_334_677) >>> 0).toString(36);
    const route = `/x${left}/z${right}`;
    const wrapperClass = `w${right} x${left}`;

    it(`survives neutral route, label, and ${wrapper} wrapper mutation seed ${seed}`, async () => {
      expect(route).not.toMatch(/billing|payment|invoice|receipt|statement/i);
      expect(wrapperClass).not.toMatch(/billing|payment|invoice|receipt|statement/i);
      const origin = `https://mutation-${seed}.example`;
      const portal: Portal = {
        name: `deterministic mutation seed ${seed}`,
        origin,
        entryPath: "/home",
        routes: [
          {
            path: "/home",
            hydrateMs: 100,
            navigations: [{ href: route, label }],
            html: "<html><body><div id=app></div></body></html>",
          },
          {
            path: route,
            hydrateMs,
            html: `<html><body><${wrapper} class="${wrapperClass}"><h1>${label}</h1><a href="/d/a.pdf" aria-label="${documentLabel}">${documentLabel}</a><a href="/d/b.pdf" aria-label="${documentLabel}">${documentLabel}</a></${wrapper}></body></html>`,
          },
        ],
      };
      const simulation = createSimulation(portal);
      active = simulation;
      simulation.install();
      try {
        const result = await discoverSupplierInTab(simulation.entryTabId, origin, { mode: "fast" });
        expect(result.candidates.candidates[0]).toMatchObject({
          adapter: { id: "dom-links" },
          candidateCount: 2,
        });
        expect(simulation.trace.probes.map((probe) => new URL(probe.url).pathname)).toContain(route);
        expect(simulation.trace.elapsedMs).toBeLessThanOrEqual(10_000);
      } finally {
        simulation.restore();
        active = undefined;
      }
    });
  }

  it("keeps look-alike destructive SPA destinations out even when they were observed", () => {
    const origin = "https://unsafe-navigation.example";
    expect(planExplorationTargets({
      origin,
      links: [{ url: `${origin}/surface/delete-account`, hintSource: "semantic_navigation" }],
      visited: new Set(),
      nextDepth: 1,
    })).toEqual([]);
  });

  for (const [lane, evidence] of [
    ["observed request", { calls: [{ url: "https://lane.example/api/billing-surface", body: JSON.stringify({ ready: true }) }] }],
    ["ResourceTiming", { resourceRoutes: ["/receipts-archive"] }],
    ["structured data", { structuredRoutes: ["/surface/r7"] }],
  ] as Array<[string, Partial<Portal["routes"][number]>]>) {
    it(`finds an invoice surface exposed only by ${lane} route evidence`, async () => {
      const target = lane === "observed request"
        ? "/api/billing-surface"
        : lane === "ResourceTiming" ? "/receipts-archive" : "/surface/r7";
      const portal: Portal = {
        name: `${lane} route lane`,
        origin: "https://lane.example",
        entryPath: "/home",
        routes: [
          {
            path: "/home",
            hydrateMs: 100,
            html: "<html><body>Home</body></html>",
            ...evidence,
          },
          {
            path: target,
            hydrateMs: 100,
            html: '<html><body><h1>Invoices</h1><a href="/documents/july.pdf">Download invoice</a></body></html>',
          },
        ],
      };
      const simulation = createSimulation(portal);
      active = simulation;
      simulation.install();
      try {
        const result = await discoverSupplierInTab(simulation.entryTabId, portal.origin, { mode: "fast" });
        expect(result.candidates.candidates[0].adapter.id).toBe("dom-links");
        expect(simulation.trace.probes.map((probe) => new URL(probe.url).pathname)).toContain(target);
      } finally {
        simulation.restore();
        active = undefined;
      }
    });
  }
});
