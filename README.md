# Invoice Collector

A browser extension that automatically collects **supplier invoices and receipts**
from vendor portals — using your own logged-in browser session, so **your vendor
passwords never leave your machine**.

It replaces the tedium of logging into a dozen SaaS/cloud/ad portals every month
to download PDFs. Instead, the extension calls each vendor's *own* billing API the
same way their billing page does, grabs the PDF, and posts it to your backend —
on a schedule, in the background, while your browser is running.

> **Why not a cloud service with your passwords?** Because it doesn't need them.
> The extension rides the session you already have. No credential vault, no
> stored 2FA, nothing to breach. That's the whole design.

---

## One purpose

Invoice Collector does exactly one thing: **collect your own supplier invoices and
receipts into your accounting backend.** Everything in the extension serves that
single purpose.

The **recorder** ("Studio") is an *authoring aid* for that same purpose — it watches a
vendor's billing page while you're on it so it can write a reusable **recipe** that
teaches the collector how to read that vendor. It is not a general-purpose
network-debugging tool, and it runs only when you explicitly click **Record**.

**Recipes are declarative data, never code.** A recipe is a frozen, validated shape —
endpoint templates, JSONPath field maps, and a *closed, fixed* set of transforms that
ship in the extension package. The schema (`src/core/schema.ts`) is `.strict()` and
rejects anything else, so a recipe hot-loaded from a backend can only *select and
parametrize* logic that already lives in the code — it can never carry behavior of its
own. That keeps the catalog firmly on the allowed side of Chrome's remote-code policy.

---

## How it works (30 seconds)

```
chrome.alarms (daily)
   ▼
service worker wakes
   ▼
for each connected vendor:
   auth-probe ──✗──▶ "reconnect" notification
       │✓
   call the vendor's billing JSON API  (credentials: 'include' → your cookies)
       ▼
   map → dedup → download PDF → POST /documents/ingest
```

The robust part is **network replay**: rather than scraping HTML, a recipe
declares the vendor's internal billing endpoint, and the worker replays it on the
live session. It survives visual redesigns because it depends only on the API
shape. See [`docs/architecture.md`](docs/architecture.md).

---

## Repository layout

```
src/
  core/        Platform-free engine. No chrome.* — runs in Node, tests, CI.
    types.ts       the whole recipe vocabulary
    schema.ts      Zod validation (also the source of the JSON Schema)
    engine.ts      auth → scopes → list → dedup → download (one code path)
    strategies/    network replay (default) + dom fallback
  vendors/     THE CONTRIBUTOR SURFACE — one file per vendor, pure data
    _template.ts   copy me
    anthropic.ts   real capture (claude.ai) — network replay + Stripe PDF
    index.ts       the registry (one import + one array entry per vendor)
  ingest/      IngestSink interface + HttpSink (default) + IgdrasilSink
  platform/    the ONLY place chrome.* lives (service worker, storage, ...)
  ui/popup/    the "Sources" screen
test/          per-vendor fixture tests (CI-enforced) + core tests
scripts/       validate-vendors, export-recipes
```

Five decisions this structure encodes:

1. **Recipes are pure data, not code** — a `.strict()`, closed-vocabulary schema freezes this → serializable, hot-serveable, testable, and safe to hot-load.
2. **`chrome.*` is quarantined to `src/platform/`** → the core runs anywhere.
3. **One engine, no per-vendor branches** → adding a vendor never edits engine code.
4. **The ingest sink is an interface** → standalone or embedded is a config swap.
5. **Every vendor ships a fixture test, enforced in CI** → the long tail can't rot.

---

## Quick start

```bash
npm install
npm run ci          # typecheck + validate recipes + tests
npm run build       # emits a loadable extension into dist/
```

Then load it: `chrome://extensions` → enable Developer mode → **Load unpacked** →
select `dist/`.

Add a vendor: see **[docs/adding-a-vendor.md](docs/adding-a-vendor.md)**.

---

## Using it with a backend

The extension POSTs a multipart document to a single endpoint. Point it anywhere:

- **Standalone** — configure an `http` sink with your own URL. The wire format is
  documented in [`src/ingest/http-sink.ts`](src/ingest/http-sink.ts).
- **Igdrasil** — configure an `igdrasil` sink; it targets `/documents/ingest` and
  authenticates with the user's session token. See
  [`src/ingest/igdrasil-sink.ts`](src/ingest/igdrasil-sink.ts).

Recipes can also be **served from your backend** as JSON (`npm run export-recipes`)
and hot-loaded, so you add vendors without shipping a new extension build.

---

## Status

Early foundation. The `network` strategy is complete; the `dom` fallback defines
its contract but needs an offscreen driver wired in `src/platform`.

`anthropic` is built from a **real claude.ai capture** — its mapping *and* org
discovery are tested, and it uses the **page fetch transport** (`fetchContext:
"page"`) to run first-party behind Cloudflare. The other three recipes (github,
slack, vercel) are **illustrative** and must be verified against the live
dashboards before use.

To test a vendor live (dry-run, no backend needed): **[docs/testing.md](docs/testing.md)**.

## License

MIT — see [LICENSE](LICENSE).
