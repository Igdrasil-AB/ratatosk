# Plan 016: Build an iterative end-to-end supplier acquisition lab

> **Executor instructions**: This is the active master plan for unsupported
> supplier acquisition. Execute phases in order as separate reviewable PRs from
> clean worktrees based on current `origin/main`. The first PR must make the
> current failure red and explainable; it must not change discovery behavior.
> Update the iteration ledger in this file after every exact-build live run.
>
> **Supersession boundary**: Plan 015 remains the historical source for
> evidence-first privacy and safety invariants. Plan 016 supersedes its remaining
> runtime debugging, live-acceptance, and release work. When the two differ,
> Plan 016 owns the testing method and Plan 015 owns the fail-closed security
> constraints.
>
> **Drift check (run first)**:
>
> ```sh
> git fetch origin
> git diff --stat b4a84d3..origin/main -- \
>   README.md PRIVACY.md docs/architecture.md docs/testing.md package.json \
>   src/core/discovery.ts src/core/engine.ts src/core/strategies/dom.ts \
>   collector/src/platform/browser-dom-driver.ts \
>   collector/src/platform/discovery.ts \
>   collector/src/platform/discovery-candidates.ts \
>   collector/src/platform/discovery-diagnostic.ts \
>   collector/src/platform/discovery-dom-policy.ts \
>   collector/src/platform/discovery-explorer.ts \
>   collector/src/platform/discovery-page-observer.ts \
>   collector/src/platform/discovery-state.ts \
>   collector/src/platform/document-action-controller.ts \
>   collector/src/platform/service-worker.ts \
>   collector/src/ui/popup/popup.ts \
>   scripts/test-chrome-discovery.ts test/core test/support
> ```
>
> If the diagnostic, replay, collection, sink, or duplicate contracts drifted,
> revise this plan in a planning-only PR before implementing against them.

## Status

- **Priority**: P0
- **Effort**: XL (six PRs plus live acceptance)
- **Risk**: HIGH
- **Depends on**: Plan 013 transactional document acquisition; Plan 014
  destination binding; Plan 015 evidence primitives
- **Supersedes**: Plan 015's remaining iterative debugging and live-release work
- **Category**: correctness, testing, diagnostics, performance, release safety
- **Planned at**: commit `b4a84d3`, 2026-08-25
- **Implementation status**: IN PROGRESS — Phases 0–4, blind Phase 5, and the
  Phase 6 CI/release gate implementation are complete in Collector 0.8.53 /
  discovery 43. The authorized three-family/ClickUp run and its exact-artifact
  receipt remain; no build has passed that live gate end to end

## Goal

Build one tight, agent-runnable learning loop that starts from an ordinary
signed-in supplier page and proves the entire result:

```text
Find Invoices
  -> observed evidence
  -> candidate plan
  -> fresh replay
  -> complete invoice enumeration
  -> transactional document resolution
  -> valid PDF
  -> selected destination accepts it
  -> identity is committed
  -> immediate rerun delivers zero duplicates
  -> configured cadence delivers zero duplicates
```

The loop must improve a reusable **supplier shape**, not a supplier name. A
supplier shape is a combination of observable behavior such as delayed SPA
hydration, an opaque workspace route, a cross-origin read-only GraphQL scope,
an accessibility-labelled menu, an iframe request, or a click-resolved document.

The system has learned from a failure only when:

1. the exact user-visible failure is reproducible by an agent-run command;
2. the minimal failing behavior exists in the shared shape corpus;
3. a shared module change makes that case green;
4. every previously learned shape stays green;
5. the same exact build moves the authorized live run to a later typed boundary
   or completes first/second/cadence acceptance.

Changing a timeout, route, selector, or supplier branch without those five
proofs is not learning.

## Browser and package control

The lab has two explicit browser lanes. They share the same package and outcome
contract but have different control boundaries.

| Capability | Controlled Chromium lane | Existing signed-in Chrome lane |
| --- | --- | --- |
| Build, test, package, checksum | automatic | automatic |
| Mirror unpacked package to a stable folder | automatic | automatic |
| Load/reload extension | automatic through Playwright persistent context | automatic only while the Chrome-control connection is healthy; otherwise pause for one user reload |
| Open supplier tabs | automatic fixture URLs | use already-open authorized tabs; open a URL only when the user supplies it |
| Read tab state | full synthetic fixture state | hostname, active state, and extension UI only; never cookies, storage, page source, or network bodies |
| Login, CAPTCHA, MFA | synthetic session | user-owned handoff; the runner never handles credentials |
| Host permission prompt | automatic test manifest for the synthetic host | user confirms Chrome's exact-origin prompt when required |
| Run extension UI/service worker | automatic | automatic when Chrome control is healthy; otherwise one guided action per supplier |
| Verify local destination | isolated temporary Downloads profile | closed extension ledger counts plus user confirmation; do not inspect real invoice contents |
| Verify Igdrasil destination | local fake in synthetic lane | selected-company ingest receipt and bounded ledger/inbox readback |
| Immediate and cadence reruns | automatic | automatic after the initial user handoff when browser control remains connected |

### Package-update preflight

Every synthetic or authorized session begins with one command that:

1. verifies the canonical worktree and records the exact commit;
2. runs the required focused and full gates;
3. builds `dist/collector`;
4. packages the ZIP and verifies its SHA-256;
5. mirrors the unpacked build into one stable development folder;
6. reloads the extension in the selected browser lane;
7. reads the service-worker runtime identity;
8. refuses to continue unless version, discovery revision, acquisition revision,
   manifest version, and built chunk identity match the prepared artifact.

The public extension cannot reload itself. Existing signed-in Chrome therefore
requires either the connected Chrome-control channel or one explicit user click
on Reload in `chrome://extensions`. The runner must report this as a handoff,
not as an automated success.

### Multi-supplier session

The authorized lane accepts several supplier tabs already open in one Chrome
profile. It enumerates only hostnames and asks the user to approve the bounded
test set. For each approved tab, in stable order, it records:

```text
hostname
  -> runtime identity matched
  -> discovery terminal phase
  -> candidate plan kind/count
  -> connected destination identity
  -> first run accepted/action counts
  -> immediate rerun accepted/action counts
  -> cadence rerun accepted/action counts
  -> page-owned download delta
```

The session report contains no tab URL, title, route, account value, invoice
identifier, amount, filename, document bytes, or credential. One supplier
failure is recorded and isolated; it does not skip the remaining approved tabs.

## Current red baseline

The authoritative live result for Collector `0.8.52`, discovery engine `42`, on
`app.clickup.com` is:

- fast search consumed 10,055 ms of 10,000 ms;
- the active entry compiled one `dom-actions` candidate;
- fresh no-sink replay failed as `list_failed` after about 9,720 ms;
- cold entry replay produced no candidate after about 9,730 ms;
- zero candidates were retained;
- later linked probes inherited only the exhausted global budget.

This proves that route discovery is no longer the first failed boundary. The
first failed boundary is **candidate replay / semantic list enumeration**. Do
not change frontier ranking, route intent, or global budgets until replay emits
a more precise closed cause and a red browser case reproduces it.

### What existing evidence does not prove

- `npm test` does not execute Chrome injection, DNR, service-worker lifetime, or
  a real destination.
- the discovery mode of `scripts/test-chrome-discovery.ts` stops at preview;
  its acquisition mode separately proves PDF resolution, destination
  acceptance, duplicate commit, and cadence behavior.
- A compiled candidate does not prove its list can reopen.
- A retained candidate does not prove a valid PDF arrives.
- A first delivery does not prove the immediate or cadence run is idempotent.

## Invariants

- Production code contains no supplier name, supplier-specific route, learned
  selector, or vendor-specific branch.
- Navigation targets come only from the active URL, an exact cold replay,
  application-exposed links/accessibility names, observed navigation, resource
  timing, observed requests, structured data, or a previously verified local
  plan.
- Common words such as billing, payment, invoice, receipt, and statement rank
  observed evidence; they never assemble a URL.
- Raw routes, tenant values, response bodies, headers, invoice values, and
  credentials never enter diagnostics, fixtures, learning receipts, or commits.
- An opaque tenant value persists only as a typed runtime template. Otherwise a
  semantic plan must reproduce the surface from a safe start, or the candidate
  fails closed.
- The active user tab stays passive. Clicks and scrolling occur only in an owned
  disposable tab under the existing mutation and download guards.
- Candidate preview and later collection execute the same plan with the same
  accessible-name and navigation policy.
- A candidate is not successful until a valid PDF is accepted by the selected
  destination.
- Identity becomes seen only after destination acceptance. Second and cadence
  runs activate zero already-accepted document controls and deliver zero files.
- Fast search remains at most ten seconds. A continuation is offered only when
  its sanitized frontier can actually be reconstructed.
- All interpretation remains packaged in the MV3 extension. No remote code,
  remote recipe, model-generated action, bundle mining, or general browser agent
  runs in Collector.

## The learning loop

Every iteration follows this sequence. Skipping a step invalidates the iteration.

### 1. Freeze

Record only:

- Collector version, discovery and acquisition revisions;
- exact artifact SHA-256;
- supplier hostname;
- mode and bounded elapsed time;
- phase, closed result/cause, and bounded evidence counts;
- candidate plan kind: `network`, `embedded`, `exact_dom`, `typed_dom`, or
  `semantic_dom`;
- first/second/cadence accepted and action counts.

Never record the route, selector, tenant, invoice identifier, amount, filename,
header, request body, response body, or PDF bytes.

**Complete when** the current exact-build failure is represented by one
privacy-safe iteration receipt and has one unambiguous first failed phase.

### 2. Reproduce

Add the smallest supplier-shape case that reproduces the same phase and cause.
Reuse `test/support/portal-simulator.ts`, `test/support/portal-corpus.ts`, and
`scripts/test-chrome-discovery.ts`; do not create another browser harness or a
new route DSL.

The focused command must already have been run and gone red, for example:

```sh
PATH=/opt/homebrew/bin:$PATH npm run build:collector
PATH=/opt/homebrew/bin:$PATH \
  RATATOSK_CHROME_CASE=semantic-replay-timeout \
  npm run test:chrome-discovery:built
```

**Complete when** the command is deterministic, agent-runnable, finishes in
seconds, and fails on the same user-visible boundary—not merely a nearby unit.

### 3. Hypothesize

Write three to five falsifiable hypotheses in the iteration ledger before
editing implementation. Each prediction names the observation that would
confirm or reject it. Instrument only closed fields needed to distinguish those
hypotheses.

**Complete when** one observation separates every live hypothesis from the
others without raw page data.

### 4. Change one shared seam

Change the lowest shared module through which every matching supplier shape
passes. Examples include evidence normalization, semantic-menu ranking, typed
scope compilation, replay execution, traversal proof, document resolution,
sink commit, or duplicate identity.

**Complete when** the minimal red case is green and no supplier literal exists
in the diff.

### 5. Sweep

Run the focused case, the entire supplier corpus, built-extension Chromium,
full CI, security audit, and artifact verification.

```sh
PATH=/opt/homebrew/bin:$PATH npm run ci
PATH=/opt/homebrew/bin:$PATH npm run audit:security
PATH=/opt/homebrew/bin:$PATH npm run test:chrome-discovery
PATH=/opt/homebrew/bin:$PATH npm run package:collector
PATH=/opt/homebrew/bin:$PATH npm run verify:collector-artifact
git diff --check
rg -n "\[DEBUG-" collector src test scripts
```

**Complete when** all learned shapes remain green, no debug marker remains, and
the package identity is recorded.

### 6. Replay live

Reload the exact unpacked build and repeat the same authorized account from the
same starting page. Accept the iteration only when the failure moves to a later
closed boundary or the complete end-to-end outcome passes. A different generic
failure at the same phase rejects the change.

**Complete when** the iteration ledger records `promote`, `revise`, or `revert`
with its evidence.

## Phase 0 — Make candidate replay explainable and red

The current `list_failed` result collapses navigation, page commit, menu reveal,
settings selection, billing selection, invoice-tab selection, enumeration,
identity, and deadline failure into one label. Repair observability before
repairing behavior.

### Required closed trace

Each candidate preview emits bounded phase outcomes:

```ts
type ReplayPhase =
  | "shell_create"
  | "supplier_commit"
  | "menu_reveal"
  | "settings_select"
  | "billing_select"
  | "invoice_section_select"
  | "document_enumeration"
  | "identity_validation";

type ReplayPhaseResult =
  | "complete"
  | "not_present"
  | "time_cap"
  | "action_cap"
  | "mutation_blocked"
  | "ambiguous"
  | "page_left_origin";
```

Retain only phase/result/duration and counts. Candidate errors must preserve the
first phase/cause through `previewCandidate`, the diagnostic, issue report, and
popup support flow.

### Files

- `collector/src/platform/document-action-controller.ts`
- `collector/src/platform/browser-dom-driver.ts`
- `collector/src/platform/discovery.ts`
- `collector/src/platform/discovery-diagnostic.ts`
- `collector/src/platform/issue-report.ts`
- `test/core/browser-dom-boundary.test.ts`
- `test/core/discovery-diagnostic.test.ts`
- `scripts/test-chrome-discovery.ts`

### Exit evidence

- a Chromium case reproduces the current candidate replay failure;
- its diagnostic identifies exactly one first failed replay phase;
- the same trace excludes route, label, selector, tenant, and document values;
- no discovery behavior changed in this phase.

### Phase 0 evidence (2026-08-26)

- `semantic-replay-timeout` reproduces active evidence, empty cold replay, and
  failed semantic candidate replay in the built extension;
- its closed timeline is `shell_create:complete`,
  `supplier_commit:complete`, `invoice_section_select:time_cap`;
- `ReplayTrace` is validated by diagnostic schema v11 and rejects free-form
  phase/result data;
- console and issue summaries expose only plan kind, closed phase/result, and
  bounded duration;
- focused diagnostic/browser/preview/report tests and the full built-browser
  discovery corpus pass; authorized ClickUp must still read back the new trace.

## Phase 1 — Add one command for an iteration

Extend the existing Chromium runner rather than creating another framework.
The command accepts a named shape, repeats it, and writes one sanitized result
to a temporary directory:

```sh
npm run test:discovery-iteration -- --case semantic-replay-timeout --repeat 3
```

The runner must:

1. build Collector once;
2. load the exact unpacked build in persistent Playwright Chromium;
3. run the actual popup/service-worker message flow;
4. exercise the selected shape;
5. assert the expected terminal phase and total time;
6. close all owned tabs and observers;
7. print one compact phase timeline;
8. leave no fixture server, profile, download, or temporary extension behind.

Add a preparation command for the authorized lane:

```sh
npm run prepare:live-supplier-test -- --browser chrome
```

It performs the package-update preflight above, then either connects to the
existing Chrome session and lists hostname-only candidate tabs or pauses with
the exact stable extension folder and one Reload instruction. After reload it
must verify the runtime identity before enabling supplier tests.

Add a human-in-the-loop wrapper only for authorized signed-in suppliers. It must
show the exact folder and runtime identity, ask the person to perform one action,
and accept only the copied sanitized diagnostic. It must never request a HAR,
page source, screenshot containing invoices, or DevTools network body.

### Exit evidence

- one command is red-capable, deterministic, under 15 seconds, and unattended;
- `--repeat 20` produces identical terminal phase/cause for a deterministic case;
- interruption leaves no running browser or fixture server;
- the live wrapper validates build identity before accepting a diagnostic.

### Phase 1 evidence (2026-08-26)

- `test:discovery-iteration` builds once and accepts a closed `--case` plus a
  bounded `--repeat`; twenty consecutive `semantic-replay-timeout` runs ended
  at `invoice_section_select/time_cap` in 9.3–9.6 seconds each;
- the runner rejects terminal-signature drift, enforces a 15-second ceiling,
  and its parent trap plus in-process cleanup left no Chromium, fixture server,
  profile, or temporary directory after passing, failing, and explicit SIGINT
  exit-130 runs;
- `prepare:live-supplier-test` requires committed clean source, runs CI and the
  security/package gates, records the exact commit and artifact checksum, and
  mirrors a byte-matching unpacked tree under ignored `artifacts/live/`;
- `scripts/live-supplier-test.sh` is syntax- and ShellCheck-clean, lists only
  approved hostnames, and rejects a ready line unless both its runtime
  revisions and hashed service-worker chunk match the prepared build.

## Phase 2 — Grow a supplier-shape corpus

Every accepted live failure adds or strengthens one generic corpus dimension.
The minimum matrix is:

| Dimension | Required mutation |
| --- | --- |
| Rendering | server HTML, delayed SPA, visibility-gated SPA |
| Scope | exact route, opaque route, typed same-origin scope, typed cross-origin GraphQL scope |
| Navigation | direct link, accessible label, four menus, competing personal/workspace avatars, localized Settings/Billing |
| Network | GET JSON, read-only GraphQL, iframe JSON, cached/early request |
| Documents | direct PDF, signed provider URL, semantic action, native-download rejection |
| Traversal | numbered page, cursor, Next/Load More, infinite scroll, stable end |
| Failure | no evidence, auth expiry, mutation attempt, permission drift, invalid PDF, destination rejection |
| Lifecycle | first run, immediate second run, cadence, route rename, worker restart |

At least one route-bearing fixture uses neutral randomized segments that contain
none of the billing vocabulary. A blind rename after build must still pass.

### Promotion rule

A new shape enters the permanent corpus only when it is minimal, contains no
supplier name or copied customer value, fails before the fix, and passes after
the shared fix. Similar failures extend an existing shape instead of adding a
supplier-labelled fixture.

### Exit evidence

- every matrix row has a deterministic test and closed expected result;
- route/name/DOM mutation seeds produce no supplier-specific production diff;
- the corpus includes at least three unrelated retrieval families: structured
  API, server-rendered documents, and semantic SPA documents.

### Phase 2 evidence (2026-08-26)

- the permanent corpus covers fourteen supplier shapes across network JSON,
  embedded JSON, direct DOM, and semantic DOM families, including delayed and
  visibility-gated SPAs, same- and cross-origin typed scopes, bearer replay,
  opaque navigation, provider documents, and cursor traversal;
- built-Chromium cases cover iframe evidence, four competing menus, competing
  personal/workspace avatars, safe mutation blocking, and semantic replay;
- controller, pagination, fallback, transaction, scheduler, and worker-restart
  tests close the remaining traversal, failure, and lifecycle rows;
- deterministic seeds 17, 41, and 73 mutate neutral routes, navigation labels,
  wrapper elements, wrapper classes, and hydration delays. None contains billing
  vocabulary in its route or class, and all three retain two direct documents
  inside the ten-second envelope without a production-code change;
- the focused seven-file matrix passes 144 tests with no supplier literal or
  route dictionary added to production.

## Phase 3 — Make replay one deep module

Discovery preview and connected collection currently reach similar UI through
different control flow. Put plan execution behind one existing platform seam,
preferably `DocumentActionController`, rather than adding another executor.

The external plan remains a closed union:

```ts
type ReplayPlan =
  | { kind: "network"; request: SafeRequest }
  | { kind: "embedded"; entry: SafeEntry }
  | { kind: "exact_dom"; entry: SafeEntry }
  | { kind: "typed_dom"; template: SafeTemplate; scope: TypedScope }
  | { kind: "semantic_dom"; start: SafeEntry; intents: readonly SemanticIntent[] };
```

No selector, supplier label, tenant value, or executable action enters the plan.
The same executor performs no-sink preview and connected list enumeration. The
only difference is that connected document resolution may run after stable
identity reservation.

Replay returns incremental evidence and the first closed failure; one malformed
item or blocked branch cannot erase evidence from another lane.

### Exit evidence

- preview and collection call the same replay executor;
- a plan proven in preview reopens the same invoice surface during collection;
- typed scope values are resolved at runtime and absent from persisted state;
- semantic intent uses the packaged accessibility policy and survives route
  renames and DOM wrapper changes;
- candidate-local replay failures fall through to the next retained plan.

### Phase 3 evidence (2026-08-26)

- the implementation already has the required deep seam: both
  `previewCandidate` and `executeRecipeRun` call `buildStrategies`, whose single
  DOM construction is `BrowserDomDriver` backed by `DocumentActionController`;
- the existing closed `VendorRecipe.invoices` union plus `ReplayPlanKind`
  represents network, embedded, exact DOM, typed DOM, and semantic DOM without
  adding a second persisted plan model;
- preview removes pagination only for its bounded no-sink pass; the DOM open,
  packaged accessibility policy, typed runtime scope rendering, replay trace,
  enumeration, and connected resolution all stay on the same executor;
- executable preview, connected collection, candidate-fallback, typed-scope,
  and browser-boundary tests pass 134 checks, including the new guard that no
  preview or collector-local `BrowserDomDriver` construction can fork the seam;
- no production refactor was made because another executor/interface would
  duplicate the already shared module without changing behavior.

## Phase 4 — Extend Chromium from preview to delivery and deduplication

The browser gate must test the product outcome, not just `candidate_found`.
Extend the existing synthetic HTTPS portal and exact built extension to:

1. configure an isolated filesystem destination;
2. run Find Invoices;
3. connect the retained candidate;
4. enumerate every expected reference;
5. resolve and validate real minimal PDF fixtures;
6. assert the destination accepted the expected files;
7. inspect the bounded ledger/seen state through public extension messages;
8. run immediately again and assert zero actions and zero new files;
9. trigger the real schedule path and assert zero actions and zero new files;
10. assert zero page-owned Chrome downloads for semantic actions.

Add negative cases for invalid PDF, destination rejection, partial traversal,
and a candidate-local failure followed by a working fallback. Failure before
sink acceptance must not commit identity.

### Exit evidence

- `npm run test:chrome-acquisition` proves first/second/cadence behavior for
  network, direct DOM, and semantic DOM shapes;
- the first run delivers exactly the fixture population;
- immediate and cadence runs deliver zero duplicates and activate zero accepted
  semantic controls;
- a rejected destination is retried on the next run;
- the test uses the built extension and public message/storage contracts, not a
  direct call into the engine.

### Phase 4 evidence (2026-08-26)

- `npm run test:chrome-acquisition` extends the existing persistent-Chromium
  harness and drives the built MV3 popup/service worker through public messages;
- structured-network, direct-DOM, and click-resolved semantic-DOM families each
  accept and ledger exactly one valid PDF on the first run, then accept zero and
  create zero downloads on the immediate rerun and a real `collector-sync`
  Chrome alarm rerun;
- semantic control activation is exactly `1/0/0`; every other family is
  `0/0/0`, and total Chrome download delta equals accepted filesystem delivery,
  proving zero extra page-owned downloads;
- an invalid PDF closes as `document_invalid`, incomplete cursor traversal as
  `retrieval_incomplete`, and both leave zero ledger, download, supplier, or
  seen evidence;
- a failed network candidate reaches a retained direct-DOM fallback and delivers
  once; a full pending delivery journal forces `destination_unavailable`, then
  clearing the destination fault retries and accepts the same document, proving
  failure before sink acceptance did not commit its identity;
- automatic permission completion and the popup completion message now join the
  same vendor/run in-flight promise. The built acquisition matrix passed three
  consecutive complete runs after CI reproduced the former `preview expired`
  race;
- teardown leaves no fixture server, browser process, profile, download folder,
  or temporary extension tree.

## Phase 5 — Blind and authorized acceptance

### Blind synthetic acceptance

After building the extension, rename neutral routes, wrapper classes, menu order,
and hydration delay without rebuilding. The complete first/second/cadence path
must still pass.

### Authorized supplier acceptance

Use the approved supplier tabs already open in the user's Chrome profile. Prefer
dedicated non-sensitive test accounts. The minimum breadth is:

1. one opaque-route semantic SPA (ClickUp-class);
2. one server-rendered receipt portal (GitHub-class);
3. one structured API or GraphQL portal.

For each supplier, start from an ordinary signed-in page without revealing a
private route to the engine. Record only the sanitized receipt fields. A supplier
is not accepted on candidate preview; it must pass delivery, immediate duplicate,
and cadence duplicate behavior.

The runner processes every approved hostname even when an earlier supplier
fails. It reports a per-supplier first boundary and a session total. Login, MFA,
CAPTCHA, an unavailable Chrome-control connection, or an unexpected permission
prompt pauses only that supplier and requests the smallest user handoff.

Every live miss returns to Step 1 of the learning loop. No live-only patch may
skip a red supplier-shape case.

### Exit evidence

- three unrelated supplier families pass the same exact package;
- blind route/DOM mutations pass without a rebuild;
- ClickUp first/second/cadence acceptance passes from an ordinary page;
- no acceptance artifact contains account or invoice data.

### Phase 5 evidence (2026-08-26, partial)

- after Collector was already built, the harness generated a new neutral route,
  wrapper class, four-menu order, and hydration delay; `blind-synthetic` still
  delivered `1/0/0` documents and activated semantic controls `1/0/0` across
  first, immediate, and real-alarm cadence runs without rebuilding;
- the signed-in wrapper processes every approved hostname independently and
  accepts only extension-generated preview/first/immediate/cadence snapshots.
  Those snapshots bind the runtime, plan count/kinds, selected plan, opaque
  destination identity, per-session nonce, timestamps, accepted/action/ledger
  counts, and the action-scope's observed page-owned download count; only the
  external destination readback count remains an explicit operator observation.
  A malformed or failed supplier row is isolated and later approved hosts still
  run;
- Chrome-control diagnostics found Google Chrome running, but the currently
  selected profile does not have the ChatGPT browser-control extension enabled.
  The wrapper remains the safe fallback, but no supplier tab was exercised in
  this run;
- the authorized three-family and ClickUp rows therefore remain open. No live
  receipt or release claim was created from synthetic evidence.

## Phase 6 — Make the learning loop release-blocking

Wire the end-to-end Chromium command and a fresh sanitized live receipt into
`validate:collector-release`. The validator checks artifact SHA, runtime
revisions, phase completion, first-run delivery, zero second/cadence additions,
zero repeated semantic actions, and zero page-owned downloads.

The release command remains validation only. Upload, submission, publication,
or automatic publication require separate explicit authority and dashboard
verification.

### Exit evidence

- CI runs unit/shape tests and built-extension end-to-end acquisition;
- release validation fails when the live receipt is absent, stale, from another
  artifact, or missing a supplier family;
- an exact validated artifact can be reproduced from the reviewed commit.

### Phase 6 evidence (2026-08-26, receipt pending)

- CI now builds Collector once and runs both the complete built-extension
  discovery corpus and `test:chrome-acquisition:built`;
- `validate:collector-release` reruns acquisition, verifies the ZIP, and then
  requires receipt schema v2 bound to the exact artifact SHA, Collector version,
  discovery revision, acquisition revision, and a seven-day completion window;
- the validator requires explicit ClickUp completion, distinct opaque supplier
  tokens, opaque semantic SPA, server-rendered document, and structured API
  families, at least one Igdrasil readback, positive first-run
  destination/ledger agreement, and zero immediate/cadence accepted documents,
  actions, ledger rows, or page-owned downloads;
- `build:live-acceptance-receipt` accepts only four ordered extension snapshots
  per distinct approved hostname, verifies run/destination identity and count
  deltas, requires ClickUp explicitly, rejects snapshots older than the runtime
  match or carrying another session nonce, strips every hostname behind a salted
  opaque token, and writes the ignored release receipt. A transient
  three-family fixture proved builder/validator compatibility and was deleted;
- release validation still fails closed because no authorized live receipt is
  present. Upload, submission, and publication remain outside this plan and
  were not attempted.

## Acceptance matrix

| ID | Requirement | Authoritative proof |
| --- | --- | --- |
| L1 | Current ClickUp failure is red locally | named Chromium case with same replay phase/cause |
| L2 | First cause is visible | sanitized replay phase timeline |
| L3 | One command runs an iteration | deterministic runner output and cleanup test |
| L4 | Failures become shapes | before/after corpus diff with no supplier literal |
| L5 | No route construction | production-source scan plus empty-evidence planner test |
| L6 | Blind rename survives | post-build mutation test |
| L7 | Fast remains honest | actual UI-to-terminal wall clock at or below ten seconds |
| L8 | Continuation is real | reconstructable frontier and no completed-page replay |
| L9 | Preview equals collection replay | shared-executor call-path test |
| L10 | Opaque scope stays private | typed runtime template and seeded-canary scan |
| L11 | Candidate fallback works | first candidate-local failure, second success |
| L12 | Traversal is complete | full-population refs and stable end proof |
| L13 | PDF is real | byte cap, `%PDF` validation, invalid negative case |
| L14 | Destination acceptance is authoritative | sink receipt before seen commit |
| L15 | Immediate rerun is idempotent | zero actions and zero new destination files |
| L16 | Cadence is idempotent | real schedule path, zero actions/files |
| L17 | Live breadth exists | three unrelated authorized supplier families |
| L18 | Release is exact | artifact SHA plus fresh validated receipt |
| L19 | Browser runs the prepared package | build identity read back from the service worker after reload |
| L20 | Several open suppliers are exercised | hostname-only live matrix with isolated per-supplier outcomes |

## Iteration ledger

Append one row after every exact-build live attempt. `First boundary` and
`Result` are closed values; `Learning` contains no route, selector, or account
data.

| Iteration | Exact build | First boundary | Hypothesis/prediction | Regression case | Result | Decision | Learning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| I-000 | 0.8.52 / discovery 42 / acquisition 3 | candidate replay `list_failed` | Replay loses workspace-scoped invoice state; a phase trace will stop before document enumeration | pending Phase 0 case | 1 compiled, 1 previewed, 0 retained; fast time cap | revise | Candidate discovery is not the current first failure; replay must become red and typed before another behavior change |

### Decision meanings

- **promote**: live failure moved later or end-to-end acceptance passed; shared
  corpus and full sweep remain green.
- **revise**: the prediction was falsified or the same boundary failed with new
  information; retain the regression/instrumentation and form new hypotheses.
- **revert**: the change did not improve the live boundary, regressed a learned
  shape, weakened an invariant, or added supplier-specific behavior.

## Done criteria

- [ ] Phases 0–6 are merged as separate reviewed PRs from clean worktrees.
- [ ] Acceptance rows L1–L20 have retained non-sensitive evidence.
- [ ] The current ClickUp replay failure is reproducible by one agent command.
- [ ] Every live failure accepted during the work exists as a generic shape.
- [ ] Preview, connected enumeration, and document resolution use one replay
      plan/executor boundary.
- [ ] Built-extension tests prove delivery, immediate deduplication, and cadence
      deduplication—not candidate preview alone.
- [ ] Blind route/DOM mutations pass after build without supplier code.
- [ ] Three unrelated authorized supplier families pass the exact artifact.
- [ ] The authorized runner processes every approved open supplier tab and
      isolates failures without retaining browser/account data.
- [ ] Package mirroring, extension reload, and runtime identity readback pass in
      both the controlled lane and a connected existing-Chrome lane.
- [ ] ClickUp passes first/second/cadence acceptance from an ordinary page.
- [ ] Full CI, browser acquisition, security audit, package verification, and
      release validation pass.
- [ ] No raw diagnostic, route, tenant, selector, response, credential, invoice
      value, or PDF is committed.
- [ ] `plans/README.md` is marked DONE only after exact live acceptance and
      release validation.

## STOP conditions

Stop and report when:

- a tight red reproduction cannot be built from sanitized structure;
- a proposed fix requires a supplier name, exact supplier route, learned
  selector, or supplier-only branch;
- a proposed diagnostic requires raw page, route, request, response, account,
  invoice, or credential data;
- preview and collection would use different replay semantics;
- a route or tenant must be persisted without exact safety or typed runtime
  provenance;
- active-tab passivity, mutation containment, PDF validation, destination
  acceptance ordering, identity reservation, or duplicate safety must weaken;
- a browser run leaves an owned tab, observer, DNR rule, download, profile, or
  fixture server behind;
- the live failure remains at the same boundary after the full sweep;
- a release is proposed without end-to-end first/second/cadence proof;
- exact Chrome acceptance would require a real customer document or
  unsanitized account evidence.

## Handoff discipline

### Draft review stack (2026-08-26)

The implementation is split into stacked draft PRs so no all-in-one branch can
be merged accidentally:

1. [PR 55](https://github.com/Igdrasil-AB/ratatosk/pull/55) — evidence-only replay baseline;
2. [PR 56](https://github.com/Igdrasil-AB/ratatosk/pull/56) — Plan 016 documents;
3. [PR 57](https://github.com/Igdrasil-AB/ratatosk/pull/57) — Phase 0 replay trace;
4. [PR 58](https://github.com/Igdrasil-AB/ratatosk/pull/58) — Phase 1 iteration/package runner;
5. [PR 59](https://github.com/Igdrasil-AB/ratatosk/pull/59) — Phase 2 supplier-shape corpus;
6. [PR 60](https://github.com/Igdrasil-AB/ratatosk/pull/60) — Phase 3 shared replay seam;
7. [PR 61](https://github.com/Igdrasil-AB/ratatosk/pull/61) — Phase 4 built-browser acquisition;
8. [PR 62](https://github.com/Igdrasil-AB/ratatosk/pull/62) — Phases 5–6 blind/live/release gates.

A two-axis standards/spec review found the automated implementation conformant
after remediation of concurrency policy, copied-count evidence, page-download
measurement, snapshot freshness, failure isolation, interruption cleanup, and
replay-trace duplication. Every PR remains draft and unmerged. The remaining
review blockers are the authorized live outcome, a green ClickUp iteration, and
maintainer approval.

- Use one branch and PR per phase:
  `test/replay-phase-trace`, `test/discovery-iteration-runner`,
  `test/supplier-shape-corpus`, `refactor/shared-replay-plan`,
  `test/chrome-acquisition-e2e`, and `release/acquisition-learning-gate`.
- Every PR states the red command, red output, hypothesis, shared seam changed,
  green focused command, full sweep, live result, and remaining boundary.
- A behavior PR without a prior red case is not reviewable.
- Preserve unrelated dirty work in isolated worktrees.
- Never overwrite a live receipt with synthetic evidence.
- After each merge, refresh `origin/main`, rerun the drift check, and update the
  iteration ledger before starting the next hypothesis.
