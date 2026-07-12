# Adding a vendor

A vendor is a single declarative recipe. You don't touch the engine — you
describe *where* the invoices are, and the engine does the rest. Most recipes are
~40 lines and take an afternoon.

## 1. Find the endpoints (DevTools)

Open the vendor's billing/invoices page while signed in. Open DevTools →
**Network** → filter to `Fetch/XHR`, then reload.

You're hunting for three things:

| You need | What to look for |
|---|---|
| **auth probe** | A cheap authenticated call the app makes on load — often `/me`, `/session`, or `/user`. Note a field that's only present when logged in. |
| **invoice list** | An XHR whose JSON response contains the array of invoices. Note the URL and the path to the array. |
| **the PDF** | Click "download" on one invoice. Either the list already had a `pdf_url`, or a new request builds the PDF from an id. |

> **Cookie vs. token.** Network replay works when the vendor authenticates with
> **cookies** (most portals). If the billing calls send an `Authorization: Bearer`
> header that lives only in the page's JS memory, cookie replay alone won't
> authenticate — note it in the recipe and prefer the `dom` strategy, or capture
> the token via a content script. Checking this is part of verifying a vendor.

## 2. Copy the template

```bash
cp src/vendors/_template.ts src/vendors/acme.ts
```

Fill in `id`, `name`, `hosts`, `auth.check`, and `invoices`. The template is
commented line-by-line. Key ideas:

- **Paths are dotted:** `"data.invoices"`, `"response_metadata.next_cursor"`.
- **Transforms normalize values:** `{ kind: "divide", by: 100 }` turns cents into
  `"12.34"`; `{ kind: "date" }` turns any timestamp into `YYYY-MM-DD`.
- **`documentUrl` vs `documentRef`:** if the list gives a direct PDF link, map it
  to `documentUrl` and omit `document.request`. If you must build the URL from an
  id, map `documentRef` and template it in `document.request.url` as `{documentRef}`.
- **Multi-workspace vendors** use `config` to discover scopes (see `slack.ts`).

## 3. Record a fixture + write the test

Save one real list response:

```
test/vendors/fixtures/acme.invoices.json
```

Then create `test/vendors/acme.test.ts` (copy `slack.test.ts`) and assert the
mapping. This is **required** — CI fails a vendor with no test.

```bash
npm test
```

## 4. Register it

Add one import and one array entry in `src/vendors/index.ts` (keep it
alphabetical). That's the entire wiring — permissions, scheduling, and the UI
listing all derive from that array.

## 5. Verify end to end

```bash
npm run ci      # typecheck + schema validation + tests
npm run build   # load dist/ unpacked, click "Connect Acme"
```

Connecting requests host permission for your `hosts`, opens the vendor if the
session is cold, and runs a first sync. Watch the popup for the collected count.

## Checklist

- [ ] `hosts` covers every domain the recipe calls (and nothing more)
- [ ] `auth.check` reliably distinguishes logged-in from logged-out
- [ ] amounts normalized to a decimal string; dates to `YYYY-MM-DD`
- [ ] `vendorInvoiceId` is stable across time (it's the dedup key)
- [ ] a fixture + passing test exist
- [ ] the `notes` field records when/where you captured the endpoints
