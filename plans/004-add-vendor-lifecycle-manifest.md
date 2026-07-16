# Plan 004: Make vendor lifecycle and verification evidence enforceable

> **Executor instructions**: Never commit test-account identifiers, credentials,
> captured invoice data, or private evidence. Public evidence references must be
> sanitized PR/release IDs or opaque internal receipt IDs.
>
> **Drift check**: `git diff --stat 0b90a93..HEAD -- src/vendors src/core/schema.ts scripts/validate-vendors.ts collector/src/ui docs store test/vendors`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: Plan 003
- **Category**: architecture, reliability
- **Planned at**: Ratatosk `0b90a93`, 2026-07-16

## Why this matters

Today “production” means membership in `VENDORS`; current compatibility is a
free-text note and an external manual checklist. With more suppliers, maintainers
cannot query stale recipes, enforce promotion evidence, or show users that an
integration needs re-verification.

## Current state

- `src/vendors/index.ts:26-32` manually separates three public and three
  experimental recipes.
- `src/core/schema.ts:165` offers only free-text `notes`.
- `docs/testing.md:64-69` describes evidence but does not encode it.
- Collector accepts `dom` recipes in schema although runtime wires an unavailable
  DOM strategy.

## Commands

| Purpose | Command | Expected |
| --- | --- | --- |
| Validate | `npm run validate` | every vendor has lifecycle metadata |
| Tests | `npm test -- --run test/core/vendor-lifecycle.test.ts` | exit 0 |
| Release gate | `npm run validate:release` | fails for stale/unverified public claims |

## Scope

**In scope**: a strict versioned lifecycle manifest adjacent to recipes,
validation scripts, user-facing health labels, testing/release docs, and tests.

**Out of scope**: storing private evidence, server-side supplier login, Temporal,
remote recipe loading, and automatically promoting recipes.

## Steps

### 1. Define a strict lifecycle record

Create a versioned record keyed by vendor ID with: stage (`experimental`,
`pilot`, `supported`, `degraded`, `retired`), owner team, recipe revision,
last-live-verification timestamp, Collector version, Chrome major, sanitized
evidence reference, next-review timestamp, and health reason code. Use ISO dates,
bounded fields, exact keys, and no freeform secret-bearing payload.

**Verify**: unknown keys, future dates beyond clock tolerance, invalid stages,
missing public entries, and duplicate IDs fail tests.

### 2. Separate ordinary CI from release freshness

Ordinary CI must validate shape and coverage. A stricter `validate:release` gate
must reject public listing claims whose stage/freshness/evidence is inadequate.
Initialize current pilot vendors honestly as `needs verification` rather than
fabricating dates.

**Verify**: release validation fails until real sanitized attestations are added;
normal development CI still supports experimental work.

### 3. Enforce runtime capabilities

Reject promotion of `dom` recipes while Collector wires
`unavailableDomStrategy`. Validate exact host permissions and supported strategy
as part of public promotion.

**Verify**: a synthetic public DOM recipe fails with a precise capability error.

### 4. Surface health without overstating support

Show stage and verification freshness in Collector. Degraded/retired vendors
must not silently appear as healthy; decide whether degraded vendors remain
runnable based on a typed reason, with conservative copy.

**Verify**: UI tests cover pilot, stale, degraded, and retired states.

## Done criteria

- [ ] All six recipes have valid lifecycle entries.
- [ ] Public promotion and release freshness are machine-enforced.
- [ ] Unsupported runtime strategies cannot enter the public registry.
- [ ] No sensitive verification evidence is committed.

## STOP conditions

- The only available evidence contains private account or invoice data.
- A proposed field would make the public manifest the source of mutable runtime
  behavior rather than reviewed release metadata.
- Product owners have not decided the freshness window; use a configurable
  conservative default and report the unresolved policy instead of inventing it.

## Maintenance notes

Plan 010 mirrors this lifecycle into Svala's PostgreSQL model and evaluates it
durably. Ratatosk remains the release authority for bundled recipe metadata.

