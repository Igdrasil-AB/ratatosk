import { afterAll, describe, expect, it } from "vitest";
import { zipDeterministically } from "../../scripts/deterministic-zip";

const originalTimezone = process.env.TZ;

afterAll(() => {
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

describe("release archive determinism", () => {
  it("encodes identical bytes in UTC and non-UTC build environments", () => {
    const files = {
      "manifest.json": new TextEncoder().encode('{"version":"0.7.1"}'),
      "assets/service-worker.js": new TextEncoder().encode("export {};"),
    };

    process.env.TZ = "UTC";
    const utc = zipDeterministically(files);
    process.env.TZ = "Europe/Stockholm";
    const stockholm = zipDeterministically(files);

    expect(stockholm).toEqual(utc);
  });
});
