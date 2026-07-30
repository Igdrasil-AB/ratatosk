# Ratatosk brand source assets

These files are source artwork for the generated Chrome extension and Web Store
assets. They are intentionally kept outside `public/`, so the full-resolution
sources are not included in the Collector package.

- `invoice-squirrel.png` — copied from
  `Igdrasil-AB/igdrasil-accounting/frontend/src/assets/igdrasil-characters/invoice_squirrel.png`
  (Git blob `a035ded9eba0179a9da870be03bbebf468cf012f`).
- `root-reconciliation-ledger-roots.png` — copied from
  `Igdrasil-AB/igdrasil-landingpage/landing-page-rustic/public/brand/root-reconciliation-ledger-roots.png`
  on `main` (Git blob `504a6f78554b6fa50f26bc954ab86e1deeea2688`).
- `ratatosk-small-promo-beige-source.png` — the approved 440×280 Chrome Web
  Store tile with the squirrel beside a compact Collector product preview.

Run `npm run gen:icons` to regenerate the four extension icons, the Collector's
rustic roots header, and the required 440×280 Chrome Web Store promotional tile.
