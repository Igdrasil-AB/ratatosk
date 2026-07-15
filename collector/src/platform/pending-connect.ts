/**
 * Short-lived handoff between the action popup and the service worker.
 *
 * Chrome may destroy an action popup while it shows the native optional-host
 * permission prompt. Keeping the selected bundled vendor in storage.session
 * lets permissions.onAdded finish the connection without relying on that popup
 * JavaScript context. Session storage is extension-only and clears on restart.
 */

const KEY = "pendingVendorConnect";
const MAX_AGE_MS = 5 * 60_000;

export interface PendingConnect {
  vendorId: string;
  origins: string[];
  startedAt: number;
}

export async function setPendingConnect(
  vendorId: string,
  origins: readonly string[],
  startedAt = Date.now(),
): Promise<void> {
  await chrome.storage.session.set({
    [KEY]: { vendorId, origins: [...origins], startedAt } satisfies PendingConnect,
  });
}

export async function getPendingConnect(now = Date.now()): Promise<PendingConnect | null> {
  const value = (await chrome.storage.session.get(KEY))[KEY] as Partial<PendingConnect> | undefined;
  if (!isPendingConnect(value) || now - value.startedAt > MAX_AGE_MS || value.startedAt > now + 60_000) {
    if (value !== undefined) await chrome.storage.session.remove(KEY);
    return null;
  }
  return value;
}

export async function clearPendingConnect(vendorId?: string): Promise<void> {
  if (vendorId) {
    const pending = await getPendingConnect();
    if (!pending || pending.vendorId !== vendorId) return;
  }
  await chrome.storage.session.remove(KEY);
}

function isPendingConnect(value: Partial<PendingConnect> | undefined): value is PendingConnect {
  return Boolean(
    value
      && typeof value.vendorId === "string"
      && value.vendorId.length > 0
      && value.vendorId.length <= 100
      && Array.isArray(value.origins)
      && value.origins.length > 0
      && value.origins.length <= 20
      && value.origins.every((origin) => typeof origin === "string" && origin.startsWith("https://"))
      && typeof value.startedAt === "number"
      && Number.isFinite(value.startedAt),
  );
}
