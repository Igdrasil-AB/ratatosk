import { describe, expect, it, vi } from "vitest";
import { disconnectIgdrasil } from "../../collector/src/platform/igdrasil-disconnect";

describe("Igdrasil disconnect", () => {
  it("revokes the credential and clears both token and destination on success", async () => {
    const clearHostToken = vi.fn(async () => undefined);
    const clearSinkConfig = vi.fn(async () => undefined);
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));

    await expect(disconnectIgdrasil({
      getSinkConfig: async () => ({ kind: "igdrasil", endpoint: "https://accounting.igdrasil.se", companyId: "company" }),
      getHostToken: async () => "rat_test",
      clearHostToken,
      clearSinkConfig,
      fetch,
    })).resolves.toEqual({ ok: true });

    expect(fetch).toHaveBeenCalledWith("https://accounting.igdrasil.se/api/documents/ingest/token", expect.objectContaining({ method: "DELETE" }));
    expect(clearHostToken).toHaveBeenCalledOnce();
    expect(clearSinkConfig).toHaveBeenCalledOnce();
  });

  it("retains the connected state when remote revocation is retryable", async () => {
    const clearHostToken = vi.fn(async () => undefined);
    const clearSinkConfig = vi.fn(async () => undefined);

    await expect(disconnectIgdrasil({
      getSinkConfig: async () => ({ kind: "igdrasil", endpoint: "https://accounting.igdrasil.se", companyId: "company" }),
      getHostToken: async () => "rat_test",
      clearHostToken,
      clearSinkConfig,
      fetch: async () => new Response(null, { status: 503 }),
    })).resolves.toMatchObject({ ok: false });

    expect(clearHostToken).not.toHaveBeenCalled();
    expect(clearSinkConfig).not.toHaveBeenCalled();
  });
});
