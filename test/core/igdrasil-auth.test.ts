import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getHostToken, setHostToken } from "../../collector/src/platform/auth";

describe("Igdrasil Collector credential storage", () => {
  const values: Record<string, unknown> = {};

  beforeEach(() => {
    for (const key of Object.keys(values)) delete values[key];
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: values[key] })),
          set: vi.fn(async (next: Record<string, unknown>) => Object.assign(values, next)),
          remove: vi.fn(async (key: string) => { delete values[key]; }),
        },
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("persists only the upload-only token shape needed by background sync", async () => {
    const token = `rat_${"a".repeat(64)}`;

    await setHostToken(token);

    await expect(getHostToken()).resolves.toBe(token);
  });

  it("rejects a general user session token", async () => {
    await expect(setHostToken("eyJhbGciOiJSUzI1NiJ9.session.jwt")).rejects.toThrow(
      "invalid backend token",
    );
    await expect(getHostToken()).resolves.toBeUndefined();
  });
});
