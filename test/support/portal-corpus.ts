import type { Portal } from "./portal-simulator";

/**
 * How suppliers actually present invoices.
 *
 * Each entry is a distinct *shape*, not a distinct brand: a GraphQL portal that
 * nests invoices under a customer envelope, a REST list behind an unremarkable
 * query string, a server-rendered receipts page, a hydration blob, an icon-only
 * download table, an application that will not render billing in a background
 * tab, a portal that only reveals billing behind a settings bridge, and one that
 * exposes it only under a tenant prefix.
 *
 * A shape earns its place here by being a way discovery can fail structurally,
 * so the corpus stays a statement about coverage rather than a list of vendors.
 */

const WORKSPACE = "3f2a9c1e-5b6d-4a7f-8c9d-0e1f2a3b4c5d";

const ME_BODY = JSON.stringify({
  operationName: "me",
  query: "query me { me { workspaces { id name } } }",
});
const ENRICH_BODY = JSON.stringify({
  operationName: "enrichCustomer",
  variables: { workspaceId: WORKSPACE },
  query: "query enrichCustomer($workspaceId: String!) { workspace(workspaceId: $workspaceId) { customer { invoices { hostedURL status invoiceId total periodEnd } } } }",
});
const ME_RESPONSE = JSON.stringify({
  data: { me: { workspaces: [{ id: WORKSPACE, name: "Acme" }] } },
});
const ENRICH_RESPONSE = JSON.stringify({
  data: {
    workspace: {
      customer: {
        invoices: [
          {
            hostedURL: "https://invoice.stripe.com/i/acct_1PabcDEFghiJKL/live_YWNjdF8xUGFiY0RFRmdoaUpLTCxfUlhY",
            status: "paid",
            invoiceId: "in_1PabcDEFghiJKLmno",
            total: 2000,
            periodEnd: "2026-07-01T00:00:00.000Z",
          },
          {
            hostedURL: "https://invoice.stripe.com/i/acct_1PabcDEFghiJKL/live_ZWNjdF8xUGFiY0RFRmdoaUpLTCxfUlha",
            status: "paid",
            invoiceId: "in_1PabcDEFghiJKLmnp",
            total: 4500,
            periodEnd: "2026-06-01T00:00:00.000Z",
          },
        ],
      },
    },
  },
});

/** A hosted-application GraphQL portal: cross-origin POST, invoices nested under
 * a customer envelope, documents delegated to a payment provider. */
const graphqlWorkspacePortal: Portal = {
  name: "graphql workspace portal",
  origin: "https://portal.example",
  entryPath: `/workspace/${WORKSPACE}/billing`,
  routes: [
    {
      path: `/workspace/${WORKSPACE}/billing`,
      title: "Billing | Portal",
      hydrateMs: 1_400,
      html: '<html><head><title>Billing | Portal</title></head><body><h1>Billing</h1><div class="invoices"></div></body></html>',
      calls: [
        { url: "https://api.portal.example/graphql?q=me", method: "POST", requestBody: ME_BODY, requestHeaders: { "content-type": "application/json" }, body: ME_RESPONSE },
        { url: "https://api.portal.example/graphql?q=enrichCustomer", method: "POST", requestBody: ENRICH_BODY, requestHeaders: { "content-type": "application/json" }, body: ENRICH_RESPONSE },
      ],
      links: [{ href: `/workspace/${WORKSPACE}/billing`, label: "Billing" }],
    },
  ],
  endpoint: (request) => {
    if (!request.url.startsWith("https://api.portal.example/graphql")) return undefined;
    if (request.body?.includes('"me"')) return { body: ME_RESPONSE };
    if (request.body?.includes("enrichCustomer")) return { body: ENRICH_RESPONSE };
    return undefined;
  },
};

const REST_INVOICES = JSON.stringify({
  object: "list",
  has_more: false,
  data: [
    { id: "in_9001", created: 1_782_950_400, amount_due: 12_900, currency: "usd", invoice_pdf: "https://portal.rest.example/files/in_9001.pdf" },
    { id: "in_9002", created: 1_780_272_000, amount_due: 12_900, currency: "usd", invoice_pdf: "https://portal.rest.example/files/in_9002.pdf" },
  ],
});

/** A REST portal whose invoice list is addressed by an ordinary query string —
 * the shape an allowlist of parameter names cannot enumerate. */
const restQueryPortal: Portal = {
  name: "rest portal with a query-addressed list",
  origin: "https://portal.rest.example",
  entryPath: "/dashboard",
  routes: [
    {
      path: "/dashboard",
      title: "Dashboard | Rest",
      hydrateMs: 300,
      html: '<html><head><title>Dashboard | Rest</title></head><body><nav><a href="/settings/billing">Billing &amp; invoices</a></nav></body></html>',
      links: [{ href: "/settings/billing", label: "Billing & invoices" }],
    },
    {
      path: "/settings/billing",
      title: "Billing | Rest",
      hydrateMs: 900,
      html: '<html><head><title>Billing | Rest</title></head><body><h1>Invoices</h1></body></html>',
      calls: [
        { url: "https://portal.rest.example/api/session", body: JSON.stringify({ user: { id: "u_1" } }) },
        { url: "https://portal.rest.example/api/billing/invoices?year=2026&view=list", body: REST_INVOICES },
      ],
    },
  ],
  endpoint: (request) => {
    if (request.url.startsWith("https://portal.rest.example/api/billing/invoices")) return { body: REST_INVOICES };
    if (request.url === "https://portal.rest.example/api/session") return { body: JSON.stringify({ user: { id: "u_1" } }) };
    return undefined;
  },
};

/** A server-rendered receipts page: no API at all, just links. */
const serverRenderedPortal: Portal = {
  name: "server-rendered receipts page",
  origin: "https://billing.static.example",
  entryPath: "/settings/billing",
  routes: [
    {
      path: "/settings/billing",
      title: "Billing history | Static",
      hydrateMs: 0,
      html: [
        '<html><head><title>Billing history | Static</title></head><body><h1>Payment history</h1><table>',
        '<tr><td>Jul 2026</td><td><a href="/account/receipt/rcpt_9001">Receipt</a></td></tr>',
        '<tr><td>Jun 2026</td><td><a href="/account/receipt/rcpt_9002">Receipt</a></td></tr>',
        '<tr><td>May 2026</td><td><a href="/account/receipt/rcpt_9003">Receipt</a></td></tr>',
        "</table></body></html>",
      ].join(""),
    },
  ],
};

const HYDRATION_BLOB = JSON.stringify({
  props: {
    pageProps: {
      invoices: [
        { id: "INV-2026-07", issued_at: "2026-07-01", amount: 4900, currency: "eur", pdf_url: "https://shop.hydrated.example/invoices/INV-2026-07.pdf" },
        { id: "INV-2026-06", issued_at: "2026-06-01", amount: 4900, currency: "eur", pdf_url: "https://shop.hydrated.example/invoices/INV-2026-06.pdf" },
      ],
    },
  },
});

/** An application that ships its invoice list inside the document. */
const hydrationBlobPortal: Portal = {
  name: "embedded hydration blob",
  origin: "https://shop.hydrated.example",
  entryPath: "/account/billing",
  routes: [
    {
      path: "/account/billing",
      title: "Invoices | Shop",
      hydrateMs: 200,
      html: `<html><head><title>Invoices | Shop</title></head><body><h1>Invoices</h1><script type="application/json">${HYDRATION_BLOB}</script></body></html>`,
    },
  ],
  endpoint: (request) => (request.url === "https://shop.hydrated.example/account/billing"
    ? { contentType: "text/html", body: `<html><head><title>Invoices | Shop</title></head><body><script type="application/json">${HYDRATION_BLOB}</script></body></html>` }
    : undefined),
};

/** An invoice table whose only download affordance is an icon button. */
const semanticTablePortal: Portal = {
  name: "icon-only invoice download table",
  origin: "https://app.semantic.example",
  entryPath: "/settings/billing",
  routes: [
    {
      path: "/settings/billing",
      title: "Billing | Semantic",
      hydrateMs: 800,
      html: '<html><head><title>Billing | Semantic</title></head><body><h1>Invoices</h1><table><thead><tr><th>Date</th><th>Amount</th><th>Actions</th></tr></thead><tbody><tr><td>Jul 2026</td><td>$44.03</td><td><button aria-label="Download invoice"></button></td></tr></tbody></table></body></html>',
      semanticControls: 4,
      semanticSections: 1,
    },
  ],
};

/** A single-page application that boots slowly before it calls its billing API. */
const slowSpaPortal: Portal = {
  name: "slow single-page application",
  origin: "https://console.slow.example",
  entryPath: "/account/billing",
  navMs: 900,
  routes: [
    {
      path: "/account/billing",
      title: "Billing | Console",
      hydrateMs: 2_200,
      html: '<html><head><title>Billing | Console</title></head><body><h1>Billing</h1></body></html>',
      calls: [
        { url: "https://console.slow.example/api/v2/invoices?page=1&per_page=25", body: REST_INVOICES.replace(/portal\.rest\.example/g, "console.slow.example") },
      ],
    },
  ],
  endpoint: (request) => (request.url.startsWith("https://console.slow.example/api/v2/invoices")
    ? { body: REST_INVOICES.replace(/portal\.rest\.example/g, "console.slow.example") }
    : undefined),
};

/** An application that refuses to hydrate billing while its tab is hidden. */
const visibilityGatedPortal: Portal = {
  name: "visibility-gated billing view",
  origin: "https://app.visible.example",
  entryPath: "/billing",
  routes: [
    {
      path: "/billing",
      title: "Billing | Visible",
      hydrateMs: 700,
      visibleOnly: true,
      html: '<html><head><title>Billing | Visible</title></head><body><h1>Invoices</h1><a href="/invoices/2026-07.pdf">Download invoice</a><a href="/invoices/2026-06.pdf">Download invoice</a></body></html>',
    },
  ],
};

/** Billing reachable only through a settings bridge that states no billing
 * intent of its own. */
const bridgedSettingsPortal: Portal = {
  name: "billing behind a settings bridge",
  origin: "https://team.bridge.example",
  entryPath: "/home",
  routes: [
    {
      path: "/home",
      title: "Home | Bridge",
      hydrateMs: 200,
      html: '<html><head><title>Home | Bridge</title></head><body><a href="/settings">Settings</a></body></html>',
      links: [{ href: "/settings", label: "Settings" }],
    },
    {
      path: "/settings",
      title: "Settings | Bridge",
      hydrateMs: 250,
      html: '<html><head><title>Settings | Bridge</title></head><body><a href="/settings/invoices">Invoice history</a></body></html>',
      links: [{ href: "/settings/invoices", label: "Invoice history" }],
    },
    {
      path: "/settings/invoices",
      title: "Invoice history | Bridge",
      hydrateMs: 600,
      html: '<html><head><title>Invoice history | Bridge</title></head><body><h1>Invoice history</h1><a href="/documents/inv-2026-07.pdf">PDF</a><a href="/documents/inv-2026-06.pdf">PDF</a></body></html>',
    },
  ],
};

const TENANT = "9012345678901";
const TENANT_INVOICES = JSON.stringify({
  invoices: [
    { invoice_id: "INV-77001", issue_date: "2026-07-04", net_amount: 1_500, currency: "SEK", document_url: "https://app.tenant.example/download/INV-77001" },
    { invoice_id: "INV-77002", issue_date: "2026-06-04", net_amount: 1_500, currency: "SEK", document_url: "https://app.tenant.example/download/INV-77002" },
  ],
});

/** A portal whose billing route exists only under the tenant prefix the person
 * is already inside — nothing links to it from the page they started on. */
const tenantScopedPortal: Portal = {
  name: "tenant-prefixed billing route",
  origin: "https://app.tenant.example",
  entryPath: `/organization/${TENANT}/projects`,
  routes: [
    {
      path: `/organization/${TENANT}/projects`,
      title: "Projects | Tenant",
      hydrateMs: 200,
      html: '<html><head><title>Projects | Tenant</title></head><body><h1>Projects</h1></body></html>',
    },
    {
      path: `/organization/${TENANT}/billing`,
      title: "Billing | Tenant",
      hydrateMs: 800,
      html: '<html><head><title>Billing | Tenant</title></head><body><h1>Invoices</h1></body></html>',
      calls: [
        { url: `https://app.tenant.example/api/organizations/${TENANT}/invoices?limit=50`, body: TENANT_INVOICES },
      ],
    },
  ],
  endpoint: (request) => (request.url.includes("/invoices") ? { body: TENANT_INVOICES } : undefined),
};

const RELAY_INVOICES = JSON.stringify({
  data: {
    account: {
      // A key an over-eager PII filter would erase along with everything under it.
      customer: { name: "Acme AB", email: "billing@acme.example" },
      invoiceConnection: {
        pageInfo: { hasNextPage: false, endCursor: "Y3Vyc29yOjI=" },
        edges: [
          { node: { id: "inv_5501", issuedAt: "2026-07-02", amountCents: 39_900, currency: "eur", documentUrl: "https://files.relay.example/inv_5501.pdf" } },
          { node: { id: "inv_5502", issuedAt: "2026-06-02", amountCents: 39_900, currency: "eur", documentUrl: "https://files.relay.example/inv_5502.pdf" } },
        ],
      },
    },
  },
});

/** A Relay-style envelope whose invoices sit beside real customer PII and behind
 * an `edges`/`node` wrapper, with documents served from a separate file host. */
const relayEnvelopePortal: Portal = {
  name: "relay envelope beside customer data",
  origin: "https://app.relay.example",
  entryPath: "/settings/billing",
  routes: [
    {
      path: "/settings/billing",
      title: "Billing | Relay",
      hydrateMs: 700,
      html: '<html><head><title>Billing | Relay</title></head><body><h1>Invoices</h1></body></html>',
      calls: [
        { url: "https://app.relay.example/api/billing/invoices?status=paid&limit=25", body: RELAY_INVOICES },
      ],
    },
  ],
  endpoint: (request) => (request.url.startsWith("https://app.relay.example/api/billing/invoices")
    ? { body: RELAY_INVOICES }
    : undefined),
};

const NOISY_TENANT = "8811223344556677";
const NOISY_INVOICES = JSON.stringify({
  invoices: [
    { number: "F-4401", issued: "2026-07-09", gross: 84_500, currency: "SEK", pdfLink: `https://noisy.example/api/accounts/${NOISY_TENANT}/invoices/F-4401.pdf` },
    { number: "F-4402", issued: "2026-06-09", gross: 84_500, currency: "SEK", pdfLink: `https://noisy.example/api/accounts/${NOISY_TENANT}/invoices/F-4402.pdf` },
  ],
});

/** A chatty application: the billing view fires far more JSON than discovery can
 * keep, and the endpoint that would reveal the tenant identifier is among what
 * gets dropped — so the account id has to survive in the list URL itself. */
const noisyTenantPortal: Portal = {
  name: "chatty billing view with a path-scoped account",
  origin: "https://noisy.example",
  entryPath: "/billing",
  routes: [
    {
      path: "/billing",
      title: "Billing | Noisy",
      hydrateMs: 1_000,
      html: '<html><head><title>Billing | Noisy</title></head><body><h1>Invoices</h1></body></html>',
      calls: [
        { url: `https://noisy.example/api/accounts/${NOISY_TENANT}/invoices?limit=50`, body: NOISY_INVOICES },
        ...Array.from({ length: 14 }, (_, index) => ({
          url: `https://noisy.example/api/billing/widget-${index}?subscription=1`,
          body: JSON.stringify({ widget: index, billing: { plan: "team", charge: 100 + index } }),
        })),
        { url: "https://noisy.example/api/me", body: JSON.stringify({ account: { id: NOISY_TENANT } }) },
      ],
    },
  ],
  endpoint: (request) => {
    if (request.url.includes("/invoices")) return { body: NOISY_INVOICES };
    if (request.url === "https://noisy.example/api/me") return { body: JSON.stringify({ account: { id: NOISY_TENANT } }) };
    return undefined;
  },
};

const CURSOR_PAGE = JSON.stringify({
  has_more: true,
  next_cursor: "cur_2",
  results: [
    { invoice_number: "2026-07-0001", invoice_date: "2026-07-01", total_amount: 25_000, currency: "gbp", download_url: "https://portal.cursor.example/d/2026-07-0001" },
    { invoice_number: "2026-06-0001", invoice_date: "2026-06-01", total_amount: 25_000, currency: "gbp", download_url: "https://portal.cursor.example/d/2026-06-0001" },
  ],
});

/** A cursor-paginated list, where the recipe must template the cursor without
 * ever making the first page unreachable. */
const cursorPaginatedPortal: Portal = {
  name: "cursor-paginated invoice API",
  origin: "https://portal.cursor.example",
  entryPath: "/account/billing",
  routes: [
    {
      path: "/account/billing",
      title: "Invoices | Cursor",
      hydrateMs: 600,
      html: '<html><head><title>Invoices | Cursor</title></head><body><h1>Invoices</h1></body></html>',
      calls: [
        { url: "https://portal.cursor.example/api/invoices?cursor=cur_1&limit=25", body: CURSOR_PAGE },
      ],
    },
  ],
  endpoint: (request) => (request.url.startsWith("https://portal.cursor.example/api/invoices")
    ? { body: CURSOR_PAGE }
    : undefined),
};

/** Billing reachable only through an icon-only navigation entry whose accessible
 * name — not its opaque route — states the intent. */
const opaqueRoutePortal: Portal = {
  name: "opaque route named only by its label",
  origin: "https://app.opaque.example",
  entryPath: "/w/7f31/overview",
  routes: [
    {
      path: "/w/7f31/overview",
      title: "Overview | Opaque",
      hydrateMs: 250,
      html: '<html><head><title>Overview | Opaque</title></head><body><nav></nav></body></html>',
      links: [{ href: "/w/7f31/s/42", label: "Invoices" }],
    },
    {
      path: "/w/7f31/s/42",
      title: "Invoices | Opaque",
      hydrateMs: 500,
      html: '<html><head><title>Invoices | Opaque</title></head><body><h1>Invoices</h1><a href="/w/7f31/d/inv-7701.pdf">Invoice July</a><a href="/w/7f31/d/inv-7702.pdf">Invoice June</a></body></html>',
    },
  ],
};

export interface CorpusEntry {
  portal: Portal;
  /** The adapter the strongest retained candidate must use. */
  expectedAdapter: "network-json" | "embedded-json" | "dom-links" | "dom-actions";
}

export const PORTAL_CORPUS: readonly CorpusEntry[] = [
  { portal: graphqlWorkspacePortal, expectedAdapter: "network-json" },
  { portal: restQueryPortal, expectedAdapter: "network-json" },
  { portal: serverRenderedPortal, expectedAdapter: "dom-links" },
  { portal: hydrationBlobPortal, expectedAdapter: "embedded-json" },
  { portal: semanticTablePortal, expectedAdapter: "dom-actions" },
  { portal: slowSpaPortal, expectedAdapter: "network-json" },
  { portal: visibilityGatedPortal, expectedAdapter: "dom-links" },
  { portal: bridgedSettingsPortal, expectedAdapter: "dom-links" },
  { portal: tenantScopedPortal, expectedAdapter: "network-json" },
  { portal: relayEnvelopePortal, expectedAdapter: "network-json" },
  { portal: noisyTenantPortal, expectedAdapter: "network-json" },
  { portal: cursorPaginatedPortal, expectedAdapter: "network-json" },
  { portal: opaqueRoutePortal, expectedAdapter: "dom-links" },
];
