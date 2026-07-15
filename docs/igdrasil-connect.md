# One-click "Connect Igdrasil"

How the Igdrasil web app connects a user's browser to the extension in one click —
so collected invoices flow straight into their Igdrasil company.

## The shape of it

```
Ratatosk popup → /integrations/invoice-collector/connect?state=<one-use intent>
      │  auth / onboarding preserves returnTo
accounting.igdrasil.se (web app)
      │  validate intent → mint upload-only token → igdrasil:connect
      ▼
connect-bridge.ts  (content script — runs ONLY on accounting.igdrasil.se)
      │  chrome.runtime.sendMessage (internal)
      ▼
service worker  →  consumes intent, stores scoped token, sets the Igdrasil sink
```

The web app never needs the extension id, and it can detect whether the extension
is installed. The extension trusts **only** `https://accounting.igdrasil.se` and
only ever sends the token to an `*.igdrasil.se` https backend.

## Production connection flow

1. Ratatosk creates a 64-hex, one-hour connection intent and opens the
   dedicated accounting-app route.
2. Existing users authenticate normally. Users without a company complete the
   normal onboarding flow. Both paths return to the dedicated route through its
   validated local `returnTo` value.
3. The web app asks the extension to validate the intent before calling the
   authenticated, tenant-scoped token endpoint.
4. Engine API mints a 90-day `rat_…` credential that can only upload documents
   for the selected company. Only its SHA-256 hash is stored server-side.
5. The extension consumes the intent, stores that scoped credential, and sends
   future invoices to `/api/documents/ingest`. Engine API creates `documents`
   rows with `import_source = invoice_collector`, which places them in Inbox.
6. Disconnect calls `/api/documents/ingest/token` with `DELETE` before clearing
   the local destination, revoking the bearer credential.

## Protocol reference

All messages are `window.postMessage` on the Igdrasil origin, wrapped as
`{ __ic: "invoice-collector", kind: "request" | "response", requestId, payload | result }`.
`payload.type` is one of:

| type | relayed to worker? | result |
|---|---|---|
| `igdrasil:ping` | no (answered by the bridge) | `{ ok, present, version }` |
| `igdrasil:prepare` | yes | `{ ok, state }` — creates a one-use intent for an in-app action |
| `igdrasil:validate` | yes | `{ ok }` — checks the intent before token minting |
| `igdrasil:connect` | yes | `{ ok }` — stores token + Igdrasil sink |
| `igdrasil:status` | yes | `{ ok, connected, companyId }` |
| `igdrasil:disconnect` | yes | `{ ok }` — clears token, reverts to local saving |

On load the bridge also emits `{ __ic, kind: "present", version }` so an app that
listens early learns of the extension without pinging.

## Security notes

- The bridge content script runs **only** on `https://accounting.igdrasil.se/*`.
- The manifest grants the service worker cross-origin fetch access only to that
  exact host; all vendor host access remains optional and is requested per
  connection.
- Every relayed request is re-validated in the service worker: it must come from
  our own content script (`sender.id`) on an allow-listed origin (`sender.origin`).
- The extension rejects general session JWTs and accepts only an upload-only
  `rat_…` credential. It is stored in extension-local storage so background sync
  survives a browser restart and is only sent to the allow-listed backend host
  (see [`SECURITY.md`](../SECURITY.md)).
- `apiBaseUrl` is rejected unless it is `https` on an `*.igdrasil.se` host.
