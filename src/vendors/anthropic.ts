import { defineVendor } from "./define";

/**
 * Anthropic (Claude) — subscription invoices from claude.ai.
 *
 * Endpoints CAPTURED from claude.ai billing on 2026-07-12 (DevTools):
 *   list:  GET https://claude.ai/api/stripe/{org}/invoices?limit=&page=
 *          → { invoices: [...], has_more, next_page }
 *          cookie-authenticated (sessionKey=sk-ant-sid… cookie).
 *   pdf:   each invoice carries `invoice_pdf_url` (pay.stripe.com/…/pdf?s=ap),
 *          a Stripe capability URL — the `?s=ap` token IS the credential, so it
 *          downloads without a Stripe login. It is re-signed on every list call,
 *          which is why we dedup on `created_ts`, not the URL.
 *
 * VERIFIED (from captures + tests): the invoice → ref mapping AND org discovery
 *   — GET /api/organizations returns a top-level array of orgs each with a
 *   `uuid`. An account can hold several orgs with different billing (e.g. an
 *   `api_evaluation` org and a `stripe_subscription` org); this recipe enumerates
 *   ALL of them and pulls invoices per org. An org without a Stripe subscription
 *   returns 403 on its invoices endpoint — that scope is skipped (a 403 is a
 *   per-scope "not allowed", NOT a dead session), and the others still collect.
 *   See anthropic.integration.test.ts.
 *
 * NOT yet verified live:
 *   • cross-origin replay — claude.ai sits behind Cloudflare (cf_clearance).
 *     A background service-worker fetch is cross-origin; if Cloudflare/Origin
 *     checks reject it, run this recipe's requests from a content script inside
 *     a claude.ai tab (first-party context). That's a platform concern, not a
 *     recipe change. Adding an `anthropic-client-platform: web_claude_ai` header
 *     may also be required.
 */
export default defineVendor({
  id: "anthropic",
  name: "Anthropic (Claude)",
  homepage: "https://claude.ai",
  category: "ai",
  icon: "anthropic",
  hosts: [
    "https://claude.ai/*",
    "https://pay.stripe.com/*",
    "https://invoice.stripe.com/*",
    "https://files.stripe.com/*",
    // The pay.stripe.com PDF 302-redirects to a presigned Amazon S3 URL; the
    // extension needs read permission for that host to follow it (S3 sends no
    // CORS headers, but host permission bypasses CORS). Broad for now — can be
    // tightened to the exact bucket once its region is confirmed stable.
    "https://*.amazonaws.com/*",
  ],
  notes:
    "claude.ai subscription invoices; PDFs are Stripe capability URLs. claude.ai is behind Cloudflare, so requests run first-party via fetchContext: page.",

  // claude.ai is behind Cloudflare → run its API calls first-party (in a tab).
  // The Stripe PDF (a different origin) still uses the worker fetch.
  fetchContext: "page",

  auth: {
    check: {
      request: { url: "https://claude.ai/api/organizations" },
      expect: { statusIn: [200] },
    },
    loginUrl: "https://claude.ai/login",
  },

  // claude.ai accounts can have multiple organizations; billing is per-org.
  config: [
    {
      id: "org",
      discover: {
        request: { url: "https://claude.ai/api/organizations" },
        items: "$", // response is a top-level array of orgs
        value: "uuid", // becomes {org}
        label: "name",
      },
    },
  ],

  invoices: {
    strategy: "network",
    list: {
      request: { url: "https://claude.ai/api/stripe/{org}/invoices?limit=100&page={cursor}" },
      items: "invoices",
      map: {
        // The payload has no explicit invoice id, but `created_ts` is stable and
        // unique per invoice, so it is the dedup key. (The Stripe URL is re-signed
        // on every fetch and must NOT be used for identity.)
        id: { path: "created_ts" },
        issuedAt: { path: "created_ts", transforms: [{ kind: "date", epoch: "s" }] },
        total: { path: "total", transforms: [{ kind: "divide", by: 100 }] },
        currency: { path: "currency", transforms: [{ kind: "upper" }] },
        documentUrl: "invoice_pdf_url",
      },
      paginate: { cursor: "next_page", maxPages: 20 },
    },
    document: { contentType: "application/pdf" },
  },
});
