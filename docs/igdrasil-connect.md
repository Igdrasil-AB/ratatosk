# One-click "Connect Igdrasil"

How the Igdrasil web app connects a user's browser to the extension in one click —
so collected invoices flow straight into their Igdrasil company.

## The shape of it

```
accounting.igdrasil.se (web app)
      │  window.postMessage  { type: "igdrasil:connect", token, companyId, apiBaseUrl }
      ▼
connect-bridge.ts  (content script — runs ONLY on accounting.igdrasil.se)
      │  chrome.runtime.sendMessage (internal)
      ▼
service worker  →  validates sender.origin, stores token (session), sets the Igdrasil sink
```

The web app never needs the extension id, and it can detect whether the extension
is installed. The extension trusts **only** `https://accounting.igdrasil.se` and
only ever sends the token to an `*.igdrasil.se` https backend.

## Web-app integration (3 steps)

1. **Copy the client.** Drop [`examples/igdrasil-connect-client.ts`](../examples/igdrasil-connect-client.ts)
   into the frontend. It's framework-agnostic and dependency-free.

2. **Add a control.** Use [`examples/ConnectInvoiceCollector.tsx`](../examples/ConnectInvoiceCollector.tsx)
   as a starting point (e.g. on a Settings → Integrations page), swapping the two
   placeholder hooks for your real session-token getter and active-company id:

   ```ts
   const { present } = await pingInvoiceCollector();          // is it installed?
   if (present) {
     const res = await connectInvoiceCollector({
       token: await getSessionToken(),                        // the user's Igdrasil JWT
       companyId,
       apiBaseUrl: "https://api.igdrasil.se",                 // must be *.igdrasil.se
     });
     // res.ok === true → the extension now collects into this company
   }
   ```

3. **Show state.** `getInvoiceCollectorStatus()` returns `{ connected, companyId }`
   so the UI can render "Connected" vs "Connect"; `disconnectInvoiceCollector()`
   clears the token and reverts the extension to saving locally.

## Protocol reference

All messages are `window.postMessage` on the Igdrasil origin, wrapped as
`{ __ic: "invoice-collector", kind: "request" | "response", requestId, payload | result }`.
`payload.type` is one of:

| type | relayed to worker? | result |
|---|---|---|
| `igdrasil:ping` | no (answered by the bridge) | `{ ok, present, version }` |
| `igdrasil:connect` | yes | `{ ok }` — stores token + Igdrasil sink |
| `igdrasil:status` | yes | `{ ok, connected, companyId }` |
| `igdrasil:disconnect` | yes | `{ ok }` — clears token, reverts to local saving |

On load the bridge also emits `{ __ic, kind: "present", version }` so an app that
listens early learns of the extension without pinging.

## Security notes

- The bridge content script runs **only** on `https://accounting.igdrasil.se/*`.
- Every relayed request is re-validated in the service worker: it must come from
  our own content script (`sender.id`) on an allow-listed origin (`sender.origin`).
- The token is stored in `chrome.storage.session` (in-memory) and is only ever
  sent to the allow-listed backend host (see [`SECURITY.md`](../SECURITY.md)).
- `apiBaseUrl` is rejected unless it is `https` on an `*.igdrasil.se` host.
