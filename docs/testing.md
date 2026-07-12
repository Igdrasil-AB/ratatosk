# Testing a vendor live

Unit tests cover the pure logic (mapping, routing, decoding, the engine run with
a mocked fetch). The one thing they can't cover is whether a real fetch survives
a vendor's live auth + bot protection. Here's how to test that end to end — no
backend required.

## 1. Build and load

```bash
npm run build
```

`chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
`dist/`.

## 2. Dry-run mode (no backend)

If no sink is configured, the collector performs a **dry run**: it fetches and
counts documents but sends nothing and marks nothing seen. That is exactly what
you want to confirm a vendor's fetch works. So you can skip straight to connecting.

## 3. Connect the vendor

Open the extension popup → click **Connect** next to the vendor (e.g. Anthropic).

- You'll be prompted to grant host permissions for that vendor's domains — accept.
- Make sure you're **logged into the vendor** in this browser (for Anthropic,
  claude.ai). The extension rides that session; it never sees your password.
- The extension reuses an open vendor tab, or briefly opens a background one.

The popup pill then shows the outcome:

| Pill | Meaning |
|---|---|
| `N · just now` | ✅ fetched N invoices (dry run — not sent anywhere) |
| `Reconnect` | session wasn't valid — sign into the vendor and retry |
| `Error` | something failed — see the service worker logs (below) |

## 4. Watch the logs

`chrome://extensions` → the extension's **service worker** link → **Console**.
You'll see the run, and for a `page`-mode vendor, the tab it drove. Errors carry
the typed reason (`AuthExpired`, `SelectorMiss`, an HTTP status, …).

## 5. What "works" looks like for Anthropic

- A `claude.ai` tab is used/opened.
- The `/api/organizations` probe returns 200 (session alive).
- Both orgs are enumerated; the one without billing is skipped, not fatal.
- The subscription org's invoices are listed and their Stripe PDFs downloaded.
- The pill shows the invoice count.

If it shows `Reconnect`, the claude.ai session wasn't live in this browser. If it
errors on the list call specifically, that's the Cloudflare signal — verify the
tab actually loaded claude.ai and you're logged in.

## 6. With a backend

To test the full path (documents actually landing somewhere), configure a sink
first via the popup/options, then connect. `http` sink → any URL that accepts the
multipart POST (see `src/ingest/http-sink.ts`); `igdrasil` sink → engine-api's
`/documents/ingest`.
