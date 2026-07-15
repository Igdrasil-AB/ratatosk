# Privacy Policy — Ratatosk Invoice Collector

**Effective date:** 2026-07-15

**Provided by:** Igdrasil AB

**Privacy contact:** legal@igdrasil.se

**Address:** Kornhamnstorg 61, 111 27 Stockholm, Sweden

This policy applies to the public **Ratatosk — Invoice Collector** Chrome
extension ("Collector"). It does not apply to the separately built, unpublished
Ratatosk Studio developer tool. A public copy of this policy is available at
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
   to 5,000 de-duplication keys, and a bounded recent ledger of up to 100 collected
   documents in `chrome.storage.local`.

Collector does not collect analytics, advertising identifiers, precise location,
or general browsing history. It does not ask for vendor passwords or two-factor
codes. It does not include the Studio recorder or record browser traffic.

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
`notifications` for expired-session notices, `downloads` for local files, and
`scripting` for a first-party request on vendors that require their billing page
context. Vendor host access is optional and requested separately when the user
connects a vendor. The only always-on page integration is the content script on
`https://accounting.igdrasil.se/*`, used for the Igdrasil connect/disconnect
handshake and the service worker's HTTPS invoice uploads.

Collector does not request `debugger`, `tabs`, `activeTab`, or `<all_urls>`.

## Security

Collector validates destination URLs, requires HTTPS except for an explicitly
configured localhost development destination, restricts the Igdrasil token to
Igdrasil hosts, uses a strict extension content-security policy, and packages all
executable logic with the extension.

## User choices and rights

Users can disconnect a vendor to revoke its optional host access and clear that
vendor's collection history. Users can disconnect Igdrasil to revoke and remove
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
