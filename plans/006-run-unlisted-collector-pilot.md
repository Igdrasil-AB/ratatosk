# Plan 006: Run a controlled unlisted Collector pilot

> **Executor instructions**: This plan includes owner-controlled external actions.
> Prepare evidence and artifacts, but do not create or submit a Chrome Web Store
> item, invite users, or distribute credentials without explicit operator approval.
>
> **Drift check**: `git diff --stat 0b90a93..HEAD -- package.json README.md PRIVACY.md SECURITY.md store collector/manifest.config.ts src/vendors .github/workflows`

## Status

- **Priority**: P1
- **Effort**: M plus store-review elapsed time
- **Risk**: MED
- **Depends on**: Plans 001, 003, 004, 005
- **Category**: direction, operations
- **Planned at**: Ratatosk `0b90a93`, 2026-07-16

## Why this matters

Ratatosk has packaging, privacy copy, store assets, and reviewer instructions,
but has not yet produced a controlled usage evidence loop. A named unlisted pilot
tests onboarding, optional permissions, session expiry, scheduling, deduplication,
and support processes before a public claim scales the blast radius.

## Current state

- `store/submission-process.md` describes an unlisted-first sequence.
- `store/release-checklist.md` contains manual Chrome and Igdrasil gates.
- `store/listing.md:131-169` still has owner-controlled checklist items.
- `README.md:153-156` calls Anthropic, ChatGPT, and Railway pilot recipes requiring
  current live verification.

## Commands

| Purpose | Command | Expected |
| --- | --- | --- |
| Clean install | `npm ci` | lockfile unchanged |
| Release build | `npm run release:collector` | ZIP + checksum |
| Verify checksum | `shasum -a 256 -c artifacts/ratatosk-collector-v*.zip.sha256` | `OK` |
| Archive audit | `unzip -l artifacts/ratatosk-collector-v*.zip` | Collector-only contents |
| Security | `npm audit --audit-level=high` | zero high/critical |

## Scope

**In scope**: a versioned pilot manifest/template, release evidence, reviewer
instructions, fresh-profile test records, support/rollback runbook, and explicit
operator checkpoints.

**Out of scope**: public listing, paid acquisition, passive analytics, real
customer documents in evidence, automatic supplier promotion, and Studio
distribution through the Web Store.

## Steps

### 1. Freeze the pilot cohort and claims

Create a non-sensitive pilot manifest containing Collector version/checksum,
named supplier IDs, regions, cohort size target (start 5–10), support owner,
start/end window, rollback version, and exit thresholds. Do not list participant
identities publicly.

**Verify**: every supplier claim has a Plan 004 lifecycle record and the release
freshness gate passes.

### 2. Produce the exact submission artifact

Build from a clean reviewed commit on Node 22/24-compatible tooling. Verify ZIP
root manifest, exact permissions, no Studio/debugger code, no source maps, and no
environment or fixture files. Record checksum and commit in the private operator
evidence, not secrets in Git.

**Verify**: packaging and archive commands above pass.

### 3. Complete fresh-profile live tests

For each claimed supplier, use an authorized dedicated account with synthetic
invoices. Test connect/deny/grant, one successful collection, duplicate rerun,
sign-out/reconnect, destination failure, disconnect/revoke, schedule off/restart,
and both local and dedicated Igdrasil destinations where applicable.

**Verify**: each case has pass/fail, Chrome version, Collector checksum, timestamp,
and sanitized evidence reference. Any failure moves the lifecycle state to
degraded or removes the claim before submission.

### 4. Complete owner-controlled store prerequisites

Confirm legal/support inboxes, developer registration, identity/trader status,
verified publisher domain, privacy URL, private reviewer test account, and listing
assets. Pause for operator approval before dashboard submission.

**Verify**: `store/release-checklist.md` and `store/submission-process.md` have an
external evidence record for every checkbox; credentials remain only in the
private dashboard.

### 5. Run and evaluate the unlisted cohort

Invite named testers only after approval. Record stable error codes from Plan 005,
not raw logs. Exit requires no unresolved high-severity issue, all claims current,
support/deletion flows exercised, and rollback retained.

**Verify**: produce a private pilot decision record: continue unlisted, remediate,
or prepare a separate public-launch plan.

## Done criteria

- [ ] Exact artifact, checksum, commit, and rollback artifact are recorded.
- [ ] Every named supplier has current synthetic live-test evidence.
- [ ] Store review and pilot use only non-sensitive evidence.
- [ ] Pilot exit decision is explicit; public launch is not automatic.

## STOP conditions

- Legal, support, publisher identity, or reviewer-account ownership is incomplete.
- Any claimed supplier lacks an authorized synthetic live test.
- The emitted manifest differs from privacy/store disclosures.
- Chrome requests broader permissions than the reviewed manifest.

## Maintenance notes

Re-run the live matrix before every release. Endpoint compatibility is temporal,
not a permanent property of a fixture test.

