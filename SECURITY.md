# Security

Invoice Collector reads authenticated billing pages and holds a backend session
token, so it is designed defensively. This document is the threat model, the
guarantees the code makes, and how to report a vulnerability.

## Reporting a vulnerability

Please report privately via a [GitHub security advisory](../../security/advisories/new)
rather than a public issue. We aim to acknowledge within 72 hours.

## What the extension can and cannot do

**Single purpose.** Collect a user's own supplier invoices and receipts into
their accounting backend. The recorder ("Studio") is an authoring aid for that
same purpose; it is not a general-purpose network-debugging tool.

**Zero credential custody.** The extension never sees, stores, or transmits
vendor passwords or 2FA. It rides the session the user already has: requests use
`credentials: "include"`, so the browser attaches the user's existing cookies and
the extension never handles them. There is no credential vault to breach.

## Assets and threat model

| Asset | Threat | Mitigation |
|---|---|---|
| Backend session token (JWT) | Read from disk; read by a content script or a compromised dependency; sent to a foreign host | Stored in `chrome.storage.session` (in-memory, trusted-contexts only), never `.local`; only ever sent to an allow-listed backend host over https (`http-sink.ts`); never logged or written into a recipe/report |
| Vendor session cookies | Exfiltration via capture or replay | `cookie`/`set-cookie` are dropped from every captured request/response; the extension never reads cookies |
| Vendor bearer tokens | Written into a shareable recipe/report | Used only to trace a request's source during inference; never written into recipes, reports, or fixtures; the "Copy for agent" report is redacted as a backstop |
| The hot-loaded recipe catalog | A recipe smuggling executable behavior ("remote interpreter") | Recipes are frozen declarative data — closed transform enum, `.strict()` schema, bounded+compiled patterns, capped pipelines (`src/core/schema.ts`); a recipe can only select/parametrize in-package logic |
| The accounting backend | A forged "connect" from a hostile page | `externally_connectable` is locked to `https://accounting.igdrasil.se/*`; the service worker re-validates `sender.origin` and only accepts a token for an `*.igdrasil.se` https backend |
| The recorder capture | A hostile page injecting fabricated entries | Capture is user-initiated; the relay forwards only same-window messages carrying a per-session nonce; the service worker drops entries from any tab that isn't the recording one; the debugger backend is the high-integrity path |

## Guarantees enforced in code (with tests)

- **Recipes are data, never code** — `src/core/schema.ts`, locked by `test/core/recipe-freeze.test.ts`.
- **The token never reaches a non-allow-listed host** — `src/ingest/http-sink.ts`, locked by `test/core/http-sink-security.test.ts`.
- **The agent report carries no secrets** — `src/core/recorder/report.ts`, locked by `test/core/report-redact.test.ts`.
- **Download paths can't traverse out of the folder** — `src/platform/filesystem-sink.ts`, locked by `test/core/filesystem-traversal.test.ts`.

## Hardening posture

- **CSP.** Strict MV3 policy (`script-src 'self'; object-src 'self'`) — no remote
  scripts, no `eval`/`new Function`; all logic ships in the package.
- **MAIN-world injection** is scoped to a connected vendor's primary origin, sends
  only that origin's own auth, treats returned data as untrusted, and caps
  response size.
- **Supply chain.** Runtime dependencies are kept minimal (currently `zod`);
  Dependabot and an advisory `npm audit` run in CI; the lockfile is committed.
- **Least privilege.** Vendor hosts are optional permissions requested at
  connect-time, not broad `<all_urls>` access.

## Permissions, briefly

`debugger` (recorder capture, user-initiated, detaches immediately), `scripting`
(first-party fetch on the vendor's own page), `downloads` (save invoice PDFs),
`storage`/`alarms`/`notifications` (settings, sync schedule, reconnect nudges),
`activeTab`/`tabs` (act on the tab being recorded). Vendor origins are optional
and requested per vendor.
