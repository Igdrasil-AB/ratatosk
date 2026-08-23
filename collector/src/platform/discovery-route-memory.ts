import { exactOriginPattern, safeEntryUrl } from "../../../src/core/discovery";

/**
 * Where invoices were last found on a supplier, remembered per origin.
 *
 * Discovery spends nearly all of its time answering one question: which page
 * on this site lists invoices. Measured across the portal corpus, a search that
 * starts on the billing page probes 2 pages; one that starts anywhere else
 * probes 6–10 and takes two to three times as long. The answer does not change
 * often, so re-deriving it on every search is the waste.
 *
 * This is that answer and nothing else — one entry URL per origin. It is not a
 * recipe: it says where to look, never what to request or how to read the
 * reply. A remembered route is re-probed like any other candidate route and
 * proves itself from scratch every time, so a supplier that moves its billing
 * page costs one wasted probe and then falls through to ordinary exploration.
 *
 * It deliberately outlives disconnecting a supplier. Reconnecting is exactly
 * when the shortcut is worth the most, and the route is a fact about the
 * supplier's site rather than about the connection. It is cleared by
 * `clearRememberedRoutes`, by uninstalling, and by repeated failure to confirm.
 *
 * Everything here stays on this machine. Nothing is uploaded or shared.
 */

const KEY = "discoveryRouteMemory.v2";
const LEGACY_KEY = "discoveryRouteMemory.v1";
/** Origins remembered before the least recently confirmed is evicted. */
const ORIGIN_CAP = 100;
/** Searches that failed to confirm a route before it is dropped as stale. */
const MAX_MISSES = 3;

let writeChain: Promise<void> = Promise.resolve();

export interface RememberedRoute {
  /** Exact HTTPS entry URL that produced a verified invoice candidate. */
  entryUrl: string;
  /** When the route was last confirmed by a real collection. */
  confirmedAt: number;
  /** Searches since that did not confirm it. Reset by every confirmation. */
  misses: number;
  /** The immediately preceding proved route. It is used only after the active
   * route fails repeatedly, then becomes active again without guessing. */
  previousEntryUrl?: string;
}

/**
 * The route to try first for an origin, if one is still trusted.
 *
 * Re-validated on every read rather than on write alone: stored data is
 * untrusted input, and this value decides which page the extension opens.
 */
export async function getRememberedRoute(origin: string): Promise<RememberedRoute | undefined> {
  const entries = await readValidated();
  return entries[canonicalOrigin(origin) ?? ""];
}

/**
 * Record the page a verified candidate was found on.
 *
 * Called only after a candidate has collected a real document, so the route is
 * backed by an invoice rather than by a shape that merely looked right.
 */
export async function rememberSupplierRoute(origin: string, entryUrl: string): Promise<void> {
  const key = canonicalOrigin(origin);
  const route = key ? safeRouteUrl(entryUrl, key) : undefined;
  if (!key || !route) return;
  await enqueue(async () => {
    const entries = await readValidated();
    const existing = entries[key];
    entries[key] = {
      entryUrl: route,
      confirmedAt: Date.now(),
      misses: 0,
      ...(existing && existing.entryUrl !== route ? { previousEntryUrl: existing.entryUrl } :
        existing?.previousEntryUrl ? { previousEntryUrl: existing.previousEntryUrl } : {}),
    };
    await write(evictOldest(entries));
  });
}

/**
 * Note that a search did not confirm the remembered route.
 *
 * A supplier that moves its billing page would otherwise leave the extension
 * probing a dead route on every future search. Three failures is enough to
 * distinguish a moved page from a signed-out session or a transient error,
 * both of which fail every route equally.
 */
export async function recordRouteMiss(origin: string): Promise<void> {
  const key = canonicalOrigin(origin);
  if (!key) return;
  await enqueue(async () => {
    const entries = await readValidated();
    const existing = entries[key];
    if (!existing) return;
    const misses = existing.misses + 1;
    if (misses >= MAX_MISSES && existing.previousEntryUrl) {
      entries[key] = { entryUrl: existing.previousEntryUrl, confirmedAt: Date.now(), misses: 0 };
    } else if (misses >= MAX_MISSES) delete entries[key];
    else entries[key] = { ...existing, misses };
    await write(entries);
  });
}

export async function forgetSupplierRoute(origin: string): Promise<void> {
  const key = canonicalOrigin(origin);
  if (!key) return;
  await enqueue(async () => {
    const entries = await readValidated();
    if (!(key in entries)) return;
    delete entries[key];
    await write(entries);
  });
}

/** Every remembered route, for disclosure and for clearing. */
export async function listRememberedRoutes(): Promise<Record<string, RememberedRoute>> {
  return readValidated();
}

export async function clearRememberedRoutes(): Promise<void> {
  await enqueue(async () => {
    await chrome.storage.local.remove(KEY);
    await chrome.storage.local.remove(LEGACY_KEY);
  });
}

// ---- storage --------------------------------------------------------------

/**
 * Read the store, dropping anything that no longer validates.
 *
 * Fails closed per entry: one unparseable record cannot deny the shortcut to
 * every other supplier, and no record reaches the explorer without passing the
 * same origin and entry-URL policy a freshly discovered route must pass.
 */
async function readValidated(): Promise<Record<string, RememberedRoute>> {
  let raw: unknown;
  try {
    raw = (await chrome.storage.local.get(KEY))[KEY];
    if (raw === undefined) raw = (await chrome.storage.local.get(LEGACY_KEY))[LEGACY_KEY];
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const valid: Record<string, RememberedRoute> = {};
  for (const [origin, value] of Object.entries(raw as Record<string, unknown>).slice(0, ORIGIN_CAP)) {
    const key = canonicalOrigin(origin);
    if (!key || key !== origin || !value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const entryUrl = typeof entry.entryUrl === "string" ? safeRouteUrl(entry.entryUrl, key) : undefined;
    const confirmedAt = Number(entry.confirmedAt);
    const misses = Number(entry.misses);
    const previousEntryUrl = typeof entry.previousEntryUrl === "string" ? safeRouteUrl(entry.previousEntryUrl, key) : undefined;
    if (!entryUrl || !Number.isFinite(confirmedAt) || confirmedAt <= 0) continue;
    if (!Number.isInteger(misses) || misses < 0 || misses >= MAX_MISSES) continue;
    if (entry.previousEntryUrl !== undefined && (!previousEntryUrl || previousEntryUrl === entryUrl)) continue;
    valid[key] = { entryUrl, confirmedAt, misses, ...(previousEntryUrl ? { previousEntryUrl } : {}) };
  }
  return valid;
}

async function write(entries: Record<string, RememberedRoute>): Promise<void> {
  await chrome.storage.local.set({ [KEY]: entries });
  await chrome.storage.local.remove(LEGACY_KEY);
}

/** Keep the most recently confirmed routes; a shortcut nobody uses is not worth
 * unbounded storage. */
function evictOldest(entries: Record<string, RememberedRoute>): Record<string, RememberedRoute> {
  const items = Object.entries(entries);
  if (items.length <= ORIGIN_CAP) return entries;
  items.sort(([, left], [, right]) => right.confirmedAt - left.confirmedAt);
  return Object.fromEntries(items.slice(0, ORIGIN_CAP));
}

/** The exact HTTPS origin, or nothing if it is not one Ratatosk may act on. */
function canonicalOrigin(value: string): string | undefined {
  try {
    exactOriginPattern(value);
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/**
 * A stored route must still be an entry page discovery would accept today:
 * same origin, HTTPS, no query, no credential-shaped path. Policy travels with
 * the read, so tightening `safeEntryUrl` retroactively invalidates anything
 * stored under looser rules.
 */
function safeRouteUrl(value: string, origin: string): string | undefined {
  try {
    const safe = safeEntryUrl(value);
    return new URL(safe).origin === origin ? safe : undefined;
  } catch {
    return undefined;
  }
}

function enqueue(mutation: () => Promise<void>): Promise<void> {
  const result = writeChain.then(mutation, mutation);
  writeChain = result.catch(() => undefined);
  return result;
}
