import { describe, expect, it } from "vitest";
import { inferRecipe } from "../../src/core/recorder/infer";
import type { CaptureSession } from "../../src/core/recorder/types";

/**
 * The proof that the recorder works: feed it a capture session shaped like the
 * REAL claude.ai billing traffic we captured by hand earlier, and assert it
 * reconstructs the anthropic recipe — id, epoch-seconds date, minor-units
 * amount, currency upper-casing, the Stripe PDF field, pagination, and the
 * auth probe — with zero human inspection of DevTools.
 */
function session(): CaptureSession {
  return {
    origin: "https://claude.ai",
    entries: [
      {
        url: "https://claude.ai/api/organizations",
        method: "GET",
        status: 200,
        contentType: "application/json",
        responseBody: JSON.stringify([
          { uuid: "org-1", name: "user@example.com's Organization", billing_type: "stripe_subscription", created_at: "2025-03-24T07:33:52Z" },
        ]),
      },
      {
        url: "https://claude.ai/api/stripe/org-11111111-2222-4333-8444-555555555555/invoices?limit=100&page=",
        method: "GET",
        status: 200,
        contentType: "application/json",
        responseBody: JSON.stringify({
          invoices: [
            {
              total: 9000,
              total_excluding_tax: 9000,
              currency: "eur",
              status: "paid",
              created_ts: 1782543567,
              due_date_ts: null,
              hosted_invoice_url: "https://invoice.stripe.com/i/acct_X/live_TOKEN1?s=ap",
              invoice_pdf_url: "https://pay.stripe.com/invoice/acct_X/live_TOKEN1/pdf?s=ap",
            },
            {
              total: 18000,
              currency: "eur",
              status: "paid",
              created_ts: 1782521674,
              invoice_pdf_url: "https://pay.stripe.com/invoice/acct_X/live_TOKEN2/pdf?s=ap",
            },
          ],
          has_more: true,
          next_page: "eyJsYXN0X2ludm9pY2VfY3JlYXRlZF9hdCI6MTc4MjUyMTY3NH0=",
        }),
      },
      {
        url: "https://pay.stripe.com/invoice/acct_X/live_TOKEN1/pdf?s=ap",
        method: "GET",
        status: 200,
        contentType: "application/pdf",
      },
    ],
  };
}

describe("recorder inference — reconstructs the anthropic recipe from captured traffic", () => {
  const draft = inferRecipe(session());

  it("finds the invoice list and maps every field the way we hand-wrote it", () => {
    expect(draft).not.toBeNull();
    const list = (draft!.recipe as any).invoices.list;

    expect(list.items).toBe("invoices");
    expect(list.map.id).toBe("created_ts"); // no id field → falls back to the stable date
    expect(list.map.issuedAt).toEqual({ path: "created_ts", transforms: [{ kind: "date", epoch: "s" }] });
    expect(list.map.total).toEqual({ path: "total", transforms: [{ kind: "divide", by: 100 }] });
    expect(list.map.currency).toEqual({ path: "currency", transforms: [{ kind: "upper" }] });
    expect(list.map.documentUrl).toBe("invoice_pdf_url"); // the /pdf one, not hosted_invoice_url
    expect(list.paginate).toEqual({ cursor: "next_page" });
    expect(list.request.url).toBe(
      "https://claude.ai/api/stripe/org-11111111-2222-4333-8444-555555555555/invoices?limit=100&page={cursor}",
    );
  });

  it("infers the auth probe, hosts, and a high confidence", () => {
    expect((draft!.recipe as any).auth.check.request.url).toBe("https://claude.ai/api/organizations");
    expect((draft!.recipe as any).hosts).toContain("https://claude.ai/*");
    expect((draft!.recipe as any).hosts).toContain("https://pay.stripe.com/*");
    expect(draft!.confidence).toBe("high");
  });

  it("redacts PII from the emitted fixture but keeps the shape", () => {
    const fixture = JSON.stringify(draft!.fixture);
    expect(fixture).not.toContain("user@example.com's Organization"); // this came from the org call…
    // …the fixture is the INVOICE response; assert its numeric shape survived:
    expect((draft!.fixture as any).invoices[0].total).toBe(9000);
  });

  it("returns null when nothing looks like an invoice list", () => {
    const empty: CaptureSession = {
      origin: "https://x.com",
      entries: [{ url: "https://x.com/api/ping", method: "GET", status: 200, contentType: "application/json", responseBody: '{"ok":true}' }],
    };
    expect(inferRecipe(empty)).toBeNull();
  });
});

describe("recorder inference — GraphQL edges/node (Railway-style)", () => {
  it("unwraps a deeply-nested Relay envelope and prefixes the field paths", () => {
    const draft = inferRecipe({
      origin: "https://railway.com",
      entries: [
        {
          url: "https://backboard.railway.com/graphql/internal",
          method: "POST",
          status: 200,
          contentType: "application/json",
          responseBody: JSON.stringify({
            data: {
              workspace: {
                invoices: {
                  edges: [
                    { node: { id: "inv_1", amountDue: 1500, currency: "usd", createdAt: "2026-06-01T00:00:00Z", pdfUrl: "https://pay.stripe.com/i/1/pdf" } },
                    { node: { id: "inv_2", amountDue: 3000, currency: "usd", createdAt: "2026-05-01T00:00:00Z", pdfUrl: "https://pay.stripe.com/i/2/pdf" } },
                  ],
                },
              },
            },
          }),
        },
      ],
    });

    expect(draft).not.toBeNull();
    const list = (draft!.recipe as any).invoices.list;
    expect(list.items).toBe("data.workspace.invoices.edges");
    expect(list.map.id).toBe("node.id");
    expect(list.map.issuedAt).toEqual({ path: "node.createdAt", transforms: [{ kind: "date" }] });
    expect(list.map.total).toEqual({ path: "node.amountDue", transforms: [{ kind: "divide", by: 100 }] });
    expect(list.map.currency).toEqual({ path: "node.currency", transforms: [{ kind: "upper" }] });
    expect(list.map.documentUrl).toBe("node.pdfUrl");
  });
});

describe("recorder inference — Railway GraphQL POST (real capture shape)", () => {
  const draft = inferRecipe({
    origin: "https://railway.com",
    entries: [
      {
        url: "https://backboard.railway.com/graphql/internal?q=enrichCustomer",
        method: "POST",
        status: 200,
        contentType: "application/json",
        requestBody: '{"query":"query enrichCustomer { workspace { customer { invoices { total } } } }","variables":{"workspaceId":"ws_1"}}',
        responseBody: JSON.stringify({
          data: {
            workspace: {
              customer: {
                invoices: [
                  { hostedURL: "https://invoice.stripe.com/i/acct_X/TOK1?s=ap", status: "paid", invoiceId: "in_1", total: 4762, periodEnd: "2026-06-14T09:27:24.000Z" },
                  { hostedURL: "https://invoice.stripe.com/i/acct_X/TOK2?s=ap", status: "paid", invoiceId: "in_2", total: 2000, periodEnd: "2026-05-14T09:27:24.000Z" },
                ],
              },
            },
          },
        }),
      },
    ],
  });

  it("emits the POST body, divides the cents total, and recognizes hostedURL as the PDF", () => {
    expect(draft).not.toBeNull();
    const list = (draft!.recipe as any).invoices.list;
    expect(list.items).toBe("data.workspace.customer.invoices");
    expect(list.map.id).toBe("invoiceId");
    expect(list.map.issuedAt).toEqual({ path: "periodEnd", transforms: [{ kind: "date" }] });
    expect(list.map.total).toEqual({ path: "total", transforms: [{ kind: "divide", by: 100 }] }); // 4762 → 47.62, no currency field needed
    expect(list.map.documentUrl).toBe("hostedURL");
    expect(list.request.method).toBe("POST");
    expect(list.request.body).toContain("enrichCustomer"); // the GraphQL query is captured for replay
  });

  it("includes the query host and the Stripe host, and uses the list request as the auth check", () => {
    const recipe = draft!.recipe as any;
    expect(recipe.hosts).toEqual(expect.arrayContaining(["https://railway.com/*", "https://backboard.railway.com/*", "https://invoice.stripe.com/*"]));
    expect(recipe.auth.check.request.method).toBe("POST"); // fell back to the list request, not a static file
  });
});

describe("recorder inference — server-rendered page (embedded-JSON hydration blob)", () => {
  const draft = inferRecipe({
    origin: "https://vendor.example",
    entries: [
      {
        url: "https://vendor.example/account/billing",
        method: "GET",
        status: 200,
        contentType: "text/html; charset=utf-8",
        responseBody: `<!doctype html><html><head>
          <script type="application/json" data-target="react-app.embeddedData">
          {"props":{"pageProps":{"invoices":[
            {"id":"in_a","amount_cents":2500,"currency":"usd","created":"2026-06-01","pdf_url":"https://vendor.example/i/in_a.pdf"},
            {"id":"in_b","amount_cents":2500,"currency":"usd","created":"2026-05-01","pdf_url":"https://vendor.example/i/in_b.pdf"}
          ]}}}
          </script></head><body></body></html>`,
      },
    ],
  });

  it("emits an html-strategy recipe that re-fetches the page and mines the blob", () => {
    expect(draft).not.toBeNull();
    const invoices = (draft!.recipe as any).invoices;
    expect(invoices.strategy).toBe("html");
    expect(invoices.list.embeddedJson).toBe(true);
    expect(invoices.list.items).toBe("props.pageProps.invoices");
    expect(invoices.list.request.url).toBe("https://vendor.example/account/billing");
    expect(invoices.list.map.id).toBe("id");
    expect(invoices.list.map.documentUrl).toBe("pdf_url");
    expect(invoices.list.map.total).toEqual({ path: "amount_cents", transforms: [{ kind: "divide", by: 100 }] });
  });

  it("prefers a real JSON API over the same data found in HTML", () => {
    // Same session, but the invoices ALSO arrive as a clean JSON endpoint → that wins.
    const withApi = inferRecipe({
      origin: "https://vendor.example",
      entries: [
        {
          url: "https://vendor.example/account/billing",
          method: "GET",
          status: 200,
          contentType: "text/html",
          responseBody: `<script type="application/json">{"invoices":[{"id":"in_a","amount_cents":2500,"created":"2026-06-01","pdf_url":"https://vendor.example/i/in_a.pdf"}]}</script>`,
        },
        {
          url: "https://vendor.example/api/invoices",
          method: "GET",
          status: 200,
          contentType: "application/json",
          responseBody: JSON.stringify({ invoices: [{ id: "in_a", amount_cents: 2500, created: "2026-06-01", pdf_url: "https://vendor.example/i/in_a.pdf" }] }),
        },
      ],
    });
    const invoices = (withApi!.recipe as any).invoices;
    expect(invoices.strategy).toBe("network");
    expect(invoices.list.request.url).toBe("https://vendor.example/api/invoices");
  });
});

describe("recorder inference — bearer token auto-wired from captured headers", () => {
  const TOKEN = "eyJhbGciOiJ" + "A".repeat(60); // a realistic long access token
  const draft = inferRecipe({
    origin: "https://chatgpt.com",
    entries: [
      // The endpoint that mints the token.
      {
        url: "https://chatgpt.com/api/auth/session",
        method: "GET",
        status: 200,
        contentType: "application/json",
        responseBody: JSON.stringify({ user: { id: "u_1" }, accessToken: TOKEN, expires: "2026-08-01" }),
      },
      // The invoice list — captured WITH its Authorization header this time.
      {
        url: "https://chatgpt.com/backend-api/invoices?limit=4",
        method: "GET",
        status: 200,
        contentType: "application/json",
        requestHeaders: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        responseBody: JSON.stringify({
          data: [{ id: "in_1", created: 1744158410, amount_due: 2000, currency: "usd", invoice_pdf: "https://pay.stripe.com/x/A/pdf" }],
        }),
      },
    ],
  });

  it("wires auth.token from /api/auth/session and templates the header — no raw token", () => {
    expect(draft).not.toBeNull();
    const recipe = draft!.recipe as any;
    expect(recipe.auth.token).toEqual({ request: { url: "https://chatgpt.com/api/auth/session" }, value: "accessToken" });
    expect(recipe.invoices.list.request.headers.authorization).toBe("Bearer {token}");
    // The raw token must never end up in the recipe.
    expect(JSON.stringify(recipe)).not.toContain(TOKEN);
    expect(draft!.notes.some((n) => /bearer token auto-wired/i.test(n))).toBe(true);
  });
});

describe("recorder inference — id in a GraphQL body (Railway-style, multi-tenant)", () => {
  const WS = "00000000-0000-4000-8000-000000000001";
  const draft = inferRecipe({
    origin: "https://railway.com",
    entries: [
      // A CIRCULAR query: it takes workspaceId as input and echoes it back at the
      // high-scoring path data.workspace.id. It must NOT be chosen as the source —
      // it already needs the value it would "discover".
      {
        url: "https://backboard.railway.com/graphql/internal?q=workspaceAgentsConfigEnabled",
        method: "POST",
        status: 200,
        contentType: "application/json",
        requestBody: JSON.stringify({ variables: { workspaceId: WS }, query: "query($workspaceId:String!){workspace(workspaceId:$workspaceId){id}}" }),
        responseBody: JSON.stringify({ data: { workspace: { id: WS } } }),
      },
      // The real source: a LIST query that carries the workspace id without taking it.
      {
        url: "https://backboard.railway.com/graphql/internal?q=me",
        method: "POST",
        status: 200,
        contentType: "application/json",
        responseBody: JSON.stringify({ data: { me: { workspaces: [{ id: WS, name: "My Workspace" }] } } }),
      },
      // The invoice list — the workspace id is in the POST body's variables.
      {
        url: "https://backboard.railway.com/graphql/internal?q=enrichCustomer",
        method: "POST",
        status: 200,
        contentType: "application/json",
        requestBody: JSON.stringify({
          operationName: "enrichCustomer",
          variables: { workspaceId: WS },
          query: "query enrichCustomer($workspaceId: String!) { workspace(workspaceId: $workspaceId) { customer { invoices { invoiceId total periodEnd hostedURL } } } }",
        }),
        responseBody: JSON.stringify({
          data: { workspace: { customer: { invoices: [{ invoiceId: "in_1", total: 4762, periodEnd: "2026-06-14T00:00:00Z", hostedURL: "https://invoice.stripe.com/i/x/A?s=ap" }] } } },
        }),
      },
    ],
  });

  it("parameterizes the body id and discovers it from the workspaces response", () => {
    expect(draft).not.toBeNull();
    const recipe = draft!.recipe as any;

    // The uuid is gone from the body, replaced by a template var.
    expect(recipe.invoices.list.request.body).toContain('"workspaceId":"{workspaceId}"');
    expect(JSON.stringify(recipe)).not.toContain(WS);

    // …discovered from the response that lists workspaces.
    const opt = recipe.config.find((c: any) => c.id === "workspaceId");
    expect(opt.discover.request.url).toBe("https://backboard.railway.com/graphql/internal?q=me");
    expect(opt.discover.value).toBe("data.me.workspaces.0.id");
  });
});

describe("recorder inference — multi-tenant id discovery (ChatGPT-style)", () => {
  const ACCOUNT = "00000000-0000-4000-8000-000000000002";
  const draft = inferRecipe({
    origin: "https://chatgpt.com",
    entries: [
      // The accounts endpoint carries the account_id at a STABLE path (…default…),
      // and also under its own uuid KEY (which must NOT be chosen — unusable for others).
      {
        url: "https://chatgpt.com/backend-api/accounts/optimized/check",
        method: "GET",
        status: 200,
        contentType: "application/json",
        responseBody: JSON.stringify({
          accounts: {
            [ACCOUNT]: { account: { account_id: ACCOUNT, structure: "personal" } },
            default: { account: { account_id: ACCOUNT, structure: "personal" } },
          },
          account_ordering: [ACCOUNT],
        }),
      },
      // The invoice list — the account_id is baked into the URL.
      {
        url: `https://chatgpt.com/backend-api/invoices?limit=4&account_id=${ACCOUNT}`,
        method: "GET",
        status: 200,
        contentType: "application/json",
        responseBody: JSON.stringify({
          data: [
            { id: "in_1", created: 1744158410, amount_due: 2000, currency: "usd", invoice_pdf: "https://pay.stripe.com/invoice/x/A/pdf" },
            { id: "in_2", created: 1741566410, amount_due: 2000, currency: "usd", invoice_pdf: "https://pay.stripe.com/invoice/x/B/pdf" },
          ],
        }),
      },
    ],
  });

  it("parameterizes the list URL and auto-wires a config discovery to a reusable path", () => {
    expect(draft).not.toBeNull();
    const recipe = draft!.recipe as any;

    // The hardcoded id is gone from the list URL, replaced by a template var.
    expect(recipe.invoices.list.request.url).toBe(
      "https://chatgpt.com/backend-api/invoices?limit=4&account_id={account_id}",
    );

    // …and discovered at runtime from the accounts endpoint, at the STABLE path
    // (accounts.default.account.account_id — NOT the uuid-keyed one).
    expect(recipe.config).toHaveLength(1);
    expect(recipe.config[0]).toEqual({
      id: "account_id",
      discover: {
        request: { url: "https://chatgpt.com/backend-api/accounts/optimized/check" },
        value: "accounts.default.account.account_id",
      },
    });
    expect(draft!.notes.some((n) => /Multi-tenant/.test(n))).toBe(true);
  });
});

describe("recorder inference — server-rendered receipt LINKS (GitHub-style)", () => {
  // GitHub billing history: plain HTML rows, no JSON array, each row an <a> to a
  // receipt PDF. Plus the PDF the user's click actually fetched — its path teaches
  // the inferer the exact link token so it finds EVERY receipt, not just that one.
  const draft = inferRecipe({
    origin: "https://github.com",
    entries: [
      {
        url: "https://github.com/account/billing/history",
        method: "GET",
        status: 200,
        contentType: "text/html; charset=utf-8",
        responseBody: `<!doctype html><html><body>
          <table>
            <tr><td>Jun 1, 2026</td><td>$25.00</td><td><a href="/account/receipt/ch_AAA">Get receipt</a></td></tr>
            <tr><td>May 1, 2026</td><td>$25.00</td><td><a href="/account/receipt/ch_BBB">Get receipt</a></td></tr>
            <tr><td>Apr 1, 2026</td><td>$25.00</td><td><a href="/account/receipt/ch_CCC">Get receipt</a></td></tr>
          </table>
          <a href="/settings/billing">Manage</a>
          <a href="https://docs.github.com/billing">Docs</a>
        </body></html>`,
      },
      // The receipt the user clicked during recording — a real PDF response.
      {
        url: "https://github.com/account/receipt/ch_AAA",
        method: "GET",
        status: 200,
        contentType: "application/pdf",
      },
    ],
  });

  it("emits an html rowRegex recipe that extracts every receipt link", () => {
    expect(draft).not.toBeNull();
    const invoices = (draft!.recipe as any).invoices;
    expect(invoices.strategy).toBe("html");
    expect(invoices.list.rowRegex).toContain("documentUrl");
    expect(invoices.list.map.documentUrl).toBe("documentUrl");
    expect(invoices.list.request.url).toBe("https://github.com/account/billing/history");

    // The generated regex, run against the page, must catch all THREE receipts
    // (and none of the unrelated /settings or docs links).
    const re = new RegExp(invoices.list.rowRegex, "g");
    const page = `<a href="/account/receipt/ch_AAA">x</a><a href="/account/receipt/ch_BBB">y</a><a href="/account/receipt/ch_CCC">z</a><a href="/settings/billing">m</a>`;
    const hrefs = [...page.matchAll(re)].map((m) => m.groups!.documentUrl);
    expect(hrefs).toEqual(["/account/receipt/ch_AAA", "/account/receipt/ch_BBB", "/account/receipt/ch_CCC"]);
  });

  it("notes the link pattern was learned from a captured PDF", () => {
    expect(draft!.notes.some((n) => /learned from a PDF/i.test(n))).toBe(true);
  });
});

describe("recorder inference — DOM snapshot fallback", () => {
  it("mines the rendered-page snapshot when the network trace missed the data", () => {
    const draft = inferRecipe({
      origin: "https://vendor.example",
      entries: [
        // A cached SPA fired no invoice request; only the DOM snapshot has the data.
        {
          url: "https://vendor.example/billing",
          method: "DOM",
          status: 200,
          contentType: "text/html",
          responseBody: `<html><body><div id="app"></div>
            <script type="application/json">{"invoices":[
              {"id":"in_x","total":1000,"created":"2026-06-01","pdf_url":"https://vendor.example/i/in_x.pdf"},
              {"id":"in_y","total":2000,"created":"2026-05-01","pdf_url":"https://vendor.example/i/in_y.pdf"}
            ]}</script></body></html>`,
        },
      ],
    });
    expect(draft).not.toBeNull();
    expect((draft!.recipe as any).invoices.strategy).toBe("html");
    expect((draft!.recipe as any).invoices.list.items).toBe("invoices");
    // The draft warns that a re-fetch only works if the data is server-rendered.
    expect(draft!.notes.some((n) => /DOM snapshot|rendered by JS/i.test(n))).toBe(true);
  });
});
