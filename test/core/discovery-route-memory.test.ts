import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  clearRememberedRoutes,
  forgetSupplierRoute,
  getRememberedRoute,
  listRememberedRoutes,
  recordRouteMiss,
  rememberSupplierRoute,
} from "../../collector/src/platform/discovery-route-memory";
import { createDiscoveredSupplierProfile } from "../../src/core/discovery";
import { removeDiscoveredSupplier, upsertDiscoveredSupplier } from "../../collector/src/platform/discovered-suppliers";
import { createInitialExplorationTargets } from "../../collector/src/platform/discovery";
import type { VendorRecipe } from "../../src/core/types";

/**
 * Remembering where a supplier keeps its invoices is a shortcut, never an
 * authority. These tests hold that line: the route is re-probed like any other,
 * it is dropped once it stops being confirmed, and nothing that fails to
 * validate on read can steer a search.
 */

const origin = "https://vendor.example";

describe("discovery route memory", () => {
  const values: Record<string, unknown> = {};

  beforeEach(() => {
    for (const key of Object.keys(values)) delete values[key];
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: values[key] })),
          set: vi.fn(async (next: Record<string, unknown>) => { Object.assign(values, next); }),
          remove: vi.fn(async (key: string) => { delete values[key]; }),
        },
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("returns the page a verified collection came from", async () => {
    await rememberSupplierRoute(origin, `${origin}/settings/billing`);

    await expect(getRememberedRoute(origin)).resolves.toMatchObject({
      entryUrl: `${origin}/settings/billing`,
      misses: 0,
    });
  });

  it("knows nothing about a supplier it has not collected from", async () => {
    await expect(getRememberedRoute("https://other.example")).resolves.toBeUndefined();
  });

  it("keeps one route per origin, the most recent", async () => {
    await rememberSupplierRoute(origin, `${origin}/billing`);
    await rememberSupplierRoute(origin, `${origin}/account/invoices`);

    expect(Object.keys(await listRememberedRoutes())).toEqual([origin]);
    expect((await getRememberedRoute(origin))?.entryUrl).toBe(`${origin}/account/invoices`);
  });

  it("treats a different origin as a different supplier", async () => {
    await rememberSupplierRoute(origin, `${origin}/billing`);
    await rememberSupplierRoute("https://app.vendor.example", "https://app.vendor.example/billing");

    expect(Object.keys(await listRememberedRoutes())).toHaveLength(2);
  });

  it("refuses a route it could not have discovered itself", async () => {
    for (const [supplierOrigin, entryUrl] of [
      [origin, "http://vendor.example/billing"],
      [origin, "https://elsewhere.example/billing"],
      ["http://vendor.example", "http://vendor.example/billing"],
      [origin, "https://user:pass@vendor.example/billing"],
    ]) {
      await rememberSupplierRoute(supplierOrigin, entryUrl);
    }

    expect(await listRememberedRoutes()).toEqual({});
  });

  it("stores the route stripped of anything a query could carry", async () => {
    await rememberSupplierRoute(origin, `${origin}/billing?token=abc123&page=2`);

    expect((await getRememberedRoute(origin))?.entryUrl).toBe(`${origin}/billing`);
  });

  it("re-validates on read, so tampered storage cannot steer a search", async () => {
    values["discoveryRouteMemory.v1"] = {
      [origin]: { entryUrl: "https://attacker.example/billing", confirmedAt: Date.now(), misses: 0 },
      "https://good.example": { entryUrl: "https://good.example/billing", confirmedAt: Date.now(), misses: 0 },
    };

    const routes = await listRememberedRoutes();

    expect(routes[origin]).toBeUndefined();
    // One bad record must not deny the shortcut to every other supplier.
    expect(routes["https://good.example"]?.entryUrl).toBe("https://good.example/billing");
  });

  it("drops a record whose shape no longer holds", async () => {
    values["discoveryRouteMemory.v1"] = {
      [origin]: { entryUrl: `${origin}/billing`, confirmedAt: 0, misses: 0 },
      "https://a.example": { entryUrl: "https://a.example/billing", confirmedAt: Date.now(), misses: -1 },
      "https://b.example": { entryUrl: "https://b.example/billing", confirmedAt: Date.now() },
      "https://c.example": "not an object",
    };

    expect(await listRememberedRoutes()).toEqual({});
  });

  it("forgets a route that three searches failed to confirm", async () => {
    await rememberSupplierRoute(origin, `${origin}/billing`);

    await recordRouteMiss(origin);
    expect((await getRememberedRoute(origin))?.misses).toBe(1);
    await recordRouteMiss(origin);
    expect((await getRememberedRoute(origin))?.misses).toBe(2);
    // A supplier that moved its billing page stops costing a probe.
    await recordRouteMiss(origin);
    expect(await getRememberedRoute(origin)).toBeUndefined();
  });

  it("clears the miss count when a route is confirmed again", async () => {
    await rememberSupplierRoute(origin, `${origin}/billing`);
    await recordRouteMiss(origin);
    await recordRouteMiss(origin);

    // A signed-out session fails every route; being right again must not leave
    // the route one failure from deletion forever.
    await rememberSupplierRoute(origin, `${origin}/billing`);

    expect((await getRememberedRoute(origin))?.misses).toBe(0);
  });

  it("counts a miss for a supplier it never knew without inventing one", async () => {
    await recordRouteMiss("https://unknown.example");

    expect(await listRememberedRoutes()).toEqual({});
  });

  it("forgets on request, one supplier or all of them", async () => {
    await rememberSupplierRoute(origin, `${origin}/billing`);
    await rememberSupplierRoute("https://other.example", "https://other.example/billing");

    await forgetSupplierRoute(origin);
    expect(Object.keys(await listRememberedRoutes())).toEqual(["https://other.example"]);

    await clearRememberedRoutes();
    expect(await listRememberedRoutes()).toEqual({});
  });

  it("survives disconnecting the supplier", async () => {
    // Reconnecting is when the shortcut is worth the most, so removing the
    // discovered supplier must not take the route with it.
    const recipe: VendorRecipe = {
      id: "candidate",
      name: "Example",
      homepage: origin,
      hosts: [`${origin}/*`],
      fetchContext: "page",
      auth: { check: { request: { url: `${origin}/api/me` }, expect: { statusIn: [200] } }, loginUrl: origin },
      invoices: {
        strategy: "network",
        list: { request: { url: `${origin}/api/invoices` }, items: "invoices", map: { id: "id", issuedAt: "issued_at", documentUrl: "pdf_url" } },
        document: { contentType: "application/pdf" },
      },
    };
    const profile = createDiscoveredSupplierProfile({
      primaryOrigin: origin,
      entryUrl: `${origin}/settings/billing`,
      displayName: "Example",
      nameSource: "page",
      nameConfidence: "medium",
      adapterId: "network-json",
      candidateCount: 2,
      recipe,
    });
    await upsertDiscoveredSupplier(profile);
    await rememberSupplierRoute(origin, `${origin}/settings/billing`);

    await removeDiscoveredSupplier(profile.id);

    expect((await getRememberedRoute(origin))?.entryUrl).toBe(`${origin}/settings/billing`);
  });

  it("discloses what it keeps, that it outlives disconnect, and how to remove it", () => {
    const privacy = readFileSync("PRIVACY.md", "utf8");
    const popup = readFileSync("collector/src/ui/popup/popup.ts", "utf8");

    // Retaining which suppliers a person uses, past the point they disconnected
    // them, is exactly the kind of thing that has to be stated and removable.
    expect(privacy).toMatch(/one exact-origin page address\s+per supplier/i);
    expect(privacy).toMatch(/kept when a supplier is disconnected/i);
    expect(privacy).toMatch(/never uploaded or shared/i);
    expect(privacy).toMatch(/Settings → Remembered billing pages/);
    expect(popup).toContain('data-action="forget-routes"');
    // The panel asks the worker rather than importing the store, so validation
    // lives in one place and the side panel does not bundle it.
    expect(popup).toContain('send({ type: "clearRouteMemory" })');
    expect(popup).not.toContain("discovery-route-memory");
  });

  it("is never cleared by disconnecting in the service worker", () => {
    const worker = readFileSync("collector/src/platform/service-worker.ts", "utf8");
    const disconnect = worker.slice(worker.indexOf('case "disconnect"'), worker.indexOf('case "forgetVendorHistory"'));

    expect(disconnect).toContain("removeDiscoveredSupplier");
    expect(disconnect).not.toContain("forgetSupplierRoute");
    expect(disconnect).not.toContain("clearRememberedRoutes");
  });

  it("holds a bounded number of suppliers, keeping the most recent", async () => {
    const stored: Record<string, unknown> = {};
    for (let index = 0; index < 120; index += 1) {
      stored[`https://s${index}.example`] = {
        entryUrl: `https://s${index}.example/billing`,
        confirmedAt: 1_000 + index,
        misses: 0,
      };
    }
    values["discoveryRouteMemory.v1"] = stored;

    await rememberSupplierRoute("https://newest.example", "https://newest.example/billing");
    const routes = await listRememberedRoutes();

    expect(Object.keys(routes).length).toBeLessThanOrEqual(100);
    expect(routes["https://newest.example"]).toBeDefined();
  });
});

describe("remembered route in the exploration queue", () => {
  const entryUrl = `${origin}/dashboard`;

  it("is probed after the entry page, never in place of it", () => {
    const targets = createInitialExplorationTargets(entryUrl, true, `${origin}/settings/billing`);

    expect(targets.map((target) => target.source)).toEqual(["entry", "entry_replay", "remembered"]);
    // The wave gate admits only entry sources, so the remembered route lands in
    // the first explored wave rather than beside the user's own tab.
    expect(targets[2].score).toBeLessThan(targets[0].score);
    expect(targets[2].url).toBe(`${origin}/settings/billing`);
  });

  it("outranks every curated guess and observed link", () => {
    const [, , remembered] = createInitialExplorationTargets(entryUrl, true, `${origin}/settings/billing`);

    // Curated billing paths score at most 68 and observed links at most ~200.
    expect(remembered.score).toBeGreaterThan(1_000);
    expect(remembered.family).toBe("common_billing_route");
  });

  it("is not queued twice when it is already the page in front of the user", () => {
    const targets = createInitialExplorationTargets(entryUrl, true, entryUrl);

    expect(targets.map((target) => target.source)).toEqual(["entry", "entry_replay"]);
  });

  it("changes nothing for a supplier with no remembered route", () => {
    expect(createInitialExplorationTargets(entryUrl, true)).toHaveLength(2);
    expect(createInitialExplorationTargets(entryUrl, false)).toHaveLength(1);
  });
});
