import { describe, expect, it } from "vitest";
import {
  replayFailureTrace,
  replayTraceWithComplete,
  replayTraceWithPrefix,
} from "../../src/core/replay-trace";

describe("closed replay trace operations", () => {
  it("keeps one ordered first failure while phases are prefixed and completed", () => {
    const failed = replayTraceWithPrefix(
      replayFailureTrace("semantic_dom", "document_enumeration", "time_cap"),
      [
        { phase: "shell_create", result: "complete", durationMs: 2 },
        { phase: "supplier_commit", result: "complete", durationMs: 3 },
      ],
    );
    expect(failed.firstFailure).toEqual({ phase: "document_enumeration", result: "time_cap" });
    expect(replayTraceWithComplete(failed, "document_enumeration").firstFailure).toBeUndefined();
  });
});
