/**
 * Protocol v2 — the Ratatosk ↔ Igdrasil connect contract.
 *
 * Platform-free on purpose: the service worker, the popup, the tests, and the
 * drop-in web-app client all narrow the same shapes here rather than each
 * re-deriving them. The frozen JSON under `test/fixtures/igdrasil-connect/` is
 * asserted against this module, and mirrored into the Igdrasil repository, so a
 * change on one side that is not made on the other fails both test suites.
 *
 * What changed from v1:
 *   - every announcement and response carries `protocol`;
 *   - `igdrasil:connect` ADDS a company instead of replacing the destination,
 *     and carries the company's display name;
 *   - `igdrasil:status` returns the full company list (breaking);
 *   - `igdrasil:disconnect` requires the company to disconnect;
 *   - refusals carry a stable `code` instead of prose, so the web app can
 *     translate them.
 */

export const IGDRASIL_CONNECT_PROTOCOL = 2;

/**
 * Stable refusal codes. Prose belongs to whichever surface renders the failure;
 * Ratatosk's own wording used to land untranslated inside an otherwise i18n'd
 * toast in the accounting app.
 */
export const IGDRASIL_CONNECT_ERROR_CODES = [
  "intent_missing",
  "intent_expired",
  "origin_not_allowed",
  "token_invalid",
  "backend_not_allowed",
  "company_already_connected",
  "unknown_company",
  "invalid_request",
  "revoke_failed",
] as const;

export type IgdrasilConnectErrorCode = typeof IGDRASIL_CONNECT_ERROR_CODES[number];

export const IGDRASIL_CONNECT_MESSAGE_TYPES = [
  "igdrasil:ping",
  "igdrasil:prepare",
  "igdrasil:validate",
  "igdrasil:connect",
  "igdrasil:status",
  "igdrasil:disconnect",
] as const;

export type IgdrasilConnectMessageType = typeof IGDRASIL_CONNECT_MESSAGE_TYPES[number];

/** `igdrasil:ping` is answered by the bridge itself; the rest reach the worker. */
export const IGDRASIL_RELAYED_MESSAGE_TYPES: readonly IgdrasilConnectMessageType[] = [
  "igdrasil:prepare",
  "igdrasil:validate",
  "igdrasil:connect",
  "igdrasil:status",
  "igdrasil:disconnect",
];

const TOKEN_PATTERN = /^rat_[a-f0-9]{64}$/;
const STATE_PATTERN = /^[a-f0-9]{64}$/;
const MAX_COMPANY_ID_LENGTH = 200;
const MAX_COMPANY_NAME_LENGTH = 200;

export interface IgdrasilPrepareRequest { type: "igdrasil:prepare" }
export interface IgdrasilValidateRequest { type: "igdrasil:validate"; state: string }
export interface IgdrasilConnectRequest {
  type: "igdrasil:connect";
  token: string;
  companyId: string;
  companyName: string;
  apiBaseUrl: string;
  state: string;
  /** ISO-8601 expiry echoed from the mint response, so the panel can warn. */
  expiresAt?: string;
}
export interface IgdrasilStatusRequest { type: "igdrasil:status" }
export interface IgdrasilDisconnectRequest { type: "igdrasil:disconnect"; companyId: string }

export type IgdrasilAppRequest =
  | IgdrasilPrepareRequest
  | IgdrasilValidateRequest
  | IgdrasilConnectRequest
  | IgdrasilStatusRequest
  | IgdrasilDisconnectRequest;

export interface IgdrasilConnectedCompany {
  companyId: string;
  companyName: string;
  supplierCount: number;
  /** Absent when the extension never learned the credential's expiry. */
  expiresAt?: string;
}

export type IgdrasilAppResponse =
  | { ok: true; protocol: number; state?: string; companies?: IgdrasilConnectedCompany[] }
  | { ok: false; protocol: number; code: IgdrasilConnectErrorCode };

export function igdrasilRefusal(code: IgdrasilConnectErrorCode): IgdrasilAppResponse {
  return { ok: false, protocol: IGDRASIL_CONNECT_PROTOCOL, code };
}

export function isIgdrasilConnectErrorCode(value: unknown): value is IgdrasilConnectErrorCode {
  return typeof value === "string"
    && (IGDRASIL_CONNECT_ERROR_CODES as readonly string[]).includes(value);
}

export function isCollectorToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function isConnectIntentState(value: unknown): value is string {
  return typeof value === "string" && STATE_PATTERN.test(value);
}

export function isCompanyId(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= MAX_COMPANY_ID_LENGTH
    && value.trim() === value;
}

function isCompanyName(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= MAX_COMPANY_NAME_LENGTH;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 40
    && Number.isFinite(Date.parse(value));
}

/**
 * Narrow one page-supplied message, field by field.
 *
 * The v1 predicate checked only `.type` and then asserted the whole union, so
 * the compiler believed attacker-supplied page data was `string`. The runtime
 * `typeof` guards that made that safe were convention, not enforcement — and
 * protocol v2 adds fields. Returning `null` for anything that does not narrow
 * makes the compiler, not a reviewer, the thing that keeps them honest.
 */
export function parseIgdrasilAppRequest(value: unknown): IgdrasilAppRequest | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "igdrasil:prepare":
      return { type: "igdrasil:prepare" };
    case "igdrasil:status":
      return { type: "igdrasil:status" };
    case "igdrasil:validate":
      return isConnectIntentState(message.state)
        ? { type: "igdrasil:validate", state: message.state }
        : null;
    case "igdrasil:disconnect":
      return isCompanyId(message.companyId)
        ? { type: "igdrasil:disconnect", companyId: message.companyId }
        : null;
    case "igdrasil:connect": {
      // A v1-shaped connect — a session JWT, no state, an `${origin}/api` base —
      // fails each of these independently and is refused as `invalid_request`.
      if (
        !isCollectorToken(message.token)
        || !isCompanyId(message.companyId)
        || !isCompanyName(message.companyName)
        || typeof message.apiBaseUrl !== "string"
        || message.apiBaseUrl.length > 200
        || !isConnectIntentState(message.state)
      ) return null;
      const expiresAt = message.expiresAt;
      if (expiresAt !== undefined && !isIsoTimestamp(expiresAt)) return null;
      return {
        type: "igdrasil:connect",
        token: message.token,
        companyId: message.companyId,
        companyName: message.companyName.trim(),
        apiBaseUrl: message.apiBaseUrl,
        state: message.state,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      };
    }
    default:
      return null;
  }
}

/** The message type of a relayable request, without narrowing its payload. */
export function igdrasilRequestType(value: unknown): IgdrasilConnectMessageType | null {
  const type = (value as { type?: unknown } | null | undefined)?.type;
  return typeof type === "string"
    && (IGDRASIL_CONNECT_MESSAGE_TYPES as readonly string[]).includes(type)
    ? type as IgdrasilConnectMessageType
    : null;
}
