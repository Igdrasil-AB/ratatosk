# Plan 014: Connect multiple Igdrasil companies with one supplier per company

> **Executor instructions**: This is a cross-repository plan. Use separate clean
> worktrees and PRs for Ratatosk and Igdrasil. Land the Igdrasil engine-api
> surface first behind a disabled feature flag, then Ratatosk multi-company
> storage and protocol v2, then the Igdrasil connect route and settings view,
> and enable the flag only after the shared contract fixtures pass on both
> sides. Never place token values, real invoice bytes, company names from
> production, or supplier-account evidence in either repository.
>
> **Ratatosk drift check**:
> `git diff --stat ac9ba5a..HEAD -- collector/src/platform/storage.ts collector/src/platform/auth.ts collector/src/platform/service-worker.ts collector/src/platform/runtime.ts collector/src/platform/collector.ts collector/src/platform/igdrasil-connect-intent.ts collector/src/platform/igdrasil-disconnect.ts collector/src/platform/connect-bridge.ts collector/src/ui/popup/popup.ts src/ingest src/core/dedup.ts examples docs test/core`
>
> **Igdrasil drift check**: from `/Users/philiperiksson/igdrasil_accounting_main/igdrasil-accounting`, run
> `git diff --stat 0ffca701e..origin/main -- services/engine-api/src/auth.rs services/engine-api/src/documents services/engine-api/src/uploads services/engine-api/src/api_contracts frontend/src/lib/invoiceCollectorApi.ts frontend/src/components/views/InvoiceCollectorSettingsView.tsx frontend/src/App.tsx db scripts/db`
>
> This plan was written against Ratatosk `origin/main` `ac9ba5a` and Igdrasil
> `origin/main` `0ffca701e`, both on 2026-08-07. Reconcile every in-scope drift
> before editing.

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none for the contract work; live acceptance depends on Plan 013
- **Category**: integration, architecture, security, UX, tests
- **Planned at**: Ratatosk `ac9ba5a`; Igdrasil `0ffca701e`; 2026-08-07
- **Status**: IN PROGRESS — STOP condition 6 fired and was RESOLVED (no user population); live acceptance remains

## Why this matters

The Igdrasil connection does not work at all today, in either direction. Igdrasil's
web app still speaks the July-13 protocol from Ratatosk v0.6.2: it sends the user's
Clerk session JWT, an `apiBaseUrl` of `${origin}/api`, and no connection intent.
Ratatosk v0.8.49 rejects all three independently, and Ratatosk's own popup opens
`/integrations/invoice-collector/connect`, which is not a route in Igdrasil. The
entire server side — token minting, revocation, and document ingest — was never
built.

Rebuilding it single-company would immediately re-create the defect the current
Igdrasil view already has: it reads the extension's connected company and then
renders the *active* company's name
(`frontend/src/components/views/InvoiceCollectorSettingsView.tsx:155`), so a bureau
user is told invoices go to the company they are looking at when they go elsewhere.
Multi-company is therefore not a later enhancement; it is the shape the first
working version has to have.

## Product decisions (settled — do not re-litigate)

1. **Multiple companies, one destination per supplier.** Ratatosk may hold several
   connected Igdrasil companies. Each supplier connection feeds exactly one
   destination. A supplier is never split across two companies.
2. **Per-supplier binding in the UI, no global active company.** Settings lists each
   connected company with its own Disconnect. Each supplier row shows its
   destination and can change it there. There is deliberately no "active company"
   selector, because an active-vs-bound divergence is the exact defect being fixed.
3. **Local saving is one destination among many.** "This Computer" is bindable per
   supplier alongside companies. One filesystem configuration is shared by every
   supplier bound to it; the sink already namespaces by supplier and date.
4. **Rebinding re-delivers full history, with a warning.** Because idempotency keys
   are tenant-scoped (`src/core/dedup.ts:17`), moving a supplier from company A to
   company B is a fresh dedup namespace and re-collects everything reachable. The
   confirmation must state that invoices already delivered to A remain in A and
   cannot be retracted.
5. **Sliding token renewal.** A successful ingest extends the company token; Igdrasil
   warns in-app when a company has not collected in 60 days. An actively used
   connection does not expire.

## Fixed architecture

1. **Ingest endpoint**: `POST https://accounting.igdrasil.se/api/documents/ingest`,
   multipart, unchanged wire format from `src/ingest/http-sink.ts`.
2. **Token endpoint**: `POST` and `DELETE
   https://accounting.igdrasil.se/api/documents/ingest/token`.
3. **Credential**: a `rat_[a-f0-9]{64}` upload-only token, one per (company,
   browser profile). Only its SHA-256 is stored server-side. Session JWTs are never
   accepted by the extension and never issued for this purpose.
4. **Tenant authority is the token, not the header.** engine-api derives the company
   from the token record and rejects the request when `X-Company-Id` disagrees.
   Under multi-company the header is a cross-check, never the source of truth.
5. **Origin binding is unchanged.** `apiBaseUrl` must be exactly
   `https://accounting.igdrasil.se` (`src/ingest/igdrasil-sink.ts:27`); the bridge
   content script and the service worker's allow-list stay as they are.
6. **Intent handshake is unchanged in shape.** `prepare → validate → mint → connect`
   remains, including the one-use 64-hex state and the `returnTo` that survives auth
   and onboarding.

## Current state

**Ratatosk (`ac9ba5a`, v0.8.49)** — client side complete but single-destination:

- One global `SinkConfig` (`collector/src/platform/storage.ts:16`) and one
  `hostToken` key (`collector/src/platform/auth.ts:17`).
- `igdrasil:status` returns a single `companyId`
  (`collector/src/platform/service-worker.ts:190`); `igdrasil:disconnect` takes no
  arguments.
- Connections are already keyed by vendorId (`storage.ts:71`) and
  `runAllConnected` already runs suppliers one at a time
  (`collector/src/platform/collector.ts:435`), each building its own sink. The
  run loop does not need restructuring.
- Idempotency keys are already `companyId \0 source \0 vendorInvoiceId`, so several
  companies coexist in one `seen` set without collision.

**Igdrasil (`0ffca701e`)** — v1 stub only:

- `frontend/src/lib/invoiceCollectorApi.ts` sends a session JWT, no state,
  `${origin}/api`.
- No `/integrations/invoice-collector/connect` route in `frontend/src/App.tsx`.
- No `/api/documents/ingest`, no `/api/documents/ingest/token`, no `rat_` concept
  anywhere in the Rust workspace. `import_source` is a free-form
  `character varying(50)`, so no enum migration is needed for `invoice_collector`.
- The closest existing precedent for a hashed, company-scoped credential is
  `companies.mcp_api_key_hash`
  (`services/engine-api/src/companies/services/repository.rs:431`,
  `integrations/services/platform_repository.rs:68`).

**Assumption to verify before step 1**: Collector has never shipped a build with a
working Igdrasil connection, so there is no installed population speaking protocol
v1. If an unlisted pilot install exists, it must be reconnected rather than migrated
— see STOP conditions.

## Scope

In scope: multi-company destinations and per-supplier binding in Ratatosk; protocol
v2; the engine-api token and ingest surface; the Igdrasil connect route with a
company picker; the rewritten settings view; shared contract fixtures on both sides.

Out of scope: publishing Collector to the Chrome Web Store (Plan 006); the remaining
Plan 011/013 live acceptance; any change to supplier discovery, recipes, or the DOM
acquisition path; per-company scheduling cadence; bureau bulk-connect.

## Steps

### 1. Freeze the shared contract fixtures

Before either side is edited, write the fixtures both repos will assert against:
the multipart field set, the success and `409 {"duplicate": true}` response bodies,
the token mint request/response, the revoke request, and every protocol v2 message
with its error codes. Commit them to `test/fixtures/igdrasil-connect/` in Ratatosk
and mirror the identical JSON under the engine-api test tree. Neither side may
hand-roll its own copy of the shape.

This directly replaces the copy-paste contract that produced the current drift:
`examples/igdrasil-connect-client.ts` was meant to be pasted into Igdrasil, diverged
three weeks ago, and nothing detected it because no build or test spans the two
repositories.

### 2. Define protocol v2 and its error codes

Add `protocol: 2` to the bridge `present` announcement and to every response
(`collector/src/platform/connect-bridge.ts:52`). Message changes:

| message | change |
|---|---|
| `igdrasil:ping` | adds `protocol` |
| `igdrasil:prepare` | unchanged |
| `igdrasil:validate` | unchanged |
| `igdrasil:connect` | adds `companyName`; **adds** a company instead of replacing the destination |
| `igdrasil:status` | returns `companies: [{ companyId, companyName, supplierCount, expiresAt }]` — breaking |
| `igdrasil:disconnect` | requires `companyId` |

Replace the prose error strings with stable codes — `intent_missing`,
`intent_expired`, `origin_not_allowed`, `token_invalid`, `backend_not_allowed`,
`company_already_connected`, `unknown_company` — and map them to translated copy in
Igdrasil. Today Ratatosk's own wording ("start again from Ratatosk") lands
untranslated in an otherwise i18n'd toast.

Replace the unsound `isAppRequest` predicate (`service-worker.ts:192`) with a
per-message validator that narrows each field it claims. It currently checks only
`.type` and then asserts the whole union, so the compiler believes attacker-supplied
page data is `string`. The runtime `typeof` checks that make this safe today are
convention, not enforcement, and protocol v2 adds fields.

### 3. Add the Igdrasil token surface behind a disabled flag

New table `collector_tokens`: `id`, `company_id`, `token_hash` (SHA-256 hex, unique),
`token_prefix`, `created_by_user_id`, `created_at`, `last_used_at`, `expires_at`,
`revoked_at`. No user agent, browser fingerprint, or label containing user input.

- `POST /api/documents/ingest/token` — Clerk-authed and tenant-scoped, requires
  `connection_state`, rejects a missing, expired, or unbound state, and binds that
  state one-use to its own mint transaction. Returns the token value exactly once.
- `DELETE /api/documents/ingest/token` — authenticated by the bearer itself; revokes
  that row. Returns success for an already-revoked token so Ratatosk's disconnect
  stays idempotent (`collector/src/platform/igdrasil-disconnect.ts:33` already treats
  401 as success).
- A new `CollectorToken` extractor, separate from `require_auth`
  (`services/engine-api/src/auth.rs:165`). It must be accepted on the two ingest
  routes and nowhere else; add a route-inventory test that fails if it spreads.
- Sliding renewal: on successful ingest set `expires_at = now() + 90 days`, but only
  write when the extension would move by more than a day, so a bulk collection does
  not issue one write per invoice.

### 4. Add the ingest endpoint

`POST /api/documents/ingest` accepts the exact multipart body `HttpSink` sends —
`file`, `source`, `vendor_id`, `vendor_invoice_id`, `issued_at`, `idempotency_key`,
`amount_gross`, `currency`, `company_id` — plus `Idempotency-Key`, `X-Company-Id`,
and `X-Collector` headers. It creates a `documents` row with
`import_source = 'invoice_collector'` so it lands in Inbox, returns
`{"document_id": …}`, and returns `409 {"duplicate": true}` for a repeat
idempotency key. Any other conflict must stay a failure — `http-sink.ts:101` only
accepts a 409 when `duplicate === true`.

The existing idempotency machinery does not apply as-is: `IdempotencyRequest::
from_json_body` hashes a serialized JSON body
(`services/engine-api/src/api_contracts/idempotency.rs:88`) and this request is
multipart with a file. Add a multipart-aware constructor that hashes the canonical
metadata field set plus the SHA-256 of the file bytes.

Verify the token's company against `X-Company-Id` and the `company_id` form field
and reject on any disagreement rather than preferring one of them.

### 5. Rework Ratatosk storage for multiple destinations

Replace the single `SinkConfig` with a destination map and a per-connection binding:

```ts
export type DestinationId = "local" | `igdrasil:${string}`;

export type Destination =
  | { kind: "filesystem"; rootFolder: string; dateMode: "extraction" | "invoice" }
  | { kind: "igdrasil"; endpoint: string; companyId: string; companyName: string };

// storage: destinations: Record<DestinationId, Destination>
// Connection gains: destinationId: DestinationId
```

`hostToken` becomes `hostTokens: Record<companyId, string>`, still under
`TRUSTED_CONTEXTS` and still re-validated per company on read — `getHostToken`
already discards a stored value that fails the `rat_` shape (`auth.ts:43-47`) and
that discipline must survive the change.

Apply the same discipline to destinations on read. `getSinkConfig` is currently an
unchecked `get<SinkConfig>` cast (`storage.ts:66`), so a config persisted by an older
build is trusted on the way back in. Validate on read and mark a destination that
fails as needing reconnection.

`sinkCompanyId` (`storage.ts:22`) keeps its semantics but resolves through the
supplier's bound destination. `executeRecipeRun` (`collector.ts:119`) reads the
destination for the vendor being run rather than a global one. The one-supplier-one-
company rule is then enforced by the data shape — a `Connection` holds exactly one
`destinationId` — not by a validation rule that can be forgotten.

### 6. Migrate existing local state

One-time, idempotent, on service-worker start:

- An existing `config` becomes a single destination; `hostToken` moves under its
  `companyId`; every existing connection gets that `destinationId`.
- An existing igdrasil config whose endpoint fails `normalizeIgdrasilApiBase` — a
  v0.6.x leftover with a `/api` path — becomes a destination in a needs-reconnect
  state. It must not crash the worker and must not silently fall back to Downloads.
- Old keys are removed only after the new shape is written successfully.

A migration that loses a connection, or rebinds one to a different company, is a STOP
condition.

### 7. Rebuild the Ratatosk settings and supplier UI

Settings gains a company list under "Save Invoices To", each row showing its supplier
count and its own Disconnect, plus "Connect another company"
(`collector/src/ui/popup/popup.ts:602`). Each supplier row gains a destination
control (`popup.ts:445`).

Behaviour to get right:

- Changing a supplier's destination opens the rebind confirmation from decision 4 and
  then collects full history into the new company.
- Disconnecting a company that still has suppliers bound to it lists them and leaves
  them unbound and paused. Local Downloads is never an automatic fallback — this
  extends the existing invariant in `docs/igdrasil-connect.md:60`.
- An expired or revoked company token gets a distinct outcome code and a per-company
  "Reconnect" state. Today a 401 collapses into `destination_unavailable` → "Invoice
  destination unavailable" (`src/core/errors.ts:334`), and the `notifyReconnect`
  machinery is vendor-scoped only (`collector/src/platform/notifications.ts:8`), so
  an expired connection currently stops collection with no route back.

### 8. Rebuild the Igdrasil connect route and settings view

- New route `/integrations/invoice-collector/connect` with a **company picker** —
  the user chooses the target company rather than inheriting whichever one happens to
  be active — reached through a validated local `returnTo` that survives auth and
  onboarding.
- Replace `frontend/src/lib/invoiceCollectorApi.ts` with the protocol v2 client
  derived from `examples/igdrasil-connect-client.ts`. Remove `getAuthToken()` and
  `resolveApiBaseUrl()` from this path entirely.
- The settings view renders every connected company from `igdrasil:status`, flags any
  company connected in the extension that the user cannot access, and stops rendering
  the active company's name for a connection bound elsewhere.
- Honour the disconnect contract: transition to disconnected only on `{ ok: true }`.
  The current view discards the result and always toasts success
  (`InvoiceCollectorSettingsView.tsx:95-100`), contradicting
  `docs/igdrasil-connect.md:58`.
- Show the 60-day inactivity expiry warning from decision 5.
- Give the presence check a bounded retry. A single 1500 ms ping against a
  `document_idle` content script reports "not installed" to users who have it
  installed.

### 9. Enable, then take live acceptance

Enable the engine-api flag only after both fixture suites pass. Live acceptance
requires: two companies connected from one browser; suppliers bound to different
companies delivering to the correct inboxes; a rebind re-delivering into the new
company; disconnecting one company leaving the other collecting; and a revoked token
producing the reconnect state rather than a generic failure.

## Required automated acceptance matrix

| # | Assertion | Side |
|---|---|---|
| 1 | Two companies connect from one profile; both appear in `igdrasil:status` | Ratatosk |
| 2 | A supplier holds exactly one `destinationId`; no path can bind two | Ratatosk |
| 3 | Company A's token is never attached to a request carrying company B's id | Ratatosk |
| 4 | Rebinding A→B produces a fresh key namespace and re-delivers | Ratatosk |
| 5 | Migration from v0.8.49 state preserves every connection and its company | Ratatosk |
| 6 | A malformed persisted destination yields needs-reconnect, not a crash | Ratatosk |
| 7 | Disconnecting a company leaves its suppliers unbound and paused, never local | Ratatosk |
| 8 | A v1-shaped connect (JWT, no state) is refused with a typed code | Ratatosk |
| 9 | Token mint refuses a missing, expired, reused, or unbound `connection_state` | Igdrasil |
| 10 | A `rat_` token is rejected on every route except the two ingest routes | Igdrasil |
| 11 | Ingest rejects a token whose company disagrees with `X-Company-Id` | Igdrasil |
| 12 | Repeat `idempotency_key` returns `409 {"duplicate": true}` | Igdrasil |
| 13 | Ingest writes `import_source = 'invoice_collector'` and reaches Inbox | Igdrasil |
| 14 | Successful ingest slides `expires_at`; the write is rate-bounded | Igdrasil |
| 15 | Revoke is idempotent; a revoked token cannot ingest | Igdrasil |
| 16 | Both repos assert the identical fixture bytes from step 1 | Both |

## Commands and gates

Ratatosk, from the repository root:

```bash
npm ci
npm run typecheck
npm run validate
npm test
npm run build
npm audit --audit-level=high
```

Igdrasil, from the repository root with a disposable test database:

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test -p engine-api
npm --prefix frontend run typecheck
npm --prefix frontend test
```

Never point a test database at development or production.

## In-scope files

Ratatosk: `collector/src/platform/storage.ts`, `auth.ts`, `service-worker.ts`,
`runtime.ts`, `collector.ts`, `igdrasil-disconnect.ts`, `connect-bridge.ts`,
`notifications.ts`, `collector/src/ui/popup/popup.ts`, `src/ingest/igdrasil-sink.ts`,
`src/ingest/http-sink.ts`, `src/core/errors.ts`, `examples/igdrasil-connect-client.ts`,
`docs/igdrasil-connect.md`, `test/core`, `test/fixtures/igdrasil-connect`.

Igdrasil: `services/engine-api/src/auth.rs`, `documents/`, `api_contracts/idempotency.rs`,
a new migration under `db/`, `frontend/src/lib/invoiceCollectorApi.ts`,
`frontend/src/components/views/InvoiceCollectorSettingsView.tsx`, `frontend/src/App.tsx`,
`frontend/src/i18n`, and the engine-api test tree.

## Security and privacy invariants

- The extension accepts only `rat_[a-f0-9]{64}`; a session JWT is refused at the
  storage boundary, not merely unused.
- Tokens are stored per company under `TRUSTED_CONTEXTS` and re-validated on read.
- A token is only ever sent to `accounting.igdrasil.se`, enforced by
  `allowTokenHosts` (`src/ingest/http-sink.ts:81`).
- engine-api stores only the SHA-256 of a token and never logs a prefix that could
  narrow a brute-force search.
- Tenant authority is the token record. `X-Company-Id` and the `company_id` form
  field are cross-checks that can only cause rejection.
- Company names are stored locally only to label the UI. No invoice metadata,
  supplier evidence, or company data crosses into this repository's fixtures.

## Watch items (not blocking)

The `seen` set evicts oldest-first across all companies at 20,000 entries
(`storage.ts:56,184`). With several companies, one busy company can evict another's
history, causing re-delivery. Server-side idempotency absorbs this correctly, so it
costs work rather than correctness — but if multi-company pilots show churn, raise the
cap or evict per destination.

## STOP conditions

Stop and report the exact failed invariant rather than weakening it if:

1. Any path allows one supplier to deliver to two companies.
2. A token minted for one company is sent with a different company's id, on either side.
3. Migration loses a connection, or rebinds one to a company the user did not choose.
4. Local Downloads becomes an automatic fallback for a failed or disconnected company.
5. The ingest routes accept a Clerk session JWT, or the `rat_` extractor becomes
   reachable on any other route.
6. An installed Collector build is found to be speaking protocol v1 against production —
   the no-installed-population assumption is then wrong and needs an explicit
   compatibility decision before Ratatosk ships.

## Done criteria

1. All 16 acceptance rows pass in CI on both sides.
2. A user can connect two companies, bind suppliers to each, rebind one with the
   documented warning, and disconnect one without disturbing the other.
3. No Ratatosk surface ever displays a company that is not the supplier's actual
   destination.
4. An expired or revoked connection produces a per-company reconnect state, not a
   generic destination failure.
5. `docs/igdrasil-connect.md` describes protocol v2 including error codes, and
   `examples/igdrasil-connect-client.ts` matches the shipped Igdrasil client exactly,
   with a test that fails if they drift.
6. The status row in `plans/README.md` is updated with sanitized evidence.

## STOP CONDITION 6 — fired 2026-08-08, RESOLVED 2026-08-09

> **The no-installed-population assumption is false in letter, true in
> substance.** Production holds a live Collector connection, so an installed
> build IS speaking the pre-v2 protocol against production — but the owner
> confirmed on 2026-08-09 that **no users depend on it**. It is a test
> connection in an owned company. There is no population to protect, so no
> compatibility support is owed and Ratatosk is free to ship.
>
> **Decision: no v1 compatibility shim.** The protocol check stays, because it
> costs nothing and stops a stale build from being told it has no connection —
> which was one click from re-minting and rotating a working credential. That is
> refusing to lie, not supporting v1. Nothing in the app or the extension
> tolerates protocol v1 semantics.

Read from the production database on 2026-08-08:

| fact | value |
|---|---|
| `invoice_collector_tokens` rows | 1 |
| company | `Igruppen Lindström AB` (`de49d017-c0f9-40ea-9f6e-b10d1f10abee`) |
| connected at | 2026-08-03 20:34 UTC |
| documents with `import_source = 'invoice_collector'` | 16 |
| delivered | 2026-08-04 06:29 UTC |
| token last used / expires | 2026-08-04 06:29 UTC / 2026-11-01 UTC |

### What actually breaks, and what does not

The web app is deployed independently of the extension, so the app reaches v2
first. Against an installed pre-v2 extension:

- **Collection keeps working.** `/api/documents/ingest` is unchanged apart from
  the sliding renewal and duplicate-on-replay, both backward-compatible, and the
  stored token is valid until 2026-11-01. Invoices keep flowing. ✅
- **The settings view reports "not connected".** It reads `result.companies`;
  a pre-v2 extension answers `{ ok, connected, companyId }` with no list. The
  one user who has this working would be told they have no connection while 16
  invoices already arrived. ❌ **This is the regression.**
- **Disconnect still works**, because a pre-v2 handler ignores the `companyId`
  it is now sent and clears its single destination. ✅ (accidentally)
- **Re-connect still works**, because a pre-v2 handler destructures only the
  four fields it knows and ignores `companyName`/`expiresAt`. ✅
- **A refusal renders a fallback sentence**, not `undefined`: pre-v2 answers
  carry prose and no `code`, which `collectorErrorMessage` now handles. ✅

### The decision, and why

Three options were put to the owner: tolerate a v1 status reply in the app,
require the extension update, or reconnect the affected connection deliberately.
The Collector is not in the Chrome Web Store (Plan 006 forbids a listing), so
there is no auto-update channel and "require the update" means hand-delivering a
build.

**Chosen: require the update, with no compatibility shim.** With no users on the
connection there is nobody to keep working in the meantime, so a v1 branch would
be code carried for a case that has no claimant. The stale test credential can
be revoked whenever convenient; it lapses on its own on 2026-11-01.

Residual note: that test token is upload-capable and sits in a browser profile
until then. Revoking it is one `DELETE /api/documents/ingest/token`, or simply
disconnecting from the extension panel.

## Review round 2 (2026-08-08) — a regression this work introduced

A code review of both PRs found twelve issues; all were real and all are fixed.
Two were severe and both came from the same mistake, so it is worth naming:

**`igdrasil:connect` was written as a refusal when the server it pairs with is
an upsert.** `POST …/invoice-collector/token` is
`ON CONFLICT (company_id) DO UPDATE SET token_hash = …`, so by the time the
extension sees `igdrasil:connect` the server has ALREADY rotated that company's
credential. Refusing with `company_already_connected` left the extension holding
a token the server no longer accepts: every subsequent ingest for that company
would 401, and the destination would be retired. Worse, the same guard read
`unavailable` destinations too, so a connection retired that way could never be
repaired — the notification said "Reconnect it" and the only path was refused.

Connect is now an upsert on both sides, which is the only shape that agrees with
the mint, and is also the way back from a revoked credential.
`company_already_connected` is gone from the protocol entirely; there is nothing
left for it to describe.

Also corrected:

- The inactivity warning read the credential's expiry, which the extension
  learns once at connect and the server slides silently — so a company
  collecting daily would have been told it had been idle for 60 days.
  `igdrasil:status` now carries `lastCollectedAt`, measured from what was
  actually delivered.
- The migration replaced the whole token map instead of merging, so a re-run
  after an interrupted worker would strand a later-connected company's
  destination with no credential.
- A pre-v2 extension is now detected and the user is told to update, instead of
  being shown an empty company list with a Connect button — which was one click
  from re-minting and rotating the live production credential (see the STOP
  condition above).
- The connect route pings (with its retry) before asking for status, keeps its
  selection inside what it actually offers, and translates thrown mint errors.
- A transport failure is `extension_unavailable`, not `invalid_request`; the
  popup renders refusal labels rather than raw codes; the settings view keeps
  its last known list when a refresh fails rather than reporting nothing
  connected.

## Implementation record (2026-08-08)

Ratatosk `feat/multi-company-destinations`; Igdrasil `feat/collector-ingest-surface`.

### A premise of this plan was already stale

"Current state — Igdrasil (`0ffca701e`): v1 stub only" is wrong, and the drift
check could not catch it because `services/engine-api/src/integrations/` was not
in the list of paths it covers. `igdrasil-accounting` PR #1575 ("Fix Ratatosk
connection and Collector ingestion contract") had already landed:

- `POST /api/v1/integrations/invoice-collector/token`, `POST
  /api/documents/ingest`, and `DELETE /api/documents/ingest/token`;
- the `invoice_collector_tokens` table, storing only a SHA-256;
- a frontend client that mints a `rat_` credential — not a session JWT — and
  sends `apiBaseUrl` as exactly `https://accounting.igdrasil.se` with a
  `connection_state`;
- the `/integrations/invoice-collector/connect` route in `App.tsx`.

The defects the plan describes as *design* consequences of single-company were
real and are fixed. The parts described as *absent* were present, so the shipped
surface was corrected rather than rebuilt.

### Deviations, and why

| Plan says | Shipped | Why |
|---|---|---|
| Token mint at `POST /api/documents/ingest/token` | `POST /api/v1/integrations/invoice-collector/token` | The shipped path works and is already the one the extension's revoke counterpart pairs with. Moving it would break a live surface for no gain. |
| Repeat idempotency key returns `409 {"duplicate": true}` | `200 {"duplicate": true}` + `Idempotent-Replayed: true` | `http-sink.ts:104` treats both identically, and the platform idempotency contract (documented in the OpenAPI spec) replays the stored status. The row-12 requirement — a repeat key must be reported as a duplicate, never as a new document — is met; the previous behaviour replayed the stored `duplicate: false`. |
| Add the token surface behind a disabled flag, enable in step 9 | No flag | The surface is already live in production. Adding a flag would take a working surface offline to turn it back on. |
| One token per (company, browser profile) | One token per company | `invoice_collector_tokens` is keyed by `company_id`. A second browser connecting the same company replaces the first's credential. Out of scope to change; recorded as a known limit. |

### Acceptance matrix

All 16 rows are automated and passing.

| # | Where |
|---|---|
| 1, 2, 4, 5, 6, 8 | `test/core/igdrasil-multi-company.test.ts` |
| 3 | `test/core/igdrasil-multi-company.test.ts` (row 3 asserts the header/credential pairing on a real sink) |
| 7 | `test/core/igdrasil-multi-company.test.ts` + `test/core/collector-run.test.ts` |
| 9, 11, 13, 14, 15 | `services/engine-api/tests/invoice_collector_plan014.rs` (`#[sqlx::test]`) |
| 10 | `invoice_collector_plan014.rs` — a source inventory that fails if the `rat_` bearer gains a third call site |
| 12 | `invoice_collector_plan014.rs` |
| 16 | `test/core/igdrasil-contract-fixtures.test.ts` + `invoice_collector_plan014.rs`, both against `manifest.json` |

### Gates

Ratatosk: `npm run ci` (typecheck, boundaries, vendor validation, 869 tests) — pass.
Igdrasil: `cargo clippy -p engine-api --all-targets -- -D warnings` — pass;
`cargo test -p engine-api --test invoice_collector_plan014` — 13 pass;
`tsc -b` — pass; frontend vitest — 1818 pass.

`cargo fmt --check` reports pre-existing diffs in `cli_contracts/bank/`,
`staged_operations/executor.rs`, and `bank_reconciliation_projection_drift.rs`,
which are untouched by this work and were already unformatted on `origin/main`.

### What remains: step 9 live acceptance

**Not done, and it can only run against production.** There is no staging
environment, and the extension is bound to exactly
`https://accounting.igdrasil.se` (`igdrasil-sink.ts:14`) — Fixed architecture
item 5. Pointing it anywhere else would weaken the origin invariant this plan
lists as a security invariant, so a local dry run is not available by design.

Its two prerequisites are decisions, not work:

1. **Merge both PRs and publish the frontend.** Only the frontend deploy is
   strictly required — all five assertions ride on already-live engine-api
   routes. (The engine-api changes still want deploying for the sliding renewal
   and duplicate-on-replay to hold in production, but rows 12 and 14 are covered
   by automated tests either way.)
2. **Load the extension.** `artifacts/ratatosk-collector-v0.8.49.zip` is built
   and packaged from this branch. It is not in the Chrome Web Store (Plan 006),
   so it is loaded unpacked via `chrome://extensions` → Developer mode → Load
   unpacked → `dist/collector`.

#### The procedure

Two companies the signed-in user owns; call them **A** and **B**. Two suppliers
with live sessions in the same browser profile; the bundled set is GitHub,
Railway, Slack, Vercel.

| # | Step | Passes when |
|---|---|---|
| 1 | Panel → Settings → Connect another company → pick A. Repeat for B. | Settings lists A and B, each with its own Disconnect. Igdrasil Settings → Invoice Collector lists both with supplier counts. |
| 2 | Connect supplier 1, choosing A. Connect supplier 2, choosing B. | Each supplier row reads `→ A` / `→ B`. No row names a company it does not feed. |
| 3 | Collect All. | Supplier 1's invoices appear in A's Inbox, supplier 2's in B's. Verify per company: `SELECT company_id, count(*) FROM documents WHERE import_source='invoice_collector' GROUP BY company_id;` |
| 4 | Supplier 1 menu → Send to B → confirm the warning. | The dialog states that invoices already delivered to A stay in A. After the run, supplier 1's history is delivered again **into B**; A's rows are unchanged. |
| 5 | Settings → Disconnect A. | The dialog names the suppliers bound to A. Afterwards they read "Paused · no destination" and are never moved to Downloads. B keeps collecting. |
| 6 | Revoke B's token server-side (`DELETE /api/documents/ingest/token` with B's bearer, or Disconnect from the Igdrasil app), then Collect All. | B's destination shows "connection expired" with a per-company Reconnect, the notification fires once for the company rather than once per supplier, and the outcome code is `destination_connection_expired` — not the generic `destination_unavailable`. |
| 7 | Reconnect B from the app. | It repairs in place: same destination id, suppliers still bound, nothing re-delivered. |

Step 7 is the one the review round added. It is not in the plan's original
matrix and would not have been exercised by it, which is how the refusal-versus-
upsert defect survived to review.

### Follow-up worth doing, deliberately not done here

`invoice_collector` has no Inbox source bucket of its own
(`inbox/services/repository.rs`), so a Collector document reaches Inbox but is
labelled "uploaded" and cannot be filtered for. Adding one touches the generated
OpenAPI client and the Inbox filter UI, which is outside this plan's scope.
