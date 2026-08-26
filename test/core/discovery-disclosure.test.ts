import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_EXPLORATION_DEPTH,
  MAX_EXPLORATION_PAGES,
} from "../../collector/src/platform/discovery-explorer";

describe("public discovery-limit disclosures", () => {
  it("matches the implemented page and depth budget in every release-facing document", () => {
    expect(MAX_EXPLORATION_PAGES).toBe(40);
    expect(MAX_EXPLORATION_DEPTH).toBe(4);

    const listing = readFileSync("store/listing.md", "utf8");
    const checklist = readFileSync("store/release-checklist.md", "utf8");
    const security = readFileSync("SECURITY.md", "utf8");
    const privacy = readFileSync("PRIVACY.md", "utf8");

    expect(listing).toMatch(/active page and at most thirty-nine additional[\s\S]*forty total[\s\S]*depth four/i);
    expect(checklist).toMatch(/maximum forty-page\/depth-four search with four inactive route tabs/i);
    expect(security).toMatch(/capped at 40 pages, depth four, and 60 seconds interactively/i);
    expect(privacy).toMatch(/active page and up to\s+thirty-nine additional same-origin pages[\s\S]*depth\s+four/i);
  });
});
