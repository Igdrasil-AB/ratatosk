<p align="center">
  <img src="store/assets/ratatosk-small-promo-440x280.png" alt="Ratatosk squirrel beside the Invoice Collector product preview" width="440">
</p>

<h1 align="center">Ratatosk</h1>

<p align="center"><strong>Your supplier invoices, collected from the billing portals you already use.</strong></p>

<p align="center">
  An open-source project by <a href="https://igdrasil.se/">Igdrasil AB</a>
  · <a href="LICENSE">MIT licensed</a>
  · <a href="PRIVACY.md">Privacy</a>
  · <a href="SECURITY.md">Security</a>
</p>

Ratatosk is an open-source Chrome extension that collects your own supplier
invoices and receipts from vendor billing portals and files them where you tell
it to. It uses the browser session you already have, so it never asks for or
stores a vendor password or two-factor code.

**It is not a list of supported vendors.** Open a supplier's billing page,
select **Find Invoices**, and a generic discovery engine works out where that
portal keeps its invoices — for any portal, not a hard-coded set. Everything
about that inference runs locally inside the packaged extension.

## How it works

Three things happen, all driven by you.

**1. Find Invoices** — from any page in a supplier app.

Ratatosk snapshots the page you're on without navigating, reloading, or closing
it, then reopens that exact page once in a hidden tab so it can watch the app
boot and see the JSON calls the billing UI makes. From there a bounded planner
follows same-origin, billing-looking routes — read-only `GET` requests in
disposable inactive tabs, at most 15 pages, depth 3, 30 seconds. It never
submits a form, and never follows logout, checkout, purchase, cancellation,
deletion, or authorization links.

It ranks routes by path intent *and* by what the page actually says, so an
opaque route labelled `Invoices` is still found, and `/<tenant>/settings/billing`
outranks a guess.

**2. Connect & Collect** — you approve, then it proves itself.

Discovery keeps up to three proof-ranked candidates, covering JSON APIs,
embedded page data, invoice-context document links, explicit download controls,
and icon-only download actions confirmed by invoice-table, row, and
action-column context. Ratatosk shows you the exact origins those candidates
need, requests only that bounded set, and then downloads and validates a real
PDF before saving anything. A candidate that doesn't hold up falls through to
the next one.

Completion is proven by exhausting the list — the API reporting no next page,
HTML with no continuation, DOM pagination reaching a stable end — never by
guessing that "enough" invoices were found. One invoice is a valid result.

**3. Collect on a schedule.**

```text
chrome.alarms (your schedule)
   -> service worker wakes
   -> for each connected supplier
      -> verify the existing session
      -> list invoices (API cursor, next-URL, numbered, offset,
         Load More, or bounded infinite scroll)
      -> de-duplicate against what was already filed
      -> download the PDF
      -> save it to your destination
```

Manual collection can optionally start from a chosen month and year. Ratatosk
lists the supplier's invoices, then filters on the resolved issue month before
it downloads any PDF. The same choice appears after first-time discovery and
before **Connect & Collect**. If any listed invoice has a missing, invalid, or
conflicting issue date, Ratatosk falls the whole supplier run back to all
available history and says so when collection finishes. Leaving the month empty
checks all available history; scheduled collection keeps its existing
all-history-plus-dedup behavior.

Nothing runs until you pick a destination. With **This Computer**, files land in
your Downloads folder. With **Igdrasil Accounting**, they upload to your company
using a revocable, upload-only token — your accounting session token never
enters the extension.

### What holds it together

- **No remote code, no remote recipes.** The engine is a fixed interpreter over
  a closed set of packaged primitives. What discovery produces is a structural
  profile, never downloaded behavior. Nothing is fetched from a backend to
  decide what the extension does.
- **Bounded permissions.** Host access is requested per supplier, for the exact
  origins your own candidates need. No wildcards, no private hosts.
- **Read-only until you say otherwise.** Search never clicks. Semantic controls
  are activated only after Connect & Collect, only when visible and enabled, and
  never when labelled as a payment, purchase, cancellation, or deletion.
- **Diagnostics carry no data.** When discovery fails, the copyable diagnostic
  holds the failed stage, a finite cause code, an optional HTTP status family,
  bounded counts, and `:id`-templated route shapes. Never URLs, selectors,
  response content, tokens, or invoice identifiers.
- **No analytics, no ad SDK.** See [PRIVACY.md](PRIVACY.md) and
  [SECURITY.md](SECURITY.md).

## Product preview

<p align="center">
  <img src="store/assets/screenshots/01-home-1280x800.png" alt="Ratatosk Collector home screen" width="100%">
</p>

<p align="center">
  <img src="store/assets/screenshots/02-vendors-1280x800.png" alt="Ratatosk connected-vendor screen" width="100%">
</p>

## Supplier support

Generic discovery is the path for every supplier, including Anthropic and
ChatGPT — current browser evidence always beats a stale hard-coded API path.

A small number of packaged recipes predate the engine, but Collector does not
present them as suppliers unless the user explicitly connected one in an older
version. Railway, GitHub, Slack, and Vercel remain repository examples and
compatibility paths. New packaged recipes are not the direction of the project
— a supplier that discovery can't handle is a gap in the engine, and that's what
we want reported.

## Contributing

The most valuable contribution is a supplier the engine fails on, reduced to the
anonymized page *shape* it missed, so that supplier and every other portal built
the same way both start working.

Read **[CONTRIBUTING.md](CONTRIBUTING.md)** first — it covers the shape corpus,
the live-failure iteration loop, and the safety and privacy rules that gate a
merge.

## Repository layout

```text
collector/              the consumer extension
  manifest.config.ts    Collector-only MV3 permissions and entries
  src/platform/         browser APIs, discovery, storage, scheduling, sinks
  src/ui/popup/         the popup
  vite.config.ts        emits dist/collector

src/
  core/                 platform-free engine, discovery policy, recipe schema
  core/recorder/        shared capture, redaction, and inference library
  ingest/               destination interfaces and implementations
  vendors/              packaged legacy recipes and their lifecycle manifest

test/                   engine, discovery, platform, and fixture tests
scripts/                validation, icon generation, deterministic packaging
store/                  Chrome Web Store copy and submission checklist
```

The dependency direction is `collector -> shared src`. Shared code never
imports Chrome extension APIs or touches page globals, which is why the engine,
the discovery policy, and every adapter run under Vitest with no browser.
`npm run check:boundaries` enforces it.

## Quick start

```bash
npm install
npm run ci              # typecheck + boundaries + validation + tests
npm run build:collector # emits dist/collector
```

Load `dist/collector` at `chrome://extensions` → Developer mode → **Load
unpacked**. Pick a destination, open a supplier's billing page, and select
**Find Invoices**.

## Releasing

```bash
npm run release:collector
```

Runs the full test and security gate, then writes a deterministic ZIP and
SHA-256 checksum under `artifacts/` with the Collector manifest at the root.
Packaging refuses to ship a bundle containing a `debugger`-backed recorder or a
fingerprint delivery marker.

Publishing stays an explicit operator action. Pushing a `v<package-version>` tag
runs `.github/workflows/release-collector.yml`, which rebuilds from that exact
commit, verifies the checksum, and publishes **one** asset pair — the Collector
ZIP and its `.sha256`. That is the only downloadable artifact this project
produces.

Before calling a supplier supported in a release, complete the live acceptance
loop in [docs/testing.md](docs/testing.md): two consecutive runs against the same
known invoice set, the first delivering every expected document and the second
delivering zero.

## Documentation

- [Architecture](docs/architecture.md) — the engine, the boundaries, the
  discovery state machine in detail
- [Contributing](CONTRIBUTING.md) — how to teach the engine a new shape
- [Testing a supplier live](docs/testing.md) — the acceptance loop
- [Privacy](PRIVACY.md) · [Security](SECURITY.md) ·
  [Store listing](store/listing.md) ·
  [Submission process](store/submission-process.md)

## License

MIT — see [LICENSE](LICENSE).
