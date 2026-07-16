# Plan 007: Deliver approved fingerprints to Svala securely

> **Executor instructions**: This is a cross-repository plan. Use separate clean
> worktrees and PRs for Ratatosk and Svala. Land Svala intake first behind a
> disabled feature flag, then Ratatosk transport, then enable only after contract
> tests pass. Never place token values or real fingerprints in Git.
>
> **Ratatosk drift check**: `git diff --stat 0b90a93..HEAD -- studio src/core/recorder docs test/studio`
>
> **Svala drift check**: from `/Users/philiperiksson/svala/src`, run
> `git diff --stat 26bfebb..origin/main -- svala-app/app/api svala-app/app/workbench svala-app/lib/features/dev svala-app/lib/db/schema.ts svala-app/tests`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 001 and 002
- **Category**: security, integration, direction
- **Planned at**: Ratatosk `0b90a93`; Svala `26bfebb`; 2026-07-16

## Why this matters

The strict submission, consent envelope, and retryable Studio outbox exist, but
delivery always returns `not_configured`. Manual JSON download/import is the main
acquisition bottleneck. This plan adds an explicit, scoped channel while keeping
Svala attribution server-verifiable and retaining local export/recovery.

## Fixed architecture

1. Endpoint: `POST https://svala.igdrasil.se/api/dev/ratatosk/fingerprints`.
2. Authentication: a revocable, upload-only Ratatosk intake token issued from an
   authenticated Svala developer pairing flow; never reuse Clerk cookies, general
   Svala sessions, Igdrasil Collector tokens, or supplier credentials.
3. Token storage: only a strong hash plus prefix/metadata in Svala; token value in
   Studio extension-local storage, removable through Disconnect.
4. Idempotency: `fingerprintId` plus `Idempotency-Key`; same content returns the
   original receipt, different content for the same key returns HTTP 409.
5. PostgreSQL commits the validated submission and receipt before HTTP success.
6. Temporal is not on the synchronous intake path. Later workflows consume DB
   identifiers through the established outbox boundary.

## Current state

- Ratatosk `studio/src/platform/fingerprint-transport.ts` has a stable interface
  but `configured: false` and no request.
- Ratatosk outbox retains at most 20 approved submissions for 30 days.
- Svala `lib/features/dev/ratatosk-fingerprint.ts` independently validates the
  approved envelope and converts manual imports to Markdown.
- Svala developer routes use `requireDeveloperAccess`; current manual import is
  client-side in `DeveloperWorkspace.tsx`.

## Commands

| Repo | Command | Expected |
| --- | --- | --- |
| Ratatosk | `npm run typecheck && npm test && npm run build` | exit 0 |
| Ratatosk | `npm audit --audit-level=high` | zero high/critical |
| Svala | `npm run typecheck && npm test` | exit 0 on Node 24/test DB |
| Svala | `npm run db:verify-migration && npm run security:audit` | exit 0 |

## Scope

**Ratatosk in scope**: Studio manifest exact Svala host, pairing UI/storage,
transport/outbox delivery states, receipt UI, retry tests, docs.

**Svala in scope**: intake-token migration/repository/service, authenticated
pairing routes, bearer intake route, strict parser reuse, receipt storage,
developer UI to create/revoke tokens, audit events, tests.

**Out of scope**: raw captures, fixtures, agent reports, invoice values, automatic
recipe creation, supplier portal credentials, Collector changes, Temporal
workflow implementation, and public unauthenticated submission.

## Steps

### 1. Freeze a shared contract fixture

Create synthetic valid/invalid submission fixtures with no real supplier data.
Both repos must parse the same fixture and reject unknown fields, size overflow,
consent mismatch, unsafe origins/paths, credential-like content, and unsupported
schema versions.

**Verify**: contract tests pass independently in both repos.

### 2. Add Svala pairing and token persistence

Add a migration with token ID, strong token hash, prefix, actor, optional company
scope, created/last-used/expires/revoked timestamps, and rate-limit counters or
audit linkage. The authenticated developer UI creates and shows the token once;
revocation is immediate. Never log or return the hash.

**Verify**: tests cover create-once display, hash-only persistence, expiry,
revocation, wrong scope, and access denial.

### 3. Add the idempotent intake transaction

Authenticate bearer token, cap bytes before JSON parsing, call the existing strict
submission parser, canonicalize/hash content, and atomically insert submission,
consent provenance, uploader attribution, and receipt. Return a bounded receipt
with ID, fingerprint ID, accepted time, and status only.

**Verify**: identical replay returns the same receipt; changed content with the
same idempotency key returns 409; malformed/unauthorized/rate-limited requests
leave no row.

### 4. Implement Studio pairing and transport

Add only the exact Svala host permission. Pair through an explicit settings flow,
store the scoped token locally, attach it only to the exact canonical host, and
send the already-approved envelope. On success retain or delete local copies
according to an explicit user setting; default to retaining until receipt is
shown. Preserve manual JSON export.

**Verify**: transport security tests assert no request to alternate scheme, port,
subdomain, redirect host, or arbitrary configured endpoint.

### 5. Implement retry and receipt states

Model `pending`, `delivering`, `delivered`, `retryable`, and `rejected`. Retry only
network/5xx/429 outcomes with capped exponential backoff; do not retry 4xx except
after re-pair/review. Prevent duplicate concurrent sends.

**Verify**: restart and fake-clock tests prove delivery resumes once and receipt
identity is stable.

### 6. Audit and stage rollout

Add structured security/audit events without payloads. Deploy Svala disabled,
exercise synthetic contract tests, release Studio disabled-by-default, then enable
for named internal developers.

**Verify**: a synthetic end-to-end receipt appears in Svala and no submission
content occurs in logs, Temporal history, or public artifacts.

## Done criteria

- [ ] Only approved v1 envelopes can be delivered.
- [ ] Svala can attribute, revoke, rate-limit, dedupe, and audit every upload.
- [ ] Studio displays a durable receipt and retains manual export.
- [ ] Tokens cannot follow redirects or configuration to another host.
- [ ] Cross-repo fixtures and full gates pass.

## STOP conditions

- The endpoint would need Clerk cookies or a general-purpose user token.
- Redirect handling could send the token or payload to another origin.
- PostgreSQL cannot atomically commit submission and receipt.
- Any design requires supplier credentials, invoice values, or raw capture data.

## Maintenance notes

Version endpoint and schema independently. Support v1 until all released Studio
versions using it are outside the retention/support window.

