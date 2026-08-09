# "Connect Igdrasil" — protocol v2

How the Igdrasil web app connects a user's browser to the extension — so
collected invoices flow straight into the right Igdrasil company.

Ratatosk holds **several** connected companies at once. Each supplier feeds
**exactly one** of them. There is deliberately no "active company": a
supplier's destination is a property of that supplier, and an active-versus-bound
divergence is the defect this shape exists to remove.

## The shape of it

```
Ratatosk panel → /integrations/invoice-collector/connect?state=<one-use intent>
      │  auth / onboarding preserves returnTo
accounting.igdrasil.se (web app)
      │  pick a company → validate intent → mint upload-only token → igdrasil:connect
      ▼
connect-bridge.ts  (content script — runs ONLY on accounting.igdrasil.se)
      │  chrome.runtime.sendMessage (internal)
      ▼
service worker  →  consumes intent, stores that company's token, upserts a destination
```

The web app never needs the extension id, and it can detect whether the
extension is installed. The extension trusts **only**
`https://accounting.igdrasil.se` and only ever sends a token to that exact
reviewed API origin.

## Production connection flow

1. Ratatosk creates a 64-hex, one-hour connection intent and opens the
   dedicated accounting-app route.
2. Existing users authenticate normally. Users without a company complete the
   normal onboarding flow. Both paths return to the dedicated route through its
   validated local `returnTo` value.
3. The route asks the user **which company** to connect. It does not inherit
   whichever company happens to be selected.
4. The web app asks the extension to validate the intent before calling the
   authenticated, tenant-scoped token endpoint. It includes that value as
   `connection_state`; the token endpoint rejects a missing, expired, or unbound
   state and binds it to its own short-lived, one-use mint transaction.
5. Engine API mints a 90-day `rat_…` credential that can only upload documents
   for the selected company. Only its SHA-256 hash is stored server-side.
6. The extension consumes the intent and stores that credential **under its
   company id**, alongside any companies already connected. Connecting a company
   it already holds re-establishes it rather than being refused: the token
   endpoint is an upsert, so by that point the server has already rotated the
   credential, and refusing would strand the extension with a token the server
   no longer accepts. It is also the way back from a revoked connection.
7. Suppliers deliver to `/api/documents/ingest`. Engine API creates `documents`
   rows with `import_source = invoice_collector`, which places them in Inbox. A
   successful ingest slides that company's expiry, so an actively used
   connection does not lapse. The renewed expiry is **not** returned, so the
   extension's stored `expiresAt` is a floor from connect time — the inactivity
   warning is computed from `lastCollectedAt`, which is what was delivered.
8. Disconnecting one company calls `DELETE /api/documents/ingest/token` with
   that company's bearer before removing it locally.

## Protocol reference

All messages are `window.postMessage` on the Igdrasil origin, wrapped as
`{ __ic: "invoice-collector", kind: "request" | "response", requestId, payload | result }`.
Every response carries `protocol: 2`. `payload.type` is one of:

| type | relayed to worker? | result |
|---|---|---|
| `igdrasil:ping` | no (answered by the bridge) | `{ ok, present, version, protocol }` |
| `igdrasil:prepare` | yes | `{ ok, protocol, state }` — creates a one-use intent |
| `igdrasil:validate` | yes | `{ ok, protocol }` — checks the intent before token minting |
| `igdrasil:connect` | yes | `{ ok, protocol }` — **upserts** a company; requires `companyName` |
| `igdrasil:status` | yes | `{ ok, protocol, companies: [{ companyId, companyName, supplierCount, expiresAt, lastCollectedAt, needsReconnect }] }` |
| `igdrasil:disconnect` | yes | `{ ok, protocol }` — requires `companyId` |

On load the bridge also emits `{ __ic, kind: "present", version, protocol }` so
an app that listens early learns of the extension without pinging. The presence
check retries — the bridge is a `document_idle` content script, and a single
1500 ms ping reported "not installed" to people who had it installed.

### Refusal codes

A refusal is `{ ok: false, protocol: 2, code }`. Prose belongs to whichever
surface renders it, so the accounting app can translate every failure instead
of pasting Ratatosk's English into an otherwise i18n'd toast.

| code | meaning |
|---|---|
| `intent_missing` | No connection intent exists to validate or consume. |
| `intent_expired` | The intent has lapsed or was already used. Start again from Ratatosk. |
| `origin_not_allowed` | The request did not come from the extension's own bridge on the reviewed origin. |
| `token_invalid` | The credential was not the upload-only `rat_…` shape, or could not be stored. |
| `backend_not_allowed` | `apiBaseUrl` was not exactly `https://accounting.igdrasil.se`. |
| `unknown_company` | The extension is not connected to the named company. |
| `invalid_request` | The payload did not narrow — including a protocol v1 connect (session JWT, no state). |
| `revoke_failed` | Server-side revocation could not be confirmed. The connection is still live. |
| `extension_unavailable` | The bridge could not reach the service worker. A transport failure, not a refusal. |

Clients must transition to a disconnected state only after `{ ok: true }`.
A refusal or timeout retains the connected state and presents a retryable error.

## Destination invariants

- **One supplier, one destination.** A `Connection` holds a single
  `destinationId`; there is no shape in which a supplier feeds two companies.
- **Disconnecting a company leaves its suppliers unbound and paused**, and names
  them. Local Downloads is never an automatic fallback — the user must choose a
  destination before those suppliers can run again.
- **Rebinding re-delivers.** Idempotency keys are tenant-scoped, so moving a
  supplier from company A to company B is a fresh dedup namespace and re-collects
  everything reachable. Invoices already delivered to A remain in A and cannot be
  retracted; the confirmation says so before the move.
- **An expired or revoked credential retires that one company** into a
  per-company reconnect state (`destination_connection_expired`), rather than
  failing every supplier bound to it with a generic destination error.
- **Persisted destinations are re-validated on read.** Anything that fails —
  including a v0.6.x endpoint carrying an `/api` path — becomes an `unavailable`
  destination that refuses delivery and offers reconnection.

## The shared contract

`test/fixtures/igdrasil-connect/` is the contract, mirrored byte-for-byte into
the Igdrasil repository under `services/engine-api/tests/fixtures/igdrasil-connect/`.
Both sides hash their own copy against `manifest.json`, so a change made in one
repository and not the other fails both suites. Regenerate with:

```bash
npx tsx scripts/build-contract-manifest.ts
```

`examples/igdrasil-connect-client.ts` carries the canonical bridge client
between its `---8<--- shared:` markers; the Igdrasil web app's
`frontend/src/lib/invoiceCollectorApi.ts` carries the same region, and both are
checked against it. That gate exists because the earlier "copy this file into
Igdrasil" instruction produced a client that diverged for three weeks with
nothing able to notice.

## Security notes

- The bridge content script runs **only** on `https://accounting.igdrasil.se/*`.
- The manifest grants the service worker cross-origin fetch access only to that
  exact host; all vendor host access remains optional and is requested per
  connection.
- Every relayed request is re-validated in the service worker: it must come from
  our own content script (`sender.id`) on an allow-listed origin
  (`sender.origin`), and each field is narrowed individually before use.
- The extension rejects general session JWTs and accepts only upload-only
  `rat_…` credentials. They are stored **per company** under `TRUSTED_CONTEXTS`,
  re-validated on read, and only sent to the allow-listed backend host (see
  [`SECURITY.md`](../SECURITY.md)).
- A company's token is only reachable through that company's id, so a request
  cannot carry one company's credential and another's `X-Company-Id`.
- Company names are stored locally only to label the UI. No invoice metadata or
  supplier evidence crosses into this repository's fixtures.
