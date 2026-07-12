# Architecture

## The one idea

The extension runs inside the user's browser. When it holds a host permission for
a vendor, it can make `fetch(url, { credentials: "include" })` and the browser
attaches that vendor's existing cookies. To the vendor it is indistinguishable
from their own billing page calling their own API. **No password ever changes
hands.** Everything else is plumbing around that fact.

## Layers

```
┌─────────────────────────────────────────────────────────────┐
│ platform/   MV3 glue — the ONLY place chrome.* appears       │
│   service-worker · scheduler · storage · permissions · popup │
└───────────────┬─────────────────────────────────────────────┘
                │ builds a RunContext + StrategyMap, calls…
┌───────────────▼─────────────────────────────────────────────┐
│ core/       platform-free engine (runs in Node too)          │
│   engine  → auth · scopes · list · dedup · download          │
│   strategies/network  (replay JSON API)  ← default           │
│   strategies/dom      (offscreen DOM)    ← fallback          │
│   http · template · jsonpath · extract · dedup · schema      │
└───────────────┬─────────────────────────────────────────────┘
                │ interprets…
┌───────────────▼──────────┐   ┌──────────────────────────────┐
│ vendors/   pure-data      │   │ ingest/   IngestSink          │
│   recipes (defineVendor)  │   │   HttpSink · IgdrasilSink     │
└───────────────────────────┘   └──────────────────────────────┘
```

The dependency rule is one-directional: **platform → core → (vendors, ingest)**.
Core never imports platform. That's what lets the engine, strategies, and every
recipe run under Vitest with no browser.

## Data flow (one sync)

```
alarm → service-worker → collector.runAllConnected()
  └─ per vendor: engine.runVendor(recipe, ctx, strategies)
        1. auth-probe        recipe.auth.check → alive? (else AuthExpired)
        2. resolveScopes     recipe.config → [{}] or one scope per workspace
        3. strategy.list     replay billing API → InvoiceRef[]
        4. dedup             idempotencyKey(company, source, invoiceId)
        5. strategy.fetch    download the PDF bytes
  └─ sink.send(doc) per new document
  └─ seen.add(key) ONLY after the sink accepts  ← failed ingest retries next run
```

## Why recipes are data, not functions

A recipe is a plain object validated by `core/schema.ts`. Consequences:

- **Serializable** — the same object compiled into the extension can be emitted as
  JSON (`scripts/export-recipes.ts`) and **hot-served from a backend**, so a new
  vendor doesn't require a Web Store release. The engine treats compiled-in and
  fetched recipes identically.
- **Safe** — no arbitrary code is shipped or fetched; the engine is a fixed
  interpreter over a closed set of primitives.
- **Testable** — `mapListResponse` is pure, so a fixture in → refs out.
- **Portable** — the JSON Schema (derived from the Zod schema) means a Rust or Go
  backend can validate and even execute the same recipes server-side (e.g. for a
  hybrid "capture session token, replay in the cloud" model).

## Fetch transports (worker vs page)

The engine receives `ctx.fetch` as an injected function, so the platform can
choose *how* requests physically go out without the engine knowing:

- **worker** (default) — `fetch(url, { credentials: "include" })` from the
  service worker. With host permissions this reads cross-origin responses fine
  and works for most vendors.
- **page** — for origins behind bot protection (e.g. claude.ai/Cloudflare) that
  reject a cross-origin worker fetch. The request runs *inside the vendor's own
  page* (MAIN world of a tab on that origin) via `chrome.scripting.executeScript`,
  so it is first-party and indistinguishable from the site calling its own API.
  A recipe opts in with `fetchContext: "page"`.

Even in page mode, only the recipe's **primary origin** is routed through the
tab; requests to other origins (e.g. a Stripe PDF capability URL) still use the
worker. Response bytes cross the executeScript boundary base64-encoded. Tabs the
transport opens are closed on dispose; pre-existing tabs are reused and left
alone. See `src/platform/page-fetch.ts`.

## The ingest seam

`IngestSink` is the single boundary for where collected documents go, selected by
config:

- **`FilesystemSink`** (OSS default) — saves to `Downloads/<root>/<supplier>/<date>/<file>`
  via `chrome.downloads`. Runs in the background service worker; bytes go out as a
  `data:` URL (SWs can't make Blob URLs). `dateMode` folders by collection date
  (default) or invoice date (deterministic path → overwrite-safe).
- **`HttpSink`** — multipart POST + normalized metadata + idempotency key to any
  URL; a `409` means "already have it" and is treated as success.
- **`IgdrasilSink`** — an `HttpSink` pointed at engine-api's `/documents/ingest`
  with the user's session token.

Duplicates are prevented upstream by the engine's persisted seen-store (keyed on
supplier + invoice id), so every sink saves each invoice once regardless of
destination.

## Unattended, honestly

- **Yes:** runs on a `chrome.alarms` schedule with no tab or user action, as long
  as the browser process is alive and the vendor session is valid.
- **No:** it cannot run while the machine is off — that's the domain of the
  server-side cloud-vault model, which this project deliberately avoids because it
  requires holding the user's credentials.

## What's intentionally minimal

- The **DOM strategy** defines its driver contract (`DomDriver`) but ships
  unavailable; wire an offscreen-document driver in `platform/` when a vendor
  genuinely needs it. Network replay covers the current set.
- The **popup** is framework-free by design — a thin view over the message bus.
