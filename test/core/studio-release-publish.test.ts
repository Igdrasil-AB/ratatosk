import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Studio release publication", () => {
  it("keeps the checksum portable in a flat release-download directory", () => {
    const fixture = releaseFixture();
    const verified = spawnSync("shasum", ["-a", "256", "-c", "ratatosk-studio-v0.8.29.zip.sha256"], {
      cwd: fixture.remote,
      encoding: "utf8",
    });

    expect(verified.status).toBe(0);
  });

  it("creates a missing release and verifies an existing release without replacing assets", () => {
    const fixture = releaseFixture();

    const created = runPublisher(fixture, false);
    expect(created.status).toBe(0);
    expect(readFileSync(fixture.log, "utf8")).toContain("release create v0.8.29");

    writeFileSync(fixture.log, "");
    const rerun = runPublisher(fixture, true);
    expect(rerun.status).toBe(0);
    expect(readFileSync(fixture.log, "utf8")).toContain("release download v0.8.29");
    expect(readFileSync(fixture.log, "utf8")).not.toContain("release create");
  });

  it("fails closed when an existing release asset differs", () => {
    const fixture = releaseFixture();
    writeFileSync(join(fixture.remote, "ratatosk-studio-v0.8.29.zip"), "different artifact");
    expect(runPublisher(fixture, true).status).not.toBe(0);
  });

  it("blocks an unchecked extra ZIP or a missing checksum before calling GitHub", () => {
    const extra = releaseFixture();
    writeFileSync(join(extra.artifacts, "ratatosk-studio-v0.8.30.zip"), "unchecked");
    expect(runPublisher(extra, false).status).not.toBe(0);
    expect(readFileSync(extra.log, "utf8")).toBe("");

    const missing = releaseFixture();
    unlinkSync(join(missing.artifacts, "ratatosk-studio-v0.8.29.zip.sha256"));
    expect(runPublisher(missing, false).status).not.toBe(0);
    expect(readFileSync(missing.log, "utf8")).toBe("");
  });
});

function releaseFixture() {
  const root = mkdtempSync(join(tmpdir(), "ratatosk-studio-release-"));
  temporaryDirectories.push(root);
  const artifacts = join(root, "artifacts");
  const remote = join(root, "remote");
  mkdirSync(artifacts);
  mkdirSync(remote);
  const archive = join(artifacts, "ratatosk-studio-v0.8.29.zip");
  writeFileSync(archive, "reviewed artifact");
  const digest = createHash("sha256").update("reviewed artifact").digest("hex");
  const checksum = `${digest}  ${basename(archive)}\n`;
  writeFileSync(`${archive}.sha256`, checksum);
  writeFileSync(join(remote, "ratatosk-studio-v0.8.29.zip"), "reviewed artifact");
  writeFileSync(join(remote, "ratatosk-studio-v0.8.29.zip.sha256"), checksum);
  const log = join(root, "gh.log");
  writeFileSync(log, "");
  const gh = join(root, "mock-gh.sh");
  writeFileSync(gh, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$MOCK_GH_LOG"
if [[ "$1 $2" == "release view" ]]; then
  [[ "$MOCK_RELEASE_EXISTS" == "true" ]]
elif [[ "$1 $2" == "release download" ]]; then
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--dir" ]]; then shift; target="$1"; fi
    shift
  done
  cp "$MOCK_REMOTE_DIR"/* "$target"/
fi
`);
  chmodSync(gh, 0o755);
  return { artifacts, remote, log, gh };
}

function runPublisher(fixture: ReturnType<typeof releaseFixture>, releaseExists: boolean) {
  return spawnSync("bash", ["scripts/publish-studio-release.sh"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REF_NAME: "v0.8.29",
      STUDIO_ARTIFACT_DIR: fixture.artifacts,
      GH_CLI: fixture.gh,
      MOCK_GH_LOG: fixture.log,
      MOCK_REMOTE_DIR: fixture.remote,
      MOCK_RELEASE_EXISTS: String(releaseExists),
    },
  });
}
