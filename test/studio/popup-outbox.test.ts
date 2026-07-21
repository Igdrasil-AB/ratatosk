import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const popupSource = readFileSync("studio/src/ui/popup/popup.ts", "utf8");
const serviceWorkerSource = readFileSync("studio/src/platform/service-worker.ts", "utf8");

describe("Studio popup outbox recovery", () => {
  it("lists retained approvals on load and exports only after an explicit click", () => {
    expect(popupSource).toContain('send({ type: "fingerprintOutboxList" })');
    expect(popupSource).toContain('class="secondary download-saved"');
    expect(popupSource).toContain('send({ type: "fingerprintOutboxGet", fingerprintId })');
    expect(popupSource).not.toMatch(/fingerprintOutboxList[\s\S]{0,500}downloadSubmission\(/);
    expect(popupSource).toContain('send({ type: "fingerprintPair", token })');
    expect(popupSource).toContain('send({ type: "fingerprintDeliver", fingerprintId:');
    expect(popupSource).toContain('type="password"');
    expect(popupSource).not.toMatch(/fingerprintApprove[\s\S]{0,1000}fingerprintDeliver/);
  });

  it("offers the richer redacted report as a separate explicit download", () => {
    expect(popupSource).toContain('id="download-report"');
    expect(popupSource).toContain('addEventListener("click", () => downloadAgentReport(');
    expect(popupSource).toMatch(/downloadAgentReport\(\s*result\.report/);
    expect(popupSource).toContain("not the structural-only fingerprint");
    expect(popupSource).not.toContain("showResult(response);\n  downloadAgentReport");
  });

  it("does not expose a capture-code workflow", () => {
    expect(popupSource).not.toContain("mission-code");
    expect(popupSource).not.toContain("missionLoad");
    expect(popupSource).not.toContain("Load mission");
  });

  it("gates recorder transitions while their messages are pending", () => {
    expect(popupSource).toContain("const startOnce = exclusiveAction(startRecording)");
    expect(popupSource).toContain("const stopOnce = exclusiveAction(stopRecording)");
    expect(popupSource).toContain('start.textContent = "Starting…"');
    expect(popupSource).toContain('stop.textContent = "Stopping…"');
  });

  it("never converts a saved approval into startup delivery", () => {
    expect(serviceWorkerSource).toContain("chrome.runtime.onStartup.addListener");
    expect(serviceWorkerSource).toContain("fingerprintOutboxStatus()");
    expect(serviceWorkerSource).not.toContain("resumeFingerprintDeliveries");
    expect(serviceWorkerSource).not.toMatch(/onStartup[\s\S]{0,300}fingerprintDeliver/);
  });
});
