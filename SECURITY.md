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

- `collector/` builds the consumer extension. It has no recorder code and does
  not request `debugger`, `tabs`, `activeTab`, or all-sites access.
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
| Recipe behavior | Remote code or remotely changed logic | Recipes and transforms are bundled, strict declarative data; Collector fetches neither remote code nor remote recipes; changes require a new reviewed package |
| Connect bridge | A hostile page installing a token or destination | Content script is limited to `https://accounting.igdrasil.se/*`; worker verifies extension id and exact sender origin; backend URL must be HTTPS on `igdrasil.se` or a subdomain; connect requires a short-lived, one-use state created by an explicit Ratatosk or in-app action |
| Extension message bus | Web content issuing privileged commands | Consumer/control messages are accepted only when Chrome reports this extension's id and exact `chrome-extension://<this-id>/` sender URL; content-script senders retain their web URL and are rejected |
| Download paths | Path traversal or unintended overwrite | Folder and filename segments are normalized and tested; local root configuration is validated and bounded |
| Studio capture | A page leaking secrets through headers, URLs, or bodies | Explicit disclosure checkbox; recording limited to the active HTTP(S) tab; auth/cookie/API-key headers dropped; URL credentials/query values and secret-like body fields redacted; state stays in session storage and is cleared on startup |
| Studio relay | A page fabricating entries for another recording | Per-session nonce, same-window relay checks, active recording-tab check, and worker-side entry rebuilding |
| Studio fingerprint outbox | Captured account data being retained or delivered without informed approval | A strict structural projection excludes bodies, headers, fixtures, query values, and invoice values; the exact preview requires authority and share confirmation; local retention is capped at 20 items and 30 days; no delivery endpoint is configured |

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
- Captured headers, URLs, and bodies are sanitized before Studio persists them:
  `src/core/recorder/cdp.ts` and `test/core/recorder-capture.test.ts`.
- Supplier fingerprints and approval envelopes reject unknown or unsafe fields;
  outbox retention, expiry, and deduplication are tested in
  `test/core/supplier-fingerprint.test.ts` and
  `test/studio/fingerprint-outbox.test.ts`.

## Platform hardening

- Strict MV3 CSP: `script-src 'self'; object-src 'self'`.
- No `eval`, `new Function`, remote scripts, remotely hosted WebAssembly, or
  remote recipe catalog.
- Optional vendor origins requested at connect time and revoked on disconnect.
- First-party page-context fetching is constrained to the recipe's primary
  origin; response sizes are capped and treated as untrusted input.
- Local and HTTP destination configuration is schema-checked at the message
  boundary; non-local HTTP destinations must use HTTPS.
- Runtime dependencies are minimal; lockfile, Dependabot, tests, validation,
  build, and audit checks are part of release preparation.

## Permissions

Collector requests `storage`, `alarms`, `notifications`, `scripting`, and
`downloads`, plus optional per-vendor host origins. It declares one narrow content
script on the Igdrasil accounting application for the user-controlled connection
handshake.

Studio requests `storage`, `scripting`, `debugger`, and `activeTab`. Those broad
authoring capabilities are the reason it is a separate development build.

## Known operational limits

The browser and vendor remain part of the trust boundary. A compromised vendor
page can return malicious data, so all vendor response data must remain bounded
and validated. Vendor API changes can also break a recipe; live pilot verification
is required before claiming support.
