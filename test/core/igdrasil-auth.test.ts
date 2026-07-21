import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getHostToken, setHostToken } from "../../collector/src/platform/auth";

describe("Igdrasil Collector credential storage", () => {
  const values: Record<string, unknown> = {};

  beforeEach(() => {
    for (const key of Object.keys(values)) delete values[key];
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          setAccessLevel: vi.fn(async () => undefined),
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
    expect(chrome.storage.local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
    expect(vi.mocked(chrome.storage.local.setAccessLevel).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(chrome.storage.local.set).mock.invocationCallOrder[0]);
  });

  it("rejects a general user session token", async () => {
    await expect(setHostToken("eyJhbGciOiJSUzI1NiJ9.session.jwt")).rejects.toThrow(
      "invalid backend token",
    );
    await expect(getHostToken()).resolves.toBeUndefined();
  });

  it.each(["eyJhbGciOiJSUzI1NiJ9.session.jwt", "rat_short", 42])(
    "fails closed and clears an invalid persisted host credential",
    async (invalidToken) => {
      values.hostToken = invalidToken;

      await expect(getHostToken()).resolves.toBeUndefined();
      expect(values.hostToken).toBeUndefined();
      expect(chrome.storage.local.remove).toHaveBeenCalledWith("hostToken");
    },
  );

  it("fails closed when Chrome cannot restrict credential storage", async () => {
    vi.resetModules();
    const set = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          setAccessLevel: vi.fn(async () => { throw new Error("unsupported"); }),
          get: vi.fn(async () => ({})),
          set,
          remove: vi.fn(async () => undefined),
        },
      },
    });
    const auth = await import("../../collector/src/platform/auth");

    await expect(auth.setHostToken(`rat_${"b".repeat(64)}`)).rejects.toThrow(/restrict Collector credential storage/);
    expect(set).not.toHaveBeenCalled();
  });
});
