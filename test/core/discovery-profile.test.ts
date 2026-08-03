import { describe, expect, it } from "vitest";
import {
  assertDiscoveredRecipePolicy,
  createDiscoveredSupplierCandidateSet,
  createDiscoveredSupplierProfile,
  deriveSupplierDisplayName,
  exactOriginPattern,
  parseDiscoveredSupplierProfile,
  requiredCandidateOrigins,
  reuseDiscoveredSupplierIdentity,
  extendCandidateDocumentOrigins,
  safeEntryUrl,
} from "../../src/core/discovery";
import type { VendorRecipe } from "../../src/core/types";

const origin = "https://billing.example.com";
const entryUrl = `${origin}/account/billing`;

function domRecipe(): VendorRecipe {
  return {
    id: "candidate",
    name: "Example",
    homepage: origin,
    hosts: [`${origin}/*`],
    fetchContext: "page",
    auth: { check: { request: { url: entryUrl }, expect: { statusIn: [200] } }, loginUrl: origin },
    invoices: {
      strategy: "dom",
      list: {
        open: entryUrl,
        steps: [
          { action: "waitFor", selector: 'a[href$=".pdf"]', timeoutMs: 5_000 },
          { action: "extractAll", selector: 'a[href$=".pdf"]', attr: "href", as: "documents" },
        ],
        hrefsFrom: "documents",
      },
      document: { contentType: "application/pdf" },
    },
  };
}

function graphqlRecipe(query: string): VendorRecipe {
  return {
    id: "candidate",
    name: "Example",
    homepage: origin,
    hosts: [`${origin}/*`],
    fetchContext: "page",
    auth: { check: { request: { url: entryUrl }, expect: { statusIn: [200] } }, loginUrl: origin },
    invoices: {
      strategy: "network",
      list: {
        request: {
          url: `${origin}/graphql`,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query, variables: {}, operationName: "BillingInvoices" }),
        },
        items: "data.invoices",
        map: { id: "id", issuedAt: "issued_at", documentUrl: "pdf_url" },
      },
      document: { contentType: "application/pdf" },
    },
  };
}

describe("discovered supplier profiles", () => {
  it("stores only a strict, bounded structural recipe", () => {
    const profile = createDiscoveredSupplierProfile({
      primaryOrigin: origin,
      entryUrl,
      displayName: "Example Cloud",
      nameSource: "page",
      nameConfidence: "medium",
      adapterId: "dom-links",
      candidateCount: 3,
      recipe: domRecipe(),
      now: new Date("2026-07-18T10:00:00.000Z"),
    });

    expect(profile.id).toMatch(/^discovered-example-/);
    expect(profile.recipe.id).toBe(profile.id);
    expect(profile.recipe.name).toBe("Example Cloud");
    expect(profile.recipe.fetchContext).toBe("page");
    expect(parseDiscoveredSupplierProfile(profile)).toEqual(profile);
    expect(JSON.stringify(profile)).not.toMatch(/cookie|authorization|responseBody|requestBody/i);
  });

  it("rejects persisted profiles whose entry page retains query, fragment, userinfo, or capability-like path data", () => {
    const profile = createDiscoveredSupplierProfile({
      primaryOrigin: origin,
      entryUrl,
      displayName: "Example Cloud",
      nameSource: "page",
      nameConfidence: "medium",
      adapterId: "dom-links",
      candidateCount: 1,
      recipe: domRecipe(),
    });

    for (const unsafeEntryUrl of [
      `${entryUrl}?account=customer-123`,
      `${entryUrl}#latest-invoice`,
      `https://user:password@billing.example.com/account/billing`,
      `${origin}/0123456789abcdef0123456789abcdef/billing`,
    ]) {
      expect(() => parseDiscoveredSupplierProfile({ ...profile, entryUrl: unsafeEntryUrl })).toThrow(
        /entry page|normal HTTPS supplier page/i,
      );
    }
  });

  it("keeps a bounded ephemeral candidate set while preserving one stable supplier identity", () => {
    const first = createDiscoveredSupplierProfile({
      primaryOrigin: origin,
      entryUrl,
      displayName: "Example Cloud",
      nameSource: "page",
      nameConfidence: "medium",
      adapterId: "dom-links",
      candidateCount: 3,
      recipe: domRecipe(),
    });
    const alternativeRecipe = domRecipe();
    if (alternativeRecipe.invoices.strategy === "dom") {
      alternativeRecipe.invoices.list.open = `${origin}/receipts`;
      alternativeRecipe.auth.check.request.url = `${origin}/receipts`;
    }
    alternativeRecipe.hosts.push("https://documents.example.com/*");
    const second = createDiscoveredSupplierProfile({
      primaryOrigin: origin,
      entryUrl: `${origin}/receipts`,
      displayName: "Example Cloud",
      nameSource: "page",
      nameConfidence: "medium",
      adapterId: "dom-links",
      candidateCount: 2,
      recipe: alternativeRecipe,
    });

    expect(second.id).toBe(first.id);
    const set = createDiscoveredSupplierCandidateSet([first, second]);
    expect(set.id).toBe(first.id);
    expect(set.candidates).toHaveLength(2);
    expect(requiredCandidateOrigins(set)).toEqual([
      "https://billing.example.com/*",
      "https://documents.example.com/*",
    ]);
  });

  it("keeps identity stable across display metadata changes and reuses a legacy stored id", () => {
    const first = createDiscoveredSupplierProfile({
      primaryOrigin: origin,
      entryUrl,
      displayName: "Example Cloud",
      nameSource: "page",
      nameConfidence: "medium",
      adapterId: "dom-links",
      candidateCount: 1,
      recipe: domRecipe(),
    });
    const renamed = createDiscoveredSupplierProfile({
      primaryOrigin: origin,
      entryUrl: `${origin}/sv/fakturor`,
      displayName: "Exempel Moln",
      nameSource: "page",
      nameConfidence: "medium",
      adapterId: "dom-links",
      candidateCount: 1,
      recipe: domRecipe(),
    });
    expect(renamed.id).toBe(first.id);

    const legacyId = "discovered-example-legacy1234";
    const legacy = parseDiscoveredSupplierProfile({
      ...first,
      id: legacyId,
      recipe: { ...first.recipe, id: legacyId },
    });
    const rebound = reuseDiscoveredSupplierIdentity(renamed, legacy);
    expect(rebound.id).toBe(legacyId);
    expect(rebound.recipe.id).toBe(legacyId);
    expect(rebound.displayName).toBe("Exempel Moln");
  });

  it("computes the candidate permissions that are unused by the elected winner", () => {
    const first = createDiscoveredSupplierProfile({
      primaryOrigin: origin,
      entryUrl,
      displayName: "Example Cloud",
      nameSource: "page",
      nameConfidence: "medium",
      adapterId: "dom-links",
      candidateCount: 1,
      recipe: domRecipe(),
    });
    const fallbackRecipe = domRecipe();
    fallbackRecipe.hosts.push("https://losing-documents.example.com/*");
    fallbackRecipe.auth.check.request.url = `${origin}/receipts`;
    if (fallbackRecipe.invoices.strategy === "dom") fallbackRecipe.invoices.list.open = `${origin}/receipts`;
    const fallback = createDiscoveredSupplierProfile({
      primaryOrigin: origin,
      entryUrl: `${origin}/receipts`,
      displayName: "Example Cloud",
      nameSource: "page",
      nameConfidence: "medium",
      adapterId: "dom-links",
      candidateCount: 1,
      recipe: fallbackRecipe,
    });
    const set = createDiscoveredSupplierCandidateSet([first, fallback]);

    expect(requiredCandidateOrigins(set).filter((host) => !first.recipe.hosts.includes(host))).toEqual([
      "https://losing-documents.example.com/*",
    ]);
  });

  it("extends only Stripe-backed candidates with a newly observed exact upload origin", () => {
    const stripeRecipe = domRecipe();
    stripeRecipe.hosts.push("https://pay.stripe.com/*");
    const stripe = createDiscoveredSupplierProfile({
      primaryOrigin: origin,
      entryUrl,
      displayName: "Example Cloud",
      nameSource: "page",
      nameConfidence: "medium",
      adapterId: "dom-links",
      candidateCount: 1,
      recipe: stripeRecipe,
    });
    const fallbackRecipe = domRecipe();
    fallbackRecipe.auth.check.request.url = `${origin}/receipts`;
    if (fallbackRecipe.invoices.strategy === "dom") fallbackRecipe.invoices.list.open = `${origin}/receipts`;
    const fallback = createDiscoveredSupplierProfile({
      primaryOrigin: origin,
      entryUrl: `${origin}/receipts`,
      displayName: "Example Cloud",
      nameSource: "page",
      nameConfidence: "medium",
      adapterId: "dom-links",
      candidateCount: 1,
      recipe: fallbackRecipe,
    });
    const set = createDiscoveredSupplierCandidateSet([stripe, fallback]);
    const extended = extendCandidateDocumentOrigins(set, [
      "https://stripe-upload-api.s3.eu-north-1.amazonaws.com/*",
    ]);

    const learnedOrigin =
      "https://stripe-upload-api.s3.eu-north-1.amazonaws.com/*";
    expect(requiredCandidateOrigins(extended)).toContain(learnedOrigin);
    expect(extended.candidates[0].recipe.hosts).toContain(learnedOrigin);
    expect(extended.candidates[1].recipe.hosts).not.toContain(learnedOrigin);
    expect(() => extendCandidateDocumentOrigins(set, ["https://other-bucket.s3.eu-north-1.amazonaws.com/*"]))
      .toThrow(/invalid/);
  });

  it("extends only semantic-action candidates with an action-proven document origin", () => {
    const semanticRecipe = domRecipe();
    if (semanticRecipe.invoices.strategy === "dom") {
      semanticRecipe.invoices.list.steps = [
        { action: "extractSemanticDownloads", as: "documents", maxActions: 8 },
      ];
      semanticRecipe.invoices.list.hrefsFrom = "documents";
    }
    const semantic = createDiscoveredSupplierProfile({
      primaryOrigin: origin,
      entryUrl,
      displayName: "Example Cloud",
      nameSource: "page",
      nameConfidence: "medium",
      adapterId: "dom-actions",
      candidateCount: 4,
      recipe: semanticRecipe,
    });
    const links = createDiscoveredSupplierProfile({
      primaryOrigin: origin,
      entryUrl,
      displayName: "Example Cloud",
      nameSource: "page",
      nameConfidence: "medium",
      adapterId: "dom-links",
      candidateCount: 4,
      recipe: domRecipe(),
    });

    const extended = extendCandidateDocumentOrigins(
      createDiscoveredSupplierCandidateSet([semantic, links]),
      ["https://assets.withorb.com/*"],
    );

    expect(extended.candidates[0].recipe.hosts).toContain("https://assets.withorb.com/*");
    expect(extended.candidates[1].recipe.hosts).not.toContain("https://assets.withorb.com/*");
  });

  it("rejects broad, local, mutating, secret-bearing, and clicking recipes", () => {
    expect(() => exactOriginPattern("http://billing.example.com")).toThrow(/HTTPS/);
    expect(() => exactOriginPattern("https://127.0.0.1")).toThrow(/HTTPS/);

    const broad = domRecipe();
    broad.hosts = ["https://*.example.com/*"];
    expect(() => assertDiscoveredRecipePolicy(broad, origin, entryUrl)).toThrow(/exact public/);

    const clicking = domRecipe();
    if (clicking.invoices.strategy === "dom") {
      (clicking.invoices.list.steps as Array<{ action: string; selector?: string }>)
        .unshift({ action: "click", selector: "button" });
    }
    expect(() => assertDiscoveredRecipePolicy(clicking, origin, entryUrl)).toThrow(/cannot click/);

    const secret = domRecipe();
    secret.auth.check.request.url = `${origin}/api/invoices?access_token=secret-value`;
    expect(() => assertDiscoveredRecipePolicy(secret, origin, entryUrl)).toThrow(/credential-like query/);
  });

  it("rejects special-purpose IPv4 origins while allowing a public address", () => {
    for (const address of [
      "100.64.0.1",
      "169.254.1.1",
      "192.0.0.1",
      "192.0.2.1",
      "192.88.99.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "240.0.0.1",
    ]) {
      expect(() => exactOriginPattern(`https://${address}`)).toThrow(/exact HTTPS/);
    }
    expect(exactOriginPattern("https://8.8.8.8")).toBe("https://8.8.8.8/*");
  });

  it("allows only the packaged bounded continuation primitive for discovered DOM suppliers", () => {
    const continuing = domRecipe();
    if (continuing.invoices.strategy === "dom") {
      continuing.invoices.list.continuation = {
        mode: "auto",
        maxActions: 8,
        maxDocuments: 500,
        timeoutMs: 30_000,
        allowScroll: true,
      };
    }
    expect(() => assertDiscoveredRecipePolicy(continuing, origin, entryUrl)).not.toThrow();
  });

  it("allows the packaged semantic-download primitive but still rejects arbitrary clicks", () => {
    const semantic = domRecipe();
    if (semantic.invoices.strategy === "dom") {
      semantic.invoices.list.steps = [{ action: "extractSemanticDownloads", as: "documents", maxActions: 8 }];
    }
    expect(() => assertDiscoveredRecipePolicy(semantic, origin, entryUrl)).not.toThrow();

    const unbounded = structuredClone(semantic);
    if (unbounded.invoices.strategy === "dom") {
      unbounded.invoices.list.steps = [{ action: "extractSemanticDownloads", as: "documents", maxActions: 50 }];
    }
    expect(() => assertDiscoveredRecipePolicy(unbounded, origin, entryUrl)).toThrow(/semantic action budget/);
  });

  it("allows only an explicit read-only GraphQL POST", () => {
    expect(() => assertDiscoveredRecipePolicy(
      graphqlRecipe("query BillingInvoices { invoices { id issued_at pdf_url } }"),
      origin,
      entryUrl,
    )).not.toThrow();
    expect(() => assertDiscoveredRecipePolicy(
      graphqlRecipe("mutation DeleteInvoice { deleteInvoice(id: 1) { id } }"),
      origin,
      entryUrl,
    )).toThrow(/read-only GraphQL/);

    const arbitraryPost = graphqlRecipe("query BillingInvoices { invoices { id } }");
    if (arbitraryPost.invoices.strategy === "network") {
      arbitraryPost.invoices.list.request.body = JSON.stringify({ action: "export-all" });
    }
    expect(() => assertDiscoveredRecipePolicy(arbitraryPost, origin, entryUrl)).toThrow(/read-only GraphQL/);
  });

  it("drops unsafe page URL data and derives a conservative provisional name", () => {
    expect(safeEntryUrl(`${entryUrl}?token=secret#invoice`)).toBe(`${entryUrl}`);
    expect(safeEntryUrl(`${origin}/#settings/Billing`)).toBe(`${origin}/#settings/Billing`);
    expect(safeEntryUrl(`${origin}/#access_token=secret`)).toBe(`${origin}/`);
    expect(safeEntryUrl(`${origin}/#settings/billing/cancel`)).toBe(`${origin}/`);
    expect(safeEntryUrl(`${origin}/eyJabcdefghijklmnopqrstuvwxyz0123456789abcdef`)).toBe(`${origin}/`);
    expect(deriveSupplierDisplayName({ origin, title: "Invoices | Example Cloud" })).toEqual({
      name: "Example Cloud",
      source: "page",
      confidence: "medium",
    });
    expect(deriveSupplierDisplayName({ origin })).toEqual({ name: "Example", source: "domain", confidence: "low" });
  });

  it("allows a bounded billing SPA fragment as a discovered DOM entry page", () => {
    const spaEntry = `${origin}/#settings/Billing`;
    const recipe = domRecipe();
    recipe.auth.check.request.url = `${origin}/`;
    if (recipe.invoices.strategy === "dom") recipe.invoices.list.open = spaEntry;

    expect(() => assertDiscoveredRecipePolicy(recipe, origin, spaEntry)).not.toThrow();
  });

  it("keeps a tenant identifier only with an explicit container and billing intent", () => {
    const tenantEntry = `${origin}/accounts/a473171df3249291b4be6fca57bb8444/billing/subscriptions`;
    expect(safeEntryUrl(tenantEntry)).toBe(tenantEntry);

    const tenantRecipe = domRecipe();
    tenantRecipe.auth.check.request.url = tenantEntry;
    if (tenantRecipe.invoices.strategy === "dom") tenantRecipe.invoices.list.open = tenantEntry;
    expect(() => assertDiscoveredRecipePolicy(tenantRecipe, origin, tenantEntry)).not.toThrow();

    expect(safeEntryUrl(`${origin}/a473171df3249291b4be6fca57bb8444/settings/team`)).toBe(`${origin}/`);
    expect(safeEntryUrl(`${origin}/a473171df3249291b4be6fca57bb8444/billing`)).toBe(`${origin}/`);
    expect(safeEntryUrl(`${origin}/token/a473171df3249291b4be6fca57bb8444/billing`)).toBe(`${origin}/`);
  });

  it("rejects opaque GraphQL variables and accepts only reviewed templates and pagination constants", () => {
    const safe = graphqlRecipe("query BillingInvoices($workspaceId: ID!, $first: Int!) { invoices { id } }");
    if (safe.invoices.strategy === "network") {
      safe.invoices.list.request.body = JSON.stringify({
        query: "query BillingInvoices($workspaceId: ID!, $first: Int!) { invoices { id } }",
        variables: { workspaceId: "{workspaceId}", first: 100 },
      });
    }
    expect(() => assertDiscoveredRecipePolicy(safe, origin, entryUrl)).not.toThrow();

    const safeStatic = graphqlRecipe("query BillingInvoices($status: String!) { invoices { id } }");
    if (safeStatic.invoices.strategy === "network") {
      safeStatic.invoices.list.request.body = JSON.stringify({
        query: "query BillingInvoices($status: String!) { invoices { id } }",
        variables: { status: "paid" },
      });
    }
    expect(() => assertDiscoveredRecipePolicy(safeStatic, origin, entryUrl)).not.toThrow();

    // A template names a runtime scope discovery, so it carries no captured
    // identity at rest — including for the account/customer scoping that most
    // billing APIs actually use. A bounded tenant identifier is the same shape
    // a first-party billing path may already carry.
    for (const variables of [
      { customerId: "{customerId}" },
      { accountId: "{accountId}" },
      { workspaceId: "9012345678901" },
    ]) {
      const scoped = graphqlRecipe("query BillingInvoices { invoices { id } }");
      if (scoped.invoices.strategy === "network") {
        scoped.invoices.list.request.body = JSON.stringify({ query: "query BillingInvoices { invoices { id } }", variables });
      }
      expect(() => assertDiscoveredRecipePolicy(scoped, origin, entryUrl)).not.toThrow();
    }

    for (const variables of [
      { accessToken: "{token}" },
      { apiKey: "{apiKey}" },
      { sessionId: "opaque" },
      { customerId: "cus_JaneExampleAccount" },
      { accountId: 90121800034 },
      { workspaceId: "raw-workspace-value" },
      { filter: "Jane Example's confidential invoices" },
    ]) {
      const unsafe = graphqlRecipe("query BillingInvoices { invoices { id } }");
      if (unsafe.invoices.strategy === "network") {
        unsafe.invoices.list.request.body = JSON.stringify({ query: "query BillingInvoices { invoices { id } }", variables });
      }
      expect(() => assertDiscoveredRecipePolicy(unsafe, origin, entryUrl)).toThrow(/read-only GraphQL/);
    }
  });

  it("replays the query data a billing endpoint is addressed by, and nothing personal", () => {
    const withQuery = (query: string): VendorRecipe => {
      const recipe = domRecipe();
      return {
        ...recipe,
        invoices: {
          strategy: "network",
          list: {
            request: { url: `${origin}/api/invoices${query}` },
            items: "invoices",
            map: { id: "id", issuedAt: "issued_at", documentUrl: "pdf_url" },
          },
          document: { contentType: "application/pdf" },
        },
      };
    };

    for (const query of [
      "?q=enrichCustomer",
      "?year=2026&view=list",
      "?since=2026-01-01&status=paid",
      "?workspace_id=9012345678901",
      "?page=2&per_page=25",
      // A billing list is routinely scoped by the account it belongs to. That
      // identifier is the address of the resource, not a capability.
      "?customer=cus_1PabcDEFghi",
    ]) {
      expect(() => assertDiscoveredRecipePolicy(withQuery(query), origin, entryUrl)).not.toThrow();
    }

    for (const query of [
      "?token=YWNjdF8xUGFiY0RFRmdoaUpLTA",
      "?filter=owner%40example.com",
      "?q=Jane%20Example",
      "?ref=YWNjdF8xUGFiY0RFRmdoaUpLTG1ub3A",
      `?note=${"a".repeat(80)}`,
    ]) {
      expect(() => assertDiscoveredRecipePolicy(withQuery(query), origin, entryUrl))
        .toThrow(/credential-like query data/);
    }
  });

  it("keeps the schema vocabulary a real billing query needs", () => {
    // None of these can carry a captured identity: a page size, a schema enum,
    // and a variable reference. Rejecting them only cost candidates.
    for (const query of [
      "query BillingInvoices($first: Int!) { invoices(first: $first, status: PAID) { id } }",
      "query BillingInvoices { invoices(first: 100, includeVoided: false) { id } }",
    ]) {
      const safe = graphqlRecipe(query);
      if (safe.invoices.strategy === "network") {
        safe.invoices.list.request.body = JSON.stringify({ query, variables: { first: 100 } });
      }
      expect(() => assertDiscoveredRecipePolicy(safe, origin, entryUrl)).not.toThrow();
    }
  });

  it("rejects inline GraphQL literals and arguments that could persist account data", () => {
    for (const query of [
      'query BillingInvoices { invoices(customerId: "acct_123", email: "owner@example.com") { id } }',
      "query BillingInvoices { invoices(team: 90121800034) { id } }",
      "query BillingInvoices { invoices(account: acct_1PabcDEFghiJKL) { id } }",
      "query BillingInvoices { invoices(filter: {customerId: acct_1Pabc}) { id } }",
    ]) {
      const unsafe = graphqlRecipe(query);
      if (unsafe.invoices.strategy === "network") {
        unsafe.invoices.list.request.body = JSON.stringify({ query, variables: {} });
      }
      expect(() => assertDiscoveredRecipePolicy(unsafe, origin, entryUrl)).toThrow(/read-only GraphQL/);
    }
  });

  it("permits only non-secret discovered config scopes and never routes them into credentials", () => {
    const tenant = domRecipe();
    tenant.config = [{
      id: "workspaceId",
      discover: { request: { url: `${origin}/api/workspaces/current` }, value: "workspace.id" },
    }];
    expect(() => assertDiscoveredRecipePolicy(tenant, origin, entryUrl)).not.toThrow();

    const tokenScope = domRecipe();
    tokenScope.config = [{
      id: "token",
      discover: { request: { url: `${origin}/api/session` }, value: "access_token" },
    }];
    expect(() => assertDiscoveredRecipePolicy(tokenScope, origin, entryUrl)).toThrow(/config scope/i);

    const credentialUse = domRecipe();
    credentialUse.auth.check.request.url = `${origin}/api/invoices?access_token={workspaceId}`;
    credentialUse.config = [{
      id: "workspaceId",
      discover: { request: { url: `${origin}/api/workspaces/current` }, value: "workspace.id" },
    }];
    expect(() => assertDiscoveredRecipePolicy(credentialUse, origin, entryUrl)).toThrow(/credential-like query/i);

    const credentialPath = domRecipe();
    credentialPath.auth.check.request.url = `${origin}/api/access_token/{workspaceId}`;
    credentialPath.config = [{
      id: "workspaceId",
      discover: { request: { url: `${origin}/api/workspaces/current` }, value: "workspace.id" },
    }];
    expect(() => assertDiscoveredRecipePolicy(credentialPath, origin, entryUrl)).toThrow(/credential-like path/i);

    const tenantPath = domRecipe();
    tenantPath.auth.check.request.url = `${origin}/api/teams/{teamId}/billing`;
    tenantPath.config = [{
      id: "teamId",
      discover: { request: { url: `${origin}/api/teams/current` }, value: "team.id" },
    }];
    expect(() => assertDiscoveredRecipePolicy(tenantPath, origin, entryUrl)).not.toThrow();

    const untypedValue = domRecipe();
    untypedValue.auth.check.request.url = `${origin}/api/teams/{teamId}/billing`;
    untypedValue.config = [{
      id: "teamId",
      discover: { request: { url: `${origin}/api/teams/current` }, value: "data.value" },
    }];
    expect(() => assertDiscoveredRecipePolicy(untypedValue, origin, entryUrl)).toThrow(/config scope/i);
  });

  it("rejects a restored entry URL that was not canonicalized at creation", () => {
    const unsafe = domRecipe();
    const credentialPath = `${origin}/accounts/a473171df3249291b4be6fca57bb8444/billing?token=secret`;
    unsafe.auth.check.request.url = credentialPath;
    if (unsafe.invoices.strategy === "dom") unsafe.invoices.list.open = credentialPath;
    expect(() => assertDiscoveredRecipePolicy(unsafe, origin, credentialPath)).toThrow(/entry page cannot contain/);
  });
});
