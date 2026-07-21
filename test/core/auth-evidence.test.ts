import { describe, expect, it } from "vitest";
import { assertAuthenticated, classifyAuthResponse, resolveAuthToken } from "../../src/core/auth";
import { AuthExpired, AuthFailure } from "../../src/core/errors";
import type { HttpResponse, RunContext, VendorRecipe } from "../../src/core/types";

describe("adapter-safe authentication evidence", () => {
  it("rejects a successful login redirect instead of treating status 200 as authenticated", () => {
    expect(classifyAuthResponse(response({
      status: 200,
      url: "https://vendor.example/login?return_to=%2Fbilling",
      redirected: true,
      contentType: "text/html",
    }), true, "https://vendor.example/account/billing")).toBe("session_expired");
  });

  it("distinguishes scope denial, challenge pages, and transport failure", () => {
    expect(classifyAuthResponse(response({ status: 403 }), false, "https://vendor.example/me")).toBe("insufficient_scope");
    expect(classifyAuthResponse(response({ status: 200, contentType: "text/html" }), false, "https://vendor.example/api/me")).toBe("blocked_or_challenged");
    expect(classifyAuthResponse(response({ status: 0 }), false, "https://vendor.example/me")).toBe("transport_failed");
    expect(classifyAuthResponse(response({ status: 407 }), false, "https://vendor.example/me")).toBe("transport_failed");
    expect(classifyAuthResponse(response({
      status: 200,
      url: "https://api.vendor-cdn.example/session",
      redirected: true,
    }), true, "https://vendor.example/me")).toBe("blocked_or_challenged");
  });

  it("rejects unexpected same-origin redirects and allows only a canonical slash", () => {
    for (const finalUrl of [
      "https://vendor.example/",
      "https://vendor.example/welcome",
      "https://vendor.example/account",
    ]) {
      expect(classifyAuthResponse(response({ status: 200, url: finalUrl, redirected: true }), true, "https://vendor.example/me"))
        .toBe("blocked_or_challenged");
    }
    expect(classifyAuthResponse(
      response({ status: 200, url: "https://vendor.example/me/", redirected: true }),
      true,
      "https://vendor.example/me",
    )).toBe("authenticated");
  });

  it("fails closed when redirected metadata omits the final URL", () => {
    expect(classifyAuthResponse(response({ status: 200, redirected: true }), true, "https://vendor.example/me"))
      .toBe("blocked_or_challenged");
  });

  it("accepts positive structural evidence when no redirect or auth failure is present", () => {
    expect(classifyAuthResponse(response({ status: 200, contentType: "application/json" }), true, "https://vendor.example/me"))
      .toBe("authenticated");
  });

  it("reports proxy authentication as transport failure, never vendor session expiry", async () => {
    const recipe = {
      id: "proxy-auth",
      auth: { check: { request: { url: "https://vendor.example/me" }, expect: { statusIn: [200] } } },
    } as unknown as VendorRecipe;
    const ctx: RunContext = {
      companyId: "company",
      vars: {},
      seen: { has: async () => false, claimIfAbsent: async () => "reservation", release: async () => undefined, add: async () => undefined },
      fetch: async () => response({ status: 407 }),
    };

    const error = await assertAuthenticated(recipe, ctx).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AuthFailure);
    expect(error).not.toBeInstanceOf(AuthExpired);
    expect(error).toMatchObject({ kind: "transport_failed" });
  });

  it("classifies templated auth and token URLs against their rendered origin", async () => {
    const recipe = {
      id: "templated-auth",
      auth: {
        check: { request: { url: "https://{host}/me" }, expect: { statusIn: [200] } },
        token: { request: { url: "https://{host}/token" }, value: "accessToken" },
      },
    } as unknown as VendorRecipe;
    const responses = [
      response({ status: 200, url: "https://vendor.example/me/", redirected: true }),
      response({ status: 200, url: "https://vendor.example/token/", redirected: true, json: { accessToken: "token" } }),
    ];
    const ctx: RunContext = {
      companyId: "company",
      vars: { host: "vendor.example" },
      seen: { has: async () => false, claimIfAbsent: async () => "test-reservation", release: async () => undefined, add: async () => undefined },
      fetch: async () => responses.shift()!,
    };

    await expect(assertAuthenticated(recipe, ctx)).resolves.toBeUndefined();
    await expect(resolveAuthToken(recipe, ctx)).resolves.toBeUndefined();
    expect(ctx.vars.token).toBe("token");
  });
});

function response(input: { status: number; url?: string; redirected?: boolean; contentType?: string; json?: unknown }): HttpResponse {
  return {
    status: input.status,
    ok: input.status >= 200 && input.status < 300,
    url: input.url,
    redirected: input.redirected,
    json: async () => input.json ?? {},
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: { get: (name) => name.toLowerCase() === "content-type" ? input.contentType ?? "application/json" : null },
  };
}
