import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareCollectorVersions, pilotWindowReadinessIssues, rollbackArtifactIssues } from "../../scripts/validate-pilot-manifest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("collector release version ordering", () => {
  it("orders SemVer prereleases rather than treating all prereleases as older", () => {
    expect(compareCollectorVersions("0.7.0-beta.2", "0.7.0-beta.10")).toBeLessThan(0);
    expect(compareCollectorVersions("0.7.0-beta.10", "0.7.0-beta.2")).toBeGreaterThan(0);
    expect(compareCollectorVersions("0.7.0-alpha", "0.7.0-beta")).toBeLessThan(0);
    expect(compareCollectorVersions("0.7.0-beta", "0.7.0")).toBeLessThan(0);
    expect(compareCollectorVersions("0.7.0", "0.7.0")).toBe(0);
  });

  it("requires an existing older rollback artifact with the recorded checksum", () => {
    const directory = mkdtempSync(join(tmpdir(), "ratatosk-rollback-"));
    temporaryDirectories.push(directory);
    const bytes = Buffer.from("reviewed collector artifact");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const rollback = { collectorVersion: "0.8.9", collectorSha256: checksum };

    expect(rollbackArtifactIssues(rollback, "0.8.10", directory)).toEqual([
      expect.stringContaining("missing rollback artifact"),
    ]);

    writeFileSync(join(directory, "ratatosk-collector-v0.8.9.zip"), bytes);
    expect(rollbackArtifactIssues({ ...rollback, collectorSha256: "f".repeat(64) }, "0.8.10", directory)).toContain(
      "rollback artifact checksum does not match manifest",
    );
    expect(rollbackArtifactIssues({ ...rollback, collectorVersion: "0.8.10" }, "0.8.10", directory)).toContain(
      "rollback version must be a previous known-good release",
    );
    expect(rollbackArtifactIssues({ ...rollback, collectorVersion: "0.8.11" }, "0.8.10", directory)).toContain(
      "rollback version must be a previous known-good release",
    );
    expect(rollbackArtifactIssues(rollback, "0.8.10", directory)).toEqual([]);
  });

  it("expires ready manifests without invalidating future or evaluated records", () => {
    const now = new Date("2026-08-18T00:00:00.000Z");
    const expiredWindow = { startsAt: "2026-08-01T00:00:00.000Z", endsAt: "2026-08-17T23:59:59.000Z" };
    expect(pilotWindowReadinessIssues({ status: "ready", window: expiredWindow }, now)).toEqual([
      expect.stringMatching(/window has expired/),
    ]);
    expect(pilotWindowReadinessIssues({ status: "evaluated", window: expiredWindow }, now)).toEqual([]);
    expect(pilotWindowReadinessIssues({
      status: "ready",
      window: { startsAt: "2026-08-20T00:00:00.000Z", endsAt: "2026-09-01T00:00:00.000Z" },
    }, now)).toEqual([]);
    expect(pilotWindowReadinessIssues({
      status: "ready",
      window: { startsAt: "2026-08-01T00:00:00.000Z", endsAt: now.toISOString() },
    }, now)).toEqual([expect.stringMatching(/window has expired/)]);
  });
});
