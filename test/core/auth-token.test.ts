import { describe, expect, it } from "vitest";
import { runVendor } from "../../src/core/engine";
import { networkStrategy } from "../../src/core/strategies/network";
import { htmlStrategy } from "../../src/core/strategies/html";
import { unavailableDomStrategy } from "../../src/core/strategies/dom";
import { renderHeaders } from "../../src/core/template";
import { AuthFailure } from "../../src/core/errors";
import type { HttpResponse, RequestSpec, RunContext, SeenStore, VendorRecipe } from "../../src/core/types";

/**
 * The bearer-token pre-flight (`auth.token`): the engine must fetch the token
 * FIRST, then thread it into every later request's `Authorization` header — so a
 * bearer-auth SPA (ChatGPT-style) authenticates instead of 401-ing. This proves
 * the token from /session actually reaches the invoice-list request.
 */
const recipe = {
  id: "tokenized",
  name: "Tokenized",
  homepage: "https://api.example",
  hosts: ["https://api.example/*"],
  auth: {
    token: { request: { url: "https://api.example/session" }, value: "accessToken" },
    check: { request: { url: "https://api.example/me", headers: { authorization: "Bearer {token}" } }, expect: { statusIn: [200] } },
    loginUrl: "https://api.example/login",
  },
  invoices: {
    strategy: "network",
    list: {
      request: { url: "https://api.example/invoices", headers: { authorization: "Bearer {token}" } },
      items: "data",
      map: { id: "id", issuedAt: { path: "created", transforms: [{ kind: "date" }] }, documentUrl: "pdf" },
    },
    document: { contentType: "application/pdf" },
  },
} as unknown as VendorRecipe;

describe("auth.token pre-flight", () => {
  it("threads the fetched token into later requests' Authorization header", async () => {
    const authSeen: Record<string, string | undefined> = {};

    const fetch = (spec: RequestSpec, vars: Record<string, unknown>): Promise<HttpResponse> => {
      const url = spec.url;
      const auth = renderHeaders(spec.headers, vars)?.authorization;
      authSeen[new URL(url).pathname] = auth;

      if (url.endsWith("/session")) return json(200, { accessToken: "TESTTOKEN" });
      if (url.endsWith("/me")) return json(200, { ok: true });
      if (url.endsWith("/invoices")) {
        return json(200, { data: [{ id: "in_1", created: "2026-06-01T00:00:00Z", pdf: "https://api.example/in_1.pdf" }] });
      }
      // the PDF
      return Promise.resolve({
        status: 200,
        ok: true,
        json: async () => ({}),
        arrayBuffer: async () => new TextEncoder().encode("%PDF-1.4").buffer,
        headers: { get: () => "application/pdf" },
      });
    };

    const seen: SeenStore = { has: async () => false, claimIfAbsent: async () => "test-reservation", release: async () => undefined, add: async () => {} };
    const ctx: RunContext = { companyId: "co", vars: {}, seen, fetch };
    const result = await runVendor(recipe, ctx, { network: networkStrategy, dom: unavailableDomStrategy, html: htmlStrategy });

    expect(result.documents).toHaveLength(1);
    expect(authSeen["/session"]).toBeUndefined(); // the token call itself has no bearer yet
    expect(authSeen["/me"]).toBe("Bearer TESTTOKEN"); // auth check carries it
    expect(authSeen["/invoices"]).toBe("Bearer TESTTOKEN"); // and so does the list
  });

  it.each([
    ["object", { opaque: "token" }],
    ["array", ["token"]],
    ["boolean", true],
    ["number", 42],
    ["whitespace", "   "],
    ["surrounding whitespace", " token "],
  ])("rejects a malformed %s token before any downstream request", async (_label, accessToken) => {
    let downstreamCalled = false;
    const ctx: RunContext = {
      companyId: "co",
      vars: {},
      seen: { has: async () => false, claimIfAbsent: async () => "reservation", release: async () => undefined, add: async () => undefined },
      fetch: async (spec) => {
        if (spec.url.endsWith("/session")) return json(200, { accessToken });
        downstreamCalled = true;
        return json(200, {});
      },
    };

    await expect(runVendor(recipe, ctx, {
      network: networkStrategy,
      dom: unavailableDomStrategy,
      html: htmlStrategy,
    })).rejects.toBeInstanceOf(AuthFailure);
    expect(downstreamCalled).toBe(false);
    expect(ctx.vars).not.toHaveProperty("token");
  });
});

function json(status: number, body: unknown): Promise<HttpResponse> {
  return Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: { get: () => "application/json" },
  });
}
