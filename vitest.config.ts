import { defineConfig } from "vitest/config";

/**
 * Tests run in plain Node against the platform-free core — no browser, no crx
 * plugin. This is only possible because `core/`, `vendors/`, and `ingest/` never
 * import `chrome.*`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    /**
     * The sync schedule is local-time arithmetic, so its tests are only
     * meaningful in a zone that actually observes daylight saving. CI runners
     * are UTC, where a "survives the clock change" assertion passes without
     * exercising anything. Pinning a DST-observing zone makes those tests real
     * and makes every other date test identical on every machine.
     */
    env: { TZ: "Europe/Stockholm" },
  },
});
