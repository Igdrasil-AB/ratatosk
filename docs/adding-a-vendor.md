# Adding a vendor

A vendor is a single declarative recipe. You don't touch the engine — you
describe *where* the invoices are, and the engine does the rest. Most recipes are
~40 lines and take an afternoon.

## 1. Install the development build

Download [Ratatosk Studio v0.6.8](https://github.com/Igdrasil-AB/ratatosk/releases/download/v0.6.8/ratatosk-studio-v0.6.8.zip),
unzip it, then open `chrome://extensions`, turn on **Developer mode**, select
**Load unpacked**, and choose the unzipped folder containing `manifest.json`.

> **Developer build warning:** Studio requests Chrome's broad `debugger` and
> `activeTab` permissions. Install it only in a dedicated developer profile, use
> only authorized synthetic supplier accounts, and remove it when the supplier
> investigation is complete. It is not the consumer Collector extension.

## 2. Find the endpoints (DevTools)

Use a dedicated vendor test account with synthetic invoices. Either inspect the
page with Chrome DevTools or use the separately installed Studio development
extension and accept its capture disclosure. Never capture a customer or
personal account.

In DevTools, open the vendor's billing/invoices page while signed in, choose
**Network**, filter to `Fetch/XHR`, then reload.

You're hunting for three things:

| You need | What to look for |
|---|---|
| **auth probe** | A cheap authenticated call the app makes on load — often `/me`, `/session`, or `/user`. Note a field that's only present when logged in. |
| **invoice list** | An XHR whose JSON response contains the array of invoices. Note the URL and the path to the array. |
| **the PDF** | Click "download" on one invoice. Either the list already had a `pdf_url`, or a new request builds the PDF from an id. |

> **Cookie vs. token.** Network replay works when the vendor authenticates with
> **cookies** (most portals). If the billing calls send an `Authorization: Bearer`
> header that lives only in the page's JS memory, do not persist or embed that
> token. Treat support as blocked until there is a reviewed, least-privilege auth
> design. Checking this is part of verifying a vendor.

## 3. Copy the template

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

## 4. Record a fixture + write the test

Save one real list response:

```
test/vendors/fixtures/acme.invoices.json
```

Then create `test/vendors/acme.test.ts` (copy `slack.test.ts`) and assert the
mapping. This is **required** — CI fails a vendor with no test.

```bash
npm test
```

## 5. Register it

Add the recipe to `EXPERIMENTAL_VENDORS` in `src/vendors/index.ts` first. The
validator and tests cover experimental recipes, but Collector does not display or
package them as supported integrations.

Promotion into public `VENDORS` requires a current live test, reviewed fixture,
least-privilege host list, and explicit release decision. Keep both arrays
alphabetical.

## 6. Verify end to end

```bash
npm run ci      # typecheck + schema validation + tests
npm run build:collector
```

Load `dist/collector`, choose a destination, and connect Acme. Connecting requests
host permission for `hosts`, opens the vendor if the session is cold, and runs a
first sync. Watch the popup for the collected count. Follow `docs/testing.md` and
record non-sensitive pass/fail evidence.

## Checklist

- [ ] `hosts` covers every domain the recipe calls (and nothing more)
- [ ] `auth.check` reliably distinguishes logged-in from logged-out
- [ ] amounts normalized to a decimal string; dates to `YYYY-MM-DD`
- [ ] `vendorInvoiceId` is stable across time (it's the dedup key)
- [ ] a fixture + passing test exist
- [ ] the `notes` field records when/where you captured the endpoints
- [ ] Studio output and fixtures contain no token, cookie, real invoice, personal
      identifier, or unnecessary HTML
- [ ] public promotion was an explicit reviewed decision, not a registry default
