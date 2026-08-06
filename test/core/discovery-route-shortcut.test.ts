import { afterEach, describe, expect, it } from "vitest";
import { discoverSupplierInTab } from "../../collector/src/platform/discovery";
import { rememberSupplierRoute } from "../../collector/src/platform/discovery-route-memory";
import { PORTAL_CORPUS } from "../support/portal-corpus";
import { createSimulation, type Portal } from "../support/portal-simulator";

/**
 * What remembering a route is actually worth.
 *
 * Every portal is discovered twice against the real engine and a virtual clock:
 * once as a first-time search, then again with the route the first search
 * proved. The second run is the one a person gets after reconnecting a supplier
 * or after a stored recipe breaks, and it must be no slower — measurably
 * faster on the portals where the billing page has to be hunted for.
 *
 * The shortcut is seeded through the same public function the service worker
 * calls, so a change that stops recording routes fails here rather than
 * quietly reverting the speed-up.
 */

/** Portals whose entry page is not already the billing page. These are the
 * searches that spend their time hunting, and the ones the shortcut is for. */
const HUNTED = new Set([
  "rest portal with a query-addressed list",
  "billing behind a settings bridge",
  "tenant-prefixed billing route",
  "opaque route named only by its label",
]);

let active: { restore(): void } | undefined;

afterEach(() => {
  active?.restore();
  active = undefined;
});

async function discover(portal: Portal, seedRoute?: string) {
  const simulation = createSimulation(portal);
  active = simulation;
  simulation.install();
  try {
    if (seedRoute) await rememberSupplierRoute(portal.origin, seedRoute);
    const result = await discoverSupplierInTab(simulation.entryTabId, portal.origin, { mode: "fast" });
    return {
      entryUrl: result.candidates.candidates[0].entryUrl,
      adapter: result.candidates.candidates[0].adapter.id,
      pages: result.diagnostic.pages.attempted,
      elapsedMs: simulation.trace.elapsedMs,
      probedRemembered: result.diagnostic.attempts.some((attempt) => attempt.source === "remembered"),
    };
  } finally {
    simulation.restore();
    active = undefined;
  }
}

describe("a remembered route shortens the next search", () => {
  for (const entry of PORTAL_CORPUS) {
    it(`finds the same source faster on a ${entry.portal.name}`, async () => {
      const first = await discover(entry.portal);
      const second = await discover(entry.portal, first.entryUrl);

      // The shortcut may not change what is found, only how long it took.
      expect(second.adapter).toBe(first.adapter);
      expect(second.entryUrl).toBe(first.entryUrl);
      expect(second.pages).toBeLessThanOrEqual(first.pages);
      expect(second.elapsedMs).toBeLessThanOrEqual(first.elapsedMs);

      if (HUNTED.has(entry.portal.name)) {
        expect(second.probedRemembered).toBe(true);
        expect(second.pages).toBeLessThan(first.pages);
      }
    }, 60_000);
  }

  it("reports the whole corpus and holds the interactive envelope", async () => {
    const rows: Array<{ name: string; before: number; after: number; pagesBefore: number; pagesAfter: number }> = [];
    for (const entry of PORTAL_CORPUS) {
      const first = await discover(entry.portal);
      const second = await discover(entry.portal, first.entryUrl);
      rows.push({
        name: entry.portal.name,
        before: first.elapsedMs,
        after: second.elapsedMs,
        pagesBefore: first.pages,
        pagesAfter: second.pages,
      });
    }

    const hunted = rows.filter((row) => HUNTED.has(row.name));
    const worstBefore = Math.max(...rows.map((row) => row.before));
    const worstAfter = Math.max(...rows.map((row) => row.after));

    console.info(
      "\nremembered-route shortcut\n" +
      rows.map((row) =>
        `${row.name.padEnd(46)} ${String(row.before).padStart(5)}ms -> ${String(row.after).padStart(5)}ms   ` +
        `${row.pagesBefore} -> ${row.pagesAfter} pages`).join("\n") + "\n",
    );

    // The slowest search is what a person actually waits for.
    expect(worstAfter).toBeLessThan(worstBefore);
    expect(worstAfter).toBeLessThanOrEqual(10_000);
    // Every hunted portal collapses to the entry wave plus the shortcut: the
    // cost of already being on the billing page.
    for (const row of hunted) {
      expect(row.pagesAfter).toBeLessThanOrEqual(3);
      expect(row.after).toBeLessThan(row.before / 1.5);
    }
  }, 180_000);
});
