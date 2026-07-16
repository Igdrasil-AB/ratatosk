# Plan 008: Build the Svala supplier-intelligence workbench

> **Executor instructions**: Implement in a clean Svala worktree. PostgreSQL is
> authoritative. Clustering is advisory and reversible; never merge suppliers or
> create recipes without human confirmation.
>
> **Drift check**: from the Svala repo run
> `git diff --stat 26bfebb..origin/main -- svala-app/lib/db/schema.ts svala-app/lib/features/dev svala-app/app/workbench svala-app/app/api/dev svala-app/tests/unit`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: Plan 007
- **Category**: direction, data model, UI
- **Planned at**: Svala `26bfebb`, 2026-07-16

## Why this matters

Manual import currently turns each fingerprint into an isolated Markdown context
document. The structured evidence is valuable only when Svala can group repeated
observations, compare request shapes, identify missing evidence, and move a
supplier toward a reviewed recipe candidate.

## Current state

- `lib/features/dev/ratatosk-fingerprint.ts` validates normalized origins,
  requests, roles, inferred fields, confidence, and privacy assertions.
- `ratatoskFingerprintToContextDoc` flattens that structure into Markdown.
- `DeveloperWorkspace.tsx` imports JSON client-side and then follows the ordinary
  context-document path.
- Svala repository/service/API patterns separate DB access, validation, and
  `requireDeveloperAccess` routes.

## Commands

| Purpose | Command | Expected |
| --- | --- | --- |
| Migration | `npm run db:verify-migration` | exit 0 |
| Focused tests | `node --import tsx --test --test-concurrency=1 tests/unit/ratatosk-*.test.ts` | all pass |
| Full gate | `npm run typecheck && npm test && npm run build` | exit 0 |

## Scope

**In scope**: first-class submission/evidence/cluster read models, deterministic
candidate matching, human merge/split decisions, completeness scoring, developer
workbench UI/API, optional context/task creation after approval, audit events.

**Out of scope**: automatic recipe execution, LLM-only merges, supplier
credentials, raw bodies/fixtures, background portal access, and Temporal (Plan
010 owns orchestration).

## Steps

### 1. Normalize first-class evidence tables

Extend the Plan 007 intake schema with supplier candidates, observations, request
shapes, inferred fields, cluster membership, review decisions, and lifecycle
events. Preserve the original canonical submission JSON/hash for audit, but query
normalized bounded columns. Enforce fingerprint uniqueness and foreign keys.

**Verify**: migration apply/rollback verification and repository round-trip tests
pass; duplicate receipt is idempotent.

### 2. Implement conservative candidate matching

Generate suggestions from canonical supplier origin, ID candidate, document
origins, and request-shape overlap. Regional domains, resellers, and renamed
portals must remain separate suggestions until a developer merges them. Record
why each suggestion was made.

**Verify**: fixtures cover same supplier, similar-but-distinct supplier, regional
portal, reseller, and maliciously similar IDs; no automatic irreversible merge.

### 3. Score evidence completeness

Produce deterministic missing-evidence reasons: auth probe, invoice list, stable
ID field, document origin/PDF, pagination, multi-scope, low confidence, or stale
Studio schema. Use states `needs_capture`, `needs_review`, `needs_verification`,
`recipe_candidate`, `promoted`, `degraded`, `retired`.

**Verify**: table-driven tests map synthetic evidence to exact states/reasons.

### 4. Build the developer workbench

Add a Ratatosk supplier view with inbox, clusters, diffed request shapes,
submission provenance/receipt, completeness, human merge/split, and linked Svala
errand/task. Render values as text; do not inject fingerprint strings as HTML.

**Verify**: route authorization tests and component tests cover empty, duplicate,
conflicting, rejected, and candidate states.

### 5. Gate recipe-candidate promotion

Only a developer decision may create a task/context bundle. Include structural
evidence and unresolved checklist; do not generate or commit a fixture because
fingerprints intentionally exclude invoice values and bodies.

**Verify**: candidate promotion creates one idempotent task/context link; replay
does not duplicate it.

## Done criteria

- [ ] Structured evidence remains queryable and traceable to a receipt.
- [ ] Clustering suggestions are explainable, reversible, and human-approved.
- [ ] Completeness/state transitions are deterministic and tested.
- [ ] No rich capture data or secrets are introduced.

## STOP conditions

- Matching requires raw bodies, customer identity, or invoice values.
- A migration collides with current `origin/main`; renumber from live main.
- The UI would expose the workbench without `requireDeveloperAccess`.
- A recipe candidate cannot be represented honestly without a new capture.

## Maintenance notes

Plan 010 operates on IDs and states from this schema. Keep large canonical JSON
out of Temporal inputs/history.

