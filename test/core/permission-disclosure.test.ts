import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import collectorManifest from "../../collector/manifest.config";

describe("Collector permission disclosures", () => {
  it("lists and justifies every required extension permission", () => {
    const listing = readFileSync("store/listing.md", "utf8");
    const checklist = readFileSync("store/release-checklist.md", "utf8");

    const permissions = (collectorManifest as { permissions?: string[] }).permissions ?? [];
    for (const permission of permissions) {
      expect(checklist, `${permission} missing from release inventory`).toContain(`\`${permission}\``);
      expect(listing, `${permission} missing a store justification`).toContain(`**${permission}**`);
    }

    const exactChecklistSection = /Manifest permissions are exactly ([\s\S]*?);/.exec(checklist)?.[1];
    expect(exactChecklistSection).toBeDefined();
    const documented = [...(exactChecklistSection?.matchAll(/`([^`]+)`/g) ?? [])]
      .map((match) => match[1])
      .sort();
    expect(documented).toEqual([...permissions].sort());
  });
});
