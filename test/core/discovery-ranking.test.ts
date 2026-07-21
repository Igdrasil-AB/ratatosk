import { describe, expect, it } from "vitest";
import { hasEnoughStrongCandidates } from "../../collector/src/platform/discovery";

describe("discovery candidate stopping policy", () => {
  it("keeps exploring when the retained set is full of weak DOM evidence", () => {
    expect(hasEnoughStrongCandidates([{ score: 165 }, { score: 140 }, { score: 105 }])).toBe(false);
  });

  it("stops once all three retained alternatives have structured evidence", () => {
    expect(hasEnoughStrongCandidates([{ score: 340 }, { score: 225 }, { score: 205 }])).toBe(true);
  });
});
