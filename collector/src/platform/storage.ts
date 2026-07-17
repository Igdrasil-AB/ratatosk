import type { OperationalOutcomeCode } from "../../../src/core/errors";
import type { SeenStore } from "../../../src/core/types";

/**
 * Typed wrapper over `chrome.storage.local`.
 *
 * Holds three things: the sink configuration, the set of connected vendors with
 * their last-run state, and the seen-set of idempotency keys (bounded, so it
 * cannot grow without limit).
 */

export type SinkConfig =
  | { kind: "filesystem"; rootFolder: string; dateMode: "extraction" | "invoice" }
  | { kind: "http"; endpoint: string; companyId: string }
  | { kind: "igdrasil"; endpoint: string; companyId: string };

/** The tenant id used for dedup keys: a constant for local files, else the configured company. */
export function sinkCompanyId(cfg: SinkConfig | undefined): string {
  if (!cfg) return "dry-run";
  return cfg.kind === "filesystem" ? "local" : cfg.companyId;
}

export type ConnectionStatus = "ok" | "partial" | "auth_expired" | "rate_limited" | "error";

export interface Connection {
  vendorId: string;
  connectedAt: number;
  /** Most recent completed attempt, whether successful or not. */
  lastRunAt?: number;
  lastSuccessAt?: number;
  consecutiveFailures?: number;
  lastStatus?: ConnectionStatus;
  lastError?: string;
  lastCount?: number;
  lastCode?: OperationalOutcomeCode;
  lastFailedScopes?: number;
  lastEmptyScopes?: number;
  nextEligibleRunAt?: number;
}

const KEY = { config: "config", connections: "connections", seen: "seen", ledger: "ledger" } as const;
const SEEN_CAP = 5000;
const LEDGER_CAP = 100;
const MAX_RATE_LIMIT_DELAY_MS = 24 * 60 * 60 * 1_000;
const MIN_RATE_LIMIT_DELAY_MS = 5_000;
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1_000;
const writeChains = new Map<string, Promise<void>>();

// ---- sink config ----------------------------------------------------------

export const getSinkConfig = () => get<SinkConfig>(KEY.config);
export const setSinkConfig = (cfg: SinkConfig) => set(KEY.config, validateSinkConfig(cfg));
export const clearSinkConfig = () => remove(KEY.config);

// ---- connections ----------------------------------------------------------

export async function getConnections(): Promise<Record<string, Connection>> {
  return (await get<Record<string, Connection>>(KEY.connections)) ?? {};
}

export async function upsertConnection(conn: Connection): Promise<void> {
  await mutate<Record<string, Connection>>(KEY.connections, {}, (all) => {
    all[conn.vendorId] = conn;
    return all;
  });
}

export async function removeConnection(vendorId: string): Promise<void> {
  await mutate<Record<string, Connection>>(KEY.connections, {}, (all) => {
    delete all[vendorId];
    return all;
  });
}

/** Merge a run outcome into a connection, preserving `connectedAt`. */
export async function recordRun(
  vendorId: string,
  patch: Partial<Omit<Connection, "vendorId" | "connectedAt">>,
  now = Date.now(),
): Promise<void> {
  await mutate<Record<string, Connection>>(KEY.connections, {}, (all) => {
    const existing = all[vendorId];
    const successful = patch.lastStatus === "ok" || patch.lastStatus === "partial";
    const failed = patch.lastStatus === "auth_expired" || patch.lastStatus === "rate_limited" || patch.lastStatus === "error";
    const next: Connection = {
      vendorId,
      connectedAt: existing?.connectedAt ?? now,
      lastRunAt: now,
      lastSuccessAt: successful ? now : existing?.lastSuccessAt,
      ...(successful ? { consecutiveFailures: 0 } : {}),
      ...(failed ? { consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1 } : {}),
      ...patch,
    };
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) delete (next as unknown as Record<string, unknown>)[key];
    }
    all[vendorId] = next;
    return all;
  });
}

export function boundedNextEligibleRunAt(retryAfterMs: number, now = Date.now()): number {
  const requested = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 30_000;
  return now + Math.min(MAX_RATE_LIMIT_DELAY_MS, Math.max(MIN_RATE_LIMIT_DELAY_MS, requested));
}

export async function getNextEligibleRunAt(vendorId: string, now = Date.now()): Promise<number | null> {
  const connection = (await getConnections())[vendorId];
  const value = connection?.nextEligibleRunAt;
  if (value === undefined) return null;
  const valid = Number.isFinite(value) && value > now && value <= now + MAX_RATE_LIMIT_DELAY_MS + CLOCK_SKEW_TOLERANCE_MS;
  if (valid) return value;
  await mutate<Record<string, Connection>>(KEY.connections, {}, (all) => {
    if (all[vendorId]) delete all[vendorId].nextEligibleRunAt;
    return all;
  });
  return null;
}

// ---- seen set (bounded) ---------------------------------------------------

export function seenStore(): SeenStore {
  return {
    async has(key) {
      const map = (await get<Record<string, unknown>>(KEY.seen)) ?? {};
      return key in map;
    },
    async add(key, source) {
      await mutate<Record<string, unknown>>(KEY.seen, {}, (map) => {
        map[key] = source ?? ""; // value tags the vendor so history is clearable
        const keys = Object.keys(map);
        if (keys.length > SEEN_CAP) for (const k of keys.slice(0, keys.length - SEEN_CAP)) delete map[k];
        return map;
      });
    },
  };
}

/** Forget a vendor's download history (so a reconnect re-fetches). Also clears
 * legacy untagged entries from before keys carried a source. */
export async function clearSeenForSource(source: string): Promise<void> {
  await mutate<Record<string, unknown>>(KEY.seen, {}, (map) => {
    for (const [k, v] of Object.entries(map)) {
      if (v === source || typeof v === "number") delete map[k];
    }
    return map;
  });
}

// ---- collected-invoice ledger (bounded) -----------------------------------

/** One invoice the collector has saved — the feed the popup shows. */
export interface LedgerEntry {
  key: string; // idempotency key — dedups the ledger too
  vendorId: string;
  vendorName: string;
  issuedAt?: string;
  total?: string;
  currency?: string;
  collectedAt: number;
}

export async function getLedger(): Promise<LedgerEntry[]> {
  const all = (await get<LedgerEntry[]>(KEY.ledger)) ?? [];
  return [...all].sort((a, b) => b.collectedAt - a.collectedAt);
}

/** Append newly-collected invoices, newest kept, deduped by key, bounded. */
export async function recordCollected(entries: LedgerEntry[]): Promise<void> {
  if (!entries.length) return;
  await mutate<LedgerEntry[]>(KEY.ledger, [], (existing) => {
    const byKey = new Map(existing.map((entry) => [entry.key, entry]));
    for (const entry of entries) byKey.set(entry.key, entry);
    return [...byKey.values()].sort((a, b) => b.collectedAt - a.collectedAt).slice(0, LEDGER_CAP);
  });
}

/** Remove a disconnected vendor's user-facing collection history. */
export async function clearLedgerForVendor(vendorId: string): Promise<void> {
  await mutate<LedgerEntry[]>(KEY.ledger, [], (existing) => existing.filter((entry) => entry.vendorId !== vendorId));
}

/** How many entries were added in the most recent run (collectedAt within the window). */
export async function newSince(sinceMs: number): Promise<number> {
  return (await getLedger()).filter((e) => e.collectedAt >= sinceMs).length;
}

// ---- low-level ------------------------------------------------------------

function validateSinkConfig(cfg: SinkConfig): SinkConfig {
  if (!cfg || typeof cfg !== "object") throw new Error("invalid destination");
  if (cfg.kind === "filesystem") {
    const rootFolder = cfg.rootFolder.trim();
    if (!rootFolder || rootFolder.length > 100) throw new Error("invalid download folder");
    if (cfg.dateMode !== "extraction" && cfg.dateMode !== "invoice") throw new Error("invalid date mode");
    return { kind: "filesystem", rootFolder, dateMode: cfg.dateMode };
  }
  if (cfg.kind === "http" || cfg.kind === "igdrasil") {
    const endpoint = new URL(cfg.endpoint);
    const isLocal = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1";
    if (endpoint.protocol !== "https:" && !isLocal) throw new Error("destination must use HTTPS");
    if (!cfg.companyId.trim() || cfg.companyId.length > 200) throw new Error("invalid company id");
    return { kind: cfg.kind, endpoint: endpoint.toString().replace(/\/$/, ""), companyId: cfg.companyId.trim() };
  }
  throw new Error("unsupported destination");
}

async function get<T>(key: string): Promise<T | undefined> {
  await writeChains.get(key);
  return getRaw<T>(key);
}

async function getRaw<T>(key: string): Promise<T | undefined> {
  const values = await chrome.storage.local.get(key);
  return values[key] as T | undefined;
}

async function set(key: string, value: unknown): Promise<void> {
  await enqueueWrite(key, () => chrome.storage.local.set({ [key]: value }));
}

async function remove(key: string): Promise<void> {
  await enqueueWrite(key, () => chrome.storage.local.remove(key));
}

async function mutate<T>(key: string, fallback: T, update: (current: T) => T): Promise<void> {
  await enqueueWrite(key, async () => {
    const current = (await getRaw<T>(key)) ?? fallback;
    await chrome.storage.local.set({ [key]: update(current) });
  });
}

function enqueueWrite(key: string, operation: () => Promise<unknown>): Promise<void> {
  const previous = writeChains.get(key) ?? Promise.resolve();
  const current = previous.then(operation, operation).then(() => undefined);
  writeChains.set(key, current);
  return current.finally(() => {
    if (writeChains.get(key) === current) writeChains.delete(key);
  });
}
