import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const popupSource = readFileSync("studio/src/ui/popup/popup.ts", "utf8");

describe("Studio popup outbox recovery", () => {
  it("lists retained approvals on load and exports only after an explicit click", () => {
    expect(popupSource).toContain('send({ type: "fingerprintOutboxList" })');
    expect(popupSource).toContain('class="secondary download-saved"');
    expect(popupSource).toContain('send({ type: "fingerprintOutboxGet", fingerprintId })');
    expect(popupSource).not.toMatch(/fingerprintOutboxList[\s\S]{0,500}downloadSubmission\(/);
  });
});
