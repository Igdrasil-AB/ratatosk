/**
 * The upload-only token for authenticating to the *host backend* (not to vendors
 * — vendor auth rides cookies and never touches this).
 *
 * SECURITY. The token is the crown jewel, so it is handled defensively:
 *   - stores only an Igdrasil-issued, upload-only Collector token — never the
 *     user's general Clerk session JWT;
 *   - stored in extension-local storage so scheduled collection survives a
 *     browser restart; content scripts cannot access extension storage directly;
 *   - it is treated as a bearer secret: never logged, never written into a
 *     recipe/report/fixture, and only ever sent to an allow-listed backend host
 *     (see `http-sink.ts` `allowTokenHosts`).
 *
 * The web-app connect handshake sets this after minting it from an authenticated,
 * tenant-scoped backend route; the sink reads it per request.
 */
const TOKEN_KEY = "hostToken";
let hostTokenStorageAccess: Promise<void> | undefined;

function isCollectorToken(value: unknown): value is string {
  return typeof value === "string" && /^rat_[a-f0-9]{64}$/.test(value);
}

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

export async function getHostToken(): Promise<string | undefined> {
  await initializeHostTokenStorage();
  const values = await chrome.storage.local.get(TOKEN_KEY);
  const token = values[TOKEN_KEY];
  if (token === undefined) return undefined;
  if (isCollectorToken(token)) return token;
  // Stored data is untrusted across extension upgrades and external mutation.
  // Never turn an arbitrary persisted value into an authorization header.
  await chrome.storage.local.remove(TOKEN_KEY);
  return undefined;
}

export async function setHostToken(token: string): Promise<void> {
  if (!isCollectorToken(token)) throw new Error("invalid backend token");
  await initializeHostTokenStorage();
  await chrome.storage.local.set({ [TOKEN_KEY]: token });
}

export async function clearHostToken(): Promise<void> {
  await initializeHostTokenStorage();
  await chrome.storage.local.remove(TOKEN_KEY);
}
