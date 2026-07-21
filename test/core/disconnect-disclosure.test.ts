import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("vendor disconnect disclosure", () => {
  it("keeps disconnect retention separate from explicit Forget History cleanup", () => {
    const privacy = readFileSync("PRIVACY.md", "utf8");
    const instructions = readFileSync("store/test-instructions.md", "utf8");
    const checklist = readFileSync("store/release-checklist.md", "utf8");
    const worker = readFileSync("collector/src/platform/service-worker.ts", "utf8");

    const disconnectCase = worker.match(/case "disconnect":[\s\S]*?case "forgetVendorHistory":/)?.[0] ?? "";
    expect(disconnectCase).not.toContain("clearSeenForSource");
    expect(disconnectCase).not.toContain("clearLedgerForVendor");
    expect(privacy).toMatch(/disconnect a vendor[\s\S]*retaining\s+duplicate protection[\s\S]*Forget History/i);
    expect(instructions).toMatch(/Forget History[\s\S]*duplicate protection are cleared[\s\S]*Then disconnect/i);
    expect(instructions).toMatch(/Disconnect[\s\S]*retains local\s+collection history and duplicate protection/i);
    expect(checklist).toMatch(/Forget History cleanup[\s\S]*disconnect without implicit history deletion/i);
  });
});
