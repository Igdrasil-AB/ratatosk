import { describe, expect, it } from "vitest";
import { parseDestinationsResponse, parseInitialBackgroundState } from "../../collector/src/ui/popup/load-state";

const successful = {
  sourceResponse: { ok: true as const, sources: [] },
  ledgerResponse: { ok: true as const, ledger: [] },
  scheduleResponse: { ok: true as const, schedule: { periodMinutes: null, nextRunAt: null } },
  discoveryResponse: { ok: true as const, discovery: { stage: "idle" as const } },
};

describe("collector popup background snapshot", () => {
  it("accepts an explicitly successful empty snapshot", () => {
    expect(parseInitialBackgroundState(successful)).toEqual({
      sources: [],
      ledger: [],
      schedule: { periodMinutes: null, nextRunAt: null },
      discovery: { stage: "idle" },
    });
    expect(parseDestinationsResponse({ ok: true, destinations: {} })).toEqual({});
  });

  it("rejects a resolved background error instead of converting it to empty state", () => {
    expect(() => parseInitialBackgroundState({
      ...successful,
      sourceResponse: { ok: false, error: "unavailable: secret internal detail" },
    })).toThrow("couldn’t load saved vendors from the background service");
  });

  it("rejects a failed destination read instead of treating it as missing setup", () => {
    expect(() => parseDestinationsResponse({ ok: false, error: "unavailable" }))
      .toThrow("couldn’t load destination settings from the background service");
  });
});
