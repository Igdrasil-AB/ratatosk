# Contributing

Thanks for helping widen vendor coverage — that's how this project gets useful.

## Adding a vendor

This is the most valuable contribution. Full walkthrough:
**[docs/adding-a-vendor.md](docs/adding-a-vendor.md)**. In short: copy
`src/vendors/_template.ts`, capture the vendor's endpoints from DevTools, add a
fixture test, register it in `src/vendors/index.ts`.

## Ground rules

- **Recipes are data.** If a vendor seems to need custom logic, first ask whether
  the schema is missing a primitive — extend `core/schema.ts` (+ `core/types.ts`
  + the engine) rather than special-casing a vendor. The engine has no per-vendor
  branches and should stay that way.
- **Keep `chrome.*` in `src/platform/`.** Nothing in `core/`, `vendors/`, or
  `ingest/` may import a browser extension API.
- **Every vendor needs a fixture test.** CI enforces it (`npm run validate`).
- **Mark unverified endpoints.** Use the `notes` field to say when/where you
  captured them. Don't claim a recipe is production-verified if it isn't.

## Before opening a PR

```bash
npm run ci      # typecheck + validate recipes + tests
```

## Scope of a good vendor PR

One vendor, one recipe file, one fixture, one test, one registry line. Small and
reviewable. Bundle unrelated changes separately.
