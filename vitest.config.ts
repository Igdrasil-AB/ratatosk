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
  },
});
