import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PUBLIC_POLICY_URL = "https://igdrasil.se/en/privacy/ratatosk/";

describe("release privacy-policy URL", () => {
  it("uses the policy's declared public URL in the canonical store listing", () => {
    const policy = readFileSync("PRIVACY.md", "utf8");
    const listing = readFileSync("store/listing.md", "utf8");

    expect(policy).toContain(`public copy of this policy is available at\n${PUBLIC_POLICY_URL}`);
    expect(listing).toContain(`**Privacy policy URL:**\n\`${PUBLIC_POLICY_URL}\``);
    expect(listing).not.toMatch(/github\.com\/[^\s`]+\/PRIVACY\.md/i);
  });
});
