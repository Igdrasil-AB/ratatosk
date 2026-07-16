import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { activeCaptureMission, clearCaptureMission, loadCaptureMission } from "../../studio/src/platform/capture-mission";
import {
  pairSvalaFingerprintTransport,
  resolveSvalaCaptureMission,
  SVALA_MISSION_RESOLVE_ENDPOINT,
} from "../../studio/src/platform/fingerprint-transport";

const values: Record<string, unknown> = {};
const TOKEN = `rtk_${"A".repeat(43)}`;
const CODE = `rmc_${"B".repeat(43)}`;
const serviceWorker = readFileSync("studio/src/platform/service-worker.ts", "utf8");
const popup = readFileSync("studio/src/ui/popup/popup.ts", "utf8");

const mission = JSON.parse(readFileSync("test/fixtures/ratatosk/valid-capture-mission.json", "utf8"));

beforeEach(() => {
  for (const key of Object.keys(values)) delete values[key];
  vi.stubGlobal("chrome", {
    storage: { local: {
      get: vi.fn(async (key: string) => ({ [key]: values[key] })),
      set: vi.fn(async (next: Record<string, unknown>) => { Object.assign(values, next); }),
      remove: vi.fn(async (key: string) => { delete values[key]; }),
    } },
  });
});

describe("guided Studio capture missions", () => {
  it("resolves a bounded mission through the paired fixed-host channel", async () => {
    await pairSvalaFingerprintTransport(TOKEN);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ mission }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(resolveSvalaCaptureMission(CODE)).resolves.toEqual(mission);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(SVALA_MISSION_RESOLVE_ENDPOINT);
    expect(url).toBe("https://svala.igdrasil.se/api/dev/ratatosk/missions/resolve");
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
  });

  it("persists only a strictly validated active mission and removes expiry or tampering", async () => {
    await pairSvalaFingerprintTransport(TOKEN);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ mission }), { status: 200 })));
    await expect(loadCaptureMission(CODE, new Date("2026-07-16T11:00:00.000Z"))).resolves.toMatchObject({ code: CODE, mission });
    await expect(activeCaptureMission(new Date("2026-07-16T11:00:00.000Z"))).resolves.toMatchObject({ code: CODE, mission });

    const stored = values["studio:active-capture-mission:v1"] as { code: string; mission: Record<string, unknown> };
    stored.mission.allowedOrigin = "https://evil.example.com/path";
    await expect(activeCaptureMission(new Date("2026-07-16T11:00:00.000Z"))).resolves.toBeUndefined();
    await clearCaptureMission();
  });

  it("keeps recording consent and delivery explicit while enforcing exact mission origin", () => {
    expect(serviceWorker).toContain("new URL(tab.url).origin !== mission.mission.allowedOrigin");
    expect(serviceWorker).toContain("enqueueFingerprintSubmission(submission, new Date(), mission?.code)");
    expect(serviceWorker).not.toMatch(/missionLoad[\s\S]{0,500}recorderStart/);
    expect(popup).toContain('type: "missionLoad"');
    expect(popup).toContain('id="consent" type="checkbox"');
    expect(popup).not.toContain('id="consent" type="checkbox" checked');
  });
});
