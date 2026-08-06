import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { discoveryProofIsSufficient, structuredProofRetained } from "../../collector/src/platform/discovery";
import type { DiscoveryAdapterId } from "../../src/core/discovery";

/**
 * A wave stops as soon as an answer arrives that nothing still running could
 * improve on. Which answers those are is the whole safety argument, so it is
 * stated here rather than left to the call site.
 */

function retained(...adapters: DiscoveryAdapterId[]) {
  return adapters.map((id) => ({ profile: { adapter: { id } } }));
}

describe("stopping a probe wave early", () => {
  it("stops only for structured evidence", () => {
    expect(structuredProofRetained(retained("network-json"))).toBe(true);
    expect(structuredProofRetained(retained("embedded-json"))).toBe(true);
    expect(structuredProofRetained(retained("dom-links", "embedded-json"))).toBe(true);
  });

  it("plays out the wave for a candidate a sibling probe could beat", () => {
    // A DOM guess can be replaced by a JSON source from the very probe that
    // would be abandoned, so these waves are never cut short.
    expect(structuredProofRetained(retained("dom-links"))).toBe(false);
    expect(structuredProofRetained(retained("dom-actions"))).toBe(false);
    expect(structuredProofRetained(retained("dom-links", "dom-actions"))).toBe(false);
    expect(structuredProofRetained([])).toBe(false);
  });

  it("cuts a wave short only where the search was ending anyway", () => {
    // Structured evidence is the one condition the end-of-wave check accepts
    // without regard to coverage. Anything else may still need more of the site
    // seen, which is exactly what a mid-wave exit cannot know.
    for (const adapters of [["network-json"], ["embedded-json"]] as DiscoveryAdapterId[][]) {
      expect(structuredProofRetained(retained(...adapters))).toBe(true);
      expect(discoveryProofIsSufficient(retained(...adapters), { entryExplored: false, exploredWaves: 0 })).toBe(true);
    }
    for (const adapters of [["dom-links"], ["dom-actions"]] as DiscoveryAdapterId[][]) {
      expect(discoveryProofIsSufficient(retained(...adapters), { entryExplored: false, exploredWaves: 0 })).toBe(false);
    }
  });

  it("consumes probes in settle order and breaks inside the wave", () => {
    const source = readFileSync("collector/src/platform/discovery.ts", "utf8");

    expect(source).toContain("mapConcurrentInSettleOrder(scheduled");
    expect(source).toContain("for await (const probe of probes)");
    // The break belongs inside the per-probe loop; at the end of the wave it
    // would save nothing, which is the bug this replaced.
    const wave = source.slice(source.indexOf("for await (const probe of probes)"), source.indexOf("await checkpoint();"));
    expect(wave).toContain("if (structuredProofRetained(retained)) {");
    expect(wave).toContain("break;");
  });

  it("still counts the wave it left early", () => {
    // `exploredWaves` gates the weaker adapters. A wave that ended early still
    // happened, so skipping the increment would make a later DOM candidate wait
    // for a wave that had already been spent.
    const source = readFileSync("collector/src/platform/discovery.ts", "utf8");
    const afterWave = source.slice(source.indexOf("await checkpoint();"));

    expect(afterWave).toContain("if (isEntryWave) entryExplored = true;");
    expect(afterWave).toContain("else exploredWaves += 1;");
  });
});
