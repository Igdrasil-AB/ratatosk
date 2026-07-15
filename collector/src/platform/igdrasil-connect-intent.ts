/**
 * One-use proof that the user started the Igdrasil destination flow from the
 * extension. The web app returns this value after auth/onboarding; the service
 * worker consumes it before accepting a destination token.
 */

const KEY = "pendingIgdrasilConnect";
const CONNECT_URL = "https://accounting.igdrasil.se/integrations/invoice-collector/connect";
// Long enough for a first-time accounting onboarding, still bounded and one-use.
const MAX_AGE_MS = 60 * 60_000;

interface StoredIntent {
  state: string;
  startedAt: number;
}

export interface IgdrasilConnectIntent {
  state: string;
  url: string;
}

export async function createIgdrasilConnectIntent(
  startedAt = Date.now(),
): Promise<IgdrasilConnectIntent> {
  const state = randomState();
  await chrome.storage.session.set({ [KEY]: { state, startedAt } satisfies StoredIntent });
  const url = new URL(CONNECT_URL);
  url.searchParams.set("state", state);
  return { state, url: url.toString() };
}

export async function consumeIgdrasilConnectIntent(
  state: string,
  now = Date.now(),
): Promise<boolean> {
  const value = (await chrome.storage.session.get(KEY))[KEY] as Partial<StoredIntent> | undefined;
  const valid = isValidIntent(value, state, now);
  if (value !== undefined) await chrome.storage.session.remove(KEY);
  return valid;
}

/** Check the browser-held intent before the web app mints a token. */
export async function validateIgdrasilConnectIntent(
  state: string,
  now = Date.now(),
): Promise<boolean> {
  const value = (await chrome.storage.session.get(KEY))[KEY] as Partial<StoredIntent> | undefined;
  return isValidIntent(value, state, now);
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isStoredIntent(value: Partial<StoredIntent> | undefined): value is StoredIntent {
  return Boolean(
    value
      && typeof value.state === "string"
      && /^[a-f0-9]{64}$/.test(value.state)
      && typeof value.startedAt === "number"
      && Number.isFinite(value.startedAt),
  );
}

function isValidIntent(
  value: Partial<StoredIntent> | undefined,
  state: string,
  now: number,
): boolean {
  return Boolean(
    isStoredIntent(value)
      && typeof state === "string"
      && state.length <= 200
      && value.state === state
      && now - value.startedAt <= MAX_AGE_MS
      && value.startedAt <= now + 60_000,
  );
}
