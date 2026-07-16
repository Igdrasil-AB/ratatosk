# Plan 003: Reject false documents and join overlapping supplier runs

> **Executor instructions**: Preserve the invariant “mark seen only after the
> sink accepts.” Do not solve overlap by marking documents seen before delivery.
>
> **Drift check**: `git diff --stat 0b90a93..HEAD -- src/core/strategies/network.ts src/core/engine.ts collector/src/platform/collector.ts collector/src/platform/service-worker.ts collector/src/platform/storage.ts collector/src/platform/filesystem-sink.ts test`

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug, reliability
- **Planned at**: Ratatosk `0b90a93`, 2026-07-16

## Why this matters

A successful HTML login/interstitial response can currently be relabeled as PDF,
delivered, and marked seen because the PDF signature check is only logged.
Separately, an alarm and manual run can overlap, both observe an unseen invoice,
and create duplicate local downloads or lost seen-map writes.

## Current state

- `src/core/strategies/network.ts:77-94` computes `looksPdf` but does not enforce it.
- `collector/src/platform/service-worker.ts:44-45` starts alarm work independently.
- `collector/src/platform/service-worker.ts:251-261` starts manual work independently.
- The only in-flight map protects connection setup, not collection.
- Extraction-date filesystem downloads use `conflictAction: "uniquify"`.

## Commands

| Purpose | Command | Expected |
| --- | --- | --- |
| Strategy tests | `npm test -- --run test/core/engine.test.ts test/vendors/anthropic.integration.test.ts` | exit 0 |
| Collector tests | `npm test -- --run test/core/collector-run.test.ts` | exit 0 |
| Full gate | `npm run ci && npm run build` | exit 0 |

## Scope

**In scope**: network document validation, typed error use, collector run
coordination, storage mutation serialization if required, focused tests.

**Out of scope**: MIME sniffing arbitrary file types, OCR, Svala dedup changes,
new scheduling policy, or changing disconnect semantics.

## Steps

### 1. Enforce document content

For recipes expecting `application/pdf`, require both a PDF-compatible response
content type (when present) and `%PDF` magic bytes. Reject HTML and other content
with `UnexpectedResponse`; never pass bytes to a sink or seen store. Keep a small
bounded diagnostic containing status and normalized content type only.

**Verify**: tests cover valid PDF, 200 HTML, mislabeled binary, empty body, and
missing content-type with valid PDF magic.

### 2. Add one per-vendor run coordinator

Place the in-flight registry at the `runVendorById` boundary so alarm, run-now,
run-all, and first-connect all join the same promise for a vendor. A second caller
receives the first run's summary; unrelated vendors remain sequential in
`runAllConnected` and may not share locks.

**Verify**: two simultaneous calls produce one list request and one sink send;
both callers resolve with the same logical result.

### 3. Serialize storage writes

Use a narrow write chain or atomic helper for seen and connection record
read-modify-write operations so two different vendors cannot overwrite each
other. Do not batch a key before its corresponding sink acceptance.

**Verify**: interleaved two-vendor additions retain both keys and both run states.

## Test plan

Create `test/core/collector-run.test.ts` with Chrome/storage/sink fakes. Model its
fake-response style on `test/vendors/anthropic.integration.test.ts` and storage
mocks on `test/core/scheduler.test.ts`.

## Done criteria

- [ ] A 200 HTML response cannot be ingested as PDF or marked seen.
- [ ] Overlapping triggers for one vendor execute one physical run.
- [ ] Concurrent storage updates for different vendors retain both results.
- [ ] Existing partial-scope behavior and all full-suite tests remain passing.

## STOP conditions

- A supported vendor demonstrably returns a non-PDF payload for a PDF recipe.
- Joining runs would cause callers to receive summaries for a different vendor.
- The implementation moves “seen” before sink acceptance.

## Maintenance notes

Keep the run coordinator platform-local. Do not put Chrome lifecycle state into
the platform-free engine.

