import { defineVendor } from "./define";

/**
 * Vercel — single-scope (the personal account) plus a constructed PDF endpoint,
 * a good example of `document.request` building the fetch from the invoice id
 * rather than a direct URL in the list.
 *
 * ⚠️ ILLUSTRATIVE: verify endpoints against the live dashboard before relying on
 * them. See docs/adding-a-vendor.md.
 */
export default defineVendor({
  id: "vercel",
  name: "Vercel",
  homepage: "https://vercel.com",
  category: "hosting",
  icon: "vercel",
  hosts: ["https://vercel.com/*", "https://api.vercel.com/*"],
  notes: "Illustrative endpoints — verify against the live dashboard billing page.",

  auth: {
    check: {
      request: { url: "https://vercel.com/api/www/user" },
      expect: { and: [{ statusIn: [200] }, { jsonPath: "user.id", exists: true }] },
    },
    loginUrl: "https://vercel.com/login",
  },

  invoices: {
    strategy: "network",
    list: {
      request: { url: "https://vercel.com/api/billing/invoices?limit=100" },
      items: "invoices",
      map: {
        id: "id",
        issuedAt: { path: "created", transforms: [{ kind: "date" }] },
        total: { path: "total", transforms: [{ kind: "divide", by: 100 }] },
        currency: "currency",
        documentRef: "id",
      },
    },
    document: {
      request: { url: "https://vercel.com/api/billing/invoices/{documentRef}/pdf" },
      contentType: "application/pdf",
    },
  },
});
