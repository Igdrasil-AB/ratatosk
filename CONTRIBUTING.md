# Contributing

Ratatosk collects a user's own invoices from supplier billing portals using the
browser session they already have. It does this with **one generic discovery
engine**, not with hand-written code per supplier.

So the most valuable contribution is no longer "add my vendor". It is:

> **Find a supplier the engine fails on, and teach the engine the general shape
> it missed — so that supplier and every other supplier built the same way both
> start working.**

If your change only makes one named supplier work, it is the wrong change.

## Prerequisites

- Node `^20.19.0 || >=22.12.0`
- Chrome, using a **dedicated developer profile**
- A supplier account you are authorized to use, with your own real or synthetic
  invoices. Never test against a customer's account.

```bash
npm ci
npm run ci              # typecheck + boundaries + schema validation + tests
npm run build:collector # emits dist/collector
```

Load `dist/collector` at `chrome://extensions` → Developer mode → **Load
unpacked**. Choose a destination (local Downloads is fine) before collecting —
there is no implicit default destination.

## How discovery works

Read [docs/architecture.md](docs/architecture.md) before your first change. The
short version — Collector, standing on a supplier's billing page:

| Stage | What happens | Where it lives |
|---|---|---|
| 1. Observe | Snapshot the rendered page, register a MAIN-world observer for that exact origin, replay the entry URL once in a disposable tab to catch cached, POST, and cross-origin JSON | `collector/src/platform/discovery-page-observer.ts`, `discovery.ts` |
| 2. Plan routes | Score same-origin routes from path intent, labels, menu context, tenant shape, and depth — best-first, GET-only, ≤15 pages, depth 3, 30s | `collector/src/platform/discovery-explorer.ts` |
| 3. Compile candidates | Four packaged adapters turn evidence into recipes: `network-json`, `embedded-json`, `dom-links`, `dom-actions`. Keep at most 3, proof-ranked | `compileCandidates` in `collector/src/platform/discovery.ts` |
| 4. Admit | Policy check: no remote code, no mutating requests, no arbitrary selectors, no credential-like values, exact origins only | `assertDiscoveredRecipePolicy` in `src/core/discovery.ts` |
| 5. Verify | Request the union of candidate origins, materialize and validate a real PDF canary, fall through to the next candidate on a candidate-local failure | `previewCandidate`, `collector/src/platform/collector.ts` |
| 6. Run | The elected profile joins the source catalog and is executed by the same engine as packaged recipes | `src/core/engine.ts` |

The engine, strategies, and adapters are shared, platform-free code in `src/`.
Chrome-specific glue lives in `collector/`. That split is enforced, not a
convention (`npm run check:boundaries`).

## The three kinds of contribution

### 1. Teach discovery a page shape it misses (most valuable)

The shape corpus is the contract for what discovery can recognize:
`test/core/discovery-shape-corpus.test.ts`. Each case is anonymized page
evidence in, expected adapters and admission reasons out.

1. Reproduce on the real supplier with an unpacked `dist/collector` build.
2. Copy the privacy-safe diagnostic from the popup. It names the termination
   cause, per-route evidence counts, adapter outcomes, and coverage families —
   that tells you which stage above gave up.
3. **Anonymize the shape.** Strip the real origin, ids, amounts, names, and any
   markup you don't need. Reduce it to the smallest HTML or JSON that still
   reproduces the miss, on `vendor.example`.
4. Add it to the corpus as a failing case, then make it pass by generalizing an
   adapter, the ranker, or the planner. Describe it structurally — "invoice rows
   with an icon-only download control in the action column", not "Acme's billing
   table".
5. Add a negative case too if your change widens what is accepted. A shape that
   must still be rejected matters as much as one that should now work.

Adjacent suites worth extending: `discovery-adapters`, `discovery-ranking`,
`discovery-route-fidelity`, `discovery-dom-policy`, `discovery-continuation`,
`dom-continuation`, `discovery-candidate-fallback`.

### 2. Fix a live supplier failure

Fixture success is not proof. Follow the iteration discipline in
[docs/testing.md](docs/testing.md):

1. Reproduce with the current unpacked build and copy the diagnostic.
2. Name the **first** failed boundary — route discovery, control enumeration,
   traversal proof, document resolution, redirect permission, PDF validation,
   destination delivery, or duplicate commit.
3. Add a regression test for exactly that boundary **before** changing code.
4. Rebuild, reload that exact `dist/collector`, rerun the same account.
5. Accept the iteration only if the failure moves to a later boundary or the run
   passes end to end. Revert changes that do neither.

Release acceptance is two consecutive runs against the same known invoice set:
the first delivers every expected document, the second delivers zero. Put the
expected, delivered, and second-run counts in the PR — counts only, never
supplier data.

### 3. Engine, strategy, or destination work

Pagination, dedup, PDF admission, concurrency policy, sinks. Same rules apply: a
typed, tested boundary, and no supplier named in shared code.

## Ground rules

Enforced by CI, review, or both. A PR that breaks one does not merge.

- **No per-supplier branches.** The engine is a fixed interpreter over packaged
  primitives and has no vendor conditionals. If a supplier seems to need custom
  logic, the schema is missing a primitive — extend `core/schema.ts` (plus
  `core/types.ts` and the engine) instead.
- **No remotely loaded code or recipes, ever.** Discovered profiles are
  structural output of the packaged interpreter, never downloaded behavior.
- **Search stays read-only.** Route exploration is GET-only in disposable
  inactive tabs. It never submits forms, and never follows logout, checkout,
  purchase, cancellation, deletion, or authorization paths. Semantic controls
  may be activated only after the user's explicit Connect & Collect, only when
  visible and enabled, and never when labelled as a mutation.
- **Keep platform globals out of shared code.** Nothing in `src/core/`,
  `src/vendors/`, or `src/ingest/` may import from `collector/`, or touch
  `chrome`, `window`, `navigator`, `localStorage`, or `sessionStorage`.
- **No authoring capabilities in the consumer build.** `core/recorder/` ships as
  the capture and inference library discovery runs on, but Collector has no
  `debugger` access, no CDP-backed recording, and no fingerprint delivery path.
  Packaging fails if those markers reappear in the bundle.
- **Never widen permissions casually.** Discovery requests the exact origins the
  user's own candidates need. Broad host patterns, private hosts, and wildcards
  are rejected.
- **Diagnostics stay structural.** Origins, raw paths, queries, headers, bodies,
  selectors, identifiers, tokens, and free-form supplier error strings must never
  reach storage, logs, or a PR. Bounded counts, typed cause codes, and
  `:id`-templated route shapes are what we keep.
- **No credentials, anywhere.** If a portal authenticates billing calls with an
  in-memory bearer token rather than cookies, support is blocked pending a
  reviewed least-privilege design. Do not persist or embed the token.
- **Concurrency is policy, not ad-hoc `Promise.all`.** Widths live in
  `src/core/concurrency.ts`. Changing one is a reviewed decision — destination
  commits stay serialized.
- **Test data is synthetic or fully anonymized.** No real invoice, account id,
  personal identifier, cookie, or token in a fixture, test, issue, or PR.

## Before opening a PR

```bash
npm run ci              # typecheck + boundaries + recipe validation + tests
npm run build:collector # the extension must still build
```

For anything touching live collection, also run the acceptance loop in
[docs/testing.md](docs/testing.md).

## PR scope and review

- **One shape, one behavior, one PR.** Bundle unrelated changes separately.
- Say in the description what shape or boundary changed, what now works that
  didn't, and what is still rejected.
- Include the sanitized diagnostic and the before/after counts when the PR came
  from a live failure.
- Green CI is required, and so is a maintainer review. Don't merge your own PR
  without one, even if you have write access.
- Security-relevant findings go through [SECURITY.md](SECURITY.md), not a public
  issue or PR.

## Legacy: packaged recipes

`src/vendors/` still holds a small set of packaged recipes — Railway ships, and
GitHub, Slack, and Vercel remain repository examples Collector does not expose.
They predate generic discovery and are **not** the contribution path.

Don't send new packaged vendor recipes. If discovery can't handle a supplier,
that is a discovery gap — report it as a missing shape. Changes to the existing
recipes or to `src/vendors/lifecycle.ts` are maintainer-driven release work.
