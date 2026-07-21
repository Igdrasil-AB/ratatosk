import { defineVendor } from "./define";
import { STRIPE_KNOWN_DOCUMENT_HOSTS } from "../core/document-provider";

/**
 * Railway — recorder-authored and now MULTI-TENANT. Billing is a GraphQL POST to
 * backboard; invoices come back as a flat array (all of them, no pagination),
 * each with a Stripe hosted invoice URL.
 *
 * The billing query is workspace-scoped, so `workspaceId` used to be hardcoded.
 * The recorder traced it to the `me` query and auto-wired a `config` discovery —
 * so it now works for any logged-in user. Finalization on top of the auto-draft:
 *   • Minimal GraphQL queries (subsets of what the app sends) for readability.
 *   • `content-type: application/json`, or backboard won't parse the query body.
 *   • documentUrl: `hostedURL` is the Stripe hosted invoice *page*; a `replace`
 *     rewrites it to the direct PDF (pay.stripe.com/…/pdf), which then redirects
 *     through Stripe's file host.
 *   • no `currency` field exists in the payload (Railway bills USD); the pipeline
 *     reads currency from the PDF.
 *
 * Workspace discovery enumerates every workspace, so the engine executes one
 * bounded invoice traversal per billed workspace and deduplicates any invoice
 * identity repeated across scopes.
 */
const GRAPHQL = "https://backboard.railway.com/graphql/internal";
const JSON_HEADERS = { "content-type": "application/json" };

// `me` → the user's workspaces (a minimal subset of the app's giant `me` query).
const ME_WORKSPACES = JSON.stringify({
  operationName: "me",
  query: "query me { me { workspaces { id name } } }",
});

// Invoices for one workspace. `{workspaceId}` is filled from the discovery above.
const ENRICH_CUSTOMER = JSON.stringify({
  operationName: "enrichCustomer",
  variables: { workspaceId: "{workspaceId}" },
  query:
    "query enrichCustomer($workspaceId: String!) { workspace(workspaceId: $workspaceId) { customer { invoices { hostedURL status invoiceId total periodEnd } } } }",
});

export default defineVendor({
  id: "railway",
  name: "Railway",
  homepage: "https://railway.com",
  category: "hosting",
  icon: "railway",
  hosts: [
    "https://railway.com/*",
    "https://backboard.railway.com/*",
    ...STRIPE_KNOWN_DOCUMENT_HOSTS,
  ],
  notes: "Recorder-authored, multi-tenant. workspaceId discovered from `me`; billing via enrichCustomer GraphQL; PDF = Stripe hosted URL rewritten to /pdf.",

  auth: {
    // The `me` query is the login check — a 200 with workspaces means we're in.
    check: {
      request: { url: `${GRAPHQL}?q=me`, method: "POST", headers: JSON_HEADERS, body: ME_WORKSPACES },
      expect: {
        and: [
          { statusIn: [200] },
          { jsonPath: "data.me.workspaces", exists: true },
          { jsonPath: "errors", exists: false },
        ],
      },
    },
    loginUrl: "https://railway.com/login",
  },

  // Discover every workspace id so a multi-workspace account cannot silently
  // omit invoices after the first entry in the `me` response.
  config: [
    {
      id: "workspaceId",
      discover: {
        request: { url: `${GRAPHQL}?q=me`, method: "POST", headers: JSON_HEADERS, body: ME_WORKSPACES },
        items: "data.me.workspaces",
        value: "id",
      },
    },
  ],

  invoices: {
    strategy: "network",
    list: {
      request: { url: `${GRAPHQL}?q=enrichCustomer`, method: "POST", headers: JSON_HEADERS, body: ENRICH_CUSTOMER },
      items: "data.workspace.customer.invoices",
      map: {
        id: "invoiceId",
        issuedAt: { path: "periodEnd", transforms: [{ kind: "date" }] },
        total: { path: "total", transforms: [{ kind: "divide", by: 100 }] }, // cents → decimal
        // hostedURL is the Stripe hosted invoice PAGE; the direct PDF is at
        // pay.stripe.com/invoice/…/pdf (same token).
        documentUrl: {
          path: "hostedURL",
          transforms: [
            { kind: "replace", pattern: "^https://invoice\\.stripe\\.com/i/([^/?#]+)/([^/?#]+)(\\?.*)?$", with: "https://pay.stripe.com/invoice/$1/$2/pdf$3" },
          ],
        },
      },
    },
    document: { contentType: "application/pdf" },
  },
});
