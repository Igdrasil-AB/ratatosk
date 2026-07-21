import { execFileSync } from "node:child_process";

/**
 * A release artifact may only claim the checked-out commit when every tracked
 * and untracked source file was part of that commit. Generated `dist/` and
 * `artifacts/` are ignored, so a normal build/package cycle remains valid.
 */
export function assertCleanReleaseSource(run = execFileSync): void {
  const status = run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" }).trim();
  if (status) {
    throw new Error("release source is dirty; commit or remove all tracked and untracked changes before packaging");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) assertCleanReleaseSource();
