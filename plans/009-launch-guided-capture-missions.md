# Plan 009: Launch guided supplier-capture missions

> **Retired on 2026-07-16:** This workflow was removed from Ratatosk. Collector
> now links missing-supplier requests to the public GitHub contribution path, and
> external contributors do not need Svala access or a special code. The remainder
> of this file is retained only as historical implementation context.

> **Executor instructions**: Missions guide an already-authorized account holder;
> they never ask Svala, an agent, or Igdrasil to obtain access. Avoid coercive
> copy and never request passwords, 2FA codes, invoices, or raw logs.
>
> **Ratatosk drift check**: `git diff --stat 0b90a93..HEAD -- studio docs src/core/recorder test/studio`
>
> **Svala drift check**: `git diff --stat 26bfebb..origin/main -- svala-app/lib/features/dev svala-app/app/workbench svala-app/app/api/dev svala-app/lib/db/schema.ts svala-app/tests`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: Plans 007 and 008
- **Category**: direction, growth
- **Planned at**: Ratatosk `0b90a93`; Svala `26bfebb`; 2026-07-16

## Why this matters

Igdrasil cannot hold billing accounts for every supplier. Studio already handles
local capture, sanitization, exact preview, and approval; a mission system lets
authorized customers or partners contribute the missing structural evidence with
clear scope and feedback.

## Current state

- Studio starts from a generic “record this page” flow and shows progress.
- Svala has no unsupported-supplier request queue or capture assignment.
- The workbench planned in 008 can identify exact missing evidence.

## Scope

**In scope**: mission request/prioritization, one-use mission claim, bounded
instructions, Studio mission import/pairing, progress/receipt statuses, expiry,
withdrawal, abuse controls, and contributor documentation.

**Out of scope**: account sharing, automated login, payment/account creation,
mission marketplaces, incentives, raw uploads, public fingerprint disclosure, and
automatic supplier support claims.

## Steps

### 1. Define the mission contract

Store supplier candidate, canonical allowed origin, requested evidence roles,
safe user actions (for example open Billing, reload, click Download on a synthetic
document), eligibility statement, expiry, priority, status, creator, claimant,
and receipt. Instructions must be bounded structured data, not executable code.

**Verify**: schema rejects HTML/script, arbitrary origins, credential requests,
unknown action kinds, overlong copy, and expired claims.

### 2. Add authenticated request and claim flows

Developers create missions from workbench gaps. Authorized Svala users explicitly
claim a mission; issue a one-use opaque mission code scoped to supplier/origin and
expiry. Do not reveal other contributors or private submissions.

**Verify**: access, one-claim/reclaim, expiry, withdrawal, and rate-limit tests.

### 3. Guide Studio without widening capture

Let Studio accept the mission code through the existing paired Svala channel,
display the exact requested origin/actions, and refuse recording on a different
origin. Retain the normal recording consent and separate fingerprint sharing
approval. A mission must never auto-start recording or auto-approve delivery.

**Verify**: wrong-origin and expired missions fail before capture; consent remains
unchecked on every new mission.

### 4. Close the loop with receipts

Delivery links the fingerprint receipt to the mission and recomputes workbench
completeness. Show contributor status `received`, `needs another capture`,
`accepted for review`, or `closed`; never promise recipe publication.

**Verify**: idempotent submission completes one mission and cannot complete a
mission for another supplier.

### 5. Publish the non-developer contribution guide

Document dedicated profiles, authorization, synthetic data, what Studio includes
and excludes, how to stop/withdraw, retention, receipt meaning, and why an agent
cannot replace an authorized supplier session.

**Verify**: docs contain no instruction to share credentials or real documents.

## Test plan

Run full Ratatosk and Svala gates plus cross-repo synthetic mission fixtures.
Add threat tests for replay, origin substitution, claim enumeration, oversized
instructions, and cross-user receipt access.

## Done criteria

- [ ] Missions are scoped, expiring, revocable, and human-claimed.
- [ ] Studio enforces mission origin without weakening consent.
- [ ] Delivery receipts close the correct mission idempotently.
- [ ] Contributors never share credentials, invoices, or raw captures.

## STOP conditions

- Product copy pressures users to capture accounts they do not control.
- Mission completion requires a real financial document instead of synthetic or
  already-authorized evidence.
- A code path can start recording or delivery without both explicit approvals.

## Maintenance notes

Use workbench missing-evidence reasons as the mission source. Do not let freeform
developer instructions become an execution language.
