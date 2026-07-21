import { defineVendor } from "./define";
import { STRIPE_KNOWN_DOCUMENT_HOSTS } from "../core/document-provider";

/**
 * ChatGPT / OpenAI — recorder-authored (Deep capture found the real billing JSON
 * API, `backend-api/invoices`) and now MULTI-TENANT: it works for any logged-in
 * user, nothing account-specific is hardcoded. Three things layered on the draft:
 *
 *   • Bearer token. `backend-api/*` needs `Authorization: Bearer <accessToken>`,
 *     not just the session cookie. `auth.token` exchanges the cookie for the
 *     token via `/api/auth/session` once per run; every backend-api call (incl.
 *     the account discovery) templates it in. (Stripe PDF fetches don't — the
 *     token is in that URL.)
 *   • Account id discovery. The invoices endpoint needs `account_id`. Rather than
 *     hardcode one account, `config` discovers THIS user's id from
 *     `accounts/check` (the recorder traced the value there) — Anthropic-style.
 *   • First-party fetch. chatgpt.com is behind Cloudflare, so requests run inside
 *     a chatgpt.com tab (`fetchContext: "page"`).
 *
 * Invoice objects are Stripe-shaped: `invoice_pdf` is the direct PDF
 * (pay.stripe.com, which redirects through files.stripe.com). The endpoint keeps
 * Stripe's list envelope, so its `has_more` flag and last invoice ID let the
 * collector continue past the first 100 records without treating a capped page
 * as a complete invoice history.
 */
const BEARER = { authorization: "Bearer {token}" };

export default defineVendor({
  id: "chatgpt",
  name: "ChatGPT",
  homepage: "https://chatgpt.com",
  category: "ai",
  icon: "openai", // simple-icons dropped OpenAI → real mark comes from icon-overrides
  fetchContext: "page", // Cloudflare-fronted — fetch first-party from a chatgpt.com tab
  hosts: [
    "https://chatgpt.com/*",
    ...STRIPE_KNOWN_DOCUMENT_HOSTS,
  ],
  notes: "Recorder-authored, multi-tenant. Bearer token from /api/auth/session; account_id discovered per user from accounts/check.",

  auth: {
    // Cookie → bearer token, needed by every backend-api call below.
    token: { request: { url: "https://chatgpt.com/api/auth/session" }, value: "accessToken" },
    check: {
      request: { url: "https://chatgpt.com/backend-api/me", headers: BEARER },
      expect: { statusIn: [200] },
    },
    loginUrl: "https://chatgpt.com/login",
  },

  // Discover THIS user's account id so the invoices URL isn't tied to one account.
  config: [
    {
      id: "account_id",
      discover: {
        request: {
          url: "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=-120",
          headers: BEARER,
        },
        value: "accounts.default.account.account_id",
      },
    },
  ],

  invoices: {
    strategy: "network",
    list: {
      request: {
        url: "https://chatgpt.com/backend-api/invoices?limit=100&account_id={account_id}&starting_after={cursor}",
        headers: BEARER,
      },
      items: "data",
      map: {
        id: "id",
        issuedAt: { path: "created", transforms: [{ kind: "date", epoch: "s" }] },
        total: { path: "amount_due", transforms: [{ kind: "divide", by: 100 }] }, // cents → decimal
        currency: { path: "currency", transforms: [{ kind: "upper" }] },
        documentUrl: "invoice_pdf", // direct Stripe PDF (not the hosted invoice page)
      },
      // The API returns Stripe's { data, has_more } list envelope. A full page
      // continues after its last stable invoice ID; the runner marks a missing
      // cursor or exhausted page cap partial rather than silently complete.
      paginate: { cursor: "data.99.id", hasMore: "has_more", pageSize: 100, maxPages: 20 },
    },
    document: { contentType: "application/pdf" },
  },
});
