import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IGDRASIL_INGEST_PATH } from "../../src/ingest/igdrasil-sink";

describe("Igdrasil endpoint documentation", () => {
  it("uses the canonical externally requested ingestion path everywhere", () => {
    for (const path of ["docs/architecture.md", "docs/igdrasil-connect.md"]) {
      const document = readFileSync(path, "utf8");
      expect(document, path).toContain(`\`${IGDRASIL_INGEST_PATH}\``);
      expect(document, path).not.toMatch(/`\/documents\/ingest`/);
    }
  });
});
