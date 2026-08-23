# Plan 015: Replace route guessing with evidence-first adaptive acquisition

> **Executor instructions**: This is the master implementation plan that
> supersedes Plan 012. Execute its phases in order as separate, reviewable PRs;
> do not land one large refactor. Start every phase from a clean worktree based
> on the then-current `origin/main`, run the drift check, and stop when a STOP
> condition applies. Update this file and `plans/README.md` after each merged
> phase.
>
> **Do not use the experimental worktree as an implementation base**:
> `/Users/philiperiksson/Ratatosk/wt-fix-clickup-route-speed` contains an
> uncommitted literal `/settings/billing-details` experiment. It demonstrated
> the route-guessing treadmill; it is not part of this architecture and must not
> be copied, committed, or merged.
>
> **Drift check (run first)**:
>
> ```sh
> git fetch origin
> git diff --stat 740c227..origin/main -- \
>   README.md docs/architecture.md docs/testing.md package.json \
>   src/core/discovery.ts src/core/strategies/dom.ts \
>   collector/src/platform/browser-dom-driver.ts \
>   collector/src/platform/discovery.ts \
>   collector/src/platform/discovery-candidates.ts \
>   collector/src/platform/discovery-diagnostic.ts \
>   collector/src/platform/discovery-dom-policy.ts \
>   collector/src/platform/discovery-explorer.ts \
>   collector/src/platform/discovery-page-observer.ts \
>   collector/src/platform/discovery-route-memory.ts \
>   collector/src/platform/discovery-state.ts \
>   collector/src/platform/discovered-suppliers.ts \
>   collector/src/platform/service-worker.ts \
>   collector/src/ui/popup/popup.ts \
>   test/core test/support/portal-simulator.ts
> ```
>
> If an in-scope contract differs materially from the current-state facts below,
> revise this plan in its own planning PR before implementation. Do not silently
> reinterpret an acceptance row.

## Status

- **Priority**: P0
- **Effort**: L (five PRs)
- **Risk**: HIGH
- **Depends on**: automated foundations from Plans 011 and 013; their remaining
  live acceptance is a final release gate, not a blocker for Phases 0–3
- **Supersedes**: `plans/012-build-adaptive-supplier-acquisition-fabric.md`
- **Category**: correctness, performance, security, tests, UX
- **Planned at**: commit `740c227`, 2026-08-22
- **Implementation status (2026-08-23)**: IN PROGRESS — Phases 0–4 automated
  work, package verification, and security audit pass. Exact-build Chrome and
  authorized ClickUp first/second/cadence acceptance remain required before a
  release, submission, or publication claim.

## Outcome

Ratatosk must find invoice surfaces from evidence the authenticated application
actually exposes, not from an expanding list of guessed billing URLs. A fast
search must finish within its advertised ten-second envelope. If it cannot
finish, it must retain a resumable frontier and offer an explicit deeper search;
it must not silently turn a ten-second action into a 55-second spinner.

The target flow is:

```text
exact active tab + one cold replay
  -> observed route hints
     (DOM/ARIA, same-document navigation, ResourceTiming/network,
      inert structured data, previously proved local memory)
  -> safe, provenance-aware frontier
  -> bounded and diverse route probes
  -> candidate replayability check
  -> existing PDF/traversal/identity verification
  -> proof-confirmed local memory
  -> existing transactional sink
```

The scalable unit is a packaged evidence primitive and route shape, not a
supplier name or a vendor path. There is no browser API that enumerates an
unvisited private SPA route table. If the application exposes no safe route,
link, navigation, network, structured-data, or document evidence, the honest
terminal UX is to ask the user to open the billing area once and search again.

## Why this replaces Plan 012

Plan 012 chose the right safety boundary—packaged deterministic behavior,
proof before promotion, no remote recipes—but it was written at `3d33b9f`.
Since then, roughly ten thousand changed lines have landed in its broad scope,
including cold replay, semantic DOM acquisition, transactional document
ownership, fair exploration families, diagnostics, and local route memory.
Implementing its eight original phases now would rebuild shipped behavior and
reintroduce removed or speculative surfaces.

This plan keeps four useful ideas from Plan 012:

1. observed evidence outranks guesses;
2. exploration is bounded, fair, resumable, and deterministic;
3. a replacement route is used only after end-to-end proof;
4. the last proved local route remains a rollback/fallback.

It removes the parts that are not needed to fix or scale supplier discovery:

- no Studio archetype-lab rebuild;
- no remote repair recipes, prompts, selectors, or model actions;
- no JavaScript-bundle route mining or `eval`;
- no Collector `debugger`, cookies, broad host access, or new install-time
  permissions;
- no general browser agent;
- no standards/e-invoicing ingestion project in this plan;
- no production WebMCP execution;
- no arbitrary 100-portal coverage claim as a prerequisite to ship a bounded
  correctness fix.

## Evidence and design basis

Recheck these primary sources before implementation because browser capabilities
and Web Store policy can change.

| Finding | Consequence |
| --- | --- |
| The Navigation API reports real navigations, including same-document SPA navigation, but does not publish an application's unvisited route table: <https://developer.chrome.com/docs/web-platform/navigation-api> | Observe actual `navigate` destinations as route evidence. Never treat the API as route enumeration. |
| `chrome.webNavigation` reports navigations that occur and requires extension permission: <https://developer.chrome.com/docs/extensions/reference/api/webNavigation> | Do not add the permission in this plan. The already-injected page observer is sufficient for same-document evidence; any permission proposal requires a separate security review. |
| Resource Timing exposes resources the document actually requested: <https://www.w3.org/TR/resource-timing/> | Use same-origin, bounded, high-signal resource URLs as hints. Do not infer arbitrary routes or persist sensitive query data. |
| Accessible names can come from `aria-labelledby`, `aria-label`, associated labels, and text alternatives: <https://www.w3.org/TR/accname-1.2/> | Discovery and collection must resolve the same bounded accessible-name inputs; otherwise discovery misses controls that collection could use. |
| JSON-LD and Schema.org can describe invoice-shaped data: <https://www.w3.org/TR/json-ld11/> and <https://schema.org/Invoice> | Treat inert structured data as evidence only. It cannot bypass existing artifact, identity, or traversal proof. |
| Web app manifests may contain developer-declared shortcuts: <https://www.w3.org/TR/appmanifest/> | Same-origin shortcuts may be an optional observed hint only after the core lanes work; do not fetch speculative manifests in the fast path. |
| Manifest V3 requires extension logic to remain self-contained: <https://developer.chrome.com/docs/webstore/program-policies/policies#additional-requirements-for-manifest-v3> | All interpretation and ranking logic stays packaged. Local memory stores proved data, not executable instructions. |
| WebMCP remains an emerging browser capability: <https://developer.chrome.com/docs/ai/webmcp> | Detection may be planned later. It is not an execution lane here. |
| Browser-agent benchmarks still show broad autonomous web operation is difficult: <https://arxiv.org/abs/2307.13854> | Keep deterministic, read-only primitives and explicit proof authoritative. |

## Current state and root causes

### Reported regression

Collector 0.8.49 discovery engine 36 reported for `app.clickup.com`:

- `limit_reached`, stopped on `time_cap`;
- deep mode consumed all 45,000 ms;
- 22 of 40 pages were probed;
- 10 linked and 10 common routes were attempted;
- zero candidates were compiled;
- stale guesses such as `/:id/billing`, `/:id/invoices`,
  `/:id/receipts`, and `/billing/history` consumed several seconds each.

Adding today's literal ClickUp route would fix one account until the next route
rename. It would not fix the shared cause and would slow every other unknown
supplier by adding another guessed page.

### Existing behavior to reuse

- `collector/src/platform/discovery-explorer.ts:44-47` already defines fast,
  deep, and self-heal budgets of 10, 45, and 120 seconds.
- `collector/src/platform/discovery-explorer.ts:60-82` already names exploration
  families, and `:382-396` already performs deterministic family-fair ranking.
- `collector/src/platform/discovery.ts:223-242` already registers a
  document-start observer and opens reusable background exploration tabs.
- Discovery keeps the active tab passive. Its disposable replay may branch
  across at most four native menus and two localized Settings/Billing controls.
- `collector/src/platform/discovery.ts:1225-1235` already reads bounded
  ResourceTiming evidence.
- `collector/src/platform/discovery-page-observer.ts:32-62` already installs in
  the page's main world before SPA startup and wraps fetch/XHR without exporting
  credentials.
- `collector/src/platform/semantic-action-observer.ts:71-100` already has a
  tab-scoped `webRequest` observation pattern, and the current manifest already
  packages that permission. It is a conditional metadata fallback, not a reason
  to broaden permissions or capture bodies/headers.
- `collector/src/platform/discovery-route-memory.ts:49-68` already remembers a
  route only after a verified document and revalidates it on every read.
- Plans 011 and 013 already provide cold replay and transactional DOM document
  acquisition. Reuse those paths; do not create a second engine or sink.

### Defects to correct

1. **Guesses still dominate the frontier.**
   `collector/src/platform/discovery-explorer.ts:272-290` contains two static
   billing-route lists, and `:343-368` adds them whenever common routes are
   enabled. They are useful only as a cheap last resort, not as the main route
   discovery mechanism.

2. **Fast failure silently becomes a full deep scan.**
   `collector/src/platform/service-worker.ts:638-644` catches every fast
   `SupplierDiscoveryError` and calls `scan("deep", undefined)`. The user sees
   one spinner for up to roughly 55 seconds, and the fast checkpoint is thrown
   away.

3. **Checkpoint data is written but its frontier is not restored.**
   `collector/src/platform/discovery.ts:219-248` restores counters, but line 234
   always rebuilds the queue from the current entry. Lines 257-274 persist only
   frontier keys/family/score/depth, not enough sanitized route material to
   reconstruct the queue. Resumption can repeat pages and burn the same budget.

4. **Planner admission and collection replay disagree.**
   The planner may probe a route containing an observed opaque tenant segment,
   while `src/core/discovery.ts:383-390` normalizes a credential-like entry path
   to `/`. `collector/src/platform/discovery.ts:2047-2053` applies that
   normalization before the candidate is persisted. A candidate can therefore
   be discovered on one page and later reopen the shell instead of the proved
   surface.

5. **Discovery sees fewer accessible names than collection.**
   The injected discovery probe does not fully include `aria-labelledby` and
   associated label text even though the collection path has richer structural
   context. The two paths must share one bounded label resolver.

6. **The synthetic portal does not exercise the real probe lifecycle.**
   `test/support/portal-simulator.ts:204-235` collapses hydration into one wait,
   and `:361-378` returns simulated evidence instead of running the injected
   reveal, quiescence, mutation, scroll, and ResourceTiming phases. It can prove
   scheduler behavior, but not real in-page discovery behavior.

7. **Documentation contradicts behavior.**
   `README.md:101` says search never clicks, while discovery may click a bounded
   semantic navigation control to reveal inert account/settings UI. The product
   promise must describe the actual safety boundary.

## Program invariants

- Search remains exact-origin and read-only. A semantic navigation click may
  reveal or navigate to existing UI; it may not submit forms, buy, cancel,
  delete, invite, authorize, or change account state.
- The extension never invents an unobserved tenant value, route, request body,
  header, selector, or action.
- Raw response bodies, account identifiers, invoice values, signed URLs,
  credentials, and page HTML do not enter diagnostics, checkpoints, or route
  memory.
- Candidate ranking is deterministic for identical sanitized evidence.
- Static common routes remain bounded, generic, and lowest priority. This plan
  adds no supplier-specific route literal.
- `safeEntryUrl` remains fail-closed. A replay fix must prove where a tenant
  binding comes from; it must not reclassify opaque path values as safe merely
  because a later segment says `billing`.
- Existing candidate validation, transactional DOM acquisition, PDF admission,
  traversal proof, identity reservation, duplicate suppression, and sink
  journaling remain authoritative.
- A time or page cap yields `limit_reached`. Only an exhausted observed and
  fallback frontier may yield `not_found`.
- No new runtime dependency is required. Use the existing TypeScript, Vitest,
  Chrome APIs, and packaged observer.

## Minimal contracts

Extend the existing `ExplorationTarget`; do not create a parallel acquisition
framework. The exact TypeScript may change during review, but it must preserve
these semantics:

```ts
type RouteHintSource =
  | "active_entry"
  | "cold_replay"
  | "dom_link"
  | "semantic_navigation"
  | "resource_timing"
  | "observed_request"
  | "structured_data"
  | "remembered"
  | "common_fallback";

interface ExplorationTarget {
  url: string;                 // ephemeral exact URL; never copied to diagnostics
  depth: number;
  source: ExplorationPageSource;
  family: ExplorationFamily;
  hintSource: RouteHintSource;
  score: number;
  label?: string;              // bounded, normalized, non-sensitive
  context?: string;            // bounded intent class, not raw page text
}
```

Checkpointed targets must use an existing sanitizer to store only a replayable
same-origin route or a typed route template. A hash/key without reconstruction
material is diagnostic data, not a resumable frontier.

The replayability decision is closed:

```text
exact safe route
  -> persist and replay

route with one opaque tenant segment
  -> persist only a structural template if the same run proves that segment
     from an existing typed config scope; resolve it at collection time

anything else
  -> may be inspected ephemerally, but cannot become a connected supplier
```

For DOM recipes, reuse the existing template renderer. The smallest expected
core change is to render `DomListSpec.open` with the already-resolved scope
variables before `driver.run`, then validate the rendered URL with one narrow
`safeScopedEntryUrl(template, rendered)` policy. That policy accepts only the
reviewed typed full-segment substitution on the same origin; it does not replace
or loosen `safeEntryUrl`. Do not introduce a general route DSL.

## Implementation phases

### Phase 0 — Freeze the regression and make tests honest

Create one synthetic supplier fixture with an arbitrary route name, delayed SPA
hydration, an actual observed navigation to that route, and an invoice control.
Its route name must be generated from neutral words and must not contain
`clickup` or `billing-details`. Add the corresponding stale common-route decoys
that consume time but cannot produce candidates.

Keep the existing portal simulator for queue, concurrency, cancellation, and
deadline tests. Make its trace expose each modeled probe phase separately:

1. safe navigation reveal;
2. observer quiescence;
3. mutation settle;
4. bounded scroll;
5. ResourceTiming snapshot.

Do not claim that this simulator executed browser DOM. Add a small fixture page
to the existing exact-Chrome semantic acceptance procedure so the real packaged
`collectPageEvidenceInPage` is checked before release. Do not add Playwright,
Puppeteer, jsdom, or another harness dependency for this phase.

Add an end-to-end synthetic assertion that the URL on which discovery compiled
a candidate is the URL the DOM driver later opens. This test must fail against
the current normalization mismatch.

**Files**:

- `test/support/portal-simulator.ts`
- `test/core/discovery-explorer.test.ts`
- `test/core/discovery-supplier-shapes.test.ts`
- `test/core/discovery-profile.test.ts`
- `test/core/semantic-dom-acceptance.test.ts`
- `store/semantic-dom-acceptance.template.json` only if a new result field is
  needed; never edit a real acceptance receipt
- `docs/testing.md`

**Focused verification**:

```sh
PATH=/opt/homebrew/bin:$PATH npx vitest run \
  test/core/discovery-explorer.test.ts \
  test/core/discovery-supplier-shapes.test.ts \
  test/core/discovery-profile.test.ts \
  test/core/semantic-dom-acceptance.test.ts
PATH=/opt/homebrew/bin:$PATH npm run typecheck
git diff --check
```

**Exit evidence**:

- the new fixture fails for the current route-guessing/replay behavior;
- existing deadline and cancellation cases still pass;
- the test output distinguishes modeled scheduler phases from exact-Chrome DOM
  acceptance.

### Phase 1 — Capture observed route evidence

Extend the existing page observer with one bounded route snapshot. Capture only
destinations the application actually exposed during the current run:

- same-origin HTTPS `NavigationEvent.destination.url` values;
- same-origin destinations passed to `history.pushState` or
  `history.replaceState` when the Navigation API is unavailable;
- `popstate` and `hashchange` destinations;
- visible or accessibility-linked anchors after each safe semantic reveal;
- same-origin, high-signal ResourceTiming URLs already observed by the document;
- same-origin URLs in bounded inert JSON/JSON-LD nodes when their key path or
  surrounding type has invoice/document intent.

Restore every wrapped browser function in `stop()`. Cap the route list and URL
length, strip fragments and unsafe query data through existing safety helpers,
and keep exact values only in page memory for the lifetime of the run.

Create one bounded accessible-name helper in
`collector/src/platform/discovery-dom-policy.ts` and call it from both discovery
enumeration and collection-side semantic matching. It must include, in order,
`aria-labelledby` references, `aria-label`, associated label text, title/alt,
and bounded visible text. It must reject missing/cyclic references, hidden
dangerous controls, and text beyond existing caps.

Convert every accepted observation into the extended existing
`ExplorationTarget`. Rank sources in this order:

1. verified remembered route;
2. exact active entry and cold replay;
3. observed semantic navigation or DOM link;
4. observed request or ResourceTiming route;
5. inert structured-data route;
6. contextual/common guessed route.

Ranking within a source remains deterministic and family-fair. No supplier name
or literal route appears in production code.

If a synthetic worker-mediated fixture proves the main-world observer misses
required request metadata, reuse the existing tab-scoped `webRequest` observer
for URL, method, status, redirect, and content type only. Keep it exact-origin,
strip query values, retain it only for the current search, and capture no body,
header, Cookie, or Authorization data. Do not add this fallback without that
failing fixture.

**Files**:

- `collector/src/platform/discovery-page-observer.ts`
- `collector/src/platform/discovery-dom-policy.ts`
- `collector/src/platform/discovery.ts`
- `collector/src/platform/discovery-explorer.ts`
- `collector/src/platform/browser-dom-driver.ts`
- `collector/src/platform/discovery-diagnostic.ts`
- `collector/src/platform/semantic-action-observer.ts` only if the conditional
  worker-mediated fixture proves it is needed
- `test/core/discovery-explorer.test.ts`
- `test/core/discovery-supplier-shapes.test.ts`
- `test/core/browser-dom-boundary.test.ts`
- `test/core/semantic-action-observer.test.ts`

**Focused verification**:

```sh
PATH=/opt/homebrew/bin:$PATH npx vitest run \
  test/core/discovery-explorer.test.ts \
  test/core/discovery-supplier-shapes.test.ts \
  test/core/browser-dom-boundary.test.ts \
  test/core/semantic-action-observer.test.ts
PATH=/opt/homebrew/bin:$PATH npm run typecheck
PATH=/opt/homebrew/bin:$PATH npm run check:boundaries
git diff --check
```

**Exit evidence**:

- an arbitrary route observed through navigation is probed before every common
  guess;
- the same route string without observed provenance is not admitted;
- `aria-labelledby` produces the same safe label in discovery and collection;
- unsafe, cross-origin, credential-shaped, and mutating destinations are
  rejected;
- observer teardown restores the page's original APIs.

### Phase 2 — Make fast search truly fast and resume deeper search

Delete the automatic fast-to-deep catch in
`collector/src/platform/service-worker.ts`. A fast scan must return a typed
`limit_reached` or `not_found` within the ten-second envelope. On
`limit_reached`, the popup shows a single `Search Deeper` action; on exhausted
`not_found`, it shows `Open billing page and Search Again`.

`Search Deeper` starts `deep` mode with the saved fast checkpoint. It is an
explicit user action and may run after the popup closes. The UI must display the
remaining upper bound, never more than 35 additional seconds after a full fast
run. Background self-heal remains separate and must never inherit an interactive
spinner.

Make checkpoints actually resumable:

- persist sanitized reconstructable targets, not only hashes;
- restore the queue from the checkpoint before adding newly observed hints;
- retain completed-target keys and cumulative elapsed/page counters;
- reject checkpoints for another origin, engine version, invalid route policy,
  or an unapproved mode transition; the only permitted transition is an
  explicit user-requested fast-to-deep continuation;
- on fast-to-deep continuation, preserve completed targets but apply the deep
  total budget once—do not add 45 seconds to time already charged to the same
  run;
- checkpoint after each completed wave and before returning `limit_reached`;
- never probe a completed target twice after service-worker restart.

Thread one absolute per-target deadline through navigation, semantic reveal,
quiescence, mutation settle, scroll, and evidence snapshot. A later phase gets
only remaining time. It must not restart its own full timer.

Keep common route guesses, but schedule at most one generic/contextual fallback
per family round, only in explicit deep mode, and only after observed evidence
for that round. Fast mode uses no common guessed route. Do not expand the route
lists in this phase.

Assign page patience by `hintSource`, not by billing words in the pathname.
Remembered and actually observed destinations may receive the existing longer
settle window. A common fallback receives a short stable-no-evidence cutoff and
cannot consume the 8–10 second deep probe intended for evidenced routes.

**Files**:

- `collector/src/platform/discovery-explorer.ts`
- `collector/src/platform/discovery.ts`
- `collector/src/platform/discovery-state.ts`
- `collector/src/platform/service-worker.ts`
- `collector/src/platform/messaging.ts`
- `collector/src/ui/popup/popup.ts`
- `test/core/discovery-explorer.test.ts`
- `test/core/discovery-state.test.ts`
- `test/core/collector-popup-ui.test.ts` (create)
- `test/core/collector-runtime-identity.test.ts`

**Focused verification**:

```sh
PATH=/opt/homebrew/bin:$PATH npx vitest run \
  test/core/discovery-explorer.test.ts \
  test/core/discovery-state.test.ts \
  test/core/collector-popup-ui.test.ts \
  test/core/collector-runtime-identity.test.ts
PATH=/opt/homebrew/bin:$PATH npm run typecheck
PATH=/opt/homebrew/bin:$PATH npm run check:boundaries
git diff --check
```

**Exit evidence**:

- fake-clock fast failure is at or below 10,000 ms and never invokes deep mode;
- explicit deep continuation starts from the saved frontier;
- simulated worker restart repeats zero completed targets;
- cumulative page/time accounting is preserved;
- cancelling or changing the active origin prevents continuation;
- one slow page cannot exceed its remaining global deadline;
- popup copy clearly distinguishes `Search Deeper` from the guided fallback.

### Phase 3 — Require replayable routes before connection

Move the replayability decision ahead of candidate retention. A candidate is not
shown as connectable unless the collection path can reproduce the same invoice
surface under the current safety policy.

Support only two persisted route forms:

1. an exact URL accepted unchanged by `safeEntryUrl`; or
2. a structural URL template containing one typed tenant placeholder whose
   value is discovered at run time by an existing safe config-scope request.

For the second form:

- the observed route must contain exactly one opaque segment;
- the same discovery run must observe the identical value under a typed tenant
  key already accepted by `assertTypedDiscoveredScopeValue`;
- replace only that full path segment with the existing scope placeholder;
- persist the template and extractor, never the observed tenant value;
- render `DomListSpec.open` with resolved scope variables before calling the DOM
  driver;
- validate the persisted template through discovered-recipe policy and validate
  the rendered run-only URL with `safeScopedEntryUrl`; never pass the rendered
  opaque value through or weaken generic `safeEntryUrl`;
- if proof is missing or ambiguous, reject the candidate with a typed
  `route_not_replayable` diagnostic and offer the guided fallback.

Do not weaken `looksCredentialLike`, `hasUnsafeCredentialPath`, or the
root-opaque-segment denial. Do not add an encryption layer or a second secret
store; template the value or reject it.

Before showing `Possible invoice source`, execute a no-sink replay check in a
fresh disposable tab: open the persisted exact/template route, enumerate the
same semantic/network candidate family, and compare the sanitized route shape
and candidate identity. Existing `Verify & Collect` remains the only path that
may materialize a document and call the transactional sink.

Extend local route memory minimally:

- keep current v1 exact routes readable;
- add a v2 record only when a route template is required;
- store route shape, scope extractor identity, proof timestamp, miss count, and
  discovery engine version;
- keep the previous proved record until the replacement passes one later
  successful collection;
- promote and roll back with the existing serialized storage write chain;
- cap origins and misses exactly as today.

Do not introduce a general generation framework. One active and one previous
proved route is sufficient; add more only if a real rollback case demonstrates
the need.

**Files**:

- `src/core/discovery.ts`
- `src/core/strategies/dom.ts`
- `collector/src/platform/discovery.ts`
- `collector/src/platform/discovery-candidates.ts`
- `collector/src/platform/discovery-route-memory.ts`
- `collector/src/platform/discovered-suppliers.ts`
- `collector/src/platform/browser-dom-driver.ts`
- `collector/src/platform/discovery-diagnostic.ts`
- `test/core/discovery-profile.test.ts`
- `test/core/discovery-candidate-fallback.test.ts`
- `test/core/discovery-route-memory.test.ts`
- `test/core/discovered-suppliers.test.ts`
- `test/core/dom-acquisition-transaction.test.ts`

**Focused verification**:

```sh
PATH=/opt/homebrew/bin:$PATH npx vitest run \
  test/core/discovery-profile.test.ts \
  test/core/discovery-candidate-fallback.test.ts \
  test/core/discovery-route-memory.test.ts \
  test/core/discovered-suppliers.test.ts \
  test/core/dom-acquisition-transaction.test.ts
PATH=/opt/homebrew/bin:$PATH npm run typecheck
PATH=/opt/homebrew/bin:$PATH npm run check:boundaries
git diff --check
```

**Exit evidence**:

- a candidate discovered on a safe exact route reopens that exact route;
- a root-level opaque tenant route connects only when a typed scope proves and
  resolves its template;
- raw tenant values are absent from persisted profile, route memory,
  checkpoint, diagnostic, and test snapshot JSON;
- an ambiguous/missing tenant proof fails closed;
- first successful collection promotes the new proved route and a subsequent
  structural failure restores the previous route;
- replay and rollback produce zero duplicate sink commits.

### Phase 4 — Prove scalability, update truth, and gate release

Build a compact mutation corpus from the Phase 0 fixture. Each mutation changes
one dimension while keeping the invoice surface semantically equivalent:

1. arbitrary route rename;
2. DOM class and nesting churn;
3. `aria-labelledby` instead of visible button text;
4. localized safe invoice/account labels;
5. delayed shell and delayed invoice hydration;
6. same-document navigation via Navigation API and history fallback;
7. invoice URL observed only through ResourceTiming;
8. one safe iframe case already permitted by current boundaries;
9. hundreds of irrelevant settings links competing with one observed route;
10. service-worker restart between frontier waves;
11. unsafe purchase/delete/logout look-alikes;
12. opaque route without typed scope proof.

Expected results are closed: `candidate_found`, `limit_reached`, `not_found`, or
`policy_rejected`. A test may not loosen safety policy to turn a negative case
green.

Update public and internal documentation:

- explain observed-evidence-first discovery and bounded generic fallbacks;
- replace “Search never clicks” with the accurate promise that search may use a
  bounded, non-mutating navigation control to reveal invoice UI and never
  activates document/mutating actions before transactional verification;
- document the 10-second fast search, explicit 45-second deeper search, and
  guided “open billing page once” fallback;
- document exactly what local route memory stores and how to clear it;
- state honestly that unlinked/unobserved private routes cannot be discovered.

Increment the discovery engine only in the behavior-changing PR and update all
runtime-identity assertions. Do not bump the extension version or publish from
an implementation PR.

**Files**:

- `test/core/discovery-supplier-shapes.test.ts`
- `test/core/discovery-explorer.test.ts`
- `test/core/discovery-shape-corpus.test.ts`
- `test/support/portal-simulator.ts`
- `README.md`
- `docs/architecture.md`
- `docs/testing.md`
- `plans/README.md`
- runtime identity files already covered by the focused tests, only if the
  engine counter changes there

**Automated verification**:

```sh
PATH=/opt/homebrew/bin:$PATH npm ci
PATH=/opt/homebrew/bin:$PATH npm run typecheck
PATH=/opt/homebrew/bin:$PATH npm run check:boundaries
PATH=/opt/homebrew/bin:$PATH npm run validate
PATH=/opt/homebrew/bin:$PATH npm test
PATH=/opt/homebrew/bin:$PATH npm run build:collector
PATH=/opt/homebrew/bin:$PATH npm run audit:security
git diff --check
```

**Exact-build Chrome acceptance**:

Use a clean Chrome profile with the exact unpacked `dist/collector` build and
only synthetic or authorized test accounts. Record no page content, account ID,
invoice ID, header, response body, credential, or PDF bytes.

1. **Arbitrary-route fixture**: fast search finds the observed invoice surface
   without a literal route in production code and finishes within ten seconds.
2. **Opaque-tenant fixture**: discovery, preview replay, Verify & Collect, second
   run, and cadence run all reopen the proved route; exactly one document is
   delivered.
3. **Blind renamed fixture**: rename the route after build without changing the
   extension; observed navigation still finds it.
4. **No-evidence fixture**: fast search stops within ten seconds and the guided
   fallback is shown; it does not burn the 45-second deep budget automatically.
5. **Authorized ClickUp acceptance**: begin at the same ordinary signed-in page
   that produced the original diagnostic. Do not tell the engine the private
   route. Confirm fast discovery, exact preview replay, one valid PDF delivery,
   second-run duplicate suppression, and cadence behavior. Save only the
   existing sanitized acceptance receipt.

Only after all automated and exact-build rows pass may the release operator run:

```sh
PATH=/opt/homebrew/bin:$PATH npm run release:collector
```

This command validates a candidate; it does not authorize a version bump, Web
Store upload, submission, or publication. Those remain separate explicit user
actions.

## Acceptance matrix

| ID | Requirement | Proof |
| --- | --- | --- |
| A1 | No supplier-specific production route is added | `rg -n "clickup|billing-details" collector/src src/core` has no new match; reviewed diff shows generic evidence primitives only |
| A2 | Observed routes outrank guesses | deterministic planner test with arbitrary renamed route and stale decoys |
| A3 | Fast means at most ten seconds | fake-clock test plus exact-build no-evidence fixture |
| A4 | Deep search is explicit and resumable | UI/state test and restart trace with zero repeated completed targets |
| A5 | Every target has one absolute deadline | phase-timing trace cannot exceed remaining target/global budget |
| A6 | Discovery and collection use the same accessible-name inputs | `aria-labelledby` parity tests on both paths |
| A7 | Connected candidate reopens the proved surface | discovery-to-DOM-driver URL assertion |
| A8 | Opaque tenant values require typed runtime provenance | positive template case and negative ambiguous/missing cases |
| A9 | No raw account/credential/invoice data persists | seeded-canary scans of profiles, route memory, checkpoints, diagnostics, and acceptance JSON |
| A10 | Existing document safety remains authoritative | Plan 013 transaction tests and full suite pass |
| A11 | Route replacement is recoverable | active/previous promotion and rollback test |
| A12 | No duplicate delivery | first/second/cadence synthetic and authorized acceptance |
| A13 | Route churn does not require a code change | blind renamed fixture after exact build |
| A14 | Honest terminal state exists | no-evidence fixture yields guided fallback, not invented routes |
| A15 | Release artifact is exact and validated | exact-build receipt followed by `npm run release:collector` |

## Done criteria

- [ ] Phases 0–4 are merged as separate reviewed PRs from clean worktrees.
- [ ] All acceptance rows A1–A15 have retained non-sensitive evidence.
- [ ] The literal ClickUp experiment was never merged.
- [ ] Observed evidence drives the frontier; generic route guesses are bounded
      last-resort candidates and no supplier-specific path exists in production.
- [ ] Fast discovery stops within ten seconds and never automatically launches
      deep discovery.
- [ ] Explicit deep discovery resumes the saved frontier without repeated pages
      or reset accounting.
- [ ] Candidate admission proves collection can reopen the same route.
- [ ] Opaque tenant routes persist only as a template backed by an existing typed
      run-time scope; otherwise they fail closed.
- [ ] Existing PDF, traversal, identity, transaction, and duplicate gates pass.
- [ ] Mutation and exact-build Chrome acceptance pass, including authorized
      ClickUp first/second/cadence behavior.
- [ ] `npm ci`, typecheck, boundaries, validation, full tests, Collector build,
      high-severity audit, and `git diff --check` exit 0.
- [ ] Documentation describes actual bounded navigation behavior and limitations.
- [ ] Plans 011 and 013 remaining exact-build live acceptance is complete before
      any Web Store release is submitted.
- [ ] `plans/README.md` is marked DONE only after exact-build and release
      validation, not after local tests or merge alone.

## STOP conditions

Stop and report; do not improvise or weaken the model if:

- success requires adding a supplier-specific route, selector, or supplier-name
  branch to production discovery;
- success requires persisting an opaque tenant/account value without typed
  runtime provenance;
- `safeEntryUrl`, credential-path, origin, request, semantic-action, document,
  traversal, identity, transaction, or duplicate policy must be weakened;
- the implementation needs `debugger`, cookies, `webNavigation`, broad host
  permissions, remote code, remote recipes, a general browser agent, bundle
  mining, or JavaScript evaluation;
- a fast run can still enter deep mode without an explicit user action;
- a checkpoint cannot reconstruct the frontier safely or a restart repeats
  completed targets;
- identical sanitized evidence produces different target or candidate order;
- discovery claims a candidate that collection cannot reopen in a fresh tab;
- an observer wrapper is not restored or changes normal page behavior;
- a safe navigation primitive can activate a mutating/document control before
  the existing transactional acquisition boundary;
- any persisted diagnostic, checkpoint, profile, memory record, fixture, log, or
  acceptance artifact contains a seeded sensitive value;
- exact Chrome acceptance requires real customer documents or unsanitized
  account evidence; use a synthetic/authorized account or stop;
- an implementation phase must edit files outside its scope without first
  revising this plan.

## Handoff discipline

- Use one branch and PR per phase, named from the outcome, for example
  `test/discovery-route-replay-regression`,
  `feat/observed-discovery-routes`, `fix/resumable-discovery-budgets`,
  `fix/discovery-route-replay-proof`, and
  `test/discovery-mutation-acceptance`.
- Each PR description must list its acceptance rows, focused test output, full
  gates run, and any remaining manual acceptance. Do not call a PR “released” or
  “published.”
- Do not commit real diagnostics or overwrite
  `store/semantic-dom-acceptance.json` with evidence from another build.
- Preserve unrelated dirty work. Never reset the canonical checkout to prepare a
  phase.
- After every merge, refresh `origin/main`, rerun the drift check for the next
  phase, and update plan status from current evidence.
