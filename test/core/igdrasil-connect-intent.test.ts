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
});
