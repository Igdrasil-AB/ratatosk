import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  collectorTokenFromResponse,
  disconnectInvoiceCollectorOutcome,
  withValidatedInvoiceCollectorIntent,
} from "../../examples/igdrasil-connect-client";

describe("Igdrasil connect example", () => {
  it("restores a recoverable state after every rejected component flow", () => {
    const source = readFileSync("examples/ConnectInvoiceCollector.tsx", "utf8");
    expect(source).toMatch(/Could not check the Invoice Collector extension/);
    expect(source).toMatch(/Could not complete the secure Collector connection/);
    expect(source).toMatch(/Could not disconnect Invoice Collector/);
    // Three flows can reject — the presence check, connect, and disconnect —
    // and each has to land somewhere the user can retry from.
    expect(source.match(/catch \{|\.catch\(/g)).toHaveLength(3);
  });

  it("translates every refusal code, so no failure lands as a bare code", () => {
    const source = readFileSync("examples/ConnectInvoiceCollector.tsx", "utf8");
    for (const code of [
      "intent_missing", "intent_expired", "origin_not_allowed", "token_invalid",
      "backend_not_allowed", "company_already_connected", "unknown_company",
      "invalid_request", "revoke_failed", "extension_unavailable",
    ]) {
      expect(source).toContain(`${code}:`);
    }
  });

  it("renders every connected company rather than whichever one is selected", () => {
    const source = readFileSync("examples/ConnectInvoiceCollector.tsx", "utf8");
    // The defect being fixed: the settings view read the extension's connected
    // company and then printed the ACTIVE company's name.
    expect(source).toContain("companies.map");
    expect(source).toContain("connected.companyName");
    expect(source).toContain("connected.supplierCount");
    // A company connected in this browser the signed-in user cannot reach.
    expect(source).toContain("accessibleCompanyIds.includes");
    // And the 60-day inactivity warning.
    expect(source).toContain("isCollectorConnectionStale");
  });

  it("keeps a retryable connected state when disconnect is refused or times out", () => {
    expect(disconnectInvoiceCollectorOutcome({ ok: false, code: "extension_unavailable" })).toEqual({
      state: "connected",
      code: "extension_unavailable",
    });
    expect(disconnectInvoiceCollectorOutcome({ ok: true })).toEqual({
      state: "disconnected",
      code: null,
    });
  });

  it("does not mint a Collector credential when extension intent validation fails", async () => {
    const mint = vi.fn(async () => "collector-token");
    const validate = vi.fn(async () => ({ ok: false as const, code: "intent_expired" as const }));

    await expect(withValidatedInvoiceCollectorIntent("state", mint, validate)).resolves.toEqual({
      ok: false,
      code: "intent_expired",
    });
    expect(validate).toHaveBeenCalledWith("state");
    expect(mint).not.toHaveBeenCalled();
  });

  it("validates the prepared intent before minting", async () => {
    const calls: string[] = [];
    const validate = vi.fn(async (state: string) => {
      calls.push(`validate:${state}`);
      return { ok: true as const };
    });
    const mint = vi.fn(async () => {
      calls.push("mint");
      return "collector-token";
    });

    await expect(withValidatedInvoiceCollectorIntent("prepared-state", mint, validate)).resolves.toEqual({
      ok: true,
      value: "collector-token",
    });
    expect(calls).toEqual(["validate:prepared-state", "mint"]);
  });

  it("accepts only an upload-only Collector credential response", () => {
    const token = `rat_${"a".repeat(64)}`;
    expect(collectorTokenFromResponse({ token })).toBe(token);
    expect(collectorTokenFromResponse({ token: "eyJhbGciOiJSUzI1NiJ9.session.jwt" })).toBeUndefined();
    expect(collectorTokenFromResponse({ token: "rat_short" })).toBeUndefined();
    expect(collectorTokenFromResponse({ token: 42 })).toBeUndefined();
    expect(collectorTokenFromResponse(null)).toBeUndefined();
  });
});
