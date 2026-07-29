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
│ collector/   consumer MV3 glue, discovery, destination, popup │
│ (the only extension this repository builds and releases)      │
└───────────────┬──────────────────────────────────────────────┘
                │ builds a RunContext + StrategyMap, calls…
┌───────────────▼─────────────────────────────────────────────┐
│ core/       platform-free engine (runs in Node too)          │
│   engine  → auth · scopes · list · dedup · download          │
│   strategies/network  (replay JSON API)  ← default           │
│   strategies/dom      (bounded real tab) ← fallback          │
│   http · template · jsonpath · extract · dedup · schema      │
└───────────────┬─────────────────────────────────────────────┘
                │ interprets…
┌───────────────▼──────────┐   ┌──────────────────────────────┐
│ vendors/   pure-data      │   │ ingest/   IngestSink          │
│   recipes (defineVendor)  │   │   HttpSink · IgdrasilSink     │
└───────────────────────────┘   └──────────────────────────────┘
```

The dependency rule is one-directional:
**collector → shared core/vendors/ingest**. Shared code never imports a platform
directory. That's what lets the engine, strategies, the discovery policy, and
every recipe run under Vitest with no browser.

`collector/manifest.config.ts` is the single permission boundary. Collector emits
to `dist/collector`, and release packaging puts that manifest at the ZIP root.
Packaging additionally rejects any `debugger`-backed recorder or fingerprint
marker, so the consumer artifact cannot regain an authoring capability.

## Data flow (one sync)

```
alarm → service-worker → collector.runAllConnected()
  └─ per vendor: engine.streamVendor(recipe, ctx, strategies, emit)
        1. auth evidence     API predicate + final redirect, or exact DOM list
        2. resolveScopes     recipe.config → [{}] or one scope per workspace
        3. strategy.list     enumerate bounded API/HTML/DOM pages → refs + traversal proof
        4. month boundary    for an explicit manual range, keep only refs with a trusted issue month
        5. preflight         reject incomplete discovered-candidate paths before delivery
        6. dedup             idempotencyKey(company, source, invoiceId)
        7. strategy.fetch    download PDF bytes in bounded ordered batches
  └─ sink.send(doc) through one exclusive commit lane
  └─ seen.add(key) + ledger receipt after the sink accepts
  └─ discovery admission callback only after durable dedup evidence
```

### Month-bounded manual collection

The user-facing boundary is month-only: an optional `YYYY-MM` starting month
through the current calendar month, both inclusive. The platform turns that
choice into a typed `SyncMonthWindow`; the engine does not accept arbitrary date
expressions from recipes or the UI.

Every strategy already normalizes invoice metadata into the same `InvoiceRef`
contract. Network and embedded-page candidates map a discovered date-like field
to `issuedAt`. DOM candidates carry labelled row dates as provenance-bearing
metadata evidence. The engine resolves that shared evidence and applies the
month boundary after complete list traversal but before identity reservation or
PDF materialization. This keeps correctness supplier-independent:

- invoices before the starting month or after the current month are skipped;
- a unique trustworthy issue month is eligible;
- missing, invalid, or equally strong conflicting dates are skipped and make the
  run explicitly partial rather than guessing or downloading;
- an unbounded run retains the existing all-history behavior.

List APIs that support server-side bounds may use the closed run variables
`syncFromYearMonth`, `syncFromDate`, `syncFromIso`,
`syncFromEpochSeconds`/`syncFromEpochMs`, and the matching
`syncToExclusive*` values in a recipe request. This is an efficiency
optimization only. The engine still enforces the normalized invoice month, so a
supplier that ignores or misinterprets its query cannot expand the requested
download set.

## Concurrency and cancellation

Concurrency is a typed policy rather than a collection of unbounded
`Promise.all` calls. `core/concurrency.ts` owns the reviewed limits and returns a
closed outcome union (`fulfilled | rejected | cancelled`) in original input
order. The current policy is:

| Work | Width | Safety boundary |
|---|---:|---|
| same-origin GET route probes | 2 | separate inactive tabs; read-only navigation |
| candidate previews | 2 | structural/API listing only; no semantic DOM actions |
| document fetches | 3 | bounded batches; at most three materialized PDFs |
| destination commits | 1 | stable source order; seen-key and ledger only after acceptance |

This is a speculate → elect → commit design. Route and candidate evidence may be
gathered speculatively. Ranking elects a deterministic candidate. A full DOM
canary and every destination write remain serialized because those paths can
activate a download control or mutate extension state. Search stops after the
current two-route wave once enough strong candidates exist, so at most one
already-running route is redundant.

Candidate election is based on retrieval completeness, not a minimum invoice
count. One resolved invoice is a valid result when the API reports no next page,
HTML has no continuation, or DOM pagination reaches a stable end. A path remains
partial when it hits a page/action/document/time cap, repeats its continuation
state, or exposes controls/links it cannot resolve. For discovered candidates,
all scopes are enumerated first and an incomplete path is rejected before any
PDF is fetched or sent; the next retained candidate can then run without creating
duplicate destination files.

Fatal supplier-wide failures (expired authentication or rate limiting) cancel
unscheduled sibling document work. Candidate-local failures stay local and allow
the next ranked fallback. Destination failures abort immediately; uncommitted
documents are not marked seen and therefore retry on the next run. Connected
vendors also remain sequential to avoid multiplying load across unrelated
supplier portals.

## Why recipes are data, not functions

A recipe is a plain object validated by `core/schema.ts`. Consequences:

- **Reviewable** — official recipes are bundled in the signed extension package.
  A new official vendor or recipe change requires tests, review, and a new Web
  Store release. Local discovery profiles are structural output from the same
  packaged interpreter, never downloaded code.
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

### Shared document providers

Document delivery infrastructure is modeled independently from supplier
recipes. The Stripe provider recognizes any normal HTTPS path on its exact
capability origins, canonicalizes only the proven hosted-invoice `/i/` shape,
and follows redirects under an observation-only listener scoped to the browser
request ID. Redirects may end only on another exact Stripe origin or the fixed
`stripe-upload-api` bucket across AWS regions. A newly observed regional origin
becomes a typed permission-drift result containing only the origin; after the
user grants that exact host, collection reruns the supplier list to obtain a
fresh signed URL. Signed paths, queries, and response data are never persisted.

The same provider boundary is used by packaged recipes, locally discovered
network candidates, worker fetches, and the cross-origin portion of page-mode
fetches. Provider permission failures are vendor-wide fatal outcomes, so bounded
concurrent document work stops and the popup can offer Review Access.

## The ingest seam

`IngestSink` is the single boundary for where collected documents go, selected by
config:

- **`FilesystemSink`** — saves to `Downloads/<root>/<supplier>/<date>/<file>`
  via `chrome.downloads`. Runs in the background service worker; bytes go out as a
  `data:` URL (SWs can't make Blob URLs). `dateMode` folders by collection date
  (default) or invoice date (deterministic path → overwrite-safe).
- **`HttpSink`** — multipart POST + normalized metadata + idempotency key to any
  URL; a `409` means "already have it" and is treated as success.
- **`IgdrasilSink`** — an `HttpSink` pointed at engine-api's `/api/documents/ingest`
  with a revocable, company-scoped, upload-only Collector token. The user's
  general accounting session token never enters the extension.

Duplicates are prevented upstream by the engine's persisted seen-store (keyed on
supplier + invoice id), so every sink saves each invoice once regardless of
destination.

There is no implicit default destination. The user must confirm local Downloads
or connect Igdrasil before a vendor can be connected or run.

## Unsupported-supplier discovery

Collector uses a two-confirmation state machine in `chrome.storage.session` so
Chrome may close the popup during either permission prompt without losing the
user's intent:

1. **Find Invoices** requests the active tab's exact HTTPS origin and snapshots
   the rendered page without navigating, reloading, scrolling, or closing it.
   Collector then dynamically registers a packaged
   `document_start` MAIN-world observer for that exact origin. It keeps a bounded,
   sanitized, in-memory sample of JSON fetch/XHR responses, including the method,
   JSON content type, and request body needed to replay an explicit GraphQL query.
   A closed allowlist of bounded static query controls (for example `limit`,
   `status`, and `page`) is preserved for replay; account identifiers,
   signatures, credentials, and unknown query values remain redacted.
   After registration succeeds, Collector reopens the exact canonical entry URL
   once in an inactive disposable tab before it tries speculative routes. That
   cold replay captures early, cached, POST, and cross-origin API evidence that
   cannot be reconstructed from `performance` URLs. Generic hydration JSON does
   not end observation: the probe waits for bounded request-shape quiescence or
   its existing deadline. If a high-confidence billing route still exposes only
   an empty shell, it may consume the one discovery-wide visibility lease. The
   disposable tab is activated for that bounded probe, the prior active tab is
   restored afterward, and a user-initiated tab switch always wins over
   restoration. The same lease remains active during semantic candidate
   verification and click capture; otherwise a visibility-gated SPA could be
   discoverable but not collectable. Registration and page hooks are removed in `finally`;
   no captured response is persisted or uploaded.
2. A deterministic planner scores same-origin routes from path intent, bounded
   visible/accessibility labels, nearby menu context, tenant shape, depth, and
   route-family confidence. Semantic controls such as `Invoices` can therefore
   lead to otherwise opaque routes, while observed `Settings` routes remain as
   lower-confidence bridges for multi-step navigation. For tenant-scoped apps,
   `/<tenant>/settings/billing` ranks ahead of speculative history paths. The
   planner also keeps a small packaged set of common paths. The best safe
   contextual/common route is scheduled after at most two higher-ranked observed
   routes, preventing a saturated menu or slow probes from starving an independent
   route source. For account-scoped apps it preserves one bounded tenant prefix, so
   shapes such as `/<account-id>/billing/subscriptions` remain navigable and
   reusable. An opaque tenant segment is bound only when the exact observed route
   placed it directly behind a trusted container such as `org`, `workspace`, or
   `account`; arbitrary opaque path segments are never promoted. A best-first
   queue repeats this process from every inspected page,
   prioritizing invoice/receipt paths over billing history and broader payment or
   subscription paths. It checks at most fifteen pages, depth three, and thirty
   seconds. After the active entry page, it probes deterministic waves of at most
   two same-origin routes in separate inactive temporary tabs. Invoice/detail
   routes stay in the queue; only explicit
   `.pdf`, download, PDF-path, known direct-receipt, or hosted-Stripe links become
   document candidates. Search navigation is GET-only; it
   never clicks controls, submits forms, or follows logout, checkout, purchase,
   cancellation, deletion, or authorization paths. The tab is always closed.
3. Packaged adapters compile observed/replayed network JSON, embedded JSON,
   rendered invoice links, or semantic document controls into recipes. Discovery
   and verification receive the same packaged semantic policy. Accessible names
   remain the primary signal; an icon-only control is eligible only when its
   document icon, invoice-shaped row, invoice-page context, and action/document
   column agree. A status button or identical icon outside that context is
   rejected. Discovery retains at most three
   proof-ranked, identity-compatible candidates rather than trusting the first
   link-shaped result. Generic downloads outside invoice-shaped page, path, label,
   or nearby context are rejected. Search remains read-only: DOM candidates and
   semantic controls are retained structurally but are not activated or given an
   eight-second canary wait inside the route-search budget.
4. **Connect & Collect** shows and requests the bounded union of every candidate's
   exact origins. It then materializes and validates a real PDF canary from the
   highest-ranked candidate. A candidate-local shape failure, empty result, or
   incomplete traversal falls through to the next candidate; authentication,
   rate-limit, permission, and destination failures stop immediately. Completion
   is proven by exhausting that path, never by requiring two or more invoices.
   The strict
   discovery policy forbids remote code, arbitrary headers/bodies, mutating
   requests, token exchange, arbitrary DOM clicks/selectors, broad/private hosts, and
   credential-like stored URL values. A semantic fallback may first reveal an
   exact invoice/receipt-history tab-like section, then activate only visible,
   enabled controls admitted by that same contextual policy after confirmation;
   payment, purchase, cancellation, deletion, logout, and form mutations are
   excluded. The only persisted POST shape is a bounded `application/json`
   GraphQL body whose operation starts with explicit `query`; mutations,
   subscriptions, persisted-query extensions, secret-like variables, and other
   POST bodies are rejected. When a supplier converts an authenticated GET response into a
   temporary `blob:` URL, Collector captures at most 8 MiB of magic-checked PDF
   bytes in memory and immediately replaces them with a SHA-256-derived internal
   handle; blob contents, request headers, and authentication values are never
   persisted or logged. Inline PDFs are additionally capped at 24 MiB and 500
   documents across the complete DOM run. Every click-capable or continuation
   run uses a disposable tab, so scheduled collection never navigates or mutates
   an existing supplier tab. Collection follows API cursors, returned next URLs, HTTP/HTML
   `rel=next`, numbered/offset pages, localized visible Next/Load More controls
   outside forms, or bounded infinite scroll. Ephemeral cursor values are never
   stored or logged. DOM advancement fingerprints invoice-row content and
   document-control structure in page memory, so icon-only tables can prove that
   a Next action changed rows even when the action buttons themselves are identical.
5. Each valid PDF is streamed to the chosen destination instead of buffering the
   whole supplier run. Stable document identity includes the canonical URL for
   generic endpoints, so distinct query-addressed invoices do not collapse or
   download twice. PDF admission uses bounded bytes plus the `%PDF` signature;
   supplier MIME metadata is advisory because signed/object-storage downloads
   commonly use `application/octet-stream`. Extracted invoice text or invoice
   keywords are not a hard retrieval gate. The profile is committed only after the destination accepts
   the first validated PDF. An accepted delivery is recorded in the seen store
   and ledger before the discovery admission callback, so a later profile-write
   failure cannot cause the delivered file to be downloaded again. Failure before
   any accepted delivery rolls back the connection, profile, seen keys, and ledger.

Failed searches or candidate verification attempts retain only a bounded
structural diagnostic in session storage:
runtime/discovery-engine identity, termination cause, bounded timings,
page/source counts (including exact-entry replay), observed-versus-replayed JSON
request counts, retained candidate count, packaged adapter/outcome codes,
per-route evidence counts, privacy-safe requested/resolved route templates, and
coverage families distinguished as attempted, exhausted, or unavailable, and up
to eight cross-origin hostnames. Route templates preserve only recognized
billing/navigation words and replace tenant, account, workspace, and other opaque
segments with `:id` or `:segment`. Origins, raw paths, queries, fragments,
headers, bodies, selectors, identifiers, and free-form error messages are never
included.

Candidate verification also carries a closed root-cause trace across the engine
boundary. The trace records the failed stage (`authentication`,
`scope_discovery`, `invoice_list`, `document_fetch`, `document_validation`,
`delivery`, or `admission`), a finite cause code, an optional bounded HTTP
status/content-type family, and any structural list proof completed before a
later document failure. This keeps `recipe_incompatible` useful as a stable UI
outcome while distinguishing a selector miss from a rejected fetch or invalid
PDF in copied diagnostics. The trace contains no supplier-provided strings,
URLs, or response content.

The source catalog merges official registry recipes with these validated local
profiles, so scheduling and sync use one engine rather than a parallel scraper.

## Capture library, without an authoring build

`core/recorder/` is the shared capture and inference library that discovery runs
on: `cdp` sanitizes observed traffic, `redact` and `payment-sensitive` strip
secret-looking values, `infer` compiles evidence into a draft recipe, and `types`
holds the shared shapes. It is packaged inside Collector and runs on the user's
own machine.

Before anything reaches session storage, that boundary drops every request header
value except a normalized `content-type`, retains only a bounded, value-free
authentication scheme/header-name marker, sanitizes URLs and secret-looking body
fields, records bounded redacted JSON paths, and caps body size. It never matches
or reconstructs a credential value.

The separate Studio authoring extension that once wrapped this library in a
`debugger`-backed recorder, together with its supplier-fingerprint delivery path,
has been removed. Supplier support now comes from generic discovery only.

## Unattended, honestly

- **Yes:** runs on a `chrome.alarms` schedule with no tab or user action, as long
  as the browser process is alive and the vendor session is valid.
- **No:** it cannot run while the machine is off — that's the domain of the
  server-side cloud-vault model, which this project deliberately avoids because it
  requires a different product and security model.

## What's intentionally minimal

- The **DOM strategy** uses a real-tab driver with a closed step vocabulary.
  Official registry recipes remain network/HTML-only for the current pilot;
  locally discovered recipes are restricted to waiting, extracting HTTPS links,
  the packaged semantic-download primitive, and packaged auto-continuation. The
  semantic primitive is available only after Connect & Collect, may reveal one
  exact invoice/receipt-history tab-like section, and rejects mutation-labelled
  controls. Continuation searches the invoice region first and
  activates only visible recognized controls outside forms or performs bounded
  scrolling after the first invoice structure has already been verified. Any
  click-capable or continuation run is isolated in a disposable tab.
- The **popup** is framework-free by design — a thin view over the message bus.
