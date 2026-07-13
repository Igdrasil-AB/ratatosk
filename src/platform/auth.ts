/**
 * The user's session token for authenticating to the *host backend* (not to
 * vendors — vendor auth rides cookies and never touches this).
 *
 * SECURITY. The token is the crown jewel, so it is handled defensively:
 *   - stored in `chrome.storage.session` (in-memory, wiped when the browser
 *     closes) rather than `chrome.storage.local` (unencrypted on disk);
 *   - `session` storage defaults to TRUSTED_CONTEXTS, so a content script (or an
 *     injected page script) cannot read it — only the service worker / extension
 *     pages can;
 *   - it is treated as a bearer secret: never logged, never written into a
 *     recipe/report/fixture, and only ever sent to an allow-listed backend host
 *     (see `http-sink.ts` `allowTokenHosts`).
 *
 * Prefer a short-lived, `documents:ingest`-scoped upload token here over a
 * full-scope session JWT once the backend can mint one. The popup or the
 * web-app connect handshake (`onMessageExternal`) sets this; the sink reads it
 * per request. Kept in its own module so swapping the host auth scheme touches
 * exactly one file.
 */
const TOKEN_KEY = "hostToken";

export function getHostToken(): Promise<string | undefined> {
  return new Promise((resolve) =>
    chrome.storage.session.get(TOKEN_KEY, (o) => resolve(o[TOKEN_KEY] as string | undefined)),
  );
}

export function setHostToken(token: string): Promise<void> {
  return new Promise((resolve) => chrome.storage.session.set({ [TOKEN_KEY]: token }, () => resolve()));
}

export function clearHostToken(): Promise<void> {
  return new Promise((resolve) => chrome.storage.session.remove(TOKEN_KEY, () => resolve()));
}
