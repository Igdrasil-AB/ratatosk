/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  COPY ME to add a new vendor.                                             │
 * │                                                                          │
 * │  1. Copy this file to `src/vendors/<your-vendor>.ts`.                     │
 * │  2. Open the vendor's billing/invoices page with DevTools → Network.     │
 * │  3. Find the XHR/fetch that returns the invoice *list* as JSON. That URL  │
 * │     and its response shape drive `invoices.list`.                        │
 * │  4. Find how a single invoice PDF is fetched. That drives                │
 * │     `invoices.document`.                                                 │
 * │  5. Find a cheap authenticated endpoint for `auth.check` (often the      │
 * │     "current user" / "me" call the app makes on load).                   │
 * │  6. Record one real list response as a fixture and write a test          │
 * │     (see `test/vendors/slack.test.ts`). CI requires it.                  │
 * │  7. Register it in `src/vendors/index.ts`.                               │
 * │                                                                          │
 * │  Full walkthrough: docs/adding-a-vendor.md                              │
 * └─────────────────────────────────────────────────────────────────────────┘
 */
import { defineVendor } from "./define";

export default defineVendor({
  id: "example", // lowercase kebab-case; used in `source` ("ext:example") and dedup keys
  name: "Example Inc.",
  homepage: "https://example.com",
  category: "cloud", // freeform grouping for the UI

  // Every host the recipe touches needs a match pattern here. The manifest's
  // host permissions are generated from these, and requested incrementally when
  // the user connects this vendor — so keep the list tight.
  hosts: ["https://api.example.com/*"],

  notes:
    "ILLUSTRATIVE placeholder. Replace every endpoint below with values captured " +
    "from the live dashboard, then delete this note.",

  auth: {
    // A cheap authenticated request. If `expect` holds, the session is alive; if
    // not, the user is prompted to reconnect. Prefer a small "me"/"session" call.
    check: {
      request: { url: "https://api.example.com/v1/me" },
      expect: { statusIn: [200] },
      // Or assert on the body:
      // expect: { and: [{ statusIn: [200] }, { jsonPath: "user.id", exists: true }] },
    },
    // Where to send the user to log in when the session has expired.
    loginUrl: "https://example.com/login",
  },

  // OPTIONAL: only for vendors scoped per workspace/team/account. Each discovered
  // value becomes the `{id}` template variable, producing one run per value.
  // config: [
  //   {
  //     id: "team",
  //     discover: {
  //       request: { url: "https://api.example.com/v1/teams" },
  //       items: "teams",
  //       value: "slug",
  //       label: "name",
  //     },
  //   },
  // ],

  invoices: {
    strategy: "network",

    // How to enumerate invoices. `items` is the path to the array; `map` reads
    // each element. Paths are dotted (`data.invoices`), transforms are optional.
    list: {
      request: { url: "https://api.example.com/v1/billing/invoices" },
      items: "invoices",
      map: {
        id: "id",
        issuedAt: { path: "created", transforms: [{ kind: "date" }] },
        total: { path: "amount_due", transforms: [{ kind: "divide", by: 100 }] }, // cents → "12.34"
        currency: { path: "currency", transforms: [{ kind: "trim" }] },
        documentUrl: "invoice_pdf", // if the list already gives a direct PDF link, use it
      },
      // paginate: { cursor: "pageInfo.endCursor", hasMore: "pageInfo.hasNextPage", maxPages: 20 },
      // Or: { kind: "next-url", nextUrl: "links.next", maxPages: 20 }
      // Or: { kind: "link-header", maxPages: 20 }
      // Or: { kind: "page", hasMore: "has_more", pageSize: 50, maxPages: 20 }
      // Or: { kind: "offset", step: 50, hasMore: "has_more", pageSize: 50, maxPages: 20 }
    },

    // How to fetch the PDF for one invoice. If the list exposed `documentUrl`,
    // you can omit `request` and the engine fetches that URL directly.
    document: {
      // request: { url: "https://api.example.com/v1/billing/invoices/{id}/pdf" },
      contentType: "application/pdf",
      // filename: "{vendorId}-{issuedAt}-{vendorInvoiceId}.pdf", // this is the default
    },
  },
});
