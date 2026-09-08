# Security

Ratatosk handles authenticated billing requests and invoice documents, so the
consumer extension is deliberately bounded: no credential custody, no remote
code, and no authoring capability in the shipped artifact.

## Reporting a vulnerability

Please report privately through a
[GitHub security advisory](https://github.com/Igdrasil-AB/ratatosk/security/advisories/new)
instead of opening a public issue. We aim to acknowledge reports within 72 hours.

Do not include live credentials, invoice documents, or unredacted capture output
in a report unless a maintainer has provided a secure transfer method.

## Release boundaries

- `collector/` builds the consumer extension. It has no debugger/CDP recorder and
  does not request `debugger`, cookies, or persistent access to every site. Its
  optional `tabs` metadata permission is user-enabled only to follow active-tab
  changes in the persistent side panel. It uses `activeTab`, optional HTTPS
  origins, and a bounded ephemeral page-load observer only during explicit app discovery.
- `src/` contains shared, platform-independent logic. It cannot call Chrome APIs.
  `src/core/recorder/` is the packaged capture, redaction, and inference library
  that discovery uses; it performs no CDP recording and has no delivery path.
- The former Studio authoring build and its supplier-fingerprint delivery have
  been removed. Collector is the only extension this repository produces, and
  packaging rejects any bundle that regains a `debugger` or fingerprint marker.

CI packages Collector from `dist/collector` only. Reviewers should inspect the
manifest inside the release ZIP, not infer permissions from the repository.

## Threat model

| Asset or boundary | Threat | Mitigation |
|---|---|---|
| Igdrasil token | A broad account credential is persisted, read by a content script, logged, or sent to another host | The extension accepts only an Igdrasil-issued `rat_…` upload credential scoped to one company; it never receives a Clerk session JWT. The token is stored in extension-only local storage for scheduled sync, never logged, attached only to the configured HTTPS Igdrasil host, rotated on reconnect, and revoked on disconnect |
| Vendor sessions | Cookie or password exfiltration | Collector uses `credentials: "include"` and lets Chrome attach cookies; it never reads cookie values and requests no cookies permission; it never asks for passwords or 2FA |
| Temporary vendor bearer token | Persisted, logged, or sent to another vendor | Derived only when a packaged recipe requires it; held in one run's variables; used only in that recipe's bounded requests; never written to storage or logs |
| Invoice documents | Silent transmission to an unexpected destination | No vendor can connect until the user confirms a destination; destinations are validated; local and Igdrasil modes are explicit in the popup |
| Shared document-provider redirects | A signed invoice URL redirects to an attacker origin, or a capability token leaks through persistence/logging | Stripe capability URLs are recognized by exact HTTPS origin; hosted invoice URLs use only the proven canonical transformation; an observation-only, request-ID-scoped redirect listener accepts only Stripe origins or the fixed `stripe-upload-api` bucket across AWS regions; unknown exact origins require a new user-approved optional host grant; paths, queries, headers, and response bodies are never stored or emitted in permission diagnostics; the final bytes must pass the PDF signature and size checks |
| Recipe behavior | Remote code or remotely changed logic | Recipes and transforms are strict declarative data interpreted only by packaged adapters; Collector fetches neither remote code nor remote recipes; official recipe changes require a new reviewed package |
| Local supplier discovery | A hostile page creates an over-broad or secret-bearing recipe, spoofs a supplier, or causes silent downloads | Discovery starts only from a user click on the active HTTPS tab; runtime permission is requested for the exact origin; exploration is capped at 15 pages, depth three, and 10 seconds interactively (45 seconds for one escalation, 120 seconds for background self-repair); it uses at most four inactive tabs, matches billing intent anywhere in same-origin paths, preserves only a narrowly shaped tenant prefix, denies action/session paths, performs GET search navigation without clicks or forms, and closes the tabs; a dynamically registered exact-origin document-start observer captures only bounded JSON fetch/XHR evidence in memory, with credential-named fields, credential-shaped values, and payment instrument data replaced before inference, and restores page APIs/unregisters in `finally`; that evidence is never persisted or uploaded — only the request a candidate must replay reaches storage, and it is re-validated so credential-named or credential-shaped URL, query, and GraphQL variable data is rejected while ordinary addressing data (operation names, filters, pages, one bounded tenant identifier) is retained; invoice/detail routes remain search inputs and only explicit PDF/download-shaped links or controls become candidates; probes are size bounded and ephemeral; at most three proof-ranked candidates share one identity and no more than eight exact origins; generated profiles reject arbitrary headers/bodies, mutating methods, broad/private hosts, arbitrary selectors/clicks, and credential-like stored URL values except one bounded account identifier required by an explicit billing path; a profile may carry one token exchange and no credential — the stored instruction is a plain same-origin GET with no body or headers reading one named response field, the minted value binds only to the reviewed `{token}` variable, may be sent only as an `authorization` header and only back to the origin that issued it, may never appear in a URL or body, is re-minted from the user's own session at the start of every run, is held in that run's variables, and is admitted only after a preview mints it and returns validated invoices; the sole POST exception is a bounded JSON GraphQL operation beginning with explicit `query`, with mutations, subscriptions, extensions, and secret-like variables rejected; after explicit Connect & Collect, every click-capable or continuation run uses a disposable tab, may first reveal one exact invoice/receipt-history tab-like section, and may then activate only visible enabled download-labelled controls in invoice-shaped context while rejecting payment/purchase/cancellation/deletion/logout/form actions; fetch, XHR, beacon, popup, navigation, and form mutation guards remain installed until that tab closes; actual PDF validation occurs before admission and candidate-local failure falls through without masking global auth, permission, rate-limit, or destination failures; continuation may follow exact-origin pagination URLs, localized visible recognized Next/Load More controls near the invoice region, or scroll within hard action/document/time caps; inline PDFs are capped per document and across the complete DOM run; ephemeral cursors are not stored or logged; the domain stays visible; documents stream one at a time, accepted deliveries gain durable dedup evidence before discovery admission, and a profile is retained only after the destination accepts a real PDF; the page a proven candidate was found on is remembered locally per exact origin — an address only, never a request, response, or recipe — to order the next search, is re-probed and re-validated against the same entry-page policy on every read, is dropped after three unconfirmed searches, and is never uploaded or shared |
| Connect bridge | A hostile page installing a token or destination | Content script is limited to `https://accounting.igdrasil.se/*`; worker verifies extension id and exact sender origin; backend URL must be exactly `https://accounting.igdrasil.se`; connect requires a short-lived, one-use state created by an explicit Ratatosk or in-app action |
| Extension message bus | Web content issuing privileged commands | Consumer/control messages are accepted only when Chrome reports this extension's id and exact `chrome-extension://<this-id>/` sender URL; content-script senders retain their web URL and are rejected |
| Download paths | Path traversal or unintended overwrite | Folder and filename segments are normalized and tested; local root configuration is validated and bounded |
| Collector diagnostics | Error export leaking supplier or accounting data | Diagnostics are an explicit user action and contain only a stable vendor ID/code, package and lifecycle revisions, bounded counts, and normalized timestamps; stored error strings, URLs, headers, bodies, invoice IDs, company IDs, and tokens are excluded by construction; the Report Issue action opens a prefilled GitHub draft and copies the same redacted record to the clipboard, transmits nothing itself, and publishes nothing until the user submits it on github.com — the report names the supplier hostname and says so in its own body |
| Discovery diagnostics | Search evidence leaking account paths or invoice data | Failure diagnostics are explicit-copy, session-only structural summaries containing bounded page/evidence/candidate counts, candidate numbers, packaged adapter outcome codes, hostnames, and route templates whose opaque segments are replaced by `:id` or `:segment`; origins, raw paths, queries, fragments, headers, bodies, tokens, account/invoice identifiers, and financial values are never included |

Semantic document controls add a stricter transaction boundary to the local
discovery row above. Enumeration produces a stable supplier-scoped identity and
an ephemeral run handle without activating the document control. The core
claims every equivalent identity before one shared controller may re-locate and
activate exactly one unambiguous control. Exact-action page and browser
observers are removed in `finally`. A strongly correlated Chrome download is
contained and classified as unsupported/side-effect rather than delivery proof;
unrelated downloads are never inspected or modified. Action handles, selectors,
row text, URLs, filenames, paths, and invoice metadata are never persisted.

## Security invariants enforced by tests

- Recipe shapes reject unknown behavior: `src/core/schema.ts` and
  `test/core/recipe-freeze.test.ts`.
- Tokens cannot follow an arbitrary HTTP sink:
  `src/ingest/http-sink.ts` and `test/core/http-sink-security.test.ts`.
- Download paths cannot escape the configured folder:
  `collector/src/platform/filesystem-sink.ts` and
  `test/core/filesystem-traversal.test.ts`.
- Captured header values are allowlisted, authentication structure is value-free,
  and URLs and bodies are sanitized before discovery persists them:
  `src/core/recorder/cdp.ts` and `test/core/recorder-capture.test.ts`.
- The consumer ZIP cannot regain an authoring capability:
  `scripts/package-extension.ts` rejects `chrome.debugger`, recorder, and
  fingerprint markers in the built bundle.
- Raw programmatic page clicks outside the reviewed document-action controller
  and guarded discovery probe fail `npm run check:boundaries`.
- A Collector release reruns the native-download regression and requires a
  fresh exact-artifact acquisition receipt built from extension-generated,
  per-session snapshots with three supplier families, explicit ClickUp and
  Igdrasil readback, and zero second/cadence actions or observed page-owned
  downloads.

Public supplier reports must omit tenant-, workspace-, account-, customer-,
employee-, and internal-specific origins.

## Platform hardening

- Strict MV3 CSP: `script-src 'self'; object-src 'self'`.
- No `eval`, `new Function`, remote scripts, remotely hosted WebAssembly, or
  remote recipe catalog.
- Optional vendor origins requested at connect time and revoked on disconnect.
- Optional `tabs` access is requested separately, reads only active-tab metadata
  for side-panel context, stores no browsing history, and grants no page access.
- Unsupported-supplier discovery uses `activeTab` plus an exact optional HTTPS
  origin requested in the click gesture; the manifest envelope grants nothing at
  install time. Its packaged route planner is same-origin, billing-intent-only,
  GET-navigation-only, capped at 15 pages/depth three/10 seconds interactively
  (45 seconds for the single escalation a fast pass could not resolve, 120
  seconds for background self-repair), and rejects mutating or
  session paths before navigation. Generated recipes remain separately bounded.
- First-party page-context fetching is constrained to the recipe's primary
  origin; response sizes are capped and treated as untrusted input.
- Semantic download actions may return a supplier-authenticated GET response as
  an in-memory PDF only when it is at most 8 MiB and begins with `%PDF`. Collector
  replaces it with a SHA-256-derived internal handle before orchestration and
  never persists or logs the blob, request headers, or authentication values.
  Retained inline documents are capped at 24 MiB and 500 documents across the
  complete DOM run.
- Discovered candidates preflight every scope before delivery. A traversal that
  hits a page/action/document/time cap, repeats state, or leaves an observed item
  unresolved is candidate-local and falls through without fetching or sending
  its PDFs. Completeness is independent of invoice count. PDF bytes are admitted
  by their bounded `%PDF` signature rather than untrusted MIME metadata or
  language-dependent invoice keywords.
- Local and HTTP destination configuration is schema-checked at the message
  boundary; non-local HTTP destinations must use HTTPS.
- Runtime dependencies are minimal; lockfile, Dependabot, tests, validation,
  build, and audit checks are part of release preparation.

## Permissions

Collector requests `storage`, `alarms`, `notifications`, `scripting`,
`downloads`, `activeTab`, observation-only `webRequest`, response-header-only
`declarativeNetRequest`, and `sidePanel` for its persistent UI, plus optional
`tabs` metadata and optional HTTPS host origins. The temporary declarative rule
is scoped to Ratatosk's exact disposable action tab and prevents attachment
responses from becoming global Chrome downloads; Ratatosk never cancels or
deletes existing downloads. Origins are requested at runtime for the exact
supplier sites shown to the user. It declares one narrow content script on the
Igdrasil accounting application for the user-controlled connection handshake.

## Known operational limits

The browser and vendor remain part of the trust boundary. A compromised vendor
page can return malicious data, so all vendor response data must remain bounded
and validated. Vendor API changes can also break a recipe; live pilot verification
is required before claiming support.
