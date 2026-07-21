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
    expect(source.match(/catch \{/g)).toHaveLength(3);
  });

  it("keeps a retryable connected state when disconnect is refused or times out", () => {
    expect(disconnectInvoiceCollectorOutcome({ ok: false, error: "extension not responding" })).toEqual({
      state: "connected",
      error: "extension not responding",
    });
    expect(disconnectInvoiceCollectorOutcome({ ok: true })).toEqual({
      state: "disconnected",
      error: null,
    });
  });

  it("does not mint a Collector credential when extension intent validation fails", async () => {
    const mint = vi.fn(async () => "collector-token");
    const validate = vi.fn(async () => ({ ok: false as const, error: "connection request expired" }));

    await expect(withValidatedInvoiceCollectorIntent("state", mint, validate)).resolves.toEqual({
      ok: false,
      error: "connection request expired",
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
