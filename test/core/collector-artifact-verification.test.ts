import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectorArtifactIssues } from "../../scripts/verify-collector-artifact";

describe("Collector release artifact verification", () => {
  it("keeps the permanent submission runbook version-derived", () => {
    const runbook = readFileSync("store/submission-process.md", "utf8");
    expect(runbook).not.toMatch(/ratatosk-collector-v\d+\.\d+\.\d+\.zip/);
    expect(runbook).toContain("require('./package.json').version");
    expect(runbook).toContain("npm run verify:collector-artifact");
    expect(runbook).toContain('unzip -l "$COLLECTOR_ZIP"');
    const packager = readFileSync("scripts/package-extension.ts", "utf8");
    expect(packager).toContain("DOCUMENT_ACQUISITION_RUNTIME_MARKER !== acquisitionMarker");
  });

  it("verifies only the explicit version when stale releases coexist", () => {
    const directory = mkdtempSync(join(tmpdir(), "ratatosk-collector-artifact-"));
    writeArtifact(directory, "0.8.28", "stale release", false);
    writeArtifact(directory, "0.8.30", "reviewed release", true);

    expect(collectorArtifactIssues("0.8.30", directory)).toEqual([]);
  });

  it("fails closed when the exact checksum names another artifact", () => {
    const directory = mkdtempSync(join(tmpdir(), "ratatosk-collector-artifact-"));
    writeArtifact(directory, "0.8.30", "reviewed release", false);

    expect(collectorArtifactIssues("0.8.30", directory)).toEqual([
      expect.stringMatching(/must contain exactly one SHA-256 entry/),
    ]);
  });
});

function writeArtifact(directory: string, version: string, contents: string, correctName: boolean): void {
  const basename = `ratatosk-collector-v${version}.zip`;
  const archive = join(directory, basename);
  const digest = createHash("sha256").update(contents).digest("hex");
  writeFileSync(archive, contents);
  writeFileSync(`${archive}.sha256`, `${digest}  ${correctName ? basename : "another-release.zip"}\n`);
}
