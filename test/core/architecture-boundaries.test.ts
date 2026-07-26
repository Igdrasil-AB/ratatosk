import { describe, expect, it } from "vitest";
import { architectureBoundaryIssues } from "../../scripts/check-architecture-boundaries";

describe("architecture boundaries", () => {
  it("rejects platform globals and imports in shared code", () => {
    expect(architectureBoundaryIssues([
      { path: "src/core/bad.ts", source: 'import "../../collector/src/platform/storage"; chrome.storage.local.get("x"); window.location.href;' },
    ])).toEqual(expect.arrayContaining([
      expect.stringMatching(/imports platform code/),
      expect.stringMatching(/platform global chrome/),
      expect.stringMatching(/platform global window/),
    ]));
  });

  it("rejects Collector-to-Studio imports and allows cross-runtime web standards", () => {
    expect(architectureBoundaryIssues([
      { path: "collector/src/bad.ts", source: 'import "../../studio/src/platform/recorder";' },
    ])).toEqual([expect.stringMatching(/Collector imports Studio/)]);
    expect(architectureBoundaryIssues([
      { path: "src/core/http.ts", source: "export const request = (url: URL) => fetch(url);" },
    ])).toEqual([]);
  });

  it("rejects raw page activation outside the reviewed action-scoped owners", () => {
    expect(architectureBoundaryIssues([
      { path: "collector/src/platform/other.ts", source: "export function run(control: HTMLElement) { control.click(); }" },
    ])).toEqual([expect.stringMatching(/raw page click/)]);
    expect(architectureBoundaryIssues([
      {
        path: "collector/src/platform/document-action-controller.ts",
        source: "export function runSemanticDocumentOperationInPage(control: HTMLElement) { control.click(); }",
      },
    ])).toEqual([]);
  });
});
