/**
 * The upload-only tokens for authenticating to the *host backend* (not to
 * vendors — vendor auth rides cookies and never touches these).
 *
 * SECURITY. A token is the crown jewel, so it is handled defensively:
 *   - stores only Igdrasil-issued, upload-only Collector tokens — never the
 *     user's general Clerk session JWT;
 *   - stored in extension-local storage so scheduled collection survives a
 *     browser restart; content scripts cannot access extension storage directly;
 *   - treated as a bearer secret: never logged, never written into a
 *     recipe/report/fixture, and only ever sent to an allow-listed backend host
 *     (see `http-sink.ts` `allowTokenHosts`).
 *
 * There is one token PER COMPANY, keyed by company id. Company A's token must
 * never travel with company B's id, and the only way to ask for a token is to
 * name the company it belongs to.
 *
 * The web-app connect handshake sets one after minting it from an
 * authenticated, tenant-scoped backend route; the sink reads the one belonging
 * to the destination it was built for.
 */
import { isCollectorToken } from "../../../src/ingest/igdrasil-protocol";

const TOKENS_KEY = "hostTokens";
/** Pre-multi-company single token. Read once by the migration, then removed. */
const LEGACY_TOKEN_KEY = "hostToken";
let hostTokenStorageAccess: Promise<void> | undefined;

/** Restrict local storage before any upload credential is read or written. The
 * extension service worker is a trusted context; content scripts are not. */
export function initializeHostTokenStorage(): Promise<void> {
  if (!hostTokenStorageAccess) {
    hostTokenStorageAccess = chrome.storage.local
      .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
      .catch((error: unknown) => {
        hostTokenStorageAccess = undefined;
        throw new Error(`unable to restrict Collector credential storage (${error instanceof Error ? error.name : "error"})`);
      });
  }
  return hostTokenStorageAccess;
}

/**
 * Read the whole map, discarding anything that is not a Collector token.
 *
 * Stored data is untrusted across extension upgrades and external mutation, and
 * that discipline has to survive going from one token to many: a map is a
 * larger surface, not a smaller one.
 */
async function readHostTokens(): Promise<Record<string, string>> {
  await initializeHostTokenStorage();
  const values = await chrome.storage.local.get(TOKENS_KEY);
  const stored = values[TOKENS_KEY];
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  const tokens: Record<string, string> = {};
  let discarded = false;
  for (const [companyId, token] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof companyId === "string" && companyId.length > 0 && isCollectorToken(token)) tokens[companyId] = token;
    else discarded = true;
  }
  // Never turn an arbitrary persisted value into an authorization header, and
  // do not leave one sitting in storage either.
  if (discarded) await chrome.storage.local.set({ [TOKENS_KEY]: tokens });
  return tokens;
}

export async function getHostToken(companyId: string): Promise<string | undefined> {
  return (await readHostTokens())[companyId];
}

export async function setHostToken(companyId: string, token: string): Promise<void> {
  if (!companyId.trim()) throw new Error("invalid company id");
  if (!isCollectorToken(token)) throw new Error("invalid backend token");
  const tokens = await readHostTokens();
  tokens[companyId] = token;
  await chrome.storage.local.set({ [TOKENS_KEY]: tokens });
}

export async function clearHostToken(companyId: string): Promise<void> {
  const tokens = await readHostTokens();
  if (!(companyId in tokens)) return;
  delete tokens[companyId];
  await chrome.storage.local.set({ [TOKENS_KEY]: tokens });
}

/** Companies this browser profile currently holds a credential for. */
export async function connectedCompanyIds(): Promise<string[]> {
  return Object.keys(await readHostTokens());
}

/** The pre-multi-company token, for the one-time migration only. */
export async function readLegacyHostToken(): Promise<string | undefined> {
  await initializeHostTokenStorage();
  const values = await chrome.storage.local.get(LEGACY_TOKEN_KEY);
  const token = values[LEGACY_TOKEN_KEY];
  return isCollectorToken(token) ? token : undefined;
}

export async function clearLegacyHostToken(): Promise<void> {
  await initializeHostTokenStorage();
  await chrome.storage.local.remove(LEGACY_TOKEN_KEY);
}

/** Replace the whole map in one commit, used by the migration. */
export async function writeHostTokens(tokens: Record<string, string>): Promise<void> {
  for (const [companyId, token] of Object.entries(tokens)) {
    if (!companyId.trim() || !isCollectorToken(token)) throw new Error("invalid backend token");
  }
  await initializeHostTokenStorage();
  await chrome.storage.local.set({ [TOKENS_KEY]: tokens });
}
