<p align="center">
  <img src="store/assets/ratatosk-small-promo-440x280.png" alt="Ratatosk squirrel among rustic ledger roots" width="440">
</p>

<h1 align="center">Ratatosk</h1>

<p align="center"><strong>Your supplier invoices, collected from the billing portals you already use.</strong></p>

<p align="center">
  An open-source project by <a href="https://igdrasil.se/">Igdrasil AB</a>
  · <a href="LICENSE">MIT licensed</a>
  · <a href="PRIVACY.md">Privacy</a>
  · <a href="SECURITY.md">Security</a>
</p>

Ratatosk is an open-source Chrome extension project for collecting a user's own
supplier invoices and receipts from vendor billing portals. It uses the browser
session the user already has, so Ratatosk never asks for or stores vendor
passwords or two-factor codes.

The repository deliberately produces two separate extensions:

- **Collector** (`collector/`) is the consumer extension intended for Chrome Web
  Store review. It collects documents only after the user chooses a destination
  and connects a vendor. It does not include recording code or the `debugger`
  permission.
- **Studio** (`studio/`) is a development-only authoring extension. It records a
  billing page after explicit, informed consent and creates a redacted draft for
  a developer to review. Do not submit Studio as the consumer extension.

Shared, browser-independent code lives in `src/` and is used by both builds.

## Product preview

The Web Store presentation uses the same squirrel and rustic ledger-root artwork
as the extension itself.

<p align="center">
  <img src="store/assets/screenshots/01-home-1280x800.png" alt="Ratatosk Collector home screen" width="100%">
</p>

<p align="center">
  <img src="store/assets/screenshots/02-vendors-1280x800.png" alt="Ratatosk connected-vendor screen" width="100%">
</p>

## How Collector works

```text
chrome.alarms (user-controlled schedule)
   -> service worker wakes
   -> for each connected vendor
      -> verify the existing session
      -> call that vendor's billing endpoint
      -> map and de-duplicate invoices
      -> download the document
      -> save it to the destination the user selected
```

Vendor access is requested per vendor at connection time. With Igdrasil selected,
documents are uploaded to the user's Igdrasil company. With local downloads
selected, documents remain on the user's machine. Collector does not run a vendor
until a destination has been confirmed.

Recipes are declarative data, never executable code. The recipe schema is strict,
bounded, and interpreted only by logic packaged with the extension. Collector
does not download remote recipes or remotely hosted code; adding or changing a
vendor requires a reviewed extension release.

## Repository layout

```text
collector/              public consumer extension
  manifest.config.ts    Collector-only MV3 permissions and entries
  src/platform/         Collector browser APIs, storage, scheduling, sinks
  src/ui/                Collector popup
  vite.config.ts         emits dist/collector

studio/                 development-only authoring extension
  manifest.config.ts    Studio-only MV3 permissions, including debugger
  src/platform/         consented capture and session storage
  src/ui/                Studio disclosure and recording UI
  vite.config.ts         emits dist/studio

src/
  core/                 platform-free engine and recipe schema
  ingest/               destination interfaces and implementations
  vendors/              reviewed recipes; public and experimental registries

test/                   core, platform, and vendor fixture tests
scripts/                validation, icon generation, deterministic packaging
store/                  Chrome Web Store copy and submission checklist
```

The dependency direction is `collector|studio -> shared src`; shared code never
imports Chrome extension APIs.

## Quick start

```bash
npm install
npm run ci
npm run build
```

Load Collector from `dist/collector` or Studio from `dist/studio` at
`chrome://extensions` using **Load unpacked**. Never load both from the same
directory.

Release the exact Collector artifact intended for review with:

```bash
npm run release:collector
```

This writes a ZIP and SHA-256 checksum under `artifacts/`. The ZIP contains the
Collector manifest at its root and excludes Studio.

## Vendor status

Collector currently exposes Anthropic, ChatGPT, and Railway as pilot recipes.
Their parsing behavior is fixture-tested, but live vendor endpoints and auth flows
must be re-verified in Chrome before a public claim or rollout. GitHub, Slack, and
Vercel remain contributor examples and are not shipped by Collector.

See [testing a vendor](docs/testing.md), [adding a vendor](docs/adding-a-vendor.md),
[the architecture](docs/architecture.md), and the
[Chrome Web Store submission process](store/submission-process.md).

## Privacy and security

Collector includes no analytics or advertising SDK. Its actual data handling,
destinations, local retention, and permissions are documented in
[PRIVACY.md](PRIVACY.md), [SECURITY.md](SECURITY.md), and the
[store listing draft](store/listing.md).

## License

MIT — see [LICENSE](LICENSE).
