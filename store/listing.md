# Chrome Web Store listing — Invoice Collector

> **DRAFT.** Fill the `‹…›` placeholders (developer/legal entity, contact email,
> the published privacy-policy URL) before submitting. Copy each section into the
> matching field of the Developer Dashboard. Per-permission justifications go in
> the **Privacy practices** tab.

---

## Product name
Invoice Collector

## Summary (short description — max 132 characters)
Automatically collect your own supplier invoices and receipts from vendor billing pages — using your existing session, no passwords.

## Category
Workflow & Planning

## Language
English (add localized listings later)

---

## Detailed description

**Stop logging into a dozen portals every month to download PDFs.**

Invoice Collector gathers your supplier invoices and receipts for you — from the
vendors you already use — and drops them into your accounting backend or a
Downloads folder, on a schedule, in the background.

**It uses the session you already have.** When you connect a vendor, the
extension calls that vendor's *own* billing page the same way your browser does,
using the login you're already signed in with. That means:

- **Your passwords never leave your machine.** The extension never sees, stores,
  or transmits vendor passwords or 2FA codes. There's no credential vault to
  breach — it simply rides your existing session.
- **It survives redesigns.** Instead of scraping fragile page layouts, it reads
  each vendor's structured billing data, so it keeps working when a vendor
  restyles their dashboard.

**Teach it a new vendor in one click.** The built-in recorder watches a vendor's
billing page while *you* are on it and writes a reusable "recipe" so the
collector can fetch from that vendor going forward. The recorder only runs when
you explicitly click **Record**.

> **A note on the recorder:** while recording, Chrome shows a banner reading
> *"Invoice Collector started debugging this browser."* That's Chrome's standard
> notice for the API the recorder uses to read the billing page you're viewing.
> It appears only during a recording you start, and the extension detaches as
> soon as capture ends. Nothing is captured unless you press Record.

**Open source.** The full code is public — every recipe is plain, reviewable
data, and there's no hidden logic. ‹repo URL›

### What it does
- Fetches invoices/receipts from connected vendors on a schedule you control
- Saves them to your accounting backend or a local Downloads folder
- De-duplicates so each invoice is collected once
- Notifies you when a vendor needs you to sign in again

### What it does NOT do
- It does not store your vendor passwords or 2FA
- It does not read your cookies
- It does not sell or share your data, or send anything to the extension's authors
- It does not track your browsing

---

## Single purpose (Privacy practices tab)

Invoice Collector has one purpose: **to collect a user's own supplier invoices
and receipts from vendor billing pages and deliver them to the user's chosen
accounting backend or local folder.** The recorder is an authoring aid for that
same purpose — it lets the user teach the collector how to read a new vendor — and
is not a general-purpose debugging tool.

---

## Per-permission justifications (Privacy practices tab)

**debugger** — Used only during a user-initiated "Record" action to read the
invoice/receipt data from the billing page the user is viewing, so the extension
can author a reusable recipe for that vendor. It attaches on an explicit click and
detaches immediately when recording ends. No code is injected or executed on the
page, and captured data never leaves the user's session except the recipe draft
the user chooses to share.

**scripting** — Runs a small first-party fetch in the vendor's own page context to
retrieve the user's invoices, matching how the vendor's billing page loads them
(required for vendors behind bot protection). Injected only on vendor origins the
user has connected.

**downloads** — Saves the user's fetched invoice and receipt PDFs.

**activeTab** — Lets the recorder capture on the tab the user is actively
recording, without broad host access.

**tabs** — Used to identify and manage the vendor tab during a recording or a
first-party fetch.

**storage** — Stores the user's settings, connected-vendor list, and a small local
history of what has been collected.

**alarms** — Runs the scheduled background sync at the interval the user chooses.

**notifications** — Tells the user when a vendor session has expired and needs a
re-login.

**Host permissions (optional, per vendor)** — Each vendor host is requested only
when the user connects that vendor, and maps to that vendor's billing endpoint.
The extension requests no broad or all-sites host access.

---

## Data usage disclosures (Privacy practices tab)

**Data handled:** the user's invoice/receipt documents and their metadata
(vendor, amount, date, invoice id); the user's backend session token (used only to
authenticate uploads to the user's own backend); and, during a user-initiated
recording, the billing page's own network traffic (with cookies and credentials
stripped).

**Certifications (all true for this extension):**
- ☑ I do not sell or transfer user data to third parties, outside of the approved use cases
- ☑ I do not use or transfer user data for purposes unrelated to the item's single purpose
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes

**Limited Use.** All data the extension handles is used solely to collect and
deliver the user's own invoices to the destination the user configured. See the
privacy policy.

**Privacy policy URL:** ‹published URL of PRIVACY.md›

---

## Assets checklist (before submission)
- [ ] Icon 128×128 (have: `public/icons/128.png`)
- [ ] At least 1 screenshot 1280×800 or 640×400 (popup: home, connect, record)
- [ ] Small promo tile 440×280 (optional)
- [ ] Privacy policy hosted at a public URL
- [ ] Developer account: $5 paid, DSA trader details verified
- [ ] Submit as **Unlisted** first for a pilot, then flip to Public
