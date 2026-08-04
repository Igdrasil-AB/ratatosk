# Privacy Policy — Ratatosk Invoice Collector

**Effective date:** 2026-07-19

**Provided by:** Igdrasil AB

**Privacy contact:** legal@igdrasil.se

**Address:** Kornhamnstorg 61, 111 27 Stockholm, Sweden

This policy applies to the **Ratatosk — Invoice Collector** Chrome extension
("Collector"), the only extension this project distributes. A
public copy of this policy is available at
https://igdrasil.se/en/privacy/ratatosk/.

## Purpose

Collector has one purpose: to collect a user's own supplier invoices and receipts
from vendor billing portals and deliver them to a destination the user explicitly
selects. Collector does not fetch a vendor until the user has selected either
Igdrasil or a local Downloads folder and connected that vendor.

## Data Collector handles

Collector handles only the data required for that purpose:

1. **Invoice and receipt documents and metadata.** This can include PDF content,
   vendor name, invoice identifier, issue date, amount, currency, and collection
   time. Collector obtains these from vendors the user chooses to connect.
2. **Existing vendor-session requests.** Collector asks Chrome to make requests
   to a connected vendor using the session already present in the browser. Chrome
   may attach that vendor's cookies to the request, but Collector does not read,
   copy, store, or transmit the cookie values. Some vendors expose a temporary
   bearer token to their own billing page; when required, Collector holds that
   value only in run memory and sends it only back to that same vendor. It is not
   persisted or logged.
3. **Igdrasil upload token and company identifier.** If the user connects
   Igdrasil, Collector receives a company-scoped, upload-only token and company
   id from the Igdrasil web application. It never receives the user's general
   Igdrasil login token. The upload token is stored in extension-local storage
   so scheduled collection can continue after Chrome restarts. It expires after
   90 days, is rotated on reconnect, and is revoked and removed on disconnect.
4. **Extension settings and operational history.** Collector stores the selected
   destination, schedule, connected vendors, last-run status, a bounded set of up
   to 20,000 de-duplication keys, and a bounded recent ledger of up to 1,000 collected
   documents in `chrome.storage.local`. If the user connects an unsupported
   supplier through Find Invoices, Collector also stores that supplier's name,
   exact origins, entry page without query/fragment data, and a strict declarative
   extraction profile. An entry-page path may include one bounded non-secret
   supplier account identifier when it is required to return to an explicit
   billing route. It stores no page body, API response, cookie, or header.

During Find Invoices, Collector temporarily inspects the active page and up to
fourteen additional same-origin pages with strong billing or invoice intent, to depth
three. It uses at most four inactive temporary tabs, performs only page navigation
and bounded same-origin GET probes, never clicks controls or submits forms, and
closes the tabs when the search ends. On those temporary pages, a packaged
exact-origin observer may temporarily inspect bounded JSON fetch/XHR responses
and the request structure needed to recognize an explicit read-only
GraphQL query. Credential-named fields, credential-shaped values, and payment
instrument data are removed from that evidence before it is read; where one was
removed, only its field name is kept, so a supplier whose API requires a
short-lived token can be recognized without the token ever being retained. That
token is re-requested from your own signed-in session at the start of each
collection, used only against the site that issued it, and discarded when the
run ends. It is never written to storage. It does not initiate the page's POST requests. Bounded rendered-page snapshots and JSON
evidence stay in memory, are not logged or uploaded, and are discarded after the
packaged adapters produce up to three proof-ranked structural candidates. A
failed search or verification may retain a redacted diagnostic in session storage
for up to 24 hours; it contains only hostnames, counts, candidate numbers,
packaged adapter names, stable outcome codes, and privacy-safe route templates.
Those templates keep recognized billing/navigation words while replacing opaque
tenant, account, workspace, and document segments with `:id` or `:segment`.
They never contain origins, raw paths, queries, fragments, page content, headers,
response bodies, tokens, account or invoice identifiers, or financial values.

After the user confirms **Connect & Collect**, Collector verifies the ranked
candidates by fetching and validating an actual PDF, falling through only when a
candidate shape is invalid or empty. A locally discovered supplier may activate
visible, enabled controls explicitly labelled as invoice/receipt downloads and
may enumerate additional invoice results using the supplier's returned API
cursor or next-page URL, numbered/offset pages, a localized visible recognized
Next or Load More control outside forms, or bounded scrolling. Payment, purchase,
cancellation, deletion, logout, disabled, and form mutation controls are excluded.
These actions use the same exact-origin permission and existing browser session.
When a shared invoice provider such as Stripe moves a document to a new regional
storage origin, Ratatosk may retain that exact origin for permission recovery.
It does not retain the signed document path, query token, redirect headers, or
response body.
Cursor values remain in memory for that collection run and are not stored or
logged. A supplier-generated PDF exposed only through a temporary `blob:` URL is
held in memory for that run, capped at 8 MiB, and replaced with an internal hash
handle before collection; its data URL and request credentials are never stored
or logged.

Collector does not collect analytics, advertising identifiers, precise location,
or general browsing history. It does not ask for vendor passwords or two-factor
codes. It does not record general browser traffic;
the temporary discovery observation described above is limited to the explicit
Find Invoices run and is discarded when that run ends.

## Where data goes

The user chooses one of these destinations before collection:

- **Igdrasil:** invoice documents and metadata are transmitted over HTTPS to the
  Igdrasil API for the company selected by the user. The Igdrasil token is
  restricted in code to HTTPS hosts at `igdrasil.se` or its subdomains. Data
  received by Igdrasil is then governed by the user's agreement with Igdrasil and
  the Igdrasil privacy notice at https://igdrasil.se/privacy/.
- **Local Downloads:** invoice documents are saved to the user-selected folder
  beneath Chrome's Downloads directory. They are not uploaded to Igdrasil.

Collector also communicates directly with each vendor the user connects to fetch
the user's invoices. Those vendors process requests under their own terms and
privacy policies. Collector contains no analytics or advertising SDK and makes no
telemetry request to the extension authors.

We do not sell extension data. We do not use or transfer it for advertising,
creditworthiness, lending, or any purpose unrelated to invoice collection and
delivery.

## Chrome Web Store Limited Use

Collector's use of information received from Google APIs complies with the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including its Limited Use requirements. Collector does not sell or transfer user
data outside approved use cases, use or transfer it for purposes unrelated to
invoice collection and delivery, or use or transfer it to determine
creditworthiness or for lending.

## Storage and retention

- The company-scoped Igdrasil upload token remains in extension-local storage
  until it expires, is rotated, the user disconnects Igdrasil, or the extension
  is uninstalled. Disconnect also revokes the server-side credential.
- Settings, schedule, connections, recent history, and de-duplication keys remain
  in local extension storage until changed, cleared through extension actions, or
  the extension is uninstalled. Chrome removes extension storage on uninstall,
  subject to Chrome's own sync, backup, and device behavior.
- Locally downloaded files remain until the user deletes them.
- Documents delivered to Igdrasil are retained under the user's Igdrasil
  agreement and Igdrasil's applicable retention rules.

## Permissions

Collector uses `storage` for settings and history, `alarms` for the schedule,
`notifications` for expired-session notices, `downloads` for local files,
observation-only `webRequest` to recognize a changed exact redirect origin for a
user-approved shared invoice-provider URL, and
`scripting` for a first-party request on vendors that require their billing page
context, and `activeTab` to identify the supplier app from which the user selects
Find Invoices. Users may separately enable the optional `tabs` metadata
permission so the persistent side panel can identify the active tab after tab
switches. Ratatosk reads only the current tab URL for this UI context, does not
store a browsing history, and this permission does not authorize page inspection.
After exact-origin approval, the bounded search may inspect up
to fourteen additional same-origin billing-related pages. HTTPS supplier access is optional and Chrome
asks for the exact origin when the user connects or tests it. During that explicit
search, `scripting` also installs and removes the bounded exact-origin page-load
observer described above. The optional
manifest pattern allows this explicit flow for previously unknown suppliers but
grants no site access at installation. The only always-on page integration is the content script on
`https://accounting.igdrasil.se/*`, used for the Igdrasil connect/disconnect
handshake and the service worker's HTTPS invoice uploads.

Collector does not request `debugger`, cookies, or `<all_urls>`. The optional
`tabs` metadata permission is disabled until the user enables tab switching.

## Security

Collector validates destination URLs, requires HTTPS except for an explicitly
configured localhost development destination, restricts the Igdrasil token to
Igdrasil hosts, uses a strict extension content-security policy, and packages all
executable logic with the extension.

## User choices and rights

Users can disconnect a vendor to revoke its optional host access while retaining
duplicate protection, or separately choose Forget History to clear that vendor's
local collection history. Users can disconnect Igdrasil to revoke and remove
its upload token and destination configuration, select local Downloads instead,
disable the schedule, or uninstall Collector to remove its local extension data.

For access, deletion, objection, or other privacy questions concerning data sent
to Igdrasil, contact legal@igdrasil.se. Users may also have the right to lodge a
complaint with the Swedish Authority for Privacy Protection (IMY).

## Children

Collector is a business productivity tool and is not directed to children.

## Changes

Material changes will be published here with a new effective date and, where
appropriate, described in extension release notes.

## Contact

Privacy questions: legal@igdrasil.se

General support: support@igdrasil.se

Security reports: security@igdrasil.se
