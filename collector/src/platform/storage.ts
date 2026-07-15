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

export type ConnectionStatus = "ok" | "auth_expired" | "error";

export interface Connection {
  vendorId: string;
  connectedAt: number;
  lastRunAt?: number;
  lastStatus?: ConnectionStatus;
  lastError?: string;
  lastCount?: number;
}

const KEY = { config: "config", connections: "connections", seen: "seen", ledger: "ledger" } as const;
const SEEN_CAP = 5000;
const LEDGER_CAP = 100;

// ---- sink config ----------------------------------------------------------

export const getSinkConfig = () => get<SinkConfig>(KEY.config);
export const setSinkConfig = (cfg: SinkConfig) => set(KEY.config, validateSinkConfig(cfg));
export const clearSinkConfig = () => remove(KEY.config);

// ---- connections ----------------------------------------------------------

export async function getConnections(): Promise<Record<string, Connection>> {
  return (await get<Record<string, Connection>>(KEY.connections)) ?? {};
}

export async function upsertConnection(conn: Connection): Promise<void> {
  const all = await getConnections();
  all[conn.vendorId] = conn;
  await set(KEY.connections, all);
}

export async function removeConnection(vendorId: string): Promise<void> {
  const all = await getConnections();
  delete all[vendorId];
  await set(KEY.connections, all);
}

/** Merge a run outcome into a connection, preserving `connectedAt`. */
export async function recordRun(
  vendorId: string,
  patch: Partial<Omit<Connection, "vendorId" | "connectedAt">>,
): Promise<void> {
  const existing = (await getConnections())[vendorId];
  await upsertConnection({
    vendorId,
    connectedAt: existing?.connectedAt ?? Date.now(),
    lastRunAt: Date.now(),
    ...patch,
  });
}

// ---- seen set (bounded) ---------------------------------------------------

export function seenStore(): SeenStore {
  return {
    async has(key) {
      const map = (await get<Record<string, unknown>>(KEY.seen)) ?? {};
      return key in map;
    },
    async add(key, source) {
      const map = (await get<Record<string, unknown>>(KEY.seen)) ?? {};
      map[key] = source ?? ""; // value tags the vendor so history is clearable
      const keys = Object.keys(map);
      if (keys.length > SEEN_CAP) for (const k of keys.slice(0, keys.length - SEEN_CAP)) delete map[k];
      await set(KEY.seen, map);
    },
  };
}

/** Forget a vendor's download history (so a reconnect re-fetches). Also clears
 * legacy untagged entries from before keys carried a source. */
export async function clearSeenForSource(source: string): Promise<void> {
  const map = (await get<Record<string, unknown>>(KEY.seen)) ?? {};
  let changed = false;
  for (const [k, v] of Object.entries(map)) {
    if (v === source || typeof v === "number") {
      delete map[k];
      changed = true;
    }
  }
  if (changed) await set(KEY.seen, map);
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
  const existing = (await get<LedgerEntry[]>(KEY.ledger)) ?? [];
  const byKey = new Map(existing.map((e) => [e.key, e]));
  for (const e of entries) byKey.set(e.key, e);
  const merged = [...byKey.values()].sort((a, b) => b.collectedAt - a.collectedAt).slice(0, LEDGER_CAP);
  await set(KEY.ledger, merged);
}

/** Remove a disconnected vendor's user-facing collection history. */
export async function clearLedgerForVendor(vendorId: string): Promise<void> {
  const existing = (await get<LedgerEntry[]>(KEY.ledger)) ?? [];
  const kept = existing.filter((entry) => entry.vendorId !== vendorId);
  if (kept.length !== existing.length) await set(KEY.ledger, kept);
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
  const values = await chrome.storage.local.get(key);
  return values[key] as T | undefined;
}

async function set(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

async function remove(key: string): Promise<void> {
  await chrome.storage.local.remove(key);
}
