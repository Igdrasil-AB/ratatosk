import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const debuggerSource = readFileSync("studio/src/platform/recorder/debugger-capture.ts", "utf8");
const relaySource = readFileSync("studio/src/platform/service-worker.ts", "utf8");
const pageSource = readFileSync("studio/src/platform/recorder/page-capture.ts", "utf8");

describe("Studio capture boundary", () => {
  it("rebuilds debugger and page-relayed entries through the same sanitizer", () => {
    expect(debuggerSource).toContain("buildEntry({");
    expect(relaySource).toContain("await appendEntry(tabId, buildEntry({");
    expect(pageSource).toContain("trusted service worker rebuilds every");
    expect(pageSource).not.toContain('key !== "cookie"');
  });
});
