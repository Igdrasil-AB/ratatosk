import {
  parseSupplierFingerprintSubmission,
  type SupplierFingerprintSubmissionV1,
} from "../../../src/core/recorder/supplier-fingerprint";

export const SVALA_FINGERPRINT_ENDPOINT = "https://svala.igdrasil.se/api/dev/ratatosk/fingerprints";
export const SVALA_MISSION_RESOLVE_ENDPOINT = "https://svala.igdrasil.se/api/dev/ratatosk/missions/resolve";
const TOKEN_STORAGE_KEY = "studio:svala-fingerprint-intake-token:v1";
const TOKEN = /^rtk_[A-Za-z0-9_-]{43}$/;
const MAX_RESPONSE_BYTES = 4 * 1024;

export interface SvalaFingerprintReceipt {
  readonly receiptId: string;
  readonly fingerprintId: string;
  readonly acceptedAt: string;
  readonly status: "accepted";
}

export type SvalaMissionStatus = "open" | "claimed" | "received" | "needs_another_capture" | "accepted_for_review" | "closed" | "withdrawn" | "expired";

export interface SvalaCaptureMission {
  readonly schema: "ratatosk.capture-mission.v1";
  readonly id: string;
  readonly candidateId: string;
  readonly supplierLabel: string;
  readonly allowedOrigin: string;
  readonly requestedRoles: readonly ("auth" | "invoice_list" | "document" | "pagination" | "multi_scope")[];
  readonly actions: readonly { kind: "open_billing" | "reload" | "open_invoice_list" | "download_synthetic_document"; label: string }[];
  readonly eligibilityStatement: string;
  readonly priority: number;
  readonly status: SvalaMissionStatus;
  readonly expiresAt: string;
  readonly claimedAt: string | null;
  readonly completedAt: string | null;
  readonly receiptId: string | null;
}

export type SvalaFingerprintDeliveryResult =
  | { delivered: true; receipt: SvalaFingerprintReceipt; replayed: boolean; mission?: { missionId: string; status: SvalaMissionStatus } }
  | { delivered: false; reason: "not_configured" | "network" | "rate_limited" | "server" | "rejected"; retryAfterMs?: number };

export interface SupplierFingerprintTransport {
  readonly target: "svala";
  configured(): Promise<boolean>;
  deliver(submission: SupplierFingerprintSubmissionV1, options?: { missionCode?: string }): Promise<SvalaFingerprintDeliveryResult>;
}

export async function pairSvalaFingerprintTransport(token: string): Promise<void> {
  const bounded = String(token || "").trim();
  if (!TOKEN.test(bounded)) throw new Error("Svala intake token is invalid");
  await chrome.storage.local.set({ [TOKEN_STORAGE_KEY]: bounded });
}

export async function disconnectSvalaFingerprintTransport(): Promise<void> {
  await chrome.storage.local.remove(TOKEN_STORAGE_KEY);
}

export async function resolveSvalaCaptureMission(missionCode: string): Promise<SvalaCaptureMission> {
  const code = String(missionCode || "").trim();
  if (!/^rmc_[A-Za-z0-9_-]{43}$/.test(code)) throw new Error("Mission code is invalid");
  const token = await configuredToken();
  if (!token) throw new Error("Pair with Svala before loading a mission");
  const response = await fetch(SVALA_MISSION_RESOLVE_ENDPOINT, {
    method: "POST", redirect: "error", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ missionCode: code }),
  });
  if (!response.ok) throw new Error(response.status === 410 ? "Mission code has expired" : "Mission could not be loaded");
  return parseMissionResponse(await boundedText(response));
}

async function configuredToken(): Promise<string | undefined> {
  const stored = await chrome.storage.local.get(TOKEN_STORAGE_KEY);
  const value = stored[TOKEN_STORAGE_KEY];
  return typeof value === "string" && TOKEN.test(value) ? value : undefined;
}

export const svalaFingerprintTransport: SupplierFingerprintTransport = {
  target: "svala",
  async configured() {
    return Boolean(await configuredToken());
  },
  async deliver(input, options = {}) {
    const submission = parseSupplierFingerprintSubmission(input);
    const token = await configuredToken();
    if (!token) return { delivered: false, reason: "not_configured" };

    let response: Response;
    try {
      response = await fetch(SVALA_FINGERPRINT_ENDPOINT, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": submission.fingerprint.fingerprintId,
          ...(options.missionCode ? { "X-Ratatosk-Mission-Code": options.missionCode } : {}),
        },
        body: JSON.stringify(submission),
      });
    } catch {
      return { delivered: false, reason: "network" };
    }

    if (response.status === 200 || response.status === 201) {
      try {
        const result = parseReceiptResponse(await boundedText(response));
        if (result.receipt.fingerprintId !== submission.fingerprint.fingerprintId) throw new Error("Receipt fingerprint mismatch");
        return result;
      } catch {
        return { delivered: false, reason: "server" };
      }
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      return {
        delivered: false,
        reason: "rate_limited",
        ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfterMs: Math.min(seconds * 1_000, 24 * 60 * 60 * 1_000) } : {}),
      };
    }
    if (response.status >= 500) return { delivered: false, reason: "server" };
    return { delivered: false, reason: "rejected" };
  },
};

async function boundedText(response: Response): Promise<string> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error("Svala receipt is too large");
  return text;
}

function parseReceiptResponse(text: string): { delivered: true; receipt: SvalaFingerprintReceipt; replayed: boolean; mission?: { missionId: string; status: SvalaMissionStatus } } {
  const root: unknown = JSON.parse(text);
  if (!isRecord(root, ["receipt", "replayed"], ["mission"]) || typeof root.replayed !== "boolean") throw new Error("Invalid receipt envelope");
  const receipt = root.receipt;
  if (!isExactRecord(receipt, ["receiptId", "fingerprintId", "acceptedAt", "status"])) throw new Error("Invalid receipt");
  if (typeof receipt.receiptId !== "string" || !/^[0-9a-f-]{36}$/i.test(receipt.receiptId)) throw new Error("Invalid receipt ID");
  if (typeof receipt.fingerprintId !== "string" || !/^fp_[a-f0-9]{32}$/.test(receipt.fingerprintId)) throw new Error("Invalid fingerprint ID");
  if (typeof receipt.acceptedAt !== "string" || !Number.isFinite(Date.parse(receipt.acceptedAt))) throw new Error("Invalid receipt time");
  if (receipt.status !== "accepted") throw new Error("Invalid receipt status");
  let mission: { missionId: string; status: SvalaMissionStatus } | undefined;
  if (root.mission !== undefined) {
    if (!isExactRecord(root.mission, ["missionId", "status"])) throw new Error("Invalid mission receipt");
    if (typeof root.mission.missionId !== "string" || !/^ratmission_[a-f0-9]{32}$/.test(root.mission.missionId)) throw new Error("Invalid mission ID");
    if (!isMissionStatus(root.mission.status)) throw new Error("Invalid mission status");
    mission = root.mission as { missionId: string; status: SvalaMissionStatus };
  }
  return { delivered: true, receipt: receipt as unknown as SvalaFingerprintReceipt, replayed: root.replayed, ...(mission ? { mission } : {}) };
}

function parseMissionResponse(text: string): SvalaCaptureMission {
  const root: unknown = JSON.parse(text);
  if (!isExactRecord(root, ["mission"])) throw new Error("Invalid mission response");
  return parseSvalaCaptureMission(root.mission);
}

export function parseSvalaCaptureMission(value: unknown): SvalaCaptureMission {
  if (!isRecord(value, ["schema", "id", "candidateId", "supplierLabel", "allowedOrigin", "requestedRoles", "actions", "eligibilityStatement", "priority", "status", "expiresAt", "claimedAt", "completedAt", "receiptId"])) throw new Error("Invalid mission response");
  const mission = value;
  if (mission.schema !== "ratatosk.capture-mission.v1") throw new Error("Invalid mission schema");
  if (typeof mission.id !== "string" || !/^ratmission_[a-f0-9]{32}$/.test(mission.id)) throw new Error("Invalid mission ID");
  if (typeof mission.candidateId !== "string" || !/^ratsup_[a-f0-9]{32}$/.test(mission.candidateId)) throw new Error("Invalid candidate ID");
  if (typeof mission.supplierLabel !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(mission.supplierLabel)) throw new Error("Invalid supplier label");
  if (typeof mission.allowedOrigin !== "string" || new URL(mission.allowedOrigin).origin !== mission.allowedOrigin || !mission.allowedOrigin.startsWith("https://")) throw new Error("Invalid mission origin");
  const roles = ["auth", "invoice_list", "document", "pagination", "multi_scope"];
  if (!Array.isArray(mission.requestedRoles) || !mission.requestedRoles.length || mission.requestedRoles.some((role) => typeof role !== "string" || !roles.includes(role))) throw new Error("Invalid mission roles");
  const actionKinds = ["open_billing", "reload", "open_invoice_list", "download_synthetic_document"];
  if (!Array.isArray(mission.actions) || !mission.actions.length || mission.actions.some((action) => !isExactRecord(action, ["kind", "label"]) || typeof action.kind !== "string" || !actionKinds.includes(action.kind) || typeof action.label !== "string" || action.label.length > 240 || /[<>]/.test(action.label))) throw new Error("Invalid mission actions");
  if (typeof mission.eligibilityStatement !== "string" || mission.eligibilityStatement.length > 300 || /[<>]/.test(mission.eligibilityStatement)) throw new Error("Invalid mission eligibility");
  if (!Number.isInteger(mission.priority) || Number(mission.priority) < 0 || Number(mission.priority) > 100 || !isMissionStatus(mission.status)) throw new Error("Invalid mission state");
  if (typeof mission.expiresAt !== "string" || !Number.isFinite(Date.parse(mission.expiresAt))) throw new Error("Invalid mission expiry");
  for (const key of ["claimedAt", "completedAt"] as const) if (mission[key] !== null && (typeof mission[key] !== "string" || !Number.isFinite(Date.parse(mission[key] as string)))) throw new Error("Invalid mission timestamp");
  if (mission.receiptId !== null && (typeof mission.receiptId !== "string" || !/^[0-9a-f-]{36}$/i.test(mission.receiptId))) throw new Error("Invalid mission receipt");
  return mission as unknown as SvalaCaptureMission;
}

function isExactRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).every((key) => keys.includes(key))
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isRecord(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  const keys = [...required, ...optional];
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).every((key) => keys.includes(key))
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isMissionStatus(value: unknown): value is SvalaMissionStatus {
  return ["open", "claimed", "received", "needs_another_capture", "accepted_for_review", "closed", "withdrawn", "expired"].includes(String(value));
}
