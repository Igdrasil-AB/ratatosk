# Architecture

## The one idea

The extension runs inside the user's browser. When it holds a host permission for
a vendor, it can make `fetch(url, { credentials: "include" })` and the browser
attaches that vendor's existing cookies. To the vendor it is indistinguishable
from their own billing page calling their own API. **No password ever changes
hands.** Everything else is plumbing around that fact.

## Build boundaries and layers

```
┌──────────────────────────────────────────────────────────────┐
│ collector/   consumer MV3 glue, destination and popup        │
│ studio/      development-only capture and authoring popup    │
│ (each builds an independent manifest and extension package)  │
└───────────────┬──────────────────────────────────────────────┘
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

The dependency rule is one-directional:
**collector|studio → shared core/vendors/ingest**. Shared code never imports a
platform directory. That's what lets the engine, strategies, and every recipe run
under Vitest with no browser, and it makes it impossible for Studio's entry points
to leak into the Collector package accidentally.

`collector/manifest.config.ts` and `studio/manifest.config.ts` are separate
permission boundaries. Collector emits to `dist/collector`; Studio emits to
`dist/studio`. Release packaging accepts one of those directories and puts only
that extension's manifest at the ZIP root.

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

- **Reviewable** — each recipe is bundled in the signed extension package. A new
  vendor or recipe change requires tests, review, and a new Web Store release.
- **Safe** — no arbitrary or remote code is fetched; the engine is a fixed
  interpreter over a closed set of packaged primitives.
- **Testable** — `mapListResponse` is pure, so a fixture in → refs out.
- **Portable** — the shape can be validated or executed by other trusted project
  components, but the Chrome extension never downloads it from a backend.

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
alone. See `collector/src/platform/page-fetch.ts`.

## The ingest seam

`IngestSink` is the single boundary for where collected documents go, selected by
config:

- **`FilesystemSink`** — saves to `Downloads/<root>/<supplier>/<date>/<file>`
  via `chrome.downloads`. Runs in the background service worker; bytes go out as a
  `data:` URL (SWs can't make Blob URLs). `dateMode` folders by collection date
  (default) or invoice date (deterministic path → overwrite-safe).
- **`HttpSink`** — multipart POST + normalized metadata + idempotency key to any
  URL; a `409` means "already have it" and is treated as success.
- **`IgdrasilSink`** — an `HttpSink` pointed at engine-api's `/documents/ingest`
  with a revocable, company-scoped, upload-only Collector token. The user's
  general accounting session token never enters the extension.

Duplicates are prevented upstream by the engine's persisted seen-store (keyed on
supplier + invoice id), so every sink saves each invoice once regardless of
destination.

There is no implicit default destination. The user must confirm local Downloads
or connect Igdrasil before a vendor can be connected or run.

## Studio authoring boundary

Studio is not part of Collector's runtime or release. A developer checks a
prominent disclosure before recording an active HTTP(S) tab. Studio can observe
network metadata, supported response bodies, child-frame traffic, and a DOM
snapshot. Before session storage, the shared capture boundary drops every request
header value except a normalized `content-type`; retains only a bounded,
value-free authentication scheme/header-name marker; sanitizes URLs and
secret-looking body fields; records bounded redacted JSON paths; and caps bodies.
Bearer-token source suggestions use only those structural markers and require
review—Studio never matches or reconstructs a credential value. On stop it
creates a redacted, manually copied report; captured HTML bodies are not exported.

Studio also creates a separately validated, structural-only supplier fingerprint.
The exact fingerprint requires authority confirmation and explicit sharing
approval before it enters a bounded local outbox. Internal developers can pair a
revocable upload-only token and explicitly deliver an approved envelope to the
fixed HTTPS Svala intake endpoint. The token cannot follow redirects or be sent
to a configured alternate origin; local JSON export remains available. See
[supplier fingerprints](supplier-fingerprints.md).

Studio output is always a draft. A human must remove unnecessary data, verify the
vendor contract in a dedicated test account, add a fixture test, and explicitly
promote the recipe into the public `VENDORS` registry before a Collector release.

## Unattended, honestly

- **Yes:** runs on a `chrome.alarms` schedule with no tab or user action, as long
  as the browser process is alive and the vendor session is valid.
- **No:** it cannot run while the machine is off — that's the domain of the
  server-side cloud-vault model, which this project deliberately avoids because it
  requires a different product and security model.

## What's intentionally minimal

- The **DOM strategy** defines its driver contract (`DomDriver`) but ships
  unavailable; wire an offscreen-document driver in `platform/` when a vendor
  genuinely needs it. Network replay covers the current pilot set.
- The **popup** is framework-free by design — a thin view over the message bus.
