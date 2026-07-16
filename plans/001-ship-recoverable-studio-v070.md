# Plan 001: Ship a recoverable Ratatosk Studio v0.7.0

> **Executor instructions**: Execute in a clean Ratatosk worktree. Run every
> verification gate. Stop on any STOP condition; do not improvise release or
> security behavior. Update `plans/README.md` after review.
>
> **Drift check**: `git diff --stat 0b90a93..HEAD -- package.json package-lock.json README.md docs studio scripts test/studio .github/workflows`

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug, dx, release
- **Planned at**: Ratatosk `0b90a93`, 2026-07-16

## Why this matters

The downloadable v0.6.8 Studio predates the supplier-fingerprint outbox now on
`main`, so the documented workflow is not available to download. The outbox also
stores complete approved submissions for 30 days but exposes only a count after
the approval popup closes. This plan makes the feature actually distributable
and makes the outbox a real recovery queue.

## Current state

- `README.md:41-42` points at `ratatosk-studio-v0.6.8.zip`.
- `studio/src/platform/fingerprint-outbox.ts:12-16` stores complete submissions.
- `studio/src/platform/messaging.ts:29-33` exposes only count and oldest time.
- `studio/src/ui/popup/popup.ts:120-125` creates a download button only from the
  in-memory approval response; a reopened popup can only clear the outbox.
- `package.json` has `package:studio` but no complete Studio release command.

## Commands

| Purpose | Command | Expected |
| --- | --- | --- |
| Focused tests | `npm test -- --run test/studio/fingerprint-outbox.test.ts` | exit 0 |
| Full gate | `npm run ci && npm run build` | exit 0 |
| Security | `npm audit --audit-level=high` | zero high/critical advisories |
| Package | `npm run release:studio` | versioned ZIP and SHA-256 under `artifacts/` |

## Scope

**In scope**: `package.json`, `package-lock.json`, `README.md`,
`docs/supplier-fingerprints.md`, `studio/src/platform/fingerprint-outbox.ts`,
`studio/src/platform/messaging.ts`, `studio/src/platform/service-worker.ts`,
`studio/src/ui/popup/popup.ts`, focused tests, packaging scripts, and a tag-driven
release workflow if one does not already exist.

**Out of scope**: Collector runtime behavior, automatic Svala delivery, endpoint
selection, Chrome Web Store submission, and any schema change to the fingerprint.

## Git workflow

- Branch: `advisor/001-recoverable-studio-release`
- Use small commits matching the repository's imperative style.
- Do not tag, publish, or push a release without explicit operator authorization.

## Steps

### 1. Add validated outbox list/export operations

Expose immutable summaries keyed by `fingerprintId`, plus an explicit get/export
operation that returns one already-validated submission. Keep reads serialized
through `writeChain`, apply expiry cleanup before returning, and never expose raw
session capture data.

**Verify**: add tests for reopen, expiry, dedupe, missing ID, corrupted storage,
and concurrent enqueue/export; focused tests pass.

### 2. Render retained items in Studio

Extend the trusted extension message contract with list/get operations. On the
start screen, show each retained supplier, capture time, expiry, and a Download
button. Preserve the separate Clear-all action and add delete-one only if it is
covered by tests. Do not download automatically.

**Verify**: typecheck passes and popup tests assert that reopening can export a
previously approved item.

### 3. Add an independent Studio release command

Add `release:studio` with the same principles as `release:collector`: run CI,
security audit, Studio build, Studio-only packaging, checksum creation, and
artifact-boundary checks. Ensure the Studio archive contains its own manifest
at ZIP root and never a Collector build.

**Verify**: inspect `unzip -l artifacts/ratatosk-studio-v0.7.0.zip`; expected no
Collector entry points, source maps, environment files, or repository fixtures.

### 4. Version and document v0.7.0

Bump package and lockfile together. Update download/checksum links and wording
only after the exact artifact exists. Add a release assertion that the built
Studio contains the fingerprint outbox message types, preventing documentation
from moving ahead of the binary again.

**Verify**: `rg 'v0\.6\.8|0\.6\.8' README.md docs package.json package-lock.json`
returns no stale current-download/version claims; historical changelog text may
remain.

## Test plan

- Extend `test/studio/fingerprint-outbox.test.ts` using its existing Chrome
  storage mock.
- Add package inspection tests alongside existing packaging tests/scripts.
- Run all 109+ existing tests; no existing privacy assertion may weaken.

## Done criteria

- [ ] A reopened popup can list and download every unexpired approved submission.
- [ ] Expired/corrupt submissions are neither listed nor exported.
- [ ] `npm run release:studio` produces a deterministic ZIP and matching checksum.
- [ ] README points at the reviewed v0.7.0 artifact, not a source archive.
- [ ] CI, build, audit, and ZIP boundary checks pass.

## STOP conditions

- The export path requires broadening Studio host permissions.
- A retained item cannot be revalidated with the existing strict parser.
- Packaging would combine Collector and Studio or publish automatically without
  operator approval.

## Maintenance notes

Plan 007 will consume the same outbox. Preserve stable IDs and explicit local
export even after network delivery exists; it is the user's recovery path.

