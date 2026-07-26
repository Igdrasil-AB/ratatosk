# Chrome Web Store listing — Ratatosk Invoice Collector

This copy describes only the artifact produced by `npm run package:collector`.
Do not upload a repository archive or any other build output.

## Product details

**Product name:** Ratatosk — Invoice Collector

**Summary (132 characters or fewer):**

Collect your own supplier invoices from billing portals using your existing browser session—no passwords stored.

**Category:** Workflow & Planning

**Language:** English

## Detailed description

Ratatosk collects your own supplier invoices and receipts from vendor
billing portals and saves them to the destination you choose.

Choose Igdrasil or a local Downloads folder, connect a listed vendor, and
select your schedule. Ratatosk then uses the session already open in Chrome to
request that vendor's billing data, download new documents, and de-duplicate them.
If a supplier is not listed, Find Invoices can check the page you opened and a
small set of same-origin billing-related pages using packaged, read-only adapters.
Ratatosk shows the detected name, domain, candidate count, and exact sites before
it downloads anything. A local provisional supplier is kept only after a valid
PDF is collected. After Connect & Collect, packaged bounded continuation can
enumerate cursor, numbered, Next/Load More, and infinite-scroll invoice lists.

Your vendor passwords and two-factor codes are never requested or stored.
Ratatosk asks Chrome to use your existing vendor session; it does not read cookie
values. If a vendor's own billing page supplies a temporary session token,
Ratatosk holds it only for that collection run, uses it only with that vendor, and
does not persist or log it. If the session expires, Ratatosk asks you to sign in
again.

You stay in control:

- No vendor is connected until you select a destination and approve that
  vendor's host access.
- Vendor access is requested separately and can be revoked by disconnecting.
- The schedule can be set to every 6, 12, or 24 hours, or turned off.
- Igdrasil uploads use HTTPS. Local-download mode does not upload documents to
  Igdrasil.
- There is no analytics, advertising, browsing-history tracking, or sale of data.

Railway is currently available as a bundled pilot. Other suppliers are verified
from their current billing pages through Ratatosk's user-initiated generic
discovery flow, avoiding stale private API paths.

Ratatosk is open source: https://github.com/Igdrasil-AB/ratatosk

### What Ratatosk does

- Fetches invoice and receipt documents from vendors you connect
- Saves new documents to Igdrasil or your local Downloads folder
- Keeps a bounded local history to avoid collecting the same invoice twice
- Notifies you when a vendor session needs attention

### What Ratatosk does not do

- Does not ask for or store vendor passwords or 2FA codes
- Does not read cookie values
- Does not record network traffic or include developer recording tools
- Does not receive access to every site at install time
- Does not download remote code or remote vendor recipes
- Does not track general browsing activity

## Single purpose declaration

Ratatosk has one purpose: to collect a user's own supplier invoices and receipts
from vendor billing portals the user connects and deliver them to the Igdrasil
company or local Downloads folder the user selects.

## Permission justifications

**storage** — Stores the selected destination and schedule, connected-vendor
state, recent collection status, a bounded invoice ledger, and bounded
de-duplication keys. A company-scoped, upload-only Igdrasil token is stored in
extension-local storage so user-enabled background sync survives a Chrome
restart. It expires after 90 days and is revoked and removed on disconnect.

**alarms** — Wakes the Manifest V3 service worker at the interval the user selects
to check connected vendors for new invoices. The user can disable the schedule.

**notifications** — Notifies the user when a connected vendor session has expired
and requires the user to sign in again.

**downloads** — Saves invoice and receipt files to the user's chosen folder under
Chrome Downloads when local-download mode is selected.

**scripting** — Runs a bounded first-party billing request in a connected vendor's
own tab when that vendor rejects an extension service-worker request. It is used
only for the invoice-collection feature and only after the user grants that
vendor's optional host access.

**activeTab** — Lets Ratatosk identify the current HTTPS supplier app after the
user explicitly selects Find Invoices. After exact-origin approval, Ratatosk
checks the active page and at most fourteen additional same-origin billing-related
pages (fifteen total), to depth three. It is not used
to monitor browsing.

**sidePanel** — Keeps the Ratatosk Collector UI open in Chrome's side panel while
the user reviews suppliers, grants access, or downloads invoices. It does not
grant access to page contents or browsing history.

**Optional tabs metadata** — When the user enables tab switching, lets the
persistent side panel identify the current tab URL after moving between tabs.
Ratatosk does not store a browsing history, and this permission does not grant
access to page contents; every supplier origin is still approved separately.

**webRequest** — Observes only the redirect URL and request ID for a document
provider capability URL Ratatosk is already authorized to fetch. This detects
when Stripe moves a PDF to a new exact regional origin so Ratatosk can ask the
user to approve that origin and retry. It does not read request headers, cookies,
or response bodies and cannot block or modify traffic; `webRequestBlocking` is
not requested.

**Optional host permissions** — Requested separately when the user connects a
vendor or selects Find Invoices. The manifest declares an optional HTTPS
envelope so previously unknown suppliers are eligible, but it grants no access at
installation. Runtime prompts request the exact billing and document origins,
which are shown before collection and revoked on disconnect. Ratatosk does not
request `<all_urls>`.

**Content script on `https://accounting.igdrasil.se/*`** — Enables the user to
connect, check, or disconnect Ratatosk from the Igdrasil web application. The
service worker re-validates the exact sender origin and accepts only HTTPS
Igdrasil backend URLs. The same exact-host permission lets the service worker
upload collected invoices; no broader Igdrasil or all-sites pattern is used.

Ratatosk Collector does not request `debugger` or `cookies`. Optional `tabs`
metadata access remains disabled unless the user enables tab switching.

## Data-use disclosures

Data handled by the extension can include:

- **Financial and payment information:** invoice and receipt documents and fields
  such as vendor, invoice id, date, amount, and currency.
- **Authentication information:** an Igdrasil upload token, if Igdrasil is chosen,
  and an ephemeral vendor session token for vendors whose own billing page uses
  one. The Igdrasil token is company-scoped, upload-only, and held in
  extension-local storage; vendor session tokens remain only in memory for one
  collection run. Neither is a vendor password or general Igdrasil login token.
- **Website content:** billing API responses and invoice documents from vendors
  the user explicitly connects.
- **User activity:** connected-vendor status, schedule, and collection history
  needed to provide the feature. Ratatosk does not collect general browsing
  history or analytics.

All data is used solely to collect, de-duplicate, and deliver the user's invoices
to the destination the user selected. Data is not sold, used for advertising,
used for creditworthiness or lending, or transferred for an unrelated purpose.

**Privacy policy URL:**
`https://igdrasil.se/en/privacy/ratatosk/` (confirm the published page contains
this exact policy before submission).

## Submission checklist

### Code and package

- [ ] Run `npm run release:collector` from a clean, reviewed commit.
- [ ] Confirm `npm audit --audit-level=high` reports no vulnerabilities.
- [ ] Verify the ZIP checksum and archive contents.
- [ ] Inspect the ZIP-root `manifest.json`: no `debugger`,
      cookies, `<all_urls>`, `webRequestBlocking`, source maps, or remote scripts;
      `activeTab`, optional `tabs`, and observation-only `webRequest` are present
      only for their documented flows.
- [ ] Load the unpacked `dist/collector` in stable Chrome and complete the manual
      smoke test in `store/release-checklist.md`.
- [ ] Live-test every vendor named in the description with a dedicated pilot
      account containing non-sensitive test invoices.

### Legal and developer account

- [ ] Publish this policy at the stable HTTPS URL entered above.
- [ ] Make support@igdrasil.se and legal@igdrasil.se operational and monitored.
- [ ] Register the Chrome Web Store developer account and pay its one-time fee.
- [ ] Complete account contact, identity, and any applicable trader verification.
- [ ] Verify `igdrasil.se` in Search Console and select it as the official URL.
- [ ] Complete Privacy practices, Distribution, and reviewer Test instructions.

### Listing assets

- [x] 128x128 squirrel extension/store icon: `public/icons/128.png`.
- [ ] At least one 1280x800 screenshot; use real Collector UI and pilot data only.
- [x] 440x280 small promotional tile: `store/assets/ratatosk-small-promo-440x280.png`.
- [ ] Optional 1400x560 marquee promotional tile.
- [ ] Optional YouTube product video.
- [ ] Homepage and support URLs.

### Rollout

- [ ] Submit **Unlisted** first and invite only named pilot testers.
- [ ] Monitor auth failures, vendor endpoint changes, duplicate behavior, and user
      deletion/disconnect requests during the pilot.
- [ ] Remove any vendor claim under an explicit vendor-change or security hold.
- [ ] Move to Public only after review feedback and the pilot exit criteria are met.
