# Testing a vendor live

Fixture tests prove mapping and engine behavior. They cannot prove that a current
vendor endpoint, browser auth flow, or bot-protection rule still works. Complete
this test before naming a vendor as supported in a release.

Use a dedicated vendor test account with synthetic, non-sensitive invoices. Do
not use a personal account, customer account, production token, or real financial
document in screenshots, logs, fixtures, or issue reports.

## 1. Build and load Collector

```bash
npm run ci
npm run build:collector
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and
select `dist/collector`.

Confirm the loaded manifest has `activeTab`, observation-only `webRequest`, and
optional (not install-time) `tabs` metadata access, but no `webRequestBlocking`,
`debugger`, cookies, or `<all_urls>` permission. Its optional HTTPS host envelope must grant no site
access until an exact origin is approved. Do not load `dist/studio` for the
consumer test.

## 2. Choose a destination

Collector intentionally has no default destination and will reject a vendor
connection until one is confirmed.

- For a local test, choose the Downloads destination and a dedicated Ratatosk test
  folder. The documents will be written to disk.
- For an Igdrasil test, use the connect flow on
  `https://accounting.igdrasil.se` and a dedicated test company.

There is no dry-run fallback: a successful run delivers documents to the selected
destination.

## 3. Connect and exercise the vendor

Open the popup and connect the vendor.

1. Review and grant only the vendor host prompt.
2. Sign in to the dedicated test account in the same Chrome profile.
3. Run collection and confirm exactly the expected synthetic documents arrive.
   For a paginated supplier, verify cursor, numbered-page, Next/Load More, or
   infinite-scroll continuation reaches every expected document within its cap.
   Confirm the run uses a disposable tab and does not navigate or scroll an
   already-open supplier tab.
4. Run again and confirm those documents are not duplicated.
5. Sign out of the vendor and run again; confirm `Reconnect` and the notification.
6. Disconnect the vendor and confirm Chrome revoked its optional host permission.

For an unsupported supplier, open its signed-in home or billing page and select
**Search This App**. Confirm Chrome names only that exact site, the active tab is
not navigated/reloaded/scrolled/closed, and an inactive tab replays the exact
entry once after the `document_start` observer is registered. The remaining
inactive probes must stay within the selected global page/time budget and close
afterward. For a fixture that withholds its invoice table while
`document.visibilityState` is hidden, confirm only the highest-ranked billing
route receives one bounded foreground lease, the prior tab is restored, and a
manual user tab switch during the lease is never overridden. Connect the
resulting semantic candidate and confirm verification keeps its disposable tab
visible until controls are enumerated and document captures finish, then
restores the prior tab before cleanup. Saturate the entry
page with at least nine billing-shaped links and
confirm a contextual/common route is still among the first three probes. Include
an exact-origin opaque route such as `/app/section/42` labelled `Invoices` and
confirm it is explored; the same path without semantic billing evidence must be
ignored. Include a tenant URL such as `/<workspace-id>/home` and confirm
`/<workspace-id>/settings/billing` is the first contextual fallback. Include
`/dashboard/org/opaqueorganization/billing` and confirm the exact organization
prefix is retained; `/dashboard/arbitrary/billing` must not become a tenant
prefix. Verify an
observed `Workspace settings` route survives as a lower-confidence bridge, and
that a generic task/export PDF outside invoice context does not compile a
candidate or consume the search deadline. The preview must show the supplier domain and possible-document count
without downloading. For an SPA fixture, issue an invoice-list fetch/XHR during
page startup and verify a GET API and an explicit read-only GraphQL POST can both
produce a network candidate through cold replay. Seed generic hydration JSON
before a delayed invoice response and confirm hydration does not end the probe
early. Verify approved static controls such as
`limit=100&status=paid`
survive replay while account identifiers, tokens, signatures, and unknown query
values remain redacted.
A GraphQL mutation or arbitrary POST must not produce a network candidate.
**Connect & Collect** asks for the bounded union of any
additional exact document hosts. Verify the first structurally valid but
non-PDF candidate falls through to the next ranked candidate. Test both direct
links and an explicit download button without an `href`; search must not click
the button, while Connect & Collect may activate it. Add an invoice table whose
Actions column uses unlabeled `receipt`, `scroll-text`, or `file-text` SVG icons:
the document actions must be retained, while a `Paid` status button and the same
icons outside an invoice-shaped row must be rejected. Paginate that table with
identical action icons on every page and confirm row changes prove advancement.
Also test a billing page
whose invoice rows appear only after selecting an `Invoices` tab: verification
must reveal that exact tab in its disposable page, then collect every row's
download control. A single resolved invoice must be accepted when traversal
reaches an explicit/stable end. Conversely, a non-empty API or DOM result that
hits its page/action/document/time cap, repeats its continuation state, or leaves
an observed download unresolved must be reported as `retrieval_incomplete`; it
must fetch and deliver zero documents before the next retained candidate runs.
Serve a `%PDF` body as `application/octet-stream` and with stale MIME metadata and
confirm it is accepted and normalized to `application/pdf`; serve an HTML login
page as a PDF and confirm it is rejected. No assertion may require invoice text
or invoice keywords inside the PDF. A provisional supplier may
appear only after at least one valid PDF reaches the selected destination. Denial,
an HTML login response, or a site with no candidates must save no supplier. On
failure, **Copy Diagnostic** must contain only structural counts (including
`observedRequests` versus `replayedRequests`), candidate
number, packaged adapter/outcome codes, closed verification stage/cause codes,
optional HTTP status/content-type families, completed retrieval proof, and
hostnames—never page URLs, selectors, free-form errors, queries,
headers, bodies, tokens, identifiers, or financial values. Disconnect the
provisional supplier and confirm its local profile and host access are gone. The
diagnostic must identify `page_cap`, `time_cap`, `queue_exhausted`,
`coverage_incomplete`, `candidate_primary_found`, or `candidate_set_complete`;
include the Collector/discovery-engine version; distinguish attempted/exhausted
families from unavailable families; and
contain only bounded timings.

## 4. Inspect extension logs safely

Open the Collector service-worker console from `chrome://extensions`. Confirm the
typed outcome and HTTP status without copying response bodies or tokens. Redact
account ids, invoice ids, URLs, and financial fields before attaching logs to an
issue.

## 5. Verify persistence and failure behavior

- Turn the schedule off, restart Chrome, and confirm it remains off.
- Deny a host prompt and confirm the vendor remains disconnected.
- Disconnect Igdrasil and confirm the destination clears; another vendor must not
  run until a destination is selected again.
- Simulate a destination failure and confirm the invoice is retried rather than
  marked collected.
- Simulate one failed account scope beside one successful scope and confirm the
  popup says `partial`, including only bounded failed/empty scope counts.
- Simulate HTTP 429 and confirm automatic and manual runs remain skipped until
  the persisted per-vendor eligibility time; another vendor must still run.
- Use **Copy diagnostic** on a non-OK vendor and inspect the JSON. It may contain
  only vendor ID, Collector/lifecycle revisions, stable outcome code, timestamps,
  counts, closed verification stage/cause codes, HTTP status/content-type
  families, hostnames, and privacy-safe route templates with opaque segments shown
  as `:id` or `:segment`—never origins, raw paths, queries, fragments, headers,
  bodies, selectors, free-form error messages, invoice/company IDs, or tokens.

## 6. Record the verification

Record the Chrome version, Ratatosk commit and package checksum, vendor name,
test date, destination mode, and pass/fail for fetch, download, de-duplication,
expired-session handling, and disconnect. Do not record secrets or actual invoice
content.

After storing the private test record, update `src/vendors/lifecycle.ts` using
only a sanitized `pr:`, `release:`, or opaque `receipt:` reference. Set the next
review date according to the release policy and run `npm run validate:release`.
The public manifest is release metadata, not a place for captured evidence.

Pull-request CI invokes that same validator without a special bypass flag.
Bundled pilot recipes may run with empty or stale attestation metadata, while
explicit health holds, experimental recipes, malformed metadata, and unsupported
public capabilities still fail validation.

CI builds and packages Collector as an ephemeral packaging smoke test but does
not upload or retain that ZIP. A distributable artifact must come from the
reviewed `release:collector` path.

The full pre-release flow is in `store/release-checklist.md`.
