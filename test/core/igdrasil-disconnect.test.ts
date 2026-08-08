import { describe, expect, it, vi } from "vitest";
import { disconnectIgdrasil } from "../../collector/src/platform/igdrasil-disconnect";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function destination(companyId = COMPANY) {
  return {
    kind: "igdrasil" as const,
    endpoint: "https://accounting.igdrasil.se",
    companyId,
    companyName: "Company A",
    connectedAt: 0,
  };
}

type Dependencies = NonNullable<Parameters<typeof disconnectIgdrasil>[1]>;

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    getDestination: async () => destination(),
    getHostToken: async () => `rat_${"a".repeat(64)}`,
    clearHostToken: vi.fn(async () => undefined),
    removeDestination: vi.fn(async () => undefined),
    unbindConnectionsFrom: vi.fn(async () => ["vendor-a"]),
    fetch: vi.fn(async () => new Response(null, { status: 204 })),
    ...overrides,
  };
}

describe("Igdrasil disconnect", () => {
  it("revokes the credential and clears that company's destination on success", async () => {
    const deps = dependencies();

    await expect(disconnectIgdrasil(COMPANY, deps)).resolves.toEqual({
      ok: true,
      protocol: 2,
      unboundVendorIds: ["vendor-a"],
    });

    expect(deps.fetch).toHaveBeenCalledWith(
      "https://accounting.igdrasil.se/api/documents/ingest/token",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(deps.clearHostToken).toHaveBeenCalledWith(COMPANY);
    expect(deps.removeDestination).toHaveBeenCalledWith(`igdrasil:${COMPANY}`);
  });

  it("leaves the company's suppliers unbound and paused, never on another destination", async () => {
    const deps = dependencies({ unbindConnectionsFrom: vi.fn(async () => ["vendor-a", "vendor-b"]) });

    const result = await disconnectIgdrasil(COMPANY, deps);

    expect(result).toMatchObject({ ok: true, unboundVendorIds: ["vendor-a", "vendor-b"] });
    expect(deps.unbindConnectionsFrom).toHaveBeenCalledWith(`igdrasil:${COMPANY}`);
  });

  it("retains the connected state when remote revocation is retryable", async () => {
    const deps = dependencies({ fetch: async () => new Response(null, { status: 503 }) });

    await expect(disconnectIgdrasil(COMPANY, deps)).resolves.toEqual({
      ok: false,
      protocol: 2,
      code: "revoke_failed",
    });

    expect(deps.clearHostToken).not.toHaveBeenCalled();
    expect(deps.removeDestination).not.toHaveBeenCalled();
    expect(deps.unbindConnectionsFrom).not.toHaveBeenCalled();
  });

  it("treats an already-revoked credential as success so disconnect stays idempotent", async () => {
    const deps = dependencies({ fetch: async () => new Response(null, { status: 401 }) });

    await expect(disconnectIgdrasil(COMPANY, deps)).resolves.toMatchObject({ ok: true });
    expect(deps.clearHostToken).toHaveBeenCalledWith(COMPANY);
  });

  it("refuses a company this profile is not connected to", async () => {
    const deps = dependencies({ getDestination: async () => undefined });

    await expect(disconnectIgdrasil(OTHER, deps)).resolves.toEqual({
      ok: false,
      protocol: 2,
      code: "unknown_company",
    });
    expect(deps.clearHostToken).not.toHaveBeenCalled();
  });

  it("does not attempt revocation against an untrusted backend, but still drops the credential", async () => {
    const deps = dependencies({
      getDestination: async () => ({ ...destination(), endpoint: "https://attacker.example" }),
    });

    await expect(disconnectIgdrasil(COMPANY, deps)).resolves.toMatchObject({
      ok: false,
      code: "backend_not_allowed",
    });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.clearHostToken).toHaveBeenCalledWith(COMPANY);
    expect(deps.removeDestination).toHaveBeenCalledWith(`igdrasil:${COMPANY}`);
  });
});
