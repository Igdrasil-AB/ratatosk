# Privacy Policy — Invoice Collector

> **DRAFT for owner review.** Fill the `‹…›` placeholders (legal entity, contact
> email, effective date) and publish this at a stable public URL (e.g. GitHub
> Pages), then put that URL in the Chrome Web Store listing.

**Effective date:** ‹YYYY-MM-DD›
**Provided by:** ‹legal entity / maintainer name›
**Contact:** ‹privacy contact email›

Invoice Collector ("the extension") is a browser extension that collects a user's
own supplier invoices and receipts from vendor billing pages and delivers them to
a destination the user chooses. This policy explains exactly what the extension
does and does not do with data. It is written to match the extension's actual
behavior, which is open source and independently verifiable at ‹repo URL›.

## The short version

- The extension **rides the user's existing browser session**. It **never sees,
  stores, or transmits vendor passwords or 2FA**, and it **never reads cookies**.
- It sends the user's collected invoices **only to the destination the user
  configures** — their own accounting backend or a local Downloads folder.
- It sends **nothing to the extension's authors**. There is **no analytics, no
  telemetry, and no tracking**.
- Data is **not sold, not shared** with third parties, and **not used for any
  purpose other than collecting the user's invoices**.

## What data the extension handles

1. **Invoice and receipt documents and their metadata** — the PDF files and fields
   such as vendor, amount, date, and invoice id. These are fetched from the
   vendors the user connects and delivered to the user's configured destination.
2. **A backend session token** — when the user connects the extension to a backend
   (e.g. Igdrasil), a session token authenticates the upload of the user's
   documents. It is stored in memory (`chrome.storage.session`, cleared when the
   browser closes), is only ever sent to the user's configured backend host, and
   is never logged or written into any recipe or report.
3. **Recording captures (only when the user starts a recording)** — to teach the
   collector a new vendor, the recorder observes the billing page's own network
   traffic. **Cookies and credentials are stripped** from these captures, they are
   held only in memory for the duration of the recording, and they never leave the
   browser except in the recipe draft the user explicitly chooses to share.

The extension **does not** collect browsing history, personal identifiers,
location, or any data unrelated to invoice collection.

## Where data goes

- **To the user's chosen destination only.** With a backend configured, collected
  documents are POSTed to that backend over HTTPS; the session token is sent only
  to that allow-listed host. With no backend, documents are saved to a local
  Downloads folder and nothing is transmitted.
- **Never to the authors or any third party.** The extension contains no analytics
  or third-party SDKs and makes no requests to the authors' servers.

## Storage and retention

- Settings, the connected-vendor list, and a small local history of collected
  invoices are stored in the browser via `chrome.storage.local`.
- The backend session token and any in-progress recording are stored in
  `chrome.storage.session` (in-memory) and cleared when the browser closes.
- **Uninstalling the extension deletes all of its locally stored data.** Documents
  already delivered to the user's backend or saved to disk are governed by that
  destination, not by the extension.

## Vendor sessions

The extension operates within the vendor sessions the user is already logged into,
using standard browser requests. It does not create, store, or manage vendor
credentials. When a vendor session expires, the extension simply notifies the user
to sign in again.

## Permissions

The extension requests only the permissions needed for its single purpose;
each is justified in the store listing. Vendor host access is optional and
requested per vendor at the moment the user connects it — never broad or
all-sites access.

## Limited Use compliance

The extension's use of any data obtained through it complies with the Chrome Web
Store User Data Policy, including the Limited Use requirements. All handled data is
used **solely** to collect and deliver the user's own invoices to the destination
the user configured. The extension does not sell user data, does not use or
transfer it for unrelated purposes, and does not use it to determine
creditworthiness or for lending.

## Children

The extension is a business/productivity tool and is not directed to children.

## Changes to this policy

Material changes will be reflected here with an updated effective date and, where
appropriate, noted in the extension's release notes.

## Contact

Questions or requests: ‹privacy contact email›. Security issues: see
[SECURITY.md](SECURITY.md).
