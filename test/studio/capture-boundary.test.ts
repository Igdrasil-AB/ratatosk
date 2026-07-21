import { describe, expect, it } from "vitest";
import { startPageCapture } from "../../studio/src/platform/recorder/page-capture";

describe("Studio capture boundary", () => {
  it("fails closed instead of starting a page-visible relay backend", async () => {
    await expect(startPageCapture(41)).rejects.toThrow("Silent page capture is disabled");
  });
});
