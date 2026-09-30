# Plan 020: Send reviewed Ratatosk feedback into Chatwoot with a durable receipt

> **Executor instructions**: Implement the Svala intake first in a clean Svala
> worktree, then the Collector client in a separate Ratatosk worktree. Use a
> synthetic shared contract fixture and land neither side until both parsers
> agree. Chatwoot is a notification/triage projection; Svala PostgreSQL is the
> accepted-report record. Keep the Chatwoot API token on the server. Run each
> verification gate, then update `plans/README.md` after review.
>
> **Drift check**: In Ratatosk compare `c74927d..HEAD` for
> `collector/src/platform/{diagnostics,discovery-diagnostic,issue-report,
> service-worker,messaging,storage}.ts`, `collector/src/ui/popup/popup.ts`,
> `collector/manifest.config.ts`, `PRIVACY.md`, `SECURITY.md`, and reporting tests.
> In Svala compare current `origin/main` with planning SHA `a7448e2`
> for `svala-app/app/api/dev/ratatosk/`, `svala-app/lib/features/dev/ratatosk-intake.ts`,
> `svala-app/lib/db/schema.ts`, `svala-app/scripts/`, `svala-app/package.json`,
> and `svala-app/deploy/aws-cli/`. Do not assume a local worktree is deployed.

## Status

- **Priority**: P0 after trustworthy Jenkins gating
- **Effort**: L, cross-repository backend, extension, and deployment work
- **Risk**: HIGH; public intake, privacy, abuse, and third-party delivery
- **Depends on**: Plan 019 Jenkins gate; merge and verify Ratatosk's current
  `feat/last-run-diagnostics` work before changing its report UI
- **Category**: product feedback, security, integration
- **Planned at**: Ratatosk `c74927d`, Svala `origin/main` `a7448e2`, 2026-09-30
- **Status**: IN PROGRESS — local intake, worker, and reviewed client built; live inbox rollout pending

## Local implementation evidence (2026-10-01)

- Diagnostics commit `17af0c2`, reviewed Collector feedback commit `798a05d`,
  combined Ratatosk commit `3f2d31d`, and Svala commit `9d51bd8` are local and
  clean. They have not been pushed, merged to main, or deployed.
- The browser-generated synthetic report is 4.5 KiB and has identical SHA-256
  `083b5ba2c5fcc642574a0950d5ad4f541bb4d326b60c7ac1b1212de22707b495`
  in both repositories. Svala's strict parser accepted the actual report from
  built Chrome. A disposable PostgreSQL test sent it through the public route,
  stored one receipt, projected one contact/conversation/message through a fake
  Chatwoot API, and returned the same receipt without another send on replay.
- The final Svala branch passed 1,113 tests on a disposable PostgreSQL database,
  typecheck, production build, and an audit with zero production advisories.
  Migration status showed 89 applied, zero pending and zero checksum mismatch.
  Built Chromium exercised review, unsafe-note rejection, duplicate click,
  a simulated outage, worker stop, popup reopen, and same-body retry.
- A local Caddy proxy overwrote a spoofed client-address header with its peer
  address. The production Caddy and database still need deployment readback.
  No dedicated Chatwoot API inbox/token, live test conversation, internal
  rollout, or accepted release ZIP exists yet.

## Why and architecture

Collector's Report Issue currently copies a redacted diagnostic and opens a
GitHub draft. A user must paste and publish it manually; maintainers receive
no receipt or internal inbox event. The last-run diagnostics work on
`feat/last-run-diagnostics` adds typed first/terminal failures, bounded
multi-scope/replay evidence, run build identity, and missing/wrong-document
report choices, but **is uncommitted at planning time**. Confirm its merged
schema and privacy tests before implementing this plan.

Use this flow:

```text
explicit review in Collector
  -> POST one bounded report to Svala
  -> PostgreSQL commit + opaque receipt (the user-visible success boundary)
  -> small durable delivery worker
  -> dedicated Ratatosk API inbox at chat.igdrasil.se
  -> Chatwoot conversation ID stored against the Svala report
```

Svala already has a PostgreSQL Ratatosk fingerprint intake pattern at
`svala-app/app/api/dev/ratatosk/fingerprints/route.ts`, with a bounded JSON
reader, idempotency, receipts, token hashing, and tests. It is **developer-only
Studio fingerprint intake**; its token and schema must not be reused for an
anonymous Collector report. Svala's production Docker Compose already runs
separate workers (`svala-app/deploy/aws-cli/user-data.sh`, `activity-alerts`).
Use that deployment pattern for a small feedback dispatcher, without waiting
for the separately blocked Temporal platform.

The Igdrasil landing page uses a Chatwoot **website widget**, and support
email aliases feed an existing Chatwoot email inbox. Neither is the Collector
API contract: a remote widget script violates Collector's packaged-code rule,
and routing machine reports into the general email inbox risks noisy tickets.
Provision a dedicated Ratatosk API inbox and server-side Application API user.
Chatwoot's [Application API](https://developers.chatwoot.com/api-reference/introduction)
requires an account token and supports [contacts](https://developers.chatwoot.com/api-reference/contacts/create-contact),
[conversations](https://developers.chatwoot.com/api-reference/conversations/create-new-conversation),
and [messages](https://developers.chatwoot.com/api-reference/messages/create-new-message).
The API inbox identifier and contact identifier exposed by the
[Client API](https://developers.chatwoot.com/api-reference/introduction)
are not a substitute for server validation and durable intake.

## Contract and privacy rules

Create `ratatosk.feedback.v1`, a strict discriminated envelope containing:

- `reportId`: random UUID generated once at the user's Send click and reused
  for retries; `kind`: `discovery`, `collection_failure`, `missing_invoices`,
  or `wrong_document`.
- Exactly one **allowlisted** current discovery or Collector diagnostic. The
  server independently re-parses every nested enum, count, timestamp, replay
  phase, and route template; unknown fields are rejected, not stored.
- Optional user-written note capped at 500 characters, displayed in the final
  review, normalized as plain text, and never copied into structured fields.
  Reject obvious URL, token, and account-identifier patterns, but do not claim
  arbitrary free text can be proven anonymous. A warning says not to include
  invoice/account data. No screenshot, PDF, HAR,
  selector, raw URL/query, HTTP body/header, token, amount, or invoice ID.
- No installation-wide identifier, company ID, Igdrasil token, or Chatwoot
  credential. The diagnostic already contains a supplier hostname for discovery
  and a closed vendor ID for collection; the review shows exactly that disclosure.

Limit the encoded request to 64 KiB before parsing; a bounded 40-page discovery
diagnostic can exceed a tiny form-style limit. `Idempotency-Key` equals
`reportId`. The server computes a canonical hash of the strictly parsed
envelope. The same ID+hash returns the same receipt; the same ID with different
content returns 409 without altering either record. A bounded report receipt
contains `reportId`, `acceptedAt`, and `status: received` only; it must not
claim Chatwoot delivery. This is a **public** endpoint, so do not place a
static secret in the extension and do not treat `Origin` as authentication.
Use a trusted-proxy client-address contract, bounded per-source and global
quotas, and a feature flag before exposing it. In
`svala-app/deploy/aws-cli/user-data.sh`, make Caddy discard inbound
client-address forwarding headers and set one proxy-owned address header;
the route must reject missing/malformed values. Do not retain raw client IP in
the report table or logs.

## Scope and commands

**Ratatosk in scope**: `collector/src/platform/issue-report.ts`,
`collector/src/ui/popup/popup.ts`, `collector/src/platform/{messaging,
service-worker}.ts`, a small typed transport/pending-report module under
`collector/src/platform/`, `PRIVACY.md`, `SECURITY.md`, `README.md`,
`docs/testing.md`, and existing diagnostic/report/browser test files. Reuse
the optional HTTPS permission envelope: request only exact
`https://svala.igdrasil.se/*` during the user's Send gesture. Pin the POST URL
in source and set `redirect: "error"`; never accept a remote URL from a report.

**Svala in scope**: a new migration in `svala-app/lib/db/schema.ts`,
`svala-app/app/api/public/ratatosk/feedback/route.ts`, a dedicated feedback
parser/repository/Chatwoot adapter under `svala-app/lib/features/`, a bounded
worker in `svala-app/scripts/`, worker command in `svala-app/package.json`,
`svala-app/deploy/aws-cli/user-data.sh` plus env/deployment contract tests,
and focused unit/integration tests. Add a named Ratatosk API inbox and a
server-held, least-privilege Chatwoot Application API credential through the
existing production secret-rendering path; never put its value in Git/Jenkins.

**Out of scope**: automatic error uploads, raw console logging, account linking,
Chatwoot widget/remote JS in the extension, supplier captures, recipe changes,
using Studio fingerprint tokens, replying inside the extension, and automatic
issue creation or recipe promotion from a Chatwoot conversation.

| Purpose | Command | Expected |
| --- | --- | --- |
| Ratatosk | `npm ci && npm run ci && npm run build:collector && npm run test:chrome-discovery:built && npm run test:chrome-acquisition:built` | Exit 0; built extension uses only synthetic cases |
| Ratatosk security | `npm run audit:security && npm run package:collector && npm run verify:collector-artifact` | No high advisory; exact ZIP excludes keys and unreviewed permissions |
| Svala | `cd svala-app && npm ci && npm run typecheck && npm test && npm audit --omit=dev --audit-level=high && npm run db:migrate && npm run db:status && npm run build` | Exit 0 against a disposable PostgreSQL test DB where required; status has zero pending migrations and no high production advisory |
| Contract | Compare synthetic v1 fixture bytes/hash in both repositories | Parsers accept/reject the same population |

## Steps

`db:verify-migration` compares a legacy SQLite export with PostgreSQL row
content. It does not verify a new Ratatosk table, so the gate above uses the
PostgreSQL migration runner and status plus focused schema tests.

### 1. Freeze the cross-repository contract

Add identical synthetic valid/invalid fixtures in Ratatosk `test/fixtures/`
and Svala `svala-app/tests/fixtures/`. Include a collection failure, failed
discovery, missing-invoice report after an `ok` run, malformed nested replay,
extra field, oversized note/body, identifier-looking path, token canary, and
same-ID/different-body conflict. Reuse Ratatosk's existing
`buildCollectorDiagnostic`/`parseDiscoveryDiagnostic` allowlists; Svala must
validate independently rather than trust a TypeScript cast or client claim.

**Verify**: focused parser tests in both repos pass and fixture hashes match.
No canary appears in a serialized accepted report or error response.

### 2. Store a report and receipt before delivery

Allocate the next migration ID from current Svala `origin/main`; do not reuse a
number from the planning checkout. Add `ratatosk_feedback_reports` with unique `report_id`, request hash, schema
version, kind, sanitized diagnostic JSONB, optional note, accepted timestamp,
and delivery state. Add a one-to-one delivery row with bounded attempts,
next-at time, last **closed** error code, and nullable Chatwoot IDs. The
transaction checks idempotency and inserts report+delivery once. Return 201
for new acceptance, 200 with the same receipt for exact replay, 409 for
content conflict. Response/cache headers are `no-store`; reject unsupported
media type, invalid UTF-8, and excess bytes before `JSON.parse` as the
fingerprint route does. Apply rate limits **before** accepted report writes.

**Verify**: PostgreSQL integration tests cover concurrent same/different
replays, 429, malformed/oversized requests, untrusted forwarded-address
headers, and a simulated DB rollback. There is one report and delivery row
per accepted ID, zero rows for rejected input, and no raw IP or canary in
logs/DB/error responses. If the trusted client-address contract cannot be
proved behind production Caddy, stop before enabling public intake.

### 3. Dispatch to a dedicated Chatwoot inbox

Add a worker following `svala-app/scripts/activity-alert-worker.ts` and the
existing Docker Compose worker pattern. Claim pending rows with a PostgreSQL
lease so two workers cannot send the same report concurrently. Use an exact
configured HTTPS `chat.igdrasil.se` base, reject redirects, set short
timeouts, and keep the API token only in the worker environment. Render a
plain-text incoming message from the **server-validated** fields, headed by
the report ID/type/build/stage; create a Chatwoot contact in the dedicated
inbox, use its returned `contact_inboxes.source_id` with `inbox_id` and
`contact_id` to create the conversation, then add a text message with
`message_type: incoming` and `private: false`. Persist Chatwoot IDs after
success. Never send the raw JSON
request, `Error.message`, or logs to Chatwoot. The contact is anonymous and
one-way in v1; do not promise an in-extension reply channel.

Retry definite pre-send transport failures and documented rate-limit responses
with capped backoff. Treat a timeout or 5xx after submission as ambiguous.
Because Chatwoot's documented conversation API does not promise an
idempotency key, an ambiguous timeout after a create must enter
`needs_reconciliation`, not blindly create a duplicate. Include `reportId`
in the message so an operator can reconcile it and save the Chatwoot IDs.
Do not mark the Svala report unreceived if Chatwoot is down. Expose closed
pending/sent/reconciliation counts to internal operations without payloads.

**Verify**: a fake Chatwoot server proves exact endpoints/auth, plain-text
payload, no redirects, retry/backoff, concurrent-worker exclusion, and the
ambiguous-response state. A synthetic report reaches a **test inbox** on the
configured Chatwoot instance and links back to the same Svala report ID.
No real supplier data is used in this check.

### 4. Replace GitHub draft as the primary Collector report action

After the diagnostics branch is merged, add a compact review state in the
existing popup for failure and false-success choices. Show site/vendor ID,
typed summary, optional note, and the destination `Igdrasil support` before
requesting exact Svala host access and sending. Retain a bounded pending
envelope locally across popup/worker restart; a Send click grants consent for
safe retry, but never sends another run automatically. Show `Sending`,
`Received <reportId>`, retryable, and rejected states. Exact replay reuses the
same ID/body; a user edit creates a new ID. Keep Copy Diagnostic/GitHub draft
as an explicit fallback while the service is unavailable; do not open GitHub
or Chatwoot automatically.

**Verify**: built Chromium with a local fake Svala server tests first send,
offline/retry, duplicate click, 429/5xx, 4xx rejection, worker/popup restart,
permission denial, and report preview. A seeded secret/URL/invoice canary
never reaches transport, storage, clipboard, or Chatwoot fixture output.
Package inspection finds no Chatwoot token, remote script, unexpected host
permission, or supplier data in the ZIP.

### 5. Roll out and close the loop

Deploy Svala migration/worker disabled, configure a dedicated Chatwoot API
inbox and server credential, then exercise synthetic Svala/Chatwoot delivery.
Enable only for internal testers first. Release the exact Collector ZIP through
Plan 019's Jenkins gate, update privacy/store permission wording, and verify a
user-reviewed synthetic report receives one Svala receipt and one Chatwoot
conversation. Read back the report ID/status from the DB and Chatwoot, then
review a real opt-in report only after the privacy gate passes. Reconcile
ambiguous deliveries manually. Maintain a small triage ledger linking report
ID, generic shape regression, fix PR, and release; never attach supplier data.

**Verify**: accepted/replayed/rejected report cases, worker outage recovery,
and `received` vs `chatwoot_sent` states match across extension, DB, and
Chatwoot. Jenkins is terminal green on the exact Ratatosk/Svala revisions;
the deployed Svala runtime and Chatwoot inbox identity are verified separately.

## STOP conditions

- `feat/last-run-diagnostics` is unmerged or its exported schema differs from
  the frozen v1 fixture; do not build around a draft shape.
- A static Chatwoot or Svala intake secret would be packaged in Collector, or
  the extension would need remote Chatwoot SDK code.
- Public intake lacks a proven trusted client-address/rate-limit boundary.
- Structured diagnostic fields cannot reject raw paths, arbitrary keys, or
  excessive payloads independently of the extension. Free-text notes must be
  visibly optional and must reject obvious secret/URL patterns without a false
  claim that every possible sensitive sentence can be detected.
- PostgreSQL cannot commit report+receipt+delivery atomically.
- An ambiguous Chatwoot call would be retried without reconciliation.
- The new Svala worker cannot be deployed independently and monitored with
  bounded, payload-free status.

## Maintenance

Version the feedback contract independently from Collector releases. Keep
private reports out of public Jenkins artifacts, GitHub issues, Svala activity
payloads, and Temporal history. Review API and privacy changes together. A
Chatwoot conversation is for fast human triage; the Svala receipt is the
durable acknowledgment and deduplication key. If a later reply channel is
desired, design it separately with explicit contact consent and identity.
