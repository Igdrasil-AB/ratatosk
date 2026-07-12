import { defineVendor } from "./define";

/**
 * GitHub — the first RECORDER-AUTHORED recipe using the HTML strategy. GitHub's
 * billing history is a server-rendered page (no JSON billing API), so the
 * recorder extracted the receipt LINKS from the page instead of a JSON array.
 *
 * Each billing row links to `/account/receipt/ch_…` (which serves the PDF
 * directly) and often a `…/ch_….pdf` variant too — so the `id` strips a trailing
 * `.pdf`/query to download each receipt ONCE. Amount and date aren't in the row
 * markup; the accounting pipeline reads them from each downloaded PDF.
 *
 * ⚠️ LIVE-TEST caveats (auth/fetch can't be verified without a logged-in session):
 *   • If a Sync returns 0 invoices, the billing page is likely rendered
 *     client-side — add `fetchContext: "page"` so it's fetched first-party in a
 *     tab (and if that still yields nothing, it needs the DOM strategy).
 *   • The auth check follows redirects, so a logged-out fetch lands on the login
 *     page (200) and simply yields 0 receipts rather than prompting a reconnect.
 */
const BILLING_HISTORY = "https://github.com/account/billing/history";

export default defineVendor({
  id: "github",
  name: "GitHub",
  homepage: "https://github.com",
  category: "developer",
  icon: "github",
  hosts: ["https://github.com/*"],
  notes: "Recorder-authored (HTML strategy). Receipt links scraped from the billing history page; PDFs served at /account/receipt/ch_….",

  auth: {
    // The billing page load is the login check — a 200 means the session is alive.
    check: { request: { url: BILLING_HISTORY }, expect: { statusIn: [200] } },
    loginUrl: "https://github.com/login",
  },

  invoices: {
    strategy: "html",
    list: {
      request: { url: BILLING_HISTORY },
      // Every receipt link on the page; the id normalizes the `/x` vs `/x.pdf` pair.
      rowRegex: 'href="(?<documentUrl>/account/receipt/[^"]+)"',
      map: {
        id: { path: "documentUrl", transforms: [{ kind: "replace", pattern: "(\\.pdf)?([?#].*)?$", with: "" }] },
        documentUrl: "documentUrl",
      },
    },
    document: { contentType: "application/pdf" },
  },
});
