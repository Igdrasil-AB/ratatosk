import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePilotManifest } from "../../src/core/pilot-manifest";

const template = JSON.parse(readFileSync("store/pilot-manifest.template.json", "utf8"));

describe("Collector pilot manifest", () => {
  it("validates a bounded identity-free cohort template", () => {
    const parsed = parsePilotManifest(template);
    expect(parsed.cohortSizeTarget).toEqual({ min: 5, max: 10 });
    expect(parsed.supplierIds).toEqual(["railway"]);
    expect(JSON.stringify(parsed)).not.toMatch(/participant|tester.*(?:name|email)|credential|account/i);
  });

  it("rejects participant identities, duplicate suppliers, and implicit decisions", () => {
    expect(() => parsePilotManifest({ ...template, participantEmails: ["person@example.test"] })).toThrow();
    expect(() => parsePilotManifest({ ...template, supplierIds: ["railway", "railway"] })).toThrow(/unique/i);
    expect(() => parsePilotManifest({ ...template, decision: "continue_unlisted" })).toThrow(/evaluation/i);
    expect(() => parsePilotManifest({ ...template, status: "evaluated", decision: null })).toThrow(/decision/i);
  });
});
