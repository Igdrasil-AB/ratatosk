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

export async function getHostToken(): Promise<string | undefined> {
  const values = await chrome.storage.local.get(TOKEN_KEY);
  return values[TOKEN_KEY] as string | undefined;
}

export async function setHostToken(token: string): Promise<void> {
  if (!/^rat_[a-f0-9]{64}$/.test(token)) throw new Error("invalid backend token");
  await chrome.storage.local.set({ [TOKEN_KEY]: token });
}

export async function clearHostToken(): Promise<void> {
  await chrome.storage.local.remove(TOKEN_KEY);
}
