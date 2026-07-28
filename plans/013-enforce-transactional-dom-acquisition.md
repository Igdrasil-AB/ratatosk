# Plan 013: Make every DOM document action transactional and idempotent

> **Executor instructions**: Follow this plan in order from a clean feature
> worktree. Start with the failing characterization tests, preserve the
> platform/core boundary, and run every verification gate. Do not add a
> supplier-specific workaround. If a STOP condition occurs, stop and report the
> exact failed invariant instead of weakening it. When complete, record only
> sanitized evidence here and update the status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat b7082c8..HEAD -- src/core/engine.ts src/core/types.ts src/core/schema.ts src/core/strategies/dom.ts collector/src/platform/browser-dom-driver.ts collector/src/platform/discovery.ts collector/src/platform/discovery-page-observer.ts collector/src/platform/semantic-action-observer.ts collector/src/platform/semantic-document-fetch.ts collector/src/platform/runtime.ts collector/src/platform/collector.ts collector/src/platform/filesystem-sink.ts scripts/check-architecture-boundaries.ts test/core docs package.json package-lock.json`
>
> This plan was written against `origin/main` commit `b7082c8` on 2026-07-27.
> Reconcile every in-scope drift before editing. A changed action, identity,
> sink, or release boundary is not permission to apply this plan mechanically.

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none; this is the corrective prerequisite for completing
  Plan 011 live acceptance and starting Plan 012
- **Category**: reliability, architecture, security, tests
- **Planned at**: commit `b7082c8`, 2026-07-27
- **Status**: IN PROGRESS — automated implementation and package evidence pass;
  exact-build Chrome load and first/immediate-second/configured-cadence live
  acceptance remain release-blocking

## Goal

Ratatosk-triggered page actions must be transactional:

> No document-producing page action may execute before Ratatosk has a stable
> supplier-scoped identity and owns its resolution lifecycle. No action may
> leave a browser-owned file outside the selected destination. Only a validated
> document accepted by the configured sink may become collected, seen, or
> eligible for discovered-supplier admission.

This is one shared acquisition invariant. Supplier recipes may declare bounded
capabilities, but they must not implement their own download ownership,
deduplication, cleanup, or commit behavior.

## Release-blocking success criteria

All of the following are required:

1. DOM listing and discovery are observational. They may enumerate stable
   document references and reveal explicitly safe navigation, but they cannot
   activate a document-producing control.
2. The core reserves every equivalent primary identity before a semantic
   document action executes.
3. Every click-capable document resolution runs through one Collector-owned,
   action-scoped controller.
4. The controller returns validated inline bytes or a controlled fetchable URL.
   A Chrome/page-owned download is evidence of an attempted side effect, never a
   successful collection.
5. A permission failure, transport failure, invalid PDF, timeout, cancellation,
   destination rejection, worker restart, or admission failure leaves no
   uncontrolled browser file.
6. A second sync does not activate controls for identities already accepted by
   the selected destination.
7. Unrelated user downloads cannot be observed as Ratatosk documents, cancelled,
   renamed, erased, or removed.
8. Existing discovered profiles receive the shared packaged behavior without a
   supplier-specific migration or broadened host permission.
9. Release validation fails if the synthetic native-download regression or the
   live two-run acceptance receipt is missing.

## Incident evidence

Do not commit the affected PDFs, filenames, signed URLs, tenant path, invoice
metadata, Chrome History database, or screenshots. Preserve only these bounded
facts in synthetic fixtures and sanitized execution notes:

- A connected Supabase discovery profile activated two invoice controls during
  scheduled sync.
- Chrome recorded the resulting files as page-owned downloads with no Ratatosk
  extension attribution, so they used Chrome's ordinary Downloads destination
  rather than the configured Ratatosk sink.
- The same two documents appeared again exactly one 720-minute schedule period
  later.
- A sanitized local history review found ten page-owned downloads from the same
  Orb object-storage host in five two-file bursts between 2026-07-24 and
  2026-07-26. No other host was observed in the bounded comparison window.
- Ratatosk-owned filesystem deliveries immediately around the incident carried
  the Collector extension ID and used the configured Ratatosk folder.
- The installed `0.8.46` build and `origin/main` `0.8.47` have the same semantic
  action implementation. The `0.8.47` PDF identity normalization is a separate
  fix and does not contain this incident.

## Root cause

### 1. Document actions execute in the list phase

`src/core/engine.ts` calls `strategy.list(...)` before deriving, checking, or
reserving document identities. The DOM strategy delegates list execution to
`BrowserDomDriver.run(...)`.

For a semantic candidate, `runDomStepsInPage(...)` calls `control.click()` while
executing `extractSemanticDownloads`. The page can therefore create an
irreversible Chrome download before the engine receives an `InvoiceRef`.

The current order is:

```text
strategy.list
  -> click every eligible semantic control
  -> observe URLs/downloads
  -> return InvoiceRef values
engine
  -> derive identity
  -> check and reserve seen keys
  -> fetch bytes
  -> sink
  -> commit seen and ledger
```

The required order is:

```text
read-only enumerate
  -> stable InvoiceRef + ephemeral packaged resolution handle
engine
  -> derive identity
  -> check and reserve every equivalent key
shared resolver
  -> perform at most one controlled action for an unseen identity
  -> return controlled URL or bounded PDF bytes
engine
  -> validate and content-identify
  -> sink
  -> commit seen and ledger
```

### 2. Observation is mistaken for ownership

`SemanticActionObserver` listens to `chrome.downloads.onCreated`, correlates the
URL, and promotes it to a document candidate. It discards the download ID and
does not model whether the download was prevented, cancelled, completed, or
left on disk.

Its URL set is scoped to the disposable tab run, not one exact control action.
Because `DownloadItem` has no tab ID, URL-only correlation must never gain a
destructive capability. Treating that signal as delivery proof is incorrect.

### 3. Page hooks cover only some mechanisms

The page observer captures fetch, XHR, blobs, and suppresses `window.open` only
while `beginDocumentAction()` is active. It does not own all generated-anchor,
default navigation, `Content-Disposition`, or browser-download paths. Capturing
the URL or bytes does not undo the browser side effect.

Navigation reveal, invoice-section reveal, packaged `DomStep.click`, and
automatic Next/Load More controls also execute outside one shared side-effect
boundary.

### 4. The regression suite codifies the wrong success condition

Current tests prove that a browser-observed request or download can recover a
destroyed execution context and produce a complete list result. They do not
assert that no external file was created, that identity was reserved before the
action, or that a second run skips the action. The focused suite is green while
the incident remains reproducible.

### 5. Live acceptance was advisory instead of release-blocking

Plan 011 required a Supabase collection followed by a second sync with no
duplicate delivery and separately stated that browser-download-only delivery
was not solved. The release gates did not convert that unfinished condition into
a blocker for dynamically discovered semantic suppliers.

## Affected and unaffected paths

| Path | Current state | Required treatment |
| --- | --- | --- |
| `extractSemanticDownloads` control activation | Confirmed pre-identity browser side effect | Move resolution after identity reservation and route it through the shared action controller |
| Packaged `DomStep.click` | Latent pre-identity side effect; no currently shipped public recipe needs it | Remove it from document listing or restrict it to a typed, shared navigation/action primitive |
| Automatic Next/Load More | Runs during listing; a misclassified control could create a side effect | Route through the shared navigation guard and fail if it creates a document/download |
| Discovery Profile/Settings/Billing reveal | Intended to be inert but enforced only by labels | Keep read-only and detect any document/download side effect as a closed failure |
| Direct DOM links | Read-only enumeration; controlled fetch occurs later | Preserve |
| Network and HTML strategies | Read-only list followed by controlled fetch | Preserve |
| Filesystem sink | Intentional Chrome download inside a journaled destination commit | Preserve; do not merge supplier-action downloads into this code |
| Igdrasil and generic HTTP sinks | Destination-side idempotent commit lane | Preserve |
| Studio report export | Explicit user-authored artifact, outside Collector sync | Out of scope |

## Target architecture

### Shared core: transaction and identity policy

Keep Chrome globals out of `src/core/`. Add the smallest platform-free contract
needed to separate enumeration from resolution. Exact type names may change, but
the contract must express:

```ts
type DocumentResolution =
  | { kind: "direct_url"; url: string }
  | { kind: "inline_pdf"; handle: string }
  | { kind: "semantic_action"; handle: string };

interface ListedDocumentRef extends InvoiceRef {
  vendorInvoiceId: string;       // stable before resolution
  resolution: DocumentResolution;
}

interface DocumentResolver {
  resolve(
    recipe: VendorRecipe,
    ref: ListedDocumentRef,
    signal?: AbortSignal,
  ): Promise<RawDocument>;
}
```

Required properties:

- `vendorInvoiceId` must be stable before any document action. Prefer explicit
  invoice/reference evidence, stable reviewed attributes, or a bounded
  supplier-scoped structural digest.
- Row position, action order, transient signed URL, generated filename alone,
  and raw selector text are not stable identities.
- If no safe pre-action identity exists, return a typed
  `unstable_action_identity`/unsupported outcome and do not activate the control
  unattended.
- Resolution handles are random or hashed, run-scoped, bounded, and ephemeral.
  They must not persist DOM, URLs containing credentials, selectors, row text,
  invoice values, or cross-run capabilities.
- The engine owns identity reservation before `resolver.resolve(...)`.
- The existing content identity remains a second post-fetch guard; it does not
  replace the pre-action identity.

### Collector platform: one document-action controller

Create one Chrome-specific owner, for example
`collector/src/platform/document-action-controller.ts`. `BrowserDomDriver`
delegates to it; suppliers do not.

The controller must:

1. operate only in the run's disposable exact-origin tab;
2. bind one action token to one enumerated resolution handle;
3. re-locate the control using the packaged shared semantic policy and require
   one unambiguous match;
4. re-check visibility, enabled state, form exclusion, unsafe labels, origin,
   and action budget immediately before activation;
5. start page and browser observation before activation and remove every hook in
   `finally`;
6. capture bounded PDF bytes or a GET URL on an approved exact origin;
7. prevent page-owned default download behavior when it can do so without
   suppressing the site's document-generation handler;
8. install one temporary response-header block rule scoped to the exact action
   tab before activation, so attachment and binary responses are stopped before
   Chrome creates a global `DownloadItem`;
9. never subscribe to, cancel, erase, rename, remove, or otherwise manipulate
   global Chrome downloads;
10. never call the destination sink, seen store, ledger, profile store, or
    scheduler directly;
11. return one closed outcome and dispose all ephemeral state.

Do not rely on `onDeterminingFilename` as the canonical transport. Renaming a
browser download cannot provide validated bytes to Igdrasil, cannot preserve the
shared sink contract, and does not prove that Ratatosk owns the download.

### Explicit outcome model

Add closed, privacy-safe failure outcomes for at least:

- `unstable_action_identity`;
- `document_action_ambiguous`;
- `browser_download_unsupported`;
- `document_action_side_effect`;
- `document_action_timeout`;
- existing exact-origin permission continuation;
- existing invalid/oversized document outcomes.

Diagnostics may record only the stage, outcome, acquisition kind, and bounded
counts. Never record the action URL, download path, filename, row contents,
invoice metadata, request/response values, or supplier identifiers.

## Implementation sequence

### Step 1: Add failing cross-boundary characterization tests

Create synthetic tests before production edits:

1. A semantic button creates a native Chrome download and destroys its execution
   context.
2. Controlled fetch then fails for missing redirect permission.
3. Assert that the current implementation activates the button before any
   `SeenStore.claimIfAbsent` call. This test must fail after encoding the desired
   order.
4. Assert that no browser-owned download may be reported as a successful
   `InvoiceListResult`.
5. Assert that a second run with an accepted stable identity never calls the
   action resolver.

Use fake Chrome events and synthetic URLs only. Do not access or copy the real
History database in tests.

**Verify**:
`npx vitest run test/core/dom-acquisition-transaction.test.ts test/core/semantic-action-observer.test.ts test/core/browser-dom-boundary.test.ts test/core/engine-streaming.test.ts`
fails only on the newly documented transaction invariants.

### Step 2: Separate DOM enumeration from document resolution

Refactor the DOM strategy contract so `list()` returns stable references without
activating document controls. Direct links remain direct URLs. Semantic rows
produce ephemeral resolution handles owned by the driver session.

Keep one disposable session alive for the run or provide a deterministic
re-location contract; do not persist live DOM state. Add an explicit dispose
path that runs on success, rejection, cancellation, timeout, and fatal sibling
failure.

Reject semantic rows that cannot produce a stable pre-action identity. Do not
fall back to index-based IDs.

**Verify**:

- a source-level/AST guard proves document-list code cannot call generic
  `click()`;
- enumeration tests observe zero downloads and zero document-producing actions;
- identical rows are either distinguished by stable evidence or rejected as
  ambiguous.

### Step 3: Move resolution behind the engine's identity claim

Update the core execution order:

1. enumerate;
2. derive primary and alias identities;
3. skip accepted/scheduled identities;
4. claim every equivalent identity;
5. resolve and validate;
6. claim the content identity;
7. enter the existing exclusive sink commit lane;
8. promote seen keys only after sink acceptance.

Every rejection or cancellation releases owned claims. Preserve the current
recovery behavior for backend-deduplicated sink responses.

**Verify**: ordered event assertions show
`identity_claim -> action -> byte_validation -> sink -> seen_commit` and never a
different order.

### Step 4: Implement the shared platform action controller

Move page-action lifecycle ownership out of observation-only helpers. Reuse the
closed DOM safety policy; do not duplicate its regular expressions or selectors.

Support, in order:

1. already-present direct HTTPS URL;
2. bounded inline PDF bytes;
3. action-produced page fetch/XHR URL or bytes;
4. action-produced `window.open` URL with the popup suppressed;
5. safely intercepted generated-anchor/default navigation;
6. typed unsupported browser download after the exact-tab response is blocked
   before a global `DownloadItem` exists.

`chrome.downloads.onCreated` must not be observed or used for containment.
`DownloadItem` has no originating tab, so post-creation ownership cannot be
proved. Use a temporary `declarativeNetRequest` session rule whose condition is
the exact disposable tab plus attachment/binary response headers. Remove the
rule in the controller cleanup path and classify the blocked acquisition path
as unsupported.

**Verify**: controller tests cover every terminal state and assert listener,
tab, page-hook, timer, and in-memory handle cleanup.

### Step 5: Put every remaining page click behind a typed shared policy

Audit and eliminate unowned clicks in:

- packaged `DomStep.click`;
- semantic Profile/Settings/Billing reveal;
- invoice-section reveal;
- automatic Next/Load More continuation;
- discovery probe reveal.

Navigation and pagination may retain distinct allowed outcomes, but they must
share one side-effect detector and fail if they produce a document/download.
Document resolution alone may return document evidence.

Add an architecture test that lists the only approved production call sites for
programmatic DOM activation. New raw `.click()` calls outside those owners must
fail CI.

### Step 6: Migrate existing profiles through packaged behavior

Do not write a Supabase migration. Existing `dom-actions` profiles must load
through the new packaged runtime behavior. If a legacy profile lacks enough
stable pre-action identity evidence, surface the typed unsupported/reconnect
state and require explicit re-discovery; do not run its action on schedule.

Profile migration must not broaden origins, retain signed URLs, or silently
change destination identity.

### Step 7: Correct tests, diagnostics, documentation, and release gates

- Replace tests that equate browser observation with collection.
- Add the transaction-order and no-external-file suites.
- Update `docs/architecture.md` so speculate/elect/commit includes action
  resolution after identity reservation.
- Update `docs/testing.md`, the privacy/security documentation, and runtime
  identity.
- Add release validation for the synthetic browser-download archetype.
- Require a versioned, sanitized two-run acceptance receipt for the semantic DOM
  capability before a Collector release can be marked ready.
- After automated implementation gates pass, bump the local patch candidate
  before live acceptance so the required receipt names the exact final version.
  Do not tag, publish, list, or submit it until every live gate passes.

### Step 8: Run authorized live acceptance

Use the authorized local Chrome profile. Do not commit screenshots, documents,
paths, raw URLs, queries, tenant identifiers, amounts, dates, filenames, or
History records.

For Supabase:

1. do not remove existing files or reset history;
2. record the pre-run count of page-owned downloads for the supplier's document
   host without retaining URLs;
3. run one manual sync;
4. confirm exactly one accepted destination document for each new stable
   identity and no page-owned Chrome download;
5. run an immediate second sync and confirm zero action activations, zero
   destination additions, and zero page-owned downloads;
6. run or wait for one real configured cadence and repeat the same checks.

For a synthetic/local archetype and one additional authorized semantic supplier:

- exercise URL, blob, native-download, permission, cancellation, and
  unrelated-user-download cases;
- repeat with filesystem and Igdrasil destinations;
- confirm one ledger row and both primary/content seen identities only after
  accepted delivery.

Record only:

```text
collector version
acquisition revision
artifact SHA-256
same-URL unrelated user download untouched
site class (not tenant)
destination kind
first-run accepted count
second-run action count
second-run accepted count
page-owned download delta
closed outcome
pass/fail
```

Use the run summary or redacted **Copy Diagnostic** output for the bounded
document-action count (`counts.documentActions`). Do not infer zero actions from
zero accepted documents.

## Required automated acceptance matrix

| Case | Expected result |
| --- | --- |
| Direct document link, unseen identity | Controlled fetch and one sink commit |
| Direct document link, accepted identity | No fetch and no sink call |
| Semantic action returns fetch/XHR URL | One controlled fetch, one sink commit |
| Semantic action returns bounded PDF blob | One sink commit, no browser file |
| Semantic action starts native download | Response blocked before `DownloadItem`, typed unsupported, never collected from observation alone |
| Redirect permission missing | Permission continuation, no file, no seen/ledger commit |
| Invalid/oversized PDF | Closed rejection, no destination or seen commit |
| Same invoice with rotated signed URL | One action/delivery across runs through stable primary identity |
| Two invoices with the same filename | Two distinct stable identities and destination files |
| Ambiguous or unstable row identity | No action; typed unsupported result |
| Unrelated user download during action | Untouched and never admitted |
| Continuation/reveal causes a download | Closed side-effect failure |
| Sink accepts, local seen write fails | Destination journal/backend idempotency makes retry safe |
| Service worker aborts before action | Claims released; no side effect |
| Service worker aborts after controlled bytes but before sink | Claims released; no browser file |

## Commands and gates

Use an allowed Node runtime (`20.19.x` or Node 24). On this machine, prefix Node
commands with `PATH=/opt/homebrew/bin:$PATH`.

```bash
npx vitest run \
  test/core/dom-acquisition-transaction.test.ts \
  test/core/semantic-action-observer.test.ts \
  test/core/semantic-document-fetch.test.ts \
  test/core/browser-dom-boundary.test.ts \
  test/core/dom-document-integrity.test.ts \
  test/core/engine-streaming.test.ts \
  test/core/filesystem-delivery.test.ts \
  test/core/discovery-profile.test.ts \
  test/core/discovery-candidate-fallback.test.ts
npm run typecheck
npm run check:boundaries
npm run validate
npm test
npm run audit:security
npm run validate:collector-release
npm run build:collector
npm run package:collector
npm run verify:collector-artifact -- artifacts/ratatosk-collector-v<version>.zip
git diff --check
```

Expected final evidence:

- all commands exit 0;
- no raw page activation exists outside reviewed shared controllers;
- the packaged artifact contains no Studio/debugger capability;
- the artifact version and runtime acquisition revision match;
- sanitized Supabase first/immediate-second/cadence-run acceptance passes;
- Plan 011 can complete its live delivery and duplicate acceptance;
- Plan 012 may then consume the transactional acquisition primitive.

## In-scope files

The executor may adjust exact filenames after the drift check, but the intended
scope is:

- `src/core/acquisition.ts` (create if the contract cannot fit cleanly in the
  existing strategy types)
- `src/core/engine.ts`
- `src/core/types.ts`
- `src/core/schema.ts`
- `src/core/strategies/dom.ts`
- `src/core/errors.ts`
- `collector/src/platform/document-action-controller.ts` (create)
- `collector/src/platform/browser-dom-driver.ts`
- `collector/src/platform/discovery-page-observer.ts`
- `collector/src/platform/semantic-action-observer.ts` (replace, narrow, or
  remove after ownership moves)
- `collector/src/platform/semantic-document-fetch.ts`
- `collector/src/platform/discovery.ts`
- `collector/src/platform/discovery-dom-policy.ts`
- `collector/src/platform/discovered-suppliers.ts`
- `collector/src/platform/runtime.ts`
- `collector/src/platform/collector-runtime-identity.ts`
- `scripts/check-architecture-boundaries.ts` or one focused architecture check
- focused `test/core` files and synthetic fixtures
- `README.md`, `SECURITY.md`, `docs/architecture.md`, `docs/testing.md`
- `store/test-instructions.md`, `store/release-checklist.md`
- `package.json`, `package-lock.json`
- `plans/011-cold-replay-and-semantic-download-parity.md`
- `plans/012-build-adaptive-supplier-acquisition-fabric.md`
- `plans/README.md` and this plan

## Out of scope

- Supabase-, Orb-, ChatGPT-, Claude-, or ClickUp-specific runtime branches.
- Deleting, moving, or deduplicating the user's existing files.
- Clearing browser download history or Ratatosk collection history.
- Changing the user's schedule or destination.
- Broad host permissions, `debugger`, CDP, `webRequestBlocking`, native
  messaging, remote browser infrastructure, or credential custody.
- Remote executable recipes, downloaded selectors, or model-generated actions.
- The broader repair generations, shadow promotion, standards-native intake, or
  Svala control plane from Plan 012.
- Treating a renamed browser download as a validated Igdrasil delivery.
- Publishing, listing, tagging, or submitting a Web Store build before every
  gate in this plan passes.

## Security and privacy invariants

- Never cancel, erase, rename, remove, or inspect an unrelated user download.
- Never read arbitrary files from Chrome's Downloads directory.
- Never persist signed URLs, blob URLs, DOM text, selectors, action handles, or
  download paths.
- Never broaden origins without the existing exact-origin user permission flow.
- Never execute a form submission, mutation, checkout, payment, cancellation,
  deletion, upgrade, logout, OAuth, or authorization action.
- Keep page-returned data untrusted and bounded at every extension boundary.
- All cleanup is exact-action-scoped and runs from `finally`.
- A disposable tab protects the user's visible page but is not proof that a
  browser download is safe or owned.

## STOP conditions

Stop and report if:

1. a stable identity cannot be established before a semantic action;
2. the design requires cancelling a download using only a URL or time window;
3. Chrome cannot distinguish the Ratatosk action from an unrelated user
   download and the proposed implementation would still manipulate it;
4. a native browser download must complete before bytes can enter the shared
   validation/sink pipeline;
5. a proposed change moves Chrome APIs into `src/core/`;
6. a supplier-specific exception is proposed;
7. a test requires real credentials, financial data, signed URLs, or committed
   PDFs;
8. listing, discovery, or pagination must be called "read-only" while it can
   produce a document/download side effect;
9. sink acceptance or seen-key ordering must be weakened to make tests pass;
10. any gate is skipped because focused tests are green;
11. live acceptance produces even one new page-owned supplier download.

## Definition of done

- [x] Failing characterization tests prove the original pre-identity action.
- [x] DOM enumeration is document-action-free.
- [x] Stable identity reservation happens before every semantic resolution.
- [x] One shared platform controller owns every document-producing page action.
- [x] Page-owned downloads never count as collected documents.
- [x] Native-download, permission, cancellation, crash, and same-URL
      unrelated-download tests pass.
- [x] All remaining programmatic page clicks are reviewed and CI-enforced.
- [x] Existing profiles use the packaged shared behavior or fail closed with a
      typed reconnect/unsupported outcome.
- [x] Filesystem and Igdrasil destinations pass repeated-run tests.
- [x] Full CI, security, build, package, and artifact verification pass.
- [ ] Release validation passes with the exact-build live acceptance receipt.
- [ ] Supabase first-run, immediate-second-run, and scheduled-cadence acceptance
      records zero page-owned downloads.
- [ ] Plan 011 live acceptance is complete.
- [x] The status row and sanitized execution evidence are updated.
- [x] No Web Store release/listing action occurs until all boxes above are
      checked.

## Sanitized execution evidence (2026-07-28, pre-live)

- Characterization first reproduced the forbidden order, then the corrected
  focused matrix passed 126 tests.
- Final local gate: 98 test files, 667 tests, typecheck, architecture boundary,
  vendor validation, and high-severity dependency audit all exit 0.
- Real Filesystem and Igdrasil sink adapters each pass a two-run stable-identity
  regression: one first-run action/delivery and zero second-run actions or
  deliveries.
- Collector production build and deterministic 16-file artifact verification
  exit 0, including a literal packaged acquisition-revision `2` assertion.
  Final unpublished exact-build acceptance candidate:
  `ratatosk-collector-v0.8.48.zip`, SHA-256
  `77405c4565d03ba7bd4568ea00b52414c30cbd196ebafd02a0ca4df894ae37ca`.
- The live receipt now carries that exact artifact SHA-256 and a required
  same-URL unrelated-user-download result. Release validation verifies the ZIP
  before comparing its computed digest with the receipt.
- Native attachment/binary responses are blocked by an exact-tab Chrome 128+
  session rule before `DownloadItem` creation. The controller no longer
  subscribes to or mutates global Chrome downloads.
- The release-specific native-download suite passes 57 tests. Release
  validation then exits non-zero only because
  `store/semantic-dom-acceptance.json` is absent. This is the intended
  release-blocking state until the exact build passes live acceptance.
- Each run now returns and persists one bounded document-action count at the
  shared controller boundary; the redacted diagnostic exposes it as
  `counts.documentActions` without action, URL, selector, or invoice data.
- No supplier URL, tenant path, invoice metadata, filename, document, browser
  History row, credential, or screenshot was retained.
