import { defineVendor } from "./define";

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
 * (pay.stripe.com, which redirects through files.stripe.com). `limit` is 100 to pull
 * the whole history (no user has >100 ChatGPT invoices; no pagination wired).
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
    "https://pay.stripe.com/*", // invoice_pdf lives here…
    "https://files.stripe.com/*", // …and redirects here
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
        url: "https://chatgpt.com/backend-api/invoices?limit=100&account_id={account_id}",
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
    },
    document: { contentType: "application/pdf" },
  },
});
