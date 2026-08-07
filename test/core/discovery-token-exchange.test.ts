import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertDiscoveredRecipePolicy } from "../../src/core/discovery";
import { buildDiscoveryEvidenceEntry } from "../../src/core/recorder/discovery-evidence";
import type { VendorRecipe } from "../../src/core/types";

/**
 * A discovered recipe may exchange the user's own session for the short-lived
 * bearer the same site issues to itself. What must stay impossible is the page
 * choosing *which* endpoint mints one or *where* it is then sent — so these
 * tests are mostly about what is refused.
 */

const origin = "https://app.vendor.example";
const entryUrl = `${origin}/settings/billing`;

function tokenRecipe(overrides: {
  token?: VendorRecipe["auth"]["token"];
  listUrl?: string;
  listHeaders?: Record<string, string>;
  hosts?: string[];
} = {}): VendorRecipe {
  return {
    id: "candidate",
    name: "Example",
    homepage: origin,
    hosts: overrides.hosts ?? [`${origin}/*`],
    fetchContext: "page",
    auth: {
      check: { request: { url: `${origin}/api/session` }, expect: { statusIn: [200] } },
      loginUrl: origin,
      token: overrides.token ?? { request: { url: `${origin}/api/session` }, value: "accessToken" },
    },
    invoices: {
      strategy: "network",
      list: {
        request: {
          url: overrides.listUrl ?? `${origin}/api/invoices?limit=50`,
          headers: overrides.listHeaders ?? { authorization: "Bearer {token}" },
        },
        items: "invoices",
        map: { id: "id", issuedAt: "issued_at", documentUrl: "pdf_url" },
      },
      document: { contentType: "application/pdf" },
    },
  };
}

describe("discovered token exchange", () => {
  it("accepts a same-origin session read whose token never leaves that origin", () => {
    expect(() => assertDiscoveredRecipePolicy(tokenRecipe(), origin, entryUrl)).not.toThrow();
  });

  it("stores an instruction to mint a token, never a token", () => {
    const recipe = tokenRecipe();
    const stored = JSON.stringify(recipe);

    expect(recipe.auth.token?.request.url).toBe(`${origin}/api/session`);
    expect(stored).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    // The only trace of the credential is the template the run fills in.
    expect(stored.match(/Bearer [^"]*/g)).toEqual(["Bearer {token}"]);
  });

  it("refuses a minting request that could do anything but read the session", () => {
    for (const token of [
      { request: { url: `${origin}/api/session`, method: "POST" as const, body: "{}" }, value: "accessToken" },
      { request: { url: `${origin}/api/session`, headers: { "x-key": "1" } }, value: "accessToken" },
      { request: { url: "https://identity.other.example/api/session" }, value: "accessToken" },
    ]) {
      expect(() => assertDiscoveredRecipePolicy(tokenRecipe({ token }), origin, entryUrl)).toThrow();
    }
  });

  it("refuses a token bound anywhere but the reviewed variable and header", () => {
    expect(() => assertDiscoveredRecipePolicy(
      tokenRecipe({ token: { request: { url: `${origin}/api/session` }, value: "accessToken", as: "secret" } }),
      origin,
      entryUrl,
    )).toThrow(/reviewed token variable/);

    expect(() => assertDiscoveredRecipePolicy(
      tokenRecipe({ listHeaders: { "x-auth": "Bearer {token}" } }),
      origin,
      entryUrl,
    )).toThrow(/authorization header/);
  });

  it("refuses to forward a token to any origin but the one that issued it", () => {
    expect(() => assertDiscoveredRecipePolicy(
      tokenRecipe({
        listUrl: "https://api.other.example/invoices?limit=50",
        hosts: [`${origin}/*`, "https://api.other.example/*"],
      }),
      origin,
      entryUrl,
    )).toThrow(/origin that issued it/);
  });

  it("refuses to place a token where it would be logged or persisted", () => {
    expect(() => assertDiscoveredRecipePolicy(
      tokenRecipe({ listUrl: `${origin}/api/invoices?access_token={token}` }),
      origin,
      entryUrl,
    )).toThrow();
  });

  it("refuses a derived or unnamed credential path", () => {
    const derived: VendorRecipe["auth"]["token"] = {
      request: { url: `${origin}/api/session` },
      value: { path: "accessToken", transforms: [{ kind: "replace", pattern: "^", with: "x" }] },
    };
    expect(() => assertDiscoveredRecipePolicy(tokenRecipe({ token: derived }), origin, entryUrl)).toThrow();

    for (const value of ["session[0].value"]) {
      expect(() => assertDiscoveredRecipePolicy(
        tokenRecipe({ token: { request: { url: `${origin}/api/session` }, value } }),
        origin,
        entryUrl,
      )).toThrow();
    }
  });

  it("reads only the authentication scheme from an observed request", () => {
    const observer = readFileSync("collector/src/platform/discovery-page-observer.ts", "utf8");

    // The credential after the scheme word is never examined or measured.
    expect(observer).toContain("function authorizationMarker");
    expect(observer).toMatch(/authorization: "Custom"/);
    expect(observer).not.toMatch(/authorization:\s*value/);
  });

  it("tells the person about the token exchange where they grant access", () => {
    const popup = readFileSync("collector/src/ui/popup/popup.ts", "utf8");
    const state = readFileSync("collector/src/platform/discovery-state.ts", "utf8");

    // The disclosure sits on the approval card, beside the origins it belongs
    // with — not only in the security notes.
    expect(popup).toContain("discovery.usesSessionToken");
    expect(popup).toContain("Re-read each time, never stored.");
    expect(popup).toMatch(/discovery-hosts[\s\S]{0,200}\$\{sessionToken\}/);
    // Any retained candidate may be the one that runs, so the flag covers the set.
    expect(state).toContain("usesSessionToken: state.candidates.candidates.some(");
    expect(state).toContain("Boolean(candidate.recipe.auth.token)");
  });

  it("records where a credential was, never what it was", () => {
    const entry = buildDiscoveryEvidenceEntry({
      url: "https://app.vendor.example/api/session",
      method: "GET",
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "u_1" },
        accessToken: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1XzEifQ.sig",
      }),
    });

    expect(entry.redactedResponsePaths).toEqual(["accessToken"]);
    expect(entry.responseBody).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(entry.responseBody).toContain("u_1");
  });
});
