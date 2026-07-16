# Plan 005: Make Collector failure and retry states operational

> **Executor instructions**: Do not add passive analytics. All persisted error
> metadata must be bounded, typed, and free of URLs, response bodies, or secrets.
>
> **Drift check**: `git diff --stat 0b90a93..HEAD -- src/core/errors.ts src/core/engine.ts collector/src/platform/collector.ts collector/src/platform/storage.ts collector/src/platform/scheduler.ts collector/src/ui test`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 003
- **Category**: reliability, UX
- **Planned at**: Ratatosk `0b90a93`, 2026-07-16

## Why this matters

The error taxonomy promises rate-limit backoff and repair-specific behavior, but
only expired auth is handled distinctly. Partial scope failures can be hidden by
a successful sibling scope, while rate limits, endpoint drift, missing documents,
and destination failures collapse into one generic error.

## Current state

- `src/core/errors.ts:23-45` defines typed errors and `retryAfterMs`.
- `collector/src/platform/collector.ts:62-72` special-cases only `AuthExpired`.
- `src/core/engine.ts:96-108` discards scope errors on partial success.
- `collector/src/platform/scheduler.ts` has only a fixed global cadence.

## Commands

| Purpose | Command | Expected |
| --- | --- | --- |
| Focused tests | `npm test -- --run test/core/collector-failures.test.ts` | exit 0 |
| Full gate | `npm run typecheck && npm test && npm run build` | exit 0 |

## Scope

**In scope**: bounded error codes, partial result metadata, per-vendor
`nextEligibleRunAt`, retry decisions, popup states, explicit redacted diagnostic
export, and tests.

**Out of scope**: telemetry to Igdrasil, arbitrary server-controlled schedules,
unbounded logs, raw HTTP responses, or retrying ambiguous sink effects inside a
single run.

## Steps

### 1. Define stable operational outcomes

Add codes for auth expired, rate limited, recipe incompatible, document invalid,
destination unavailable, partial scope failure, and unknown. Extend `RunResult`
with bounded counts/codes, never raw errors.

**Verify**: exhaustive TypeScript switches fail compilation when a new code is
not handled.

### 2. Preserve partial failure truth

Return successful documents plus a partial-failure summary when sibling scopes
fail. Record status `partial` and show “collected N; M account scopes need
attention,” rather than `ok`.

**Verify**: a two-scope test with one success/one 403 records partial; all-scope
failure remains error; an expected no-billing scope can be represented explicitly
without false alarms.

### 3. Honor rate-limit eligibility

Persist a bounded `nextEligibleRunAt` derived from `RateLimited.retryAfterMs` with
clock-skew and maximum-delay caps. Manual and alarm runs before that time return a
typed skipped summary without calling the vendor; provide an explicit user
override only if product copy warns it may worsen limiting.

**Verify**: fake-clock tests cover delay, restart persistence, expiry, corrupt
timestamps, and a different vendor remaining runnable.

### 4. Add explicit redacted diagnostics

Let the user copy/export vendor ID, Collector version, stable code, timestamps,
counts, and lifecycle revision. Exclude URLs, headers, bodies, invoice IDs,
company IDs, and tokens.

**Verify**: a security test asserts forbidden fields/values are absent.

## Done criteria

- [ ] Typed outcomes reach storage and popup without sensitive data.
- [ ] Partial success is never shown as full success.
- [ ] Rate limits suppress premature automatic retries across restarts.
- [ ] Full tests and build pass.

## STOP conditions

- A retry would repeat a sink effect whose result is ambiguous.
- Correct classification requires persisting raw HTTP data.
- Existing pilot behavior cannot distinguish “no billing for this scope” from a
  broken scope; report that recipe-specific ambiguity before changing semantics.

## Maintenance notes

The diagnostic codes become inputs to Plan 004 verification and the Plan 010
health lifecycle. Keep them versioned and backward-compatible.

