import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeIgdrasilConnectIntent,
  createIgdrasilConnectIntent,
  validateIgdrasilConnectIntent,
} from "../../collector/src/platform/igdrasil-connect-intent";

describe("Igdrasil connection intent", () => {
  const values: Record<string, unknown> = {};

  beforeEach(() => {
    for (const key of Object.keys(values)) delete values[key];
    vi.stubGlobal("chrome", {
      storage: {
        session: {
          get: vi.fn(async (key: string) => ({ [key]: values[key] })),
          set: vi.fn(async (next: Record<string, unknown>) => Object.assign(values, next)),
          remove: vi.fn(async (key: string) => { delete values[key]; }),
        },
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("creates a short-lived, one-use state bound to the dedicated connect route", async () => {
    const intent = await createIgdrasilConnectIntent(1_000);

    expect(intent.url).toBe(
      `https://accounting.igdrasil.se/integrations/invoice-collector/connect?state=${encodeURIComponent(intent.state)}`,
    );
    await expect(validateIgdrasilConnectIntent(intent.state, 1_001)).resolves.toBe(true);
    await expect(validateIgdrasilConnectIntent(intent.state, 1_001)).resolves.toBe(true);
    await expect(consumeIgdrasilConnectIntent(intent.state, 1_001)).resolves.toBe(true);
    await expect(consumeIgdrasilConnectIntent(intent.state, 1_002)).resolves.toBe(false);
  });

  it("rejects an incorrect or expired state without authorizing a connection", async () => {
    const intent = await createIgdrasilConnectIntent(1_000);

    await expect(consumeIgdrasilConnectIntent(`${intent.state}x`, 1_001)).resolves.toBe(false);
    await expect(consumeIgdrasilConnectIntent(intent.state, 1_000 + 60 * 60_000 + 1)).resolves.toBe(false);
  });

  it("atomically consumes a state once when two bridge requests overlap", async () => {
    const intent = await createIgdrasilConnectIntent(1_000);

    await expect(Promise.all([
      consumeIgdrasilConnectIntent(intent.state, 1_001),
      consumeIgdrasilConnectIntent(intent.state, 1_001),
    ])).resolves.toEqual([true, false]);
  });

  it("does not let an older consume delete a newly created intent", async () => {
    const oldIntent = await createIgdrasilConnectIntent(1_000);
    let releaseRead: (() => void) | undefined;
    const readBarrier = new Promise<void>((resolve) => { releaseRead = resolve; });
    (chrome.storage.session.get as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async (key: string) => {
      const snapshot = { [key]: structuredClone(values[key]) };
      await readBarrier;
      return snapshot;
    });

    const consuming = consumeIgdrasilConnectIntent(oldIntent.state, 1_001);
    await vi.waitFor(() => expect(chrome.storage.session.get).toHaveBeenCalled());
    const replacement = createIgdrasilConnectIntent(2_000);
    releaseRead?.();

    await expect(consuming).resolves.toBe(true);
    const newIntent = await replacement;
    await expect(validateIgdrasilConnectIntent(newIntent.state, 2_001)).resolves.toBe(true);
    await expect(consumeIgdrasilConnectIntent(newIntent.state, 2_001)).resolves.toBe(true);
  });
});
