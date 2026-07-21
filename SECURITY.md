# Security

Ratatosk handles authenticated billing requests and invoice documents, so the
public Collector is deliberately isolated from the development-only Studio.

## Reporting a vulnerability

Please report privately through a
[GitHub security advisory](https://github.com/Igdrasil-AB/ratatosk/security/advisories/new)
instead of opening a public issue. We aim to acknowledge reports within 72 hours.

Do not include live credentials, invoice documents, or unredacted Studio output
in a report unless a maintainer has provided a secure transfer method.

## Release boundaries

- `collector/` builds the consumer extension. It has no debugger/CDP recorder and
  does not request `debugger`, cookies, or persistent access to every site. Its
  optional `tabs` metadata permission is user-enabled only to follow active-tab
  changes in the persistent side panel. It uses `activeTab`, optional HTTPS
  origins, and a bounded ephemeral page-load observer only during explicit app discovery.
- `studio/` builds a development tool with `debugger`. It must not be submitted
  or distributed as the consumer Collector.
- `src/` contains shared, platform-independent logic. It cannot call Chrome APIs.

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
| Local supplier discovery | A hostile page creates an over-broad or secret-bearing recipe, spoofs a supplier, or causes silent downloads | Discovery starts only from a user click on the active HTTPS tab; runtime permission is requested for the exact origin; exploration is capped at 15 pages, depth three, and 30 seconds; it uses at most two inactive tabs, matches billing intent anywhere in same-origin paths, preserves only a narrowly shaped tenant prefix, denies action/session paths, performs GET search navigation without clicks or forms, and closes the tabs; a dynamically registered exact-origin document-start observer captures only bounded sanitized JSON fetch/XHR evidence in memory and restores page APIs/unregisters in `finally`; only a closed allowlist of bounded static query controls is replayed while identifiers, signatures, credentials, and unknown values stay redacted; invoice/detail routes remain search inputs and only explicit PDF/download-shaped links or controls become candidates; probes are size bounded and ephemeral; at most three proof-ranked candidates share one identity and no more than eight exact origins; generated profiles reject arbitrary headers/bodies, mutating methods, broad/private hosts, token exchange, arbitrary selectors/clicks, and credential-like stored URL values except one bounded account identifier required by an explicit billing path; the sole POST exception is a bounded JSON GraphQL operation beginning with explicit `query`, with mutations, subscriptions, extensions, and secret-like variables rejected; after explicit Connect & Collect, every click-capable or continuation run uses a disposable tab, may first reveal one exact invoice/receipt-history tab-like section, and may then activate only visible enabled download-labelled controls in invoice-shaped context while rejecting payment/purchase/cancellation/deletion/logout/form actions; fetch, XHR, beacon, popup, navigation, and form mutation guards remain installed until that tab closes; actual PDF validation occurs before admission and candidate-local failure falls through without masking global auth, permission, rate-limit, or destination failures; continuation may follow exact-origin pagination URLs, localized visible recognized Next/Load More controls near the invoice region, or scroll within hard action/document/time caps; inline PDFs are capped per document and across the complete DOM run; ephemeral cursors are not stored or logged; the domain stays visible; documents stream one at a time, accepted deliveries gain durable dedup evidence before discovery admission, and a profile is retained only after the destination accepts a real PDF |
| Connect bridge | A hostile page installing a token or destination | Content script is limited to `https://accounting.igdrasil.se/*`; worker verifies extension id and exact sender origin; backend URL must be exactly `https://accounting.igdrasil.se`; connect requires a short-lived, one-use state created by an explicit Ratatosk or in-app action |
| Extension message bus | Web content issuing privileged commands | Consumer/control messages are accepted only when Chrome reports this extension's id and exact `chrome-extension://<this-id>/` sender URL; content-script senders retain their web URL and are rejected |
| Download paths | Path traversal or unintended overwrite | Folder and filename segments are normalized and tested; local root configuration is validated and bounded |
| Studio capture | A page leaking secrets through headers, URLs, or bodies | Explicit disclosure checkbox; recording limited to the active HTTPS tab; all request-header values are dropped except normalized `content-type`; auth is represented only by a bounded scheme/header-name marker; URL credentials/query values and secret-like body fields are redacted; state stays in session storage and is cleared on startup |
| Studio relay | A page fabricating entries for another recording | Per-session nonce, same-window relay checks, active recording-tab check, and worker-side entry rebuilding |
| Studio fingerprint outbox | Captured account data being retained or delivered without informed approval | A strict structural projection excludes bodies, headers, fixtures, query values, and invoice values; canonical origins and traversal-free patterns are enforced; the exact preview requires authority and share confirmation; local retention is capped at 20 items with 30-day validity; delivery is explicit-only to the fixed `https://svala.igdrasil.se/api/dev/ratatosk/fingerprints` endpoint under Studio's sole Svala host permission, using an extension-local scoped token, no cookies/referrer, redirect refusal, and fingerprint-ID idempotency; startup never delivers pending or retryable records |
| Collector diagnostics | Error export leaking supplier or accounting data | Diagnostics are an explicit user action and contain only a stable vendor ID/code, package and lifecycle revisions, bounded counts, and normalized timestamps; stored error strings, URLs, headers, bodies, invoice IDs, company IDs, and tokens are excluded by construction |
| Discovery diagnostics | Search evidence leaking account paths or invoice data | Failure diagnostics are explicit-copy, session-only structural summaries containing bounded page/evidence/candidate counts, candidate numbers, packaged adapter outcome codes, hostnames, and route templates whose opaque segments are replaced by `:id` or `:segment`; origins, raw paths, queries, fragments, headers, bodies, tokens, account/invoice identifiers, and financial values are never included |

## Security invariants enforced by tests

- Recipe shapes reject unknown behavior: `src/core/schema.ts` and
  `test/core/recipe-freeze.test.ts`.
- Tokens cannot follow an arbitrary HTTP sink:
  `src/ingest/http-sink.ts` and `test/core/http-sink-security.test.ts`.
- Studio reports redact secrets and omit captured HTML bodies:
  `src/core/recorder/report.ts` and `test/core/report-redact.test.ts`.
- Download paths cannot escape the configured folder:
  `collector/src/platform/filesystem-sink.ts` and
  `test/core/filesystem-traversal.test.ts`.
- Captured header values are allowlisted, authentication structure is value-free,
  and URLs and bodies are sanitized before Studio persists them:
  `src/core/recorder/cdp.ts` and `test/core/recorder-capture.test.ts`.
- Supplier fingerprints and approval envelopes reject unknown or unsafe fields;
  outbox retention, expiry, and deduplication are tested in
  `test/core/supplier-fingerprint.test.ts` and
  `test/studio/fingerprint-outbox.test.ts`.

Manual submission envelopes record the contributor's assertion; they are not
cryptographic signatures. Origins and schema names can still reveal tenant or
internal naming and must be inspected before approval. Approved JSON belongs in
private Svala, not in public issues, commits, or pull-request attachments.
Public supplier requests must also omit tenant-, workspace-, account-, customer-,
employee-, and internal-specific origins even when no fingerprint is attached.

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
  GET-navigation-only, capped at 15 pages/depth three/30 seconds, and rejects mutating or
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
`downloads`, `activeTab`, observation-only `webRequest`, and `sidePanel` for its
persistent UI, plus optional `tabs` metadata and optional HTTPS host origins. Origins are
requested at runtime for the exact supplier sites shown to the user. It declares
one narrow content script on the Igdrasil accounting application for the
user-controlled connection handshake.

Studio requests `storage`, `scripting`, `debugger`, and `activeTab`. Those broad
authoring capabilities are the reason it is a separate development build.

## Known operational limits

The browser and vendor remain part of the trust boundary. A compromised vendor
page can return malicious data, so all vendor response data must remain bounded
and validated. Vendor API changes can also break a recipe; live pilot verification
is required before claiming support.
