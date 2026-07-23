# Plan 011: Discover hidden invoice routes through cold replay and make semantic downloads reproducible

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update this plan and the status row in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 3d33b9f..HEAD -- collector/src/platform/discovery.ts collector/src/platform/discovery-page-observer.ts collector/src/platform/discovery-explorer.ts collector/src/platform/discovery-diagnostic.ts collector/src/platform/browser-dom-driver.ts collector/src/platform/discovery-dom-policy.ts src/core/strategies/dom.ts src/core/retrieval.ts test/core docs/architecture.md docs/testing.md README.md package.json package-lock.json`
>
> This plan was written while unrelated UI/version changes were present in the
> working tree. Execute it only from a clean worktree based on the commit that
> contains those changes. If any in-scope file changed after `3d33b9f`, compare
> the current-state excerpts and invariants below against the live code before
> editing. A behavioral mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: bug, tests, direction
- **Planned at**: commit `3d33b9f`, 2026-07-21

## Why this matters

Unsupported-supplier discovery should learn from the application that is already
authorized in the user's browser rather than require a human to know its private
API routes. The current observer can capture early JSON fetch/XHR traffic, but it
is registered after the active SPA has already loaded; the entry probe therefore
cannot recover a response that has already happened. Supabase produced exactly
that false negative.

ClickUp exposed a second, independent gap. Search found four invoice-shaped DOM
controls on the tenant billing page and retained a `dom-actions` candidate, but
verification reopened the page and reported zero observed controls and zero
resolved documents. Candidate detection and candidate execution are therefore
not reproducible enough to support unattended sync.

After this plan, Collector must cold-load the exact current tenant billing URL
under its packaged observer, infer candidates without knowing API routes in
advance, and use one shared semantic-control policy during discovery and
verification. It must still refuse unsafe navigation, forms, arbitrary POSTs,
remote code, unapproved origins, and unverified document bodies.

## Incident evidence to preserve as acceptance cases

Do not commit the original diagnostics, URLs containing tenant identifiers,
response bodies, invoice metadata, or authenticated fixtures. Encode only these
bounded structural facts in synthetic tests and comments.

### Supabase false negative: entry traffic happened before observation

- Runtime: Collector `0.8.33`, discovery engine `22`.
- Entry shape: `/dashboard/org/:tenant/billing`.
- The active entry probe completed in 13 ms with zero JSON resources, zero
  observed requests, zero document links, and two structured-data scripts.
- The run knew that `api.supabase.com` had been contacted, but it captured no
  response body and compiled zero candidates.
- The queue exhausted after eleven pages. This was not an authentication,
  document-validation, or delivery failure.

### ClickUp false negative: retained semantic candidate was not reproducible

- Runtime: Collector `0.8.33`, discovery engine `22`.
- Tenant billing shape: `/:tenant/settings/billing`.
- Discovery observed 96 JSON responses in total. The billing page contributed
  twelve observed responses and four semantic controls.
- Search compiled and retained exactly one `dom-actions` candidate. It did not
  compile a network candidate or a direct document-link candidate.
- Verification attempted that candidate, visited one page, terminated with
  `explicit_end`, and reported `observedItems: 0`, `resolvedItems: 0`,
  `unresolvedItems: 0`, followed by `no_documents`.
- The strongest code-supported hypothesis is discovery/verification policy or
  readiness drift: discovery counts structurally matching controls without a
  visibility check, while `BrowserDomDriver` requires visible controls and uses
  a separately implemented predicate. The plan must prove or reject this with
  synthetic characterization tests before changing behavior.
- A secondary possibility is that a visible control requires an unsupported
  request shape to obtain its PDF. That is not established by the diagnostic;
  it must be reported distinctly if encountered instead of being guessed.

## Current state

### Discovery lifecycle

- `collector/src/platform/discovery.ts:105-141` reads the already-open entry URL,
  queues it as `source: "entry"`, then registers the `document_start` observer.
  The entry page is probed in place; it is not reloaded after registration.
- `collector/src/platform/discovery.ts:929-970` registers the packaged observer
  for the exact approved origin at `document_start` and unregisters it in
  `finally`.
- `collector/src/platform/discovery.ts:976-1009` opens later exploration routes
  in inactive tabs. Those future navigations receive the early observer, unlike
  the already-loaded active entry page.
- `collector/src/platform/discovery.ts:640-727` can stop DOM settling when generic
  structured data exists. Hydration scripts are useful evidence, but their mere
  presence does not mean the invoice API request has completed.
- `collector/src/platform/discovery.ts:730-810` sees cross-origin resource
  hostnames through Performance APIs, but only the installed page observer can
  provide cross-origin response bodies. Same-origin GET replay is a fallback,
  not a substitute for early observation.
- `collector/src/platform/discovery-page-observer.ts:28-196` wraps page-world
  `fetch` and XHR, retains at most twelve bounded JSON entries in memory, and
  removes its hooks at the end of the discovery run. Preserve these bounds and
  the ephemeral-only design.

### Route planning and candidate compilation

- `collector/src/platform/discovery-explorer.ts:11-14` bounds search to fifteen
  pages, depth three, and thirty seconds.
- `collector/src/platform/discovery-explorer.ts:72-167` combines common billing
  paths, tenant-scoped suffixes, and observed labelled links. It should remain a
  fallback; exact-entry cold replay must not become another list of vendor URLs.
- `collector/src/platform/discovery.ts:418-477` ranks network JSON, embedded JSON,
  direct links, and semantic actions. Semantic actions are retained without
  clicking during search and are verified only after user confirmation.
- `collector/src/platform/discovery.ts:1293-1337` stores the exact evidence page
  as the semantic recipe's `open` URL and permits only the same origin plus
  bounded cross-origin hosts observed while that page loaded.

### Semantic discovery and verification drift

- `collector/src/platform/discovery.ts:640-668` identifies a semantic control
  using explicit download language plus document language or invoice context.
  It does not require the control to be visible.
- `collector/src/platform/browser-dom-driver.ts:475-551` independently defines
  similar regular expressions and selectors, but requires non-zero geometry,
  visibility, and enabled state.
- `collector/src/platform/browser-dom-driver.ts:557-607` may reveal only an
  exact, safe invoice/receipt-history section before waiting for row controls.
- `collector/src/platform/browser-dom-driver.ts:614-759` resolves direct data
  URLs, HTTPS links, GET forms, click-created links, GET fetch/XHR PDF responses,
  and bounded PDF blobs. It suppresses non-GET requests during generic semantic
  collection. Keep that fail-closed default.
- `collector/src/platform/browser-dom-driver.ts:904-935` always creates a new
  inactive tab for semantic or continuation runs. This correctly protects the
  user's existing tab, but the reopened page must reproduce the evidence used to
  compile the candidate.
- `collector/src/platform/discovery-candidates.ts:16-77` accepts only a candidate
  that delivered at least one verified document and falls through candidate-local
  failures. Preserve this admission invariant.

### Existing conventions to match

- Keep browser-independent recipe/retrieval types under `src/core/`; Chrome APIs
  stay under `collector/src/platform/`.
- Injected page functions are self-contained and accept policy values as bounded
  arguments. Do not close over extension-world objects.
- Diagnostics are structural and bounded. Never store or copy paths, query
  values, headers, bodies, tokens, tenant IDs, invoice IDs, amounts, or dates.
- Tests use Vitest and synthetic `vendor.example` pages/data. Follow
  `test/core/discovery-adapters.test.ts`,
  `test/core/browser-dom-boundary.test.ts`, and
  `test/core/discovery-diagnostic.test.ts`.
- Discovery recipes remain declarative bundled data. Do not add remotely
  executable recipes or a vendor-specific ClickUp branch to the generic engine.

## Commands you will need

Run with a Node version allowed by `package.json` (`20.19.x` or Node 24). On this
machine, `/opt/homebrew/bin/node` avoids the ChatGPT-bundled Node library-validation
restriction for native Rolldown modules.

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Focused discovery tests | `npx vitest run test/core/discovery-entry-replay.test.ts test/core/discovery-explorer.test.ts test/core/discovery-adapters.test.ts test/core/discovery-diagnostic.test.ts` | exit 0; all tests pass |
| Focused DOM tests | `npx vitest run test/core/browser-dom-boundary.test.ts test/core/discovery-candidate-fallback.test.ts test/core/dom-document-integrity.test.ts` | exit 0; all tests pass |
| Typecheck | `npm run typecheck` | exit 0; no errors |
| Architecture | `npm run check:boundaries` | exit 0 |
| Recipe validation | `npm run validate` | exit 0 |
| Full tests | `npm test` | exit 0; all tests pass |
| Build | `npm run build:collector` | exit 0; Collector emitted to `dist/collector` |
| Security audit | `npm audit --audit-level=high` | exit 0; no high/critical advisory |
| Patch hygiene | `git diff --check` | exit 0; no output |

## Scope

**In scope** (the only implementation files to modify or create):

- `collector/src/platform/discovery.ts`
- `collector/src/platform/discovery-page-observer.ts`
- `collector/src/platform/discovery-explorer.ts`
- `collector/src/platform/discovery-diagnostic.ts`
- `collector/src/platform/browser-dom-driver.ts`
- `collector/src/platform/discovery-dom-policy.ts` (create only if needed to
  centralize the closed semantic policy)
- `collector/src/platform/collector-runtime-identity.ts`
- `src/core/strategies/dom.ts` and `src/core/retrieval.ts` only if bounded
  semantic phase counters must cross the existing retrieval-proof boundary
- `test/core/discovery-entry-replay.test.ts` (create)
- `test/core/discovery-explorer.test.ts`
- `test/core/discovery-adapters.test.ts`
- `test/core/discovery-shape-corpus.test.ts`
- `test/core/discovery-diagnostic.test.ts`
- `test/core/browser-dom-boundary.test.ts`
- `test/core/discovery-candidate-fallback.test.ts`
- `test/core/collector-runtime-identity.test.ts`
- `README.md`, `docs/architecture.md`, and `docs/testing.md`
- `package.json` and `package-lock.json` for one final patch-version increment
- `plans/README.md` and this plan for execution status/evidence

**Out of scope** (do not touch even if related):

- Bundled vendor recipes or a ClickUp/Supabase-specific recipe.
- Studio capture, Svala delivery, remote fingerprint intake, or remote browser
  infrastructure.
- Broad host permissions, `debugger`, `webRequest`, or credential persistence.
- Automatically allowing arbitrary POST, form submission, mutation, checkout,
  payment, cancellation, upgrade, deletion, logout, OAuth, or authorization
  actions.
- Persisting raw diagnostics, DOM excerpts, request/response bodies, paths,
  queries, header values, identifiers, financial values, or document bytes.
- Changing duplicate suppression, sinks, scheduling, or history reset behavior.
- Publishing, tagging, pushing, opening a PR, or creating a Web Store release.

## Git workflow

- Start from a clean worktree after the existing `0.8.33` changes are committed.
- Branch: `fix/discovery-cold-replay-semantic-parity`.
- Use focused commits such as `Fix exact-entry discovery replay` and
  `Make semantic candidate verification reproducible`.
- Do not push or open a PR unless the operator explicitly requests it.

## Steps

### Step 1: Add failing synthetic characterization tests

Create `test/core/discovery-entry-replay.test.ts` around a small exported or
dependency-injected orchestration seam. Do not test source strings when a
behavioral test is feasible. Cover all of the following before implementation:

1. The observer registration completes before any cold-replay tab is created.
2. The exact canonical entry URL, including its bounded tenant path but excluding
   fragment and unsafe query values, is opened once in an inactive disposable
   tab even though the active page URL is already in the visited set.
3. The active user tab is never reloaded, updated, scrolled, or closed.
4. A startup cross-origin JSON response visible only during cold replay reaches
   candidate compilation without the API route being preconfigured.
5. Generic hydration JSON present at document start does not end settling before
   a later invoice-shaped response arrives.
6. The replay tab closes and the dynamic observer unregisters on success,
   timeout, cancellation, and thrown probe error.
7. Total exploration remains at fifteen page attempts and thirty seconds; cold
   replay consumes a documented slot rather than silently exceeding the cap.

Add a synthetic ClickUp-shaped DOM case to
`test/core/browser-dom-boundary.test.ts`: controls exist structurally during
search, become visible only after a safe `Invoices` section is revealed, and
then generate a bounded GET/blob PDF. Assert that search and verification agree
on eligibility and that verification reports at least one observed and resolved
item. Add a negative twin where hidden unrelated controls do not compile.

**Verify**:
`npx vitest run test/core/discovery-entry-replay.test.ts test/core/browser-dom-boundary.test.ts`
must fail only on the missing cold replay/shared-policy behavior. If the tests
already pass without production changes, the hypothesis is wrong; STOP and
report the actual observed behavior.

### Step 2: Cold-replay the exact entry URL under the early observer

Refactor discovery orchestration so it has two explicit entry phases:

1. **Active snapshot**: inspect the user's current tab without navigation to
   obtain title, application name, visible routes, DOM links, and already
   available evidence.
2. **Exact-entry replay**: after `DiscoveryPageObserverRegistration.start()`
   succeeds, open the exact canonical entry URL in an inactive disposable tab
   and let the application boot naturally. Probe that tab before speculative
   linked/common routes.

The exact replay is the generic route-capture primitive: do not guess the API
endpoint. The application's own boot must reveal same-origin and cross-origin
fetch/XHR traffic to the existing bounded observer. Merge entry evidence by
stable request shape without persisting it, then compile/rank candidates using
the existing adapters.

Add an explicit structural diagnostic source such as `entry_replay` rather than
misreporting the replay as a linked/common route. Evolve the diagnostic schema
and parser together; retain backward parsing for existing bounded diagnostics if
that is the current convention. Increment `DISCOVERY_ENGINE_REVISION` only in
the final step after behavior and tests settle.

If observer registration fails, retain the current rendered-page and safe GET
fallbacks. Do not claim cold replay succeeded in diagnostics.

**Verify**:
`npx vitest run test/core/discovery-entry-replay.test.ts test/core/discovery-explorer.test.ts test/core/discovery-diagnostic.test.ts`
exits 0 and proves ordering, caps, cleanup, and structural-only diagnostics.

### Step 3: Wait for bounded network quiescence instead of generic hydration

Separate DOM readiness from observer readiness. A
`script[type="application/json"]` may make DOM evidence durable, but must not
cause an observed replay probe to finish before startup billing requests settle.

Implement a bounded observer snapshot/quiescence rule:

- Poll or subscribe only within the existing per-probe/global deadlines.
- Finish early after high-signal observed entries and control/link evidence have
  remained stable for a short deterministic quiet window.
- Treat changes in bounded request identity/count as activity; never compare or
  log full response bodies.
- If no high-signal entry arrives, finish at the existing bounded settle time.
- Snapshot pending observer work before returning so a response that arrived
  near the quiet boundary is not dropped.
- Preserve the twelve-entry, per-body, total-body, and 45-second observer limits.

Do not replay cross-origin URLs directly. Capture them only as responses to the
page's own authorized boot traffic.

**Verify**:
`npx vitest run test/core/discovery-entry-replay.test.ts test/core/discovery-adapters.test.ts test/core/discovery-shape-corpus.test.ts`
exits 0, including delayed API, cached/service-worker response, empty response,
and deadline cases.

### Step 4: Centralize semantic-control eligibility and readiness

Create one closed semantic policy used by both discovery and verification. If a
new `discovery-dom-policy.ts` is introduced, it should contain bounded selectors
and regex source strings/data only; injected page functions must receive those
values explicitly.

The shared policy must define:

- Eligible element selectors and label sources (`aria-label`, title, bounded
  text, `data-test`, `data-testid`, icon/name metadata).
- Explicit download verbs and invoice/receipt/document context.
- Unsafe labels and paths.
- Visibility, enabled-state, and form exclusions.
- Exact safe invoice/receipt-history section labels that may be revealed.
- Stable readiness: visible eligible controls must remain stable briefly after
  the safe section is revealed or rows render.

Discovery may record both structural and visible counts, but it must compile a
`dom-actions` candidate only when verification has a reproducible path: a visible
eligible control, or a visible exact safe section whose reveal can expose eligible
controls. A hidden element alone is not proof.

Keep search read-only. Only Connect & Collect may activate the packaged semantic
primitive.

**Verify**:
`npx vitest run test/core/discovery-adapters.test.ts test/core/browser-dom-boundary.test.ts test/core/discovery-shape-corpus.test.ts`
exits 0. The synthetic ClickUp mismatch must now reproduce controls in
verification, while hidden unrelated controls compile no candidate.

### Step 5: Make semantic action outcomes diagnosable without weakening safety

Extend bounded retrieval evidence only as far as needed to distinguish these
states:

- no eligible control rendered;
- safe invoice section found/revealed but no control rendered;
- eligible controls observed but not activated;
- controls activated but no document request/result appeared;
- document URL/blob captured but rejected by origin, size, or PDF validation;
- a non-GET/form/mutation-shaped request was suppressed.

Prefer bounded integer counters and closed enums. Propagate them through
`DomDriverRunResult`, retrieval proof, candidate verification diagnostic parsing,
and `Copy details`. Never include control labels, selectors, URLs, paths, query
values, request bodies, response bodies, headers, IDs, amounts, or dates.

Do not automatically permit a blocked non-GET request. Surface a distinct
candidate-local result such as `unsupported_document_action` so the run no longer
looks like a site with no invoices. Preserve candidate fallback.

**Verify**:
`npx vitest run test/core/browser-dom-boundary.test.ts test/core/discovery-candidate-fallback.test.ts test/core/discovery-diagnostic.test.ts`
exits 0 and proves every phase is bounded, parsed fail-closed, and redacted.

### Step 6: Verify safe GET, link, navigation, and blob document resolution

With the unified policy in place, ensure an eligible explicit download control
can be resolved through the already-approved generic mechanisms:

- direct approved HTTPS `href`, `data-href`, or `data-url`;
- approved same-origin navigation/window-open target;
- GET fetch/XHR whose response is a PDF or invoice-shaped binary;
- same-origin `blob:` URL or bounded magic-checked PDF blob;
- asynchronously created anchor/link within the action deadline.

Use the approved origins captured during exact-entry replay. Keep the existing
PDF magic, 8 MiB per-inline-document, 24 MiB per-run, document-count, action,
page, and time caps.

If a synthetic control attempts a POST, form submission, or mutation-shaped
request, assert that it is blocked and produces the distinct structural outcome
from Step 5. Do not add a generic POST allowlist in this plan.

**Verify**:
`npx vitest run test/core/browser-dom-boundary.test.ts test/core/dom-document-integrity.test.ts`
exits 0 with positive tests for every allowed mechanism and negative tests for
unapproved origins, HTML masquerading as PDF, oversized blobs, forms, and POSTs.

### Step 7: Run authorized Supabase and ClickUp acceptance checks

Use an authorized test account in a dedicated Chrome profile. Do not save or
commit screenshots containing financial data, raw diagnostics, request bodies,
tenant identifiers, invoice metadata, or downloaded documents.

For Supabase:

1. Open the exact organization billing/invoices page before starting discovery.
2. Run Find Invoices.
3. Confirm diagnostics show an `entry_replay` attempt with observed requests and
   that the active tab was not reloaded.
4. Confirm a candidate is compiled if the captured response has a supported
   stable invoice/document shape.
5. Connect, collect at least one valid test PDF, then sync again and confirm no
   duplicate delivery.

For ClickUp:

1. Open the tenant billing page containing test invoices/receipts.
2. Run Find Invoices and confirm the billing page produces the same eligible
   semantic-control state used by verification.
3. Connect and confirm at least one valid test PDF is captured and delivered.
4. Sync again and confirm no duplicate delivery.
5. Confirm all temporary tabs close and the active ClickUp tab remains unchanged.

Record only a redacted pass/fail matrix in the PR description or plan execution
notes: site, runtime version, discovery revision, candidate adapter, closed
outcome code, count, duplicate result. Do not record routes or payloads.

**Verify**: both authorized cases pass the matrix above. If Supabase cold replay
captures traffic but still compiles zero candidates, STOP and create a follow-up
inference-shape plan from a sanitized local structural analysis. If ClickUp
reports `unsupported_document_action`, STOP and request a security review or a
reviewed vendor-specific recipe; do not loosen the generic POST boundary.

### Step 8: Update runtime identity and documentation

- Increment `DISCOVERY_ENGINE_REVISION` from 22 to 23.
- Increment the package patch version once and update `package-lock.json` through
  the package manager; do not hand-edit lockfile integrity fields.
- Update `README.md` and `docs/architecture.md` to explain active snapshot versus
  exact-entry cold replay, bounded network quiescence, shared semantic policy,
  and fail-closed unsupported action reporting.
- Update `docs/testing.md` with the Supabase-style preloaded SPA and
  ClickUp-style semantic parity acceptance cases.
- Update runtime-identity and diagnostic schema tests.
- Do not state that Ratatosk supports “any supplier.” State the actual bounded
  acquisition channels and their limitations.

**Verify**:
`npm run typecheck && npm run check:boundaries && npm run validate && npm test && npm run build:collector && npm audit --audit-level=high && git diff --check`
exits 0.

## Test plan

### Automated tests

- `test/core/discovery-entry-replay.test.ts`
  - observer-before-tab ordering;
  - exact tenant entry replay without active-tab mutation;
  - cross-origin startup JSON captured without a configured endpoint;
  - hydration-before-invoice delayed response;
  - cancellation, timeout, error, and cleanup;
  - global page/time caps.
- `test/core/discovery-adapters.test.ts` and
  `test/core/discovery-shape-corpus.test.ts`
  - cold-replayed network candidate;
  - visible semantic control candidate;
  - safe reveal candidate;
  - hidden unrelated control rejection;
  - no stable identity/document path rejection remains intact.
- `test/core/browser-dom-boundary.test.ts`
  - search/verification policy parity;
  - delayed visibility and safe section reveal;
  - direct link, GET fetch/XHR, window-open, async anchor, and blob capture;
  - form/POST/mutation suppression with a distinct outcome;
  - approved-origin and resource caps.
- `test/core/discovery-diagnostic.test.ts`
  - new entry-replay source and semantic phase counters;
  - old diagnostic parsing if supported;
  - oversized/unknown fields fail closed;
  - serialized diagnostic contains none of the forbidden sensitive fields.
- `test/core/discovery-candidate-fallback.test.ts`
  - unsupported semantic action falls through to another retained candidate;
  - authentication/rate-limit/destination failures remain fatal;
  - admission still requires at least one verified delivered PDF.

### Manual acceptance

- Authorized Supabase organization invoices: pre-opened SPA, cold replay,
  candidate, one valid delivery, second-run dedupe.
- Authorized ClickUp tenant billing: semantic parity, one valid delivery,
  second-run dedupe.
- Active tabs remain unchanged; all temporary tabs and observer registrations
  are removed after every outcome.

## Done criteria

- [ ] Observer registration happens before exact-entry replay navigation.
- [ ] The exact current tenant billing URL is cold-loaded once in a disposable
      inactive tab without reloading or navigating the active tab.
- [ ] A synthetic unknown cross-origin API route can produce a network candidate
      solely because the application requests it during boot.
- [ ] Generic hydration data cannot prematurely suppress a delayed invoice API
      response within the bounded settle window.
- [ ] Search and verification use one semantic-control eligibility policy.
- [ ] A hidden control alone cannot compile a semantic candidate.
- [ ] The ClickUp-shaped synthetic case observes and resolves at least one
      permitted document, or reports a distinct fail-closed unsupported action.
- [ ] Arbitrary POSTs, forms, and mutation-shaped actions remain blocked.
- [ ] Candidate admission still requires one validated PDF accepted by the sink.
- [ ] Second sync delivers no duplicate in both authorized acceptance cases.
- [ ] Diagnostics remain bounded and contain no sensitive route/payload/account
      data.
- [ ] Temporary tabs and observer hooks are removed on every exit path.
- [ ] Discovery remains within fifteen page attempts, depth three, and thirty
      seconds.
- [ ] Discovery engine revision and package/runtime identity are incremented.
- [ ] All focused and full verification commands exit 0.
- [ ] `git status --short` shows no modified files outside the in-scope list.
- [ ] This plan and `plans/README.md` are updated with DONE/BLOCKED evidence.

## STOP conditions

Stop and report back; do not improvise if:

- In-scope code no longer matches the lifecycle or safety invariants described
  in “Current state.”
- Reproducing exact entry traffic requires reloading, scrolling, or clicking in
  the user's active tab.
- Cold replay requires broader-than-exact-origin host permission or persistent
  capture of credentials, headers, bodies, identifiers, or document bytes.
- ClickUp's only working path requires allowing an arbitrary POST, form
  submission, mutation, checkout, payment, cancellation, deletion, upgrade,
  logout, OAuth, or authorization action.
- The candidate cannot be verified with a real PDF in an authorized test account.
- A proposed diagnostic field would expose a route, query, selector, label,
  request/response body, header value, tenant/invoice ID, amount, or date.
- Page/response/action bounds must be increased beyond current documented limits
  to make a fixture pass.
- Any focused test fails twice after a reasonable correction, or the full suite
  reveals a regression outside this plan's scope.

## Maintenance notes

- Exact-entry cold replay is the generic acquisition primitive. Common route
  suffixes remain bounded fallbacks, not the main scaling strategy.
- Keep observer/network readiness separate from DOM readiness. A future SPA may
  have immediate hydration and delayed billing traffic just like Supabase.
- Any change to semantic labels, visibility, safe section reveal, or control
  selectors must update the shared policy and both discovery/verification tests.
- Treat a newly observed non-GET document action as a security/design review,
  not a reason to expand the generic collector silently.
- WebSocket-, Worker-, browser-download-, or IndexedDB-only invoice delivery is
  not automatically solved by this plan. Add a separately bounded acquisition
  lane only after an authorized structural case proves it is necessary.
- Preserve proof-ranked fallback, real-PDF validation, sink acceptance before
  admission, and persisted deduplication. Better discovery must not weaken
  delivery correctness.
