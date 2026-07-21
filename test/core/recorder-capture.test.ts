import { describe, expect, it } from "vitest";
import { buildEntry, createCaptureRedactionContext, detectRequestAuth, MAX_BODY_CHARS, sanitizeBody, sanitizeHeaders, sanitizeUrl } from "../../src/core/recorder/cdp";
import { inferRecipe } from "../../src/core/recorder/infer";

/**
 * Capture-layer guarantees: authentication material never reaches session
 * storage. Non-sensitive structure remains available for recipe inference.
 */
describe("request-header capture", () => {
  it("allowlists only normalized content-type values", () => {
    const clean = sanitizeHeaders({
      Authorization: "Bearer abc",
      "Content-Type": "application/json; charset=utf-8",
      Accept: "application/json",
      "X-Custom-Auth": "random-high-entropy-credential-0123456789",
      Cookie: "session=secret",
    });
    expect(clean).toEqual({ "content-type": "application/json" });
    expect(JSON.stringify(clean)).not.toMatch(/secret|high-entropy|credential/i);
  });

  it("returns undefined when nothing survives sanitizing", () => {
    expect(sanitizeHeaders({ cookie: "x" })).toBeUndefined();
    expect(sanitizeHeaders(undefined)).toBeUndefined();
  });

  it("buildEntry attaches sanitized request headers", () => {
    const entry = buildEntry({
      url: "https://api.example/invoices",
      method: "get",
      status: 200,
      contentType: "application/json",
      body: "{}",
      requestHeaders: { Authorization: "Bearer t", Cookie: "c=1" },
    });
    expect(entry.requestHeaders).toBeUndefined();
    expect(entry.requestAuth).toEqual({ scheme: "bearer", headerName: "authorization" });
    expect(JSON.stringify(entry)).not.toContain("Bearer t");
  });

  it.each([
    [{ Authorization: "Bearer synthetic-secret" }, { scheme: "bearer", headerName: "authorization" }],
    [{ AUTHORIZATION: "Basic synthetic-secret" }, { scheme: "basic", headerName: "authorization" }],
    [{ "X-Supplier-Session": "synthetic-secret" }, { scheme: "custom", headerName: "x-supplier-session" }],
    [{ Cookie: "sid=synthetic-secret" }, { scheme: "custom", headerName: "cookie" }],
    [{ Accept: "application/json" }, { scheme: "none" }],
    [{ ["x".repeat(100)]: "synthetic-secret" }, { scheme: "none" }],
  ])("keeps only bounded authentication structure for %o", (headers, expected) => {
    expect(detectRequestAuth(headers)).toEqual(expected);
    const serialized = JSON.stringify(buildEntry({
      url: "https://api.example/invoices",
      method: "GET",
      status: 200,
      contentType: "application/json",
      requestHeaders: headers,
    }));
    expect(serialized).not.toContain("synthetic-secret");
  });

  it("redacts URL values and secret-bearing JSON fields", () => {
    expect(sanitizeUrl("https://api.example/invoices?account=123&sig=secret#row")).toBe(
      "https://api.example/invoices?account=REDACTED&sig=REDACTED",
    );
    const body = sanitizeBody('{"invoice":{"id":"inv_1"},"accessToken":"secret-value"}', "application/json");
    expect(JSON.parse(body)).toEqual({ invoice: { id: "inv_1" }, accessToken: "REDACTED" });
    const entry = buildEntry({
      url: "https://api.example/session",
      method: "GET",
      status: 200,
      contentType: "application/json",
      body: '{"nested":{"accessToken":"secret-value"},"not_tokenized":"also-redacted"}',
    });
    expect(entry.redactedResponsePaths).toEqual(["nested.accessToken", "not_tokenized"]);
    expect(JSON.stringify(entry)).not.toContain("secret-value");
  });

  it("redacts high-entropy path capabilities and UUIDs", () => {
    const clean = sanitizeUrl(
      "https://files.example/invoice/in_1234567890abcdefghijklmnop/550e8400-e29b-41d4-a716-446655440000/pdf",
    );
    expect(clean).toBe("https://files.example/invoice/REDACTED/REDACTED/pdf");
    expect(clean).not.toContain("in_1234567890");
    expect(clean).not.toContain("550e8400");
  });

  it("stores only opaque session-local aliases for correlated identifier values", () => {
    const accountId = "550e8400-e29b-41d4-a716-446655440000";
    const context = createCaptureRedactionContext();
    const source = buildEntry({
      url: "https://api.example/accounts/default",
      method: "GET",
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ account: { account_id: accountId } }),
      redactionContext: context,
    });
    const list = buildEntry({
      url: `https://api.example/invoices?limit=100&account_id=${accountId}`,
      method: "GET",
      status: 200,
      contentType: "application/json",
      body: "{}",
      redactionContext: context,
    });

    expect(source.responseBody).toContain("ref_1");
    expect(list.url).toBe("https://api.example/invoices?limit=100&account_id=__ratatosk_ref_1__");
    expect(list.urlValueAliases).toEqual([{ location: "query", key: "account_id", alias: "ref_1" }]);
    expect(JSON.stringify({ source, list })).not.toContain(accountId);
  });

  it("removes PII fields and emails from captured JSON, including arrays", () => {
    const entry = buildEntry({
      url: "https://api.example/invoices",
      method: "GET",
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { email: "owner@example.com", name: "Owner Name" },
        customer_names: ["Jane Doe", "John Doe"],
        note: "Contact owner@example.com for a copy",
        invoices: [{ id: "inv_1", amount: 1200 }],
      }),
    });

    expect(JSON.parse(entry.responseBody!)).toEqual({
      user: { email: "REDACTED", name: "REDACTED" },
      customer_names: "REDACTED",
      note: "Contact user@example.com for a copy",
      invoices: [{ id: "inv_1", amount: 1200 }],
    });
    expect(entry.redactedResponsePaths).toEqual(["user.email", "user.name", "customer_names"]);
    expect(entry.responseBody).not.toContain("owner@example.com");
  });

  it("redacts camelCase PII fields and customer-scoped short path values", () => {
    const entry = buildEntry({
      url: "https://api.example/customers/alice-smith/receipts",
      method: "GET",
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        firstName: "Alice",
        customerName: "Alice Smith",
        billingAddress: "1 Main Street",
        credential: "short-credential-42",
        passcode: "1234",
      }),
    });

    expect(entry.url).toBe("https://api.example/customers/REDACTED/receipts");
    expect(JSON.parse(entry.responseBody!)).toEqual({
      firstName: "REDACTED",
      customerName: "REDACTED",
      billingAddress: "REDACTED",
      credential: "REDACTED",
      passcode: "REDACTED",
    });
    expect(JSON.stringify(entry)).not.toMatch(/Alice|Main Street|alice-smith|short-credential-42|1234/i);
  });

  it("sanitizes signed and capability-bearing URLs embedded in JSON values", () => {
    const capability = "capability-1234567890abcdefghijklmnop";
    const signature = "signed-secret-value";
    const entry = buildEntry({
      url: "https://api.example/invoices",
      method: "GET",
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        document_url: `https://files.example/download/${capability}?X-Amz-Signature=${signature}`,
        href: `/receipts/${capability}?signature=${signature}`,
      }),
    });

    expect(JSON.parse(entry.responseBody!)).toEqual({
      document_url: "https://files.example/download/REDACTED?X-Amz-Signature=REDACTED",
      href: "/receipts/REDACTED?signature=REDACTED",
    });
    expect(entry.responseBody).not.toContain(capability);
    expect(entry.responseBody).not.toContain(signature);
  });

  it("keeps only sanitized document links from HTML and redacts form-like bodies", () => {
    const html = buildEntry({
      url: "https://vendor.example/billing",
      method: "GET",
      status: 200,
      contentType: "text/html",
      body: '<main>Jane Doe owner@example.com <a href="/receipt/inv_1?token=secret">Download</a><script>password=hunter2</script></main>',
    });
    expect(html.responseBody).toBe('<a href="/receipt/inv_1?token=REDACTED"></a>');
    expect(html.responseBody).not.toMatch(/Jane|owner@example|hunter2/);

    const form = buildEntry({
      url: "https://vendor.example/export",
      method: "POST",
      status: 200,
      contentType: "application/json",
      requestHeaders: { "content-type": "application/x-www-form-urlencoded" },
      requestBody: "email=owner%40example.com&password=hunter2&account_id=1234567",
      body: "{}",
    });
    expect(form.requestBody).toBe("email=REDACTED&password=REDACTED&account_id=REDACTED");

    expect(sanitizeBody('{"password":"hunter2"', "application/json")).not.toContain("hunter2");
  });

  it("never persists a secret from an oversized JSON body that cannot be safely parsed", () => {
    const secret = "unredacted-capture-secret";
    const entry = buildEntry({
      url: "https://api.example/invoices",
      method: "GET",
      status: 200,
      contentType: "application/json",
      body: `{"accessToken":"${secret}","padding":"${"x".repeat(MAX_BODY_CHARS)}"}`,
    });

    expect(entry.responseBody).toBe('{"__ratatosk_truncated__":true}');
    expect(JSON.stringify(entry)).not.toContain(secret);
  });

  it("drops malformed JSON-like bodies rather than relying on textual credential matching", () => {
    const secret = "short-passcode-42";
    const entry = buildEntry({
      url: "https://api.example/invoices",
      method: "POST",
      status: 200,
      contentType: "application/json",
      requestBody: `{"passcode":"${secret}",`,
      body: `{"credential":"${secret}",`,
    });

    expect(entry.requestBody).toBe('{"__ratatosk_malformed__":true}');
    expect(entry.responseBody).toBe('{"__ratatosk_malformed__":true}');
    expect(JSON.stringify(entry)).not.toContain(secret);
  });

  it("retains only structural GraphQL request values and redacts arbitrary variables", () => {
    const workspaceId = "00000000-0000-4000-8000-000000000095";
    const customerName = "Jane Example";
    const invoiceDescription = "Private consulting work for Jane Example";
    const entry = buildEntry({
      url: "https://api.example/graphql",
      method: "POST",
      status: 200,
      contentType: "application/json",
      requestHeaders: { "content-type": "application/json" },
      requestBody: JSON.stringify({
        operationName: "BillingInvoices",
        query: "query BillingInvoices($workspaceId: ID!, $status: String!) { invoices { id } }",
        variables: {
          workspaceId,
          status: "paid",
          customerName,
          filter: invoiceDescription,
        },
      }),
      body: "{}",
      redactionContext: createCaptureRedactionContext(),
    });

    expect(JSON.parse(entry.requestBody!)).toEqual({
      operationName: "BillingInvoices",
      query: "query BillingInvoices($workspaceId: ID!, $status: String!) { invoices { id } }",
      variables: {
        workspaceId: "ref_1",
        status: "paid",
        customerName: "REDACTED",
        filter: "REDACTED",
      },
    });
    expect(JSON.stringify(entry)).not.toContain(workspaceId);
    expect(JSON.stringify(entry)).not.toContain(customerName);
    expect(JSON.stringify(entry)).not.toContain(invoiceDescription);
  });

  it("redacts personal JSON property names and percent-encoded personal route segments", () => {
    const emailKey = "owner@example.com";
    const encodedEmail = "alice%40example.com";
    const entry = buildEntry({
      url: `https://api.example/customers/${encodedEmail}/invoices`,
      method: "GET",
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        [emailKey]: { billingAddress: "1 Private Road" },
        invoices: [{ id: "inv_1", created: "2026-07-01", amount: 1200 }],
      }),
    });

    expect(entry.url).toBe("https://api.example/customers/REDACTED/invoices");
    expect(JSON.stringify(entry)).not.toContain(emailKey);
    expect(JSON.stringify(entry)).not.toContain(encodedEmail);
    expect(JSON.stringify(entry)).not.toContain("1 Private Road");

    const fixtureEntry = buildEntry({
      url: "https://api.example/invoices",
      method: "GET",
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        [emailKey]: { billingAddress: "1 Private Road" },
        invoices: [{ id: "inv_1", created: "2026-07-01", amount: 1200 }],
      }),
    });
    const draft = inferRecipe({ origin: "https://api.example", entries: [fixtureEntry] });
    expect(draft).not.toBeNull();
    expect(JSON.stringify(draft!.fixture)).not.toContain(emailKey);
    expect(JSON.stringify(draft!.fixture)).not.toContain("1 Private Road");
  });

  it("redacts payment fields and valid payment values before persisting capture", () => {
    const cardNumber = "4111 1111 1111 1111";
    const iban = "GB82 WEST 1234 5698 7654 32";
    const entry = buildEntry({
      url: "https://api.example/billing",
      method: "GET",
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cardNumber,
        cvv: "123",
        bankAccount: "123456789",
        routingNumber: "021000021",
        iban,
        note: `card=${cardNumber}`,
        paymentReference: iban,
      }),
    });

    expect(JSON.parse(entry.responseBody!)).toEqual({
      cardNumber: "REDACTED",
      cvv: "REDACTED",
      bankAccount: "REDACTED",
      routingNumber: "REDACTED",
      iban: "REDACTED",
      note: "REDACTED",
      paymentReference: "REDACTED",
    });
    expect(JSON.stringify(entry)).not.toContain(cardNumber);
    expect(JSON.stringify(entry)).not.toContain(iban);
  });

  it("does not misclassify a UUID tenant identifier as a payment card", () => {
    const organizationId = "11111111-2222-4333-8444-555555555555";
    const entry = buildEntry({
      url: "https://api.example/organizations/current",
      method: "GET",
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ organization: { id: organizationId } }),
      redactionContext: createCaptureRedactionContext(),
    });

    expect(entry.responseBody).toContain("ref_1");
    expect(entry.responseBody).not.toContain(organizationId);
  });
});
