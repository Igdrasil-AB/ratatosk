import { parseSvalaCaptureMission, resolveSvalaCaptureMission, type SvalaCaptureMission } from "./fingerprint-transport";

const STORAGE_KEY = "studio:active-capture-mission:v1";

export type ActiveCaptureMission = { code: string; mission: SvalaCaptureMission };

export async function loadCaptureMission(code: string, now = new Date()): Promise<ActiveCaptureMission> {
  const mission = await resolveSvalaCaptureMission(code);
  if (Date.parse(mission.expiresAt) <= now.getTime() || mission.status !== "claimed") throw new Error("Mission is expired or no longer claimable");
  const active = { code: String(code).trim(), mission };
  await chrome.storage.local.set({ [STORAGE_KEY]: active });
  return active;
}

export async function activeCaptureMission(now = new Date()): Promise<ActiveCaptureMission | undefined> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const value = stored[STORAGE_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["code", "mission"].includes(key)) || typeof record.code !== "string" || !/^rmc_[A-Za-z0-9_-]{43}$/.test(record.code)) return undefined;
  let mission: SvalaCaptureMission;
  try { mission = parseSvalaCaptureMission(record.mission); }
  catch { await chrome.storage.local.remove(STORAGE_KEY); return undefined; }
  if (Date.parse(mission.expiresAt) <= now.getTime() || !["claimed", "received", "needs_another_capture", "accepted_for_review", "closed"].includes(mission.status)) {
    await chrome.storage.local.remove(STORAGE_KEY);
    return undefined;
  }
  return { code: record.code, mission };
}

export async function clearCaptureMission(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}
