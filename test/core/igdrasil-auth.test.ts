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

    await setHostToken("company-a", token);

    await expect(getHostToken("company-a")).resolves.toBe(token);
    expect(chrome.storage.local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
    expect(vi.mocked(chrome.storage.local.setAccessLevel).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(chrome.storage.local.set).mock.invocationCallOrder[0]);
  });

  it("rejects a general user session token", async () => {
    await expect(setHostToken("company-a", "eyJhbGciOiJSUzI1NiJ9.session.jwt")).rejects.toThrow(
      "invalid backend token",
    );
    await expect(getHostToken("company-a")).resolves.toBeUndefined();
  });

  it.each(["eyJhbGciOiJSUzI1NiJ9.session.jwt", "rat_short", 42])(
    "fails closed and clears an invalid persisted host credential",
    async (invalidToken) => {
      values.hostTokens = { "company-a": invalidToken };

      await expect(getHostToken("company-a")).resolves.toBeUndefined();
      // Never turn an arbitrary persisted value into an authorization header,
      // and do not leave it sitting in storage waiting for the next read.
      expect(values.hostTokens).toEqual({});
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

    await expect(auth.setHostToken("company-a", `rat_${"b".repeat(64)}`)).rejects.toThrow(/restrict Collector credential storage/);
    expect(set).not.toHaveBeenCalled();
  });

  it("keeps one company's credential from ever answering for another", async () => {
    const a = `rat_${"a".repeat(64)}`;
    const b = `rat_${"b".repeat(64)}`;

    await setHostToken("company-a", a);
    await setHostToken("company-b", b);

    await expect(getHostToken("company-a")).resolves.toBe(a);
    await expect(getHostToken("company-b")).resolves.toBe(b);
    // There is no ambient "current token" to fall back to.
    await expect(getHostToken("company-c")).resolves.toBeUndefined();
  });

  it("discards only the invalid entries, keeping the companies that are still usable", async () => {
    const good = `rat_${"c".repeat(64)}`;
    values.hostTokens = { "company-a": good, "company-b": "eyJhbGciOiJSUzI1NiJ9.session.jwt" };

    await expect(getHostToken("company-a")).resolves.toBe(good);
    await expect(getHostToken("company-b")).resolves.toBeUndefined();
    expect(values.hostTokens).toEqual({ "company-a": good });
  });
});
