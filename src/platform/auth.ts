/**
 * The user's session token for authenticating to the *host backend* (not to
 * vendors — vendor auth rides cookies and never touches this).
 *
 * In production the popup obtains a Clerk session JWT from the Igdrasil web app
 * and stores it here; the sink reads it per request. Kept in its own module so
 * swapping the host auth scheme touches exactly one file.
 */
export function getHostToken(): Promise<string | undefined> {
  return new Promise((resolve) =>
    chrome.storage.local.get("hostToken", (o) => resolve(o.hostToken as string | undefined)),
  );
}

export function setHostToken(token: string): Promise<void> {
  return new Promise((resolve) => chrome.storage.local.set({ hostToken: token }, () => resolve()));
}
