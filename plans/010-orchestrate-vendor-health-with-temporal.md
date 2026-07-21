# Plan 010: Orchestrate vendor health with Temporal TypeScript

> **Executor instructions**: Extend Svala's existing self-hosted Temporal
> TypeScript foundation. Do not create a second SDK setup, use Temporal Cloud,
> add Go, store fingerprint JSON in Workflow history, or put Temporal calls on
> synchronous read routes. Use a clean Svala worktree.
>
> **Svala drift check**: `git diff --stat 26bfebb..origin/main -- svala-app/lib/temporal svala-app/scripts/temporal-schedules.ts svala-app/tests/temporal svala-app/lib/db/schema.ts svala-app/lib/features/dev docs/architecture docs/runbooks`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: Plans 004, 005, and 008
- **Category**: reliability, orchestration, direction
- **Planned at**: Svala `26bfebb`, 2026-07-16

## Why this matters

Vendor compatibility decays over time and needs durable evaluation, reminders,
approved public-contribution handoffs, and escalation. Svala already has pinned Temporal TypeScript
SDK 1.20.3 packages, prebuilt production Workflow bundles, task-queue isolation,
PostgreSQL outbox dispatch, schedules, telemetry, time-skipping tests, and replay
fixtures. The correct next step is a new supplier-health domain on that platform.

## Current state and fixed decisions

- `docs/architecture/0001-self-hosted-temporal.md` requires self-hosted Temporal
  and TypeScript-only Svala integration.
- `lib/temporal/worker.ts` uses `NativeConnection`, production workflow bundles,
  graceful shutdown, and per-task-queue activity registration.
- `lib/temporal/commands.ts` commits PostgreSQL command + outbox in one transaction.
- `lib/temporal/retry-policies.ts` separates safe idempotent retries from ambiguous
  external effects.
- `tests/temporal/replay.test.ts` requires sanitized history fixtures for every
  production Workflow.
- PostgreSQL remains authoritative; Temporal inputs carry supplier IDs, lifecycle
  revision, command/correlation IDs, and bounded reason codes only.

Official Temporal guidance to retain:

- Worker processes register exact Workflow/Activity types per task queue and
  production TypeScript workers should use ahead-of-time Workflow bundles:
  https://docs.temporal.io/develop/typescript/workers/run-worker-process
- Temporal Schedules provide explicit overlap policies, pause, trigger, update,
  describe, and backfill operations:
  https://docs.temporal.io/develop/typescript/workflows/schedules
- Workflow changes require deterministic testing/replay and safe deployment:
  https://docs.temporal.io/develop/typescript/best-practices/testing-suite and
  https://docs.temporal.io/develop/safe-deployments

## Target behavior

```text
Temporal Schedule (daily, overlap SKIP)
  -> supplierHealthSweepWorkflow({ scheduleId, policyRevision })
     -> listDueSupplierIdsActivity()
     -> bounded child/batch evaluations
        -> evaluateSupplierHealthActivity({ supplierId, lifecycleRevision })
        -> persist transition + audit event (idempotent PostgreSQL transaction)
        -> create owner-reminder/public-GitHub-handoff command only when policy requires
```

The Workflow never logs into a supplier. “Health” means freshness and outcome of
authorized evidence: Ratatosk release metadata, fingerprint receipts, explicit
live-verification attestations, and recent operational error codes. Plan 009's
guided Svala missions are retired: this plan must not create mission records,
mission codes, mission eligibility, claimant state, or Svala mission commands.
When new external evidence is needed, the only contributor-facing follow-up is
the already-approved public GitHub contribution path; it grants no Svala access.

## Commands

Run from `svala-app/` with Node 24:

| Purpose | Command | Expected |
| --- | --- | --- |
| Build bundle | `npm run build:temporal` | `.temporal` bundle created |
| Unit gate | `npm run typecheck && npm test` | exit 0 on disposable DB |
| Temporal tests | `npm run test:temporal` | integration/time-skipping/replay pass |
| Production build | `npm run build` | Next + workflow bundle pass |
| Security/license | `npm run security:audit && npm run licenses:check` | exit 0 |

## Scope

**In scope**: supplier-health Temporal domain/task queue, contracts, workflows,
activities, schedule registration/cutover, DB policies/transitions, outbox command
support for internal owner reminders and the public GitHub contribution handoff,
search attributes/metrics, replay/time-skipping/restart tests, runbooks.

**Out of scope**: Temporal foundation replacement, Temporal Cloud, Go, supplier
browser access, remote recipe execution, raw fingerprint/history payloads,
guided capture missions or mission codes, Gmail,
and immediate removal of any legacy/manual health process before parity evidence.

## Steps

### 1. Freeze the health policy and DB transition contract

Define versioned policy inputs: freshness windows by lifecycle stage, qualifying
attestation types, Plan 005's `collector.operational-outcome.v1` operational
error codes and thresholds, reminder cooldown, approved
follow-up kinds (`owner_reminder` or `public_github_contribution_handoff`), and
terminal states. Implement a pure evaluator returning previous state, next state,
reason codes, next evaluation time, and an optional approved follow-up.

**Verify**: table-driven unit tests cover fresh, stale, degraded, recovered,
retired, missing evidence, repeated error, cooldown, and clock boundaries. A
missing-evidence case emits only an approved reminder or GitHub handoff; tests
assert that no mission record, mission code, or Svala mission command is created.

### 2. Add a dedicated task queue and contracts

Extend `TemporalDomain` and `TEMPORAL_TASK_QUEUES` with supplier health. Add
bounded Workflow/Activity types containing IDs and revisions only. Register exact
activities for the new queue in `activitiesForTaskQueue`; update configuration,
search attributes, metrics, and worker deployment manifests.

**Verify**: typecheck and worker-registration tests prove another task queue cannot
execute supplier-health activities.

### 3. Implement idempotent activities

Activities list due supplier IDs in bounded pages, load authoritative evidence,
evaluate policy, and atomically persist state/audit/follow-up outbox records using
an evaluation idempotency key. Use safe retry policy only for DB/idempotent work.
Treat external notifications as separate commands with ambiguous-effect policy.

The follow-up command schema is a closed union of `owner_reminder` and
`public_github_contribution_handoff`; the latter contains only the canonical
public contribution URL plus bounded supplier/reason identifiers and never
creates contributor identity, claim, mission, or access state.

**Verify**: repeated activity execution produces one transition and one follow-up.
Contract tests reject every retired mission command/type and prove a
missing-evidence evaluation produces the approved GitHub handoff or owner reminder.

### 4. Implement a finite scheduled workflow

Create `supplierHealthSweepWorkflow` with bounded batch size and deterministic
ordering. Prefer finite daily runs over an indefinitely growing entity Workflow.
If volume exceeds safe history limits, use child workflows or Continue-As-New
only after a measured threshold and replay tests.

**Verify**: time-skipping tests cover schedule cadence, retry, partial supplier
failure, worker restart, cancellation, and no-overlap behavior.

### 5. Register a paused Temporal Schedule

Add a managed schedule with deterministic ID such as
`svala:supplier-health:daily:v1`, explicit `SKIP` overlap, bounded catch-up window,
and pause-by-default cutover configuration. Support describe, trigger, pause,
update, and backfill through the existing schedules script.

**Verify**: schedule config tests reject unknown active schedule IDs and confirm
the overlap/catch-up policy.

### 6. Add replay and safe-deployment coverage

Generate a sanitized protobuf history fixture for the new production Workflow,
add it to the exact replay count, and exercise replacement-worker recovery. Use
the repository's existing workflow-bundle build and deployment-versioning
runbooks; do not mutate Workflow logic incompatibly without a versioning path.

**Verify**: `npm run test:temporal` replays every production Workflow including
supplier health and passes against the self-hosted test server.

### 7. Shadow, compare, and cut over

Run the schedule paused/manual first, then shadow mode that records proposed
transitions without applying them. Compare with human workbench decisions for a
defined window. Enable transitions only after parity thresholds; retain immediate
pause and rollback.

**Verify**: cutover evidence records zero duplicate transitions, zero raw payloads
in history, bounded schedule lag, and successful worker/server interruption tests.

## Done criteria

- [ ] Existing Svala Temporal TypeScript foundation is reused unchanged in shape.
- [ ] Supplier health has a separate task queue and paused schedule.
- [ ] PostgreSQL holds all product/fingerprint state; histories contain IDs/codes.
- [ ] Activities are idempotent and ambiguous effects are isolated.
- [ ] Follow-ups are limited to owner reminders or the public GitHub contribution
      handoff; no retired mission state or command exists.
- [ ] Time-skipping, restart, replay, bundle, typecheck, full tests, security, and
  license gates pass.
- [ ] Shadow evidence and an operator-approved cutover exist before activation.

## STOP conditions

- Production Temporal/TLS/platform prerequisites from the existing roadmap are
  not operational; keep the schedule paused and report the external gate.
- A Workflow needs current time, randomness, network, or database access outside
  Activities.
- Any input/history would contain fingerprint JSON, origin paths, contributor
  identity beyond bounded internal IDs, or credential-like data.
- A follow-up effect cannot be made idempotent or isolated with one-attempt review.
- Implementation would recreate Plan 009 mission records, codes, claims,
  eligibility, or a Svala-only contributor workflow.
- Implementation requires changing Gmail behavior or adding another runtime.

## Maintenance notes

Every production Workflow change must retain replay compatibility or follow the
repository's safe-deployment/versioning procedure. Review schedule overlap and
catch-up policy whenever evaluation duration or supplier volume changes.
