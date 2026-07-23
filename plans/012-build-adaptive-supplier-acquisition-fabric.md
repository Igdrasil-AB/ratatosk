# Plan 012: Build a proof-carrying adaptive acquisition fabric for unknown suppliers

> **Executor instructions**: This is a staged program plan, not permission to
> land one giant PR. Execute the phases in order as separate, reviewable PRs.
> Run every verification command and confirm the expected result before moving
> to the next phase. If anything in the "STOP conditions" section occurs, stop
> and report — do not improvise. When all phases are done, update this plan and
> the status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 3d33b9f..HEAD -- src/core/schema.ts src/core/types.ts src/core/discovery.ts src/core/errors.ts src/core/retrieval.ts src/core/engine.ts src/core/recorder collector/src/platform/discovery.ts collector/src/platform/discovery-candidates.ts collector/src/platform/discovered-suppliers.ts collector/src/platform/collector.ts collector/src/platform/storage.ts collector/src/platform/browser-dom-driver.ts collector/src/platform/service-worker.ts collector/manifest.config.ts studio/manifest.config.ts test/core docs package.json package-lock.json`
>
> This plan was written while unrelated local UI/version changes and Plan 011
> were uncommitted. Execute it from a clean worktree based on the commit that
> contains those changes. Plan 011 must be complete first. If an in-scope
> contract differs from the current-state facts below, treat that as a STOP
> condition and revise this plan before editing.

## Status

- **Priority**: P1
- **Effort**: L (multi-PR program)
- **Risk**: HIGH
- **Depends on**: `plans/011-cold-replay-and-semantic-download-parity.md`
- **Category**: direction, security, tests
- **Planned at**: commit `3d33b9f`, 2026-07-21

## Executive decision

The high-confidence path is **not** a general LLM browser agent and **not** a
server that sends new recipes to Collector. Build a local, deterministic,
proof-carrying acquisition control loop over a small capability grammar that is
packaged with the extension. Keep several structurally different fallback paths,
run repair discovery in shadow after a typed path failure, prove a replacement
against a real document without producing a duplicate, then atomically promote
it with a last-known-good rollback.

This can credibly target:

> Any supplier portal that can expose an already-existing invoice or receipt in
> the user's authenticated Chrome session through a bounded, read-only browser
> path, plus suppliers reachable through structured e-invoicing channels.

It cannot honestly guarantee every supplier. No local extension can create an
invoice that does not exist, defeat CAPTCHA/2FA, restore an expired session,
obtain billing rights the user lacks, safely perform a purchase/mutation to
generate a receipt, or infer a completely unlinked and unobserved private route.
Those are explicit terminal states, not repair opportunities.

Breadth and time are correctness requirements, not performance tuning. Discovery
must test every supported safe path family through a starvation-free scheduler,
continue after the first working candidate to build independent fallbacks, and
receive a resumable deep-search budget measured in minutes rather than forcing
every unknown application through one thirty-second window. A time/page ceiling
must produce `limit_reached`, never the false conclusion `not_found`.

## Why this matters

Ratatosk already has the right safety nucleus: exact-origin consent, the user's
existing browser session, a fixed packaged interpreter, bounded discovery,
proof-ranked candidates, disposable tabs, validated document admission, and
durable duplicate suppression. The remaining scale problem is that a discovered
path is effectively a static snapshot. When routes, response shapes, selectors,
pagination, or document providers move, the extension reports an incompatibility
instead of deriving and proving a safe successor.

The scalable unit should be a **site archetype and capability primitive**, not a
vendor recipe. A single improvement to cold replay, GraphQL joins, semantic
download resolution, or iframe observation should repair a class of suppliers.
Vendor-specific knowledge remains useful as a reviewed optimization, but it must
not be the only route to coverage.

## Research basis and architectural consequences

These are primary or official sources. Recheck them before implementation because
Chrome capabilities and Web Store policy can change.

| Finding | Architectural consequence |
| --- | --- |
| Chrome Web Store Manifest V3 policy says extension logic must be self-contained and explicitly lists an interpreter running complex commands fetched as data as a common violation: <https://developer.chrome.com/docs/webstore/program-policies/policies#additional-requirements-for-manifest-v3> | A backend may aggregate consented structural health, select feature flags, and advertise packaged capability versions. It must never send executable recipes, repair plans, selectors, transformations, or agent instructions to Collector. |
| Chrome's `scripting` API supports dynamically registered packaged scripts and per-frame execution: <https://developer.chrome.com/docs/extensions/reference/api/scripting> | Register the exact-origin observer before cold navigation; observe every permitted frame independently. Late `executeScript` cannot recover traffic that already happened, which is why Plan 011 is a prerequisite. |
| `webRequest` observes request lifecycle but requires both initiator and target access for subresources, and MV3 blocking is unavailable to ordinary extensions: <https://developer.chrome.com/docs/extensions/reference/api/webRequest> | Keep it observation-only and narrowly scoped. It is not a response-body acquisition strategy and cannot replace the page-world fetch/XHR observer. |
| `chrome.debugger` can instrument network, DOM, frames, and workers through CDP, whose Network domain can retrieve response bodies: <https://developer.chrome.com/docs/extensions/reference/api/debugger> and <https://chromedevtools.github.io/devtools-protocol/tot/Network/> | Use CDP only in the separately packaged Studio repair lab. Do not add `debugger` to consumer Collector. Studio can close worker/iframe blind spots and produce reviewed fixtures or new packaged primitives. |
| Chrome describes WebMCP as a proposed standard and a Chrome 149 origin trial; it needs a visible browsing context: <https://developer.chrome.com/docs/ai/webmcp> | Treat WebMCP as a disabled-by-default progressive lane, not a foundation. Enable only after the API and its read-only safety semantics are stable enough to validate. |
| Playwright recommends user-facing roles/text and explicit contracts, and resolves a locator fresh before each action: <https://playwright.dev/docs/locators> | Persist semantic fingerprints and re-locate from current page state; do not make brittle absolute CSS/XPath selectors the primary identity of a control. |
| Large browser-agent evaluations still characterize robust web agents as a significant challenge: <https://arxiv.org/abs/2412.05467> | LLM/browser agents may propose repairs in Studio or classify sanitized evidence, but they do not execute unsupervised financial-page actions or promote Collector paths. Deterministic proof remains authoritative. |
| The European Commission defines e-invoicing as structured exchange that enables automated processing, Peppol publishes a current BIS Billing specification, and ZUGFeRD/Factur-X combines EN 16931 data with PDF/A-3: <https://ec.europa.eu/digital-building-blocks/sites/spaces/DIGITAL/pages/467108637/eInvoicing>, <https://docs.peppol.eu/poacc/billing/3.0/>, <https://www.ferd-net.de/en/standards/zugferd/factur-x> | “Almost any supplier” must be a multi-lane product, not only a scraper. Add standards-native intake/validation alongside browser acquisition; it is more durable when available. |

## Current state

### Trust and execution boundaries to preserve

- `docs/architecture.md:5-9` makes the user's authenticated browser session the
  core trust primitive; no supplier password leaves the browser.
- `collector/manifest.config.ts` keeps vendor hosts optional and exact-origin at
  runtime. Collector has no `debugger` permission and has strict self-only CSP.
- `studio/manifest.config.ts` deliberately gives the development-only Studio the
  broad `debugger` permission in a separate package.
- `src/core/schema.ts` defines a strict, closed recipe vocabulary. Transforms are
  non-Turing-complete, bounded, and rejected on unknown fields.
- `src/core/discovery.ts:27-89` validates one discovered profile and at most three
  fallback candidates. `src/core/discovery.ts:269-322` requires page transport,
  exact public origins, bounded semantic actions, and no arbitrary discovered
  clicks.
- `src/core/discovery.ts:324-450` permits GET and only a structurally explicit,
  literal-free, read-only GraphQL query as persisted POST. Keep this fail-closed.
- `docs/architecture.md:75-96` already defines speculate → elect → commit,
  completeness-based election, candidate-local fallthrough, and supplier-wide
  auth/rate/permission failure.
- `src/core/retrieval.ts:18-52` creates a closed traversal proof and refuses
  contradictory counts or unresolved opportunities.
- `collector/src/platform/discovery-candidates.ts:11-77` admits only a candidate
  that verifies a document and complete traversal; supplier-wide failures stop.
- `collector/src/platform/collector.ts:127-173` sends through one irreversible
  sink lane, records durable destination evidence, then commits both content and
  primary seen identities.

### Gaps this program closes

- `collector/src/platform/discovered-suppliers.ts` stores only the latest v1
  profile under `discoveredSuppliers.v1`. There is no active/previous/shadow
  generation, compare-and-swap promotion, probation, or automatic rollback.
- `src/core/errors.ts` maps route, response-shape, selector, and template failures
  to broad `recipe_incompatible`; it cannot decide which failures are repairable
  without conflating them with auth, rights, rate, provider permission, or sink
  failures.
- Candidate ranking keeps multiple paths at initial discovery, but the local
  catalog persists only the elected profile. It loses diversity that would let a
  later sync switch to an already-proven fallback.
- The recorder infers one list response heuristically. It does not maintain an
  evidence graph that can join an organization response to an invoice list and a
  detail response, or relate a click/download/browser event to the row that
  caused it.
- DOM fallback has safe packaged behavior, but the durable identity of a control
  is still too close to a selector/page snapshot. It needs a semantic,
  multi-attribute fingerprint and a shared safety predicate.
- Scheduled runs execute the current profile. They do not run bounded shadow
  discovery after a repairable path failure and cannot verify a successor
  without risking a duplicate destination write.
- The diagnostic boundary is intentionally structural and ephemeral. There is
  no consent-safe mechanism for turning a hard site into a reusable archetype
  fixture in Studio without preserving sensitive values.

## Target architecture: Ratatosk Adaptive Acquisition Fabric

```text
                       packaged capability grammar
                                  |
            +---------------------+---------------------+
            |                     |                     |
  structured standards     observed browser       declared tools
  Peppol/UBL/CII and       network/embedded/DOM       WebMCP (later)
  Factur-X/PDF-A-3          in disposable tabs      progressive only
            |                     |                     |
            +------------- evidence graph -------------+
                                  |
                     diverse candidate portfolio
                    (max 3, different failure modes)
                                  |
                  safety proof + traversal proof +
                  validated document/identity proof
                                  |
             versioned local store: active / previous /
                     shadow / probation generations
                                  |
                     one exclusive sink commit lane
                                  |
                       seen aliases and ledger

  Separate Studio repair lab (CDP + optional model assistance)
        -> sanitized archetype fixture -> reviewed grammar/code release
        -> never remote executable instructions in Collector
```

### 1. Fixed capability grammar

Add a typed, acyclic acquisition plan that can select only packaged primitives.
It is the extension's local intermediate representation, not a general workflow
language. It must have no loops except bounded pagination modes already modeled,
no script strings, no arbitrary predicates, no arbitrary request headers, and no
generic DOM click.

The grammar is five stages:

1. **Observe** — cold-load the exact approved entry, observe page fetch/XHR,
   inspect bounded embedded structured data, inspect permitted frames, enumerate
   direct document links, inspect bounded same-origin JSON route manifests/client
   router state, and later detect declared WebMCP tools. Collector must not mine
   arbitrary JavaScript bundles or execute downloaded logic.
2. **Navigate** — same-origin GET navigation or a packaged safe semantic reveal
   of an invoice/receipt/history section. Never submit a form or activate a
   control that can purchase, pay, cancel, delete, authorize, log out, or mutate.
3. **Enumerate** — map a bounded JSON/GraphQL array, embedded array, DOM list,
   or one of the closed pagination modes to invoice references and a traversal
   proof.
4. **Resolve** — direct PDF URL, reviewed document-reference request, safe
   semantic download, bounded browser download correlation, or bounded blob.
5. **Validate and identify** — validate PDF magic/size or a supported structured
   invoice schema; derive primary identity plus content and canonical-URL aliases.

Proposed core types belong in a new `src/core/acquisition.ts` and are validated
with Zod in `src/core/schema.ts`:

```ts
type AcquisitionLane =
  | "network-json"
  | "embedded-json"
  | "document-link"
  | "semantic-dom"
  | "structured-invoice"
  | "webmcp";

interface CandidateProofV1 {
  lane: AcquisitionLane;
  grammarVersion: number;
  safety: { allowedOrigins: string[]; methods: ("GET" | "POST_QUERY")[]; actionBudget: number };
  traversal: RetrievalProof;
  document: { kind: "pdf" | "ubl" | "cii"; validated: true; contentAlias: string };
  reproducibility: { freshContextRuns: 2; stableIdentity: true };
  verifiedAt: string;
}

type ExplorationFamily =
  | "exact-entry"
  | "observed-navigation"
  | "tenant-contextual-route"
  | "common-billing-route"
  | "observed-network"
  | "embedded-structured-data"
  | "document-link-provider"
  | "semantic-download"
  | "permitted-child-frame"
  | "declared-tool";

interface ExplorationCoverageProofV1 {
  attemptedFamilies: ExplorationFamily[];
  exhaustedFamilies: ExplorationFamily[];
  pruned: Array<{ family: ExplorationFamily; reason: "unsafe" | "duplicate" | "out_of_scope" }>;
  elapsedMs: number;
  pageAttempts: number;
  checkpoints: number;
  termination: "frontier_exhausted" | "portfolio_complete" | "time_budget" | "page_budget" | "external_state";
}

interface AcquisitionGenerationV2 {
  generation: number;
  state: "active" | "previous" | "shadow" | "probation";
  supplierLineageId: string;
  candidates: Array<{ profile: DiscoveredSupplierProfileV1; proof: CandidateProofV1 }>;
}
```

The final schema may use more precise names, but it must preserve these
properties. `contentAlias` above means an existing bounded SHA-256-derived
idempotency alias, never raw document bytes or supplier values.

### 2. Evidence graph, not one-response guessing

Represent local, ephemeral discovery evidence as a graph:

```text
entry/page -> tenant scope -> list request -> row identity
                                      |          |
                                      v          v
                                detail request -> document capability -> artifact
```

Nodes contain structural types and ephemeral value aliases. Edges are observed
correlations: same opaque alias, request initiator/time window, row-to-control
context, document URL, or explicit GraphQL field relationship. Values, bodies,
tokens, signed URLs, invoice metadata, and document bytes remain ephemeral.

Compilation may emit a candidate only when every persisted template value has a
typed source and every edge needed at scheduled runtime can be reproduced by a
packaged primitive. An unresolved edge makes the candidate partial; it is never
filled by model guesswork.

### 3. Diverse candidate portfolio

Retain at most three candidates as today, but select for **failure-domain
diversity**, not merely score:

- Prefer a complete network/structured path over DOM.
- Keep one complete direct/embedded path if it does not share the network path's
  list or document-resolution edge.
- Keep at most one semantic DOM fallback.
- Do not spend all three slots on candidates with the same endpoint, selector,
  or document provider.
- Rank WebMCP only after its semantics are stable and never let it displace a
  proven deterministic path merely because it is newer.

Persist the whole proven portfolio in the active generation. Scheduled sync may
fall through candidate-local failures exactly as initial verification does.

Finding one working candidate is not permission to cancel the remaining path
families. Collector may surface the first proven primary promptly, but it must
continue bounded background exploration until it has a diverse proven portfolio
or every safe family is exhausted. If the site genuinely exposes only one safe
path, the coverage proof records that fact; the engine must not invent a fallback.

### 4. Typed self-healing state machine

```text
HEALTHY
  | repairable path failure
  v
SUSPECT -- non-repairable/auth/rate/destination --> WAITING_FOR_EXTERNAL_STATE
  |
  v
SHADOW_DISCOVERY -- no proven candidate --> DEGRADED (keep last-known-good)
  |
  v
PROOF: complete traversal + safe actions + valid artifact + stable identity
  |
  v
PROBATION: fresh disposable context repeats proof, no sink write
  |
  v
ATOMIC_PROMOTION -- first scheduled run succeeds --> HEALTHY
  |
  +-- candidate-local failure --> ROLLBACK previous generation
```

Automatic repair is allowed only for:

- route missing or safe redirect drift;
- response schema/items-path drift;
- semantic control missing/relocalized;
- pagination/continuation drift;
- document resolution/provider path drift within the exact permission policy;
- a stored candidate becoming partial while another proven fallback is complete.

Do **not** run repair for:

- expired/blocked session, CAPTCHA, 2FA, or insufficient billing scope;
- supplier rate limiting or offline transport;
- user-denied exact-origin permission;
- destination unavailable or persistence failure;
- a complete, valid empty result with no contrary structural evidence;
- a flow requiring mutation, checkout, payment, cancellation, authorization,
  logout, or a new secret;
- missing invoice content at the supplier.

Split `recipe_incompatible` internally into bounded structural reasons, while
keeping a stable user-facing umbrella if needed. Diagnostics expose reason codes
and counts only, never raw values.

### 5. Proof without duplicate delivery

Initial admission remains unchanged: a new supplier needs a real validated
document accepted by the selected destination before connection is reported.

A repair of an already-connected supplier may prove a shadow candidate without
writing to the sink when all of these hold:

1. traversal is complete;
2. at least one artifact validates;
3. its stable invoice identity or content alias matches an accepted seen/ledger
   identity for the same immutable `supplierLineageId` and destination company;
4. a second fresh disposable context reproduces the identity;
5. no unapproved origin, method, or semantic action is introduced.

If the shadow path exposes only a genuinely new artifact, use the existing
exclusive sink lane and normal idempotency key. A backend/local duplicate response
is valid proof. Never create a special unjournaled delivery path.

Promotion writes a new generation with compare-and-swap semantics and retains one
previous generation. A crash must leave either the old or new complete generation,
never a hybrid. Candidate-specific identifiers must not change the supplier
lineage or duplicate key namespace.

### 6. Semantic self-healing

Replace durable selector identity with a bounded semantic fingerprint made from:

- element role/tag and enabled/visible state;
- normalized accessible-name intent class, not invoice/user values;
- href/action family (`download`, `pdf`, `receipt`, `invoice`);
- nearby heading/table-column intent classes;
- safe control type and whether it is inside a form;
- the route family and frame origin;
- optional stable test-id key only when it is non-sensitive.

At runtime, re-locate from the current DOM, require one unambiguous high-scoring
match, and re-run the shared forbidden-action policy immediately before action.
Ambiguity, a form boundary, a dangerous label, a cross-origin frame without
permission, or an unseen action type fails closed. A lower-scoring candidate may
be shown for user confirmation but cannot self-promote.

### 7. Studio repair lab and learning loop

Extend existing Studio rather than broadening Collector. A developer-authorized
capture may use CDP to observe service workers, child frames, browser downloads,
and response bodies. It produces:

- a redacted local capture;
- a structural evidence graph;
- a candidate acquisition plan;
- an automatically minimized synthetic archetype fixture;
- explicit disclosures of every method, origin, action, field shape, and cap.

An LLM may summarize the redacted graph or propose a new grammar primitive in
Studio, but a human must review the diff, tests must prove the primitive across
positive and negative archetypes, and the behavior ships only in a new signed
extension build. Do not send raw captures to a model by default.

The reusable learning loop is:

```text
hard authorized site -> Studio/CDP evidence -> sanitize -> archetype fixture
-> general primitive or inference improvement -> adversarial tests -> reviewed release
-> all matching local suppliers can repair with packaged behavior
```

### 8. Standards-native lane

Treat e-invoicing as a separate acquisition lane converging at `IngestSink`, not
as a browser recipe. In a separately scoped implementation plan:

- accept and validate Peppol BIS Billing / UBL invoice and credit-note documents;
- accept EN 16931 CII embedded in Factur-X/ZUGFeRD PDF/A-3;
- retain the original structured invoice and/or rendered PDF according to the
  destination contract;
- derive the same supplier lineage, invoice identity, content alias, ledger, and
  idempotency semantics used by browser acquisition;
- keep transport/account enrollment outside Collector unless a reviewed product
  decision explicitly puts it there.

This lane increases supplier coverage without browser fragility. It does not
weaken or bypass invoice validation.

### 9. Progressive WebMCP lane

Do not implement before the API reaches an agreed maturity gate. Detection may be
added behind a packaged feature flag when supported, but execution requires:

- a visible disposable supplier context;
- exact-origin permission;
- a declared output schema that maps to invoice enumeration/document retrieval;
- explicit read-only semantics that Ratatosk can validate rather than trust from
  a tool name;
- the same traversal, document, identity, and duplicate proofs as every lane.

Until those conditions are possible, record only `tool_available` as bounded
structural evidence and continue with deterministic lanes.

### 10. Starvation-free exploration scheduler and resumable time budgets

Use two levels of ordering:

1. **Fairness across families** — take one highest-ranked item from every nonempty
   safe family before any family receives a second turn. Repeat weighted rounds
   while frontiers remain. A large settings menu or many guessed common routes
   must not starve exact-entry replay, observed network evidence, frames, direct
   documents, or semantic controls.
2. **Best-first within a family** — use deterministic evidence scores to order
   that family's routes, requests, controls, or frames. Ties resolve from stable
   structural keys, never discovery timing.

All supported safe families are:

| Family | What it explores | Boundary |
| --- | --- | --- |
| Exact entry | Cold replay of the exact current billing/account route | Mandatory first round; active user tab remains untouched |
| Observed navigation | Same-origin links and accessible menu/tab destinations | GET-only; dangerous route vocabulary pruned |
| Tenant-contextual routes | Billing/invoice suffixes under one observed tenant prefix | One typed tenant prefix; no opaque capability guessing |
| Common billing routes | Small packaged route families independent of site menus | Lowest initial priority, but guaranteed a fair turn |
| Observed network | Fetch/XHR REST and explicit read-only GraphQL evidence | Bounded bodies; typed provenance; no arbitrary POST |
| Embedded data/router state | JSON/JSON-LD/hydration and bounded same-origin JSON route manifests | Data only; never execute or mine arbitrary bundles |
| Document/provider links | PDF/download/receipt links and known capability providers | Exact origins and provider redirect policy |
| Semantic download | Visible, enabled, unambiguous invoice/receipt controls | Disposable tab; shared forbidden-action policy |
| Permitted child frames | The same evidence lanes inside frames whose origins are approved | Each frame independently permission-checked |
| Declared tools | WebMCP invoice tools when the maturity gate is met | Disabled until read-only semantics are verifiable |

Use separate reviewed budgets for user experience and coverage. These are initial
ceilings to validate in the mutation and blind-site benchmark, not promises that
more requests automatically produce better discovery:

| Mode | Trigger | Cumulative budget | Page attempts | Depth | Result behavior |
| --- | --- | ---: | ---: | ---: | --- |
| Fast primary | Explicit initial Find Invoices | 30 seconds | 15 | 3 | May surface a proven primary promptly; checkpoints remaining frontier |
| Deep connect | User continues or first primary is absent/only path | 180 seconds | 60 | 5 | Fills diverse portfolio or exhausts every safe family |
| Self-heal | Repairable failure on a connected supplier | 300 seconds over at most five checkpointed slices | 80 total | 5 | Runs in shadow; never delays or mutates the current active generation |

Preserve the existing maximum of two concurrent route probes, one semantic/PDF
canary at a time, per-origin rate awareness, and immediate cancellation on
authentication challenge, rate limiting, permission denial, or unsafe evidence.
Budgets are cumulative across service-worker restarts. Persist only the bounded
frontier's structural keys, family, score, depth, and visited state in
`chrome.storage.session`; never persist response bodies, raw paths with tenant
values, request values, signed URLs, DOM excerpts, or documents.

Completion rules are strict:

- `not_found` requires every enabled safe family to be exhausted and a coverage
  proof showing no unresolved frontier.
- A time/page cap is `limit_reached`, with the frontier checkpointed for an
  explicit continuation or later shadow slice.
- `portfolio_complete` requires one proven primary plus at least one proven
  independent fallback, unless all other safe families are exhausted.
- A high-scoring family cannot terminate exploration while another enabled family
  has received no attempt.
- Repeated URLs, route templates, requests, controls, and document capabilities
  consume no additional page budget after structural deduplication.
- Normal scheduled sync uses the active portfolio and does not deep-scan healthy
  suppliers. Deep exploration is limited to explicit discovery, portfolio
  completion, or typed repair.

## Privacy and control-plane boundary

The self-healing control plane is local. `chrome.storage.local` holds only
validated generations and bounded health state. Raw evidence stays in memory or
in an explicitly authorized Studio session.

A remote service may receive only one of:

- existing explicit, previewed Studio fingerprint submissions;
- opt-in operational codes for a reviewed packaged vendor/capability version;
- aggregate release/feature health where the extension's disclosed single
  purpose and privacy policy permit it.

It may return only feature enablement for behavior already packaged in the
extension, minimum/supported capability versions, or release availability. It
must not return a recipe, selector, transform, request, DOM action, repair graph,
or natural-language instruction that changes execution. Unknown-supplier origin,
route families, browsing activity, request shapes, or failure fingerprints are
not uploaded automatically.

## Commands you will need

Use Node `^20.19.0 || >=22.12.0`. On this machine, `/opt/homebrew/bin/node` avoids
the ChatGPT-bundled Node native-module restriction.

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install | `npm ci` | exit 0 |
| Focused contracts | `npx vitest run test/core/acquisition-profile.test.ts test/core/discovery-profile.test.ts test/core/retrieval-completeness.test.ts test/core/discovery-candidate-fallback.test.ts` | all pass |
| Focused repair | `npx vitest run test/core/discovery-repair.test.ts test/core/discovered-supplier-generations.test.ts test/core/discovery-exploration-scheduler.test.ts test/core/dedup.test.ts` | all pass |
| Discovery corpus | `npx vitest run test/core/discovery-shape-corpus.test.ts test/core/discovery-adapters.test.ts test/core/browser-dom-boundary.test.ts` | all pass |
| Studio capture | `npx vitest run test/core/recorder-capture.test.ts test/core/recorder-infer.test.ts test/core/supplier-fingerprint.test.ts` | all pass |
| Typecheck | `npm run typecheck` | exit 0; no errors |
| Architecture | `npm run check:boundaries` | exit 0 |
| Recipe validation | `npm run validate` | exit 0 |
| Full CI | `npm run ci` | exit 0 |
| Collector build | `npm run build:collector` | exit 0; `dist/collector` emitted |
| Studio build | `npm run build:studio` | exit 0; `dist/studio` emitted |
| Security | `npm run audit:security` | exit 0; no high/critical advisory |
| Patch hygiene | `git diff --check` | exit 0; no output |

Commands naming new tests apply after the phase that creates them.

## Scope

This is a multi-PR program. Each phase's PR may touch only the files listed in
that phase plus `docs/architecture.md`, `docs/testing.md`, `plans/README.md`, this
plan, and one final `package.json`/`package-lock.json` patch-version increment
when a releasable Collector is built.

**Always out of scope**:

- adding `debugger`, `cookies`, broad install-time host access, or blocking
  `webRequest` to Collector;
- a general autonomous agent in scheduled Collector runs;
- remote recipes, selectors, transforms, prompts, or executable repair plans;
- vendor-specific Supabase, ClickUp, Stripe Dashboard, X, or other branches in
  the generic engine;
- CAPTCHA/2FA bypass, credential storage, mutation, purchase, payment,
  cancellation, deletion, logout, OAuth, or authorization actions;
- automatic upload of unknown-supplier origins, routes, request shapes, DOM,
  bodies, headers, tokens, invoice metadata, or document bytes;
- claiming universal or “almost any supplier” coverage before the benchmark
  gate below passes;
- combining Collector and Studio packages or publishing Studio to consumers.

## Git workflow

- Start every phase in a clean worktree based on current `origin/main` after its
  dependencies merge.
- Branches: `feat/acquisition-contracts`, `feat/discovery-shadow-repair`,
  `feat/discovery-evidence-graph`, `feat/discovery-semantic-repair`,
  `feat/studio-archetype-lab`, and `test/acquisition-blind-benchmark`.
- Use focused commits matching the repository's imperative style, for example
  `Add bounded discovery concurrency` and `Fix discovered candidate fallback`.
- Do not push, publish, or open a PR unless the operator explicitly requests it.

## Implementation phases

### Phase 0: Complete Plan 011 and freeze acceptance cases

Finish exact-entry cold replay and one shared semantic policy. Add the Supabase-
shaped startup API and ClickUp-shaped semantic-control cases to the synthetic
corpus. Record only structural shapes.

**Files**: only Plan 011's in-scope list.

**Verify**: every Plan 011 gate passes. If its core hypotheses are disproven,
STOP and revise this program's observation and semantic assumptions.

### Phase 1: Add acquisition profile, proof, and failure contracts

Create `src/core/acquisition.ts`. Define and validate:

- immutable supplier lineage;
- generation state and monotonically increasing generation number;
- maximum-three diverse candidate portfolio;
- candidate safety, traversal, document, identity, reproducibility, and freshness
  proofs;
- repairable structural failure reasons distinct from external-state failures;
- schema v1 → v2 migration that preserves current discovered profiles as one
  active generation with `legacy_unproven` proof state.

Extend `src/core/errors.ts` without breaking existing persisted
`OperationalOutcomeCode` values. Put detailed repair reasons in a separate closed
union and map them to the current umbrella UI code where necessary.

**Files**:

- `src/core/acquisition.ts` (create)
- `src/core/schema.ts`
- `src/core/discovery.ts`
- `src/core/errors.ts`
- `src/core/types.ts`
- `test/core/acquisition-profile.test.ts` (create)
- `test/core/discovery-profile.test.ts`

**Verify**: focused contracts, `npm run typecheck`, and `npm run check:boundaries`
pass. Parsing an unknown primitive, arbitrary action, executable string, broad
origin, contradictory proof, or more than three candidates must fail.

### Phase 2: Persist versioned generations and run shadow repair

Replace the single-profile storage implementation with a versioned store. Keep a
read migration for `discoveredSuppliers.v1`; do not delete it until a v2 write is
durable. Provide serialized operations for:

- `getActiveGeneration`;
- `stageShadowGeneration`;
- `promoteShadow(expectedActiveGeneration)`;
- `markProbationSuccess`;
- `rollbackToPrevious(expectedGeneration)`;
- `removeSupplierLineage`.

Create `collector/src/platform/discovery-repair.ts`. On one of the repairable
reasons, schedule one bounded shadow discovery, using the same exact-origin
permission and disposal guarantees as manual discovery. Coalesce concurrent
repair attempts per supplier. Apply backoff to repeated unproven repairs. Never
repair during auth/rate/destination/permission failure.

Create a starvation-free, resumable scheduler in
`collector/src/platform/discovery-explorer.ts` backed by a platform-free policy
in `src/core/exploration.ts`. Implement the three budget modes and coverage proof
defined above. Checkpoint only sanitized structural frontier state in session
storage. An interrupted service worker must resume with the same deterministic
family order and cumulative counters.

Scheduled collection first tries the retained active portfolio. Shadow discovery
cannot change the current sync or write a sink artifact until proof rules select
a candidate.

**Files**:

- `collector/src/platform/discovered-suppliers.ts`
- `collector/src/platform/discovery-repair.ts` (create)
- `collector/src/platform/discovery-explorer.ts`
- `collector/src/platform/discovery-diagnostic.ts`
- `collector/src/platform/collector.ts`
- `collector/src/platform/service-worker.ts`
- `collector/src/platform/storage.ts`
- `collector/src/platform/source-catalog.ts`
- `src/core/exploration.ts` (create)
- `test/core/discovered-supplier-generations.test.ts` (create)
- `test/core/discovery-repair.test.ts` (create)
- `test/core/discovery-exploration-scheduler.test.ts` (create)
- `test/core/discovery-explorer.test.ts`
- `test/core/discovery-candidate-fallback.test.ts`

**Verify**: focused repair tests pass. Simulated crashes before and after each
storage write leave exactly one valid active generation. Auth, rate, destination,
and permission cases create no repair run. Fake-clock tests prove every nonempty
safe family receives a turn, fast mode checkpoints into deep mode, restart resumes
the same frontier, and only exhausted frontiers produce `not_found`.

### Phase 3: Compile an evidence graph and select diverse candidates

Create a platform-free ephemeral evidence graph and compiler. Integrate bounded
observer, replay, embedded JSON, link, and DOM evidence. Support correlations
needed for common split flows:

- tenant source → account-scoped invoice list;
- list row document reference → detail/document endpoint;
- GraphQL list operation with literal-free variables;
- row/control → HTTPS, browser download, or blob document capability;
- cursor/next-link/page continuation → completeness proof.

Every persisted placeholder needs typed provenance. Add deterministic candidate
diversity selection and stable ranking. Keep raw values out of graph snapshots
used by tests; fixtures use opaque synthetic aliases.

**Files**:

- `src/core/acquisition-evidence.ts` (create)
- `src/core/acquisition-compiler.ts` (create)
- `src/core/recorder/infer.ts`
- `src/core/recorder/types.ts`
- `collector/src/platform/discovery.ts`
- `collector/src/platform/discovery-candidates.ts`
- `collector/src/platform/discovery-page-observer.ts`
- `test/core/acquisition-evidence.test.ts` (create)
- `test/core/acquisition-compiler.test.ts` (create)
- `test/core/discovery-adapters.test.ts`
- `test/core/discovery-shape-corpus.test.ts`

**Verify**: discovery corpus and new graph/compiler tests pass. Property/fuzz tests
show that secret-like values, arbitrary POST, unbound identifiers, cycles, broad
origins, and incomplete correlations cannot compile.

### Phase 4: Prove, promote, and roll back without duplicates

Add a verification-only execution mode that may materialize one bounded artifact
but never calls an unjournaled sink. It may prove an existing artifact only by
matching accepted identity/content aliases under the same supplier lineage and
company. Otherwise it uses the ordinary idempotent sink lane.

Require two fresh-context proofs for automatic promotion. Use compare-and-swap to
promote, mark probation, and retain previous. The first later candidate-local
failure rolls back; external-state failures leave the generation unchanged.
After a probation success, retain previous for a bounded period/runs, then prune.

**Files**:

- `src/core/engine.ts`
- `src/core/retrieval.ts`
- `src/core/types.ts`
- `collector/src/platform/collector.ts`
- `collector/src/platform/discovery-repair.ts`
- `collector/src/platform/discovered-suppliers.ts`
- `collector/src/platform/storage.ts`
- `test/core/discovery-repair.test.ts`
- `test/core/dedup.test.ts`
- `test/core/retrieval-completeness.test.ts`

**Verify**: run each synthetic repair at least ten times across two sink kinds.
There must be zero duplicate sink commits, zero resurrection after disconnect,
and deterministic active/previous generations after injected storage failures.

### Phase 5: Add semantic fingerprint re-localization

Create one shared core/platform policy for semantic fingerprints and action
safety. Discovery and verification must call the same predicate. Persist only
bounded intent classes and structural attributes. Require an unambiguous match
above a fixed threshold and revalidate immediately before action.

Test renamed classes, reordered tables, changed nesting, localized labels,
React rerenders, hidden duplicate controls, disabled controls, dangerous nearby
actions, GET forms, mutating forms, iframes, and blob/browser-download outcomes.

**Files**:

- `collector/src/platform/discovery-dom-policy.ts`
- `collector/src/platform/browser-dom-driver.ts`
- `collector/src/platform/discovery.ts`
- `src/core/strategies/dom.ts`
- `test/core/browser-dom-boundary.test.ts`
- `test/core/dom-document-integrity.test.ts`
- `test/core/discovery-shape-corpus.test.ts`

**Verify**: the semantic corpus passes with 100% rejection of dangerous/ambiguous
controls. A formerly proven control with no unique safe match must remain
degraded; it must not choose the closest guess.

### Phase 6: Turn Studio into an archetype repair lab

Extend Studio's existing CDP capture to create a local evidence graph and a
sanitized archetype-fixture export. Make export explicit and previewed. Add
checks that forbid response values, header values, cookies, tokens, signed URL
values, invoice/customer metadata, and raw HTML/document bytes.

Do not make candidate output directly installable in Collector. The only path to
production is a reviewed source/fixture change and packaged extension release.

**Files**:

- `studio/src/platform/service-worker.ts`
- `studio/src/ui/popup/popup.ts`
- `studio/src/ui/popup/popup.html`
- `src/core/recorder/cdp.ts`
- `src/core/recorder/infer.ts`
- `src/core/recorder/report.ts`
- `src/core/recorder/supplier-fingerprint.ts`
- `test/core/recorder-capture.test.ts`
- `test/core/recorder-infer.test.ts`
- `test/core/recorder-report.test.ts`
- `test/core/supplier-fingerprint.test.ts`
- `docs/contributing-supplier-fingerprints.md`

**Verify**: Studio-focused tests, `npm run build:studio`, and an adversarial
fixture scan pass. Searching the exported fixture for seeded canary values must
return no matches.

### Phase 7: Build the mutation and blind-site benchmark

Create a reusable synthetic site corpus spanning at least:

1. REST list with direct PDFs;
2. REST list + detail join;
3. GraphQL query + variables + cursor;
4. server-rendered links;
5. embedded hydration JSON;
6. tenant-scoped SPA with startup-only traffic;
7. accessible semantic download controls;
8. GET/blob/browser-download controls;
9. safe iframe evidence;
10. worker-mediated flow detectable only in Studio;
11. pagination and infinite-scroll caps;
12. Factur-X/UBL/CII structured artifacts.

Generate safe mutations: route rename, extra JSON envelope, field rename with
stable semantics, pagination change, DOM nesting/class churn, label localization,
iframe move, delayed startup, document redirect-origin drift, and a dangerous
look-alike control. Each mutation has an expected outcome of `repaired`,
`degraded`, or `external_state`; no test may silently weaken policy to improve
coverage.

Add adversarial breadth cases: one family with hundreds of high-scoring settings
links cannot starve a low-volume network/direct-document/frame family; the first
working path does not stop fallback discovery; simulated service-worker shutdown
resumes the frontier; 30-second fast mode may become `limit_reached` but the
180/300-second cumulative modes eventually exhaust the bounded fixture frontier.

Then run an authorized, blinded panel of at least 100 supplier portals selected
before testing and stratified across app architectures and invoice delivery
patterns. Operators may open the billing page and grant exact-origin access, but
may not tell the engine private API routes. Store only aggregate results and
consented structural diagnostics.

**Files**:

- `test/core/discovery-shape-corpus.test.ts`
- `test/core/acquisition-mutation-corpus.test.ts` (create)
- `test/e2e/collector-discovery.spec.ts` (create if a reviewed browser harness is adopted)
- `test/fixtures/acquisition/` (create; synthetic only)
- `docs/testing.md`
- `docs/acquisition-coverage.md` (create; aggregate results only)
- `package.json` and `package-lock.json` only if the reviewed E2E harness needs a dependency

**Verify**: `npm run ci`, both builds, audit, and the benchmark command documented
in `package.json` pass.

### Phase 8: Plan standards intake and WebMCP separately

After browser fabric gates pass, write two new self-contained plans:

- standards intake through the destination/Igdrasil boundary, with Peppol/UBL,
  CII, Factur-X validation and unified idempotency;
- WebMCP detection/validation after the maturity gate is met.

Do not implement either by adding special cases inside generic discovery.

**Verify**: both plans identify trust boundaries, owners, exact schemas, conformance
fixtures, and release gates. WebMCP stays disabled in production until its STOP
conditions are cleared.

## Test and confidence plan

The architecture is high-confidence only if evidence satisfies all three axes:

### Coverage

- Synthetic archetype coverage: every supported lane and correlation has at least
  one positive and two negative fixtures.
- Exploration breadth: every nonempty enabled family is attempted before any
  family consumes a second fair-scheduling round; no safe family starves.
- Mutation recovery: at least 95% of mutations labeled safely repairable recover
  within one bounded shadow cycle; 100% of non-repairable mutations remain
  degraded or external-state.
- Blind live coverage: at least 90 of 100 preselected, authorized portals produce
  a complete traversal and valid artifact. Report the Wilson 95% confidence
  interval and results by architecture; no architecture stratum may be hidden by
  aggregate performance.

### Safety and privacy

- Zero mutating requests or dangerous DOM actions across the full negative corpus.
- Zero automatic broad-origin grants and zero `debugger` permission in Collector.
- Zero seeded credentials, customer/invoice values, signed URL values, or raw
  bodies in persisted profiles, diagnostics, fixture exports, or telemetry.
- Every automatic promotion has machine-verifiable safety, traversal, artifact,
  identity, and reproducibility proofs.

### Reliability

- Zero duplicate sink commits in repeated sync, fallback, promotion, crash, and
  rollback tests.
- Zero partial generation states under injected storage failures.
- 100% deterministic candidate ordering for identical evidence.
- 100% deterministic frontier continuation across a simulated service-worker
  restart, with cumulative time/page accounting preserved.
- Repeat the blinded panel after 30 days; report retained success and every repair.

Until these gates pass, product language must be “works with many authenticated
supplier billing portals” rather than “almost any supplier.”

## Done criteria

- [ ] Plan 011 is DONE and its Supabase/ClickUp structural regressions pass.
- [ ] Collector executes only the packaged capability grammar; remote commands
      and general agent actions are structurally impossible.
- [ ] Discovered suppliers retain an active diverse portfolio plus versioned
      shadow/previous/probation generations with atomic promotion and rollback.
- [ ] Repair triggers only for closed structural failure reasons.
- [ ] Fast, deep, and self-heal modes use starvation-free family scheduling,
      resumable cumulative budgets, and coverage proofs; only an exhausted
      frontier can produce `not_found`.
- [ ] Shadow verification can prove an accepted document without duplicate
      delivery and cannot bypass the existing sink journal.
- [ ] Semantic re-localization uses shared safety policy and fails on ambiguity.
- [ ] Studio produces sanitized archetype fixtures without making output directly
      installable in Collector.
- [ ] Mutation, privacy, crash, duplicate, and blind-site gates above pass.
- [ ] `npm run ci`, `npm run build`, `npm run audit:security`, and
      `git diff --check` exit 0.
- [ ] `docs/architecture.md`, `docs/testing.md`, and aggregate coverage evidence
      describe the final behavior and its honest limitations.
- [ ] No files outside the current phase's scope are modified.
- [ ] `plans/README.md` status is updated after each phase and marked DONE only
      after the full confidence gate passes.

## STOP conditions

Stop and report; do not weaken the model if:

- Plan 011 cannot make exact-entry observation or semantic detection reproducible.
- Chrome Web Store policy review indicates the proposed locally persisted plan is
  treated as remotely supplied execution logic, or implementation starts to
  depend on server-supplied behavior.
- A repair requires `debugger`, broad install-time host permissions, arbitrary
  headers/POST, generic click, or credential persistence in Collector.
- A candidate cannot prove complete traversal, a valid artifact, stable identity,
  or a safe action set.
- Exploration completion relies on the first successful/high-scoring family while
  another enabled safe family is unattempted, or a service-worker restart loses
  the cumulative budget/frontier.
- A shadow candidate requires sink delivery but the selected destination cannot
  provide idempotent/durable duplicate evidence.
- Supplier lineage cannot remain stable across profile generations.
- Any persisted/exported diagnostic contains seeded secret or invoice values.
- Candidate ranking differs for identical evidence.
- A dangerous mutation is executed in any test or live run.
- The blind panel is selected after seeing results, uses fewer than 100 authorized
  portals, or lacks meaningful architecture diversity. Report exploratory data,
  but do not make the coverage claim.
- WebMCP remains experimental or cannot express verifiable read-only semantics.
- A phase requires touching another phase's files without first revising this
  plan and its drift/scope list.

## Maintenance notes

- Treat a new primitive as security-sensitive interpreter expansion. Require an
  adversarial test and a new signed extension build.
- Keep last-known-good profiles until a new path proves itself. Never delete a
  working path merely because shadow discovery found a higher score.
- Empty complete traversal is not automatically broken. Repair needs structural
  contrary evidence or a typed path failure.
- Browser-agent and selector-repair research will improve. Re-evaluate it for the
  Studio proposal loop, not as justification to weaken Collector promotion.
- WebMCP and e-invoicing standards are moving targets; pin supported versions and
  conformance fixtures.
- Report coverage by acquisition archetype. A headline percentage without the
  failure distribution is not sufficient evidence for product claims.
