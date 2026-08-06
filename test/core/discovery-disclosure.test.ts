import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_EXPLORATION_DEPTH,
  MAX_EXPLORATION_PAGES,
} from "../../collector/src/platform/discovery-explorer";

describe("public discovery-limit disclosures", () => {
  it("matches the implemented page and depth budget in every release-facing document", () => {
    expect(MAX_EXPLORATION_PAGES).toBe(15);
    expect(MAX_EXPLORATION_DEPTH).toBe(3);

    const listing = readFileSync("store/listing.md", "utf8");
    const checklist = readFileSync("store/release-checklist.md", "utf8");
    const security = readFileSync("SECURITY.md", "utf8");
    const privacy = readFileSync("PRIVACY.md", "utf8");

    expect(listing).toMatch(/active page and at most fourteen additional[\s\S]*fifteen total[\s\S]*depth three/i);
    expect(checklist).toMatch(/maximum fifteen-page\/depth-three search/i);
    expect(security).toMatch(/capped at 15 pages, depth three, and 10 seconds interactively/i);
    expect(privacy).toMatch(/active page and up to\s+fourteen additional same-origin pages[\s\S]*depth\s+three/i);
  });
});
