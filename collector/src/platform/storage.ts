import type { OperationalOutcomeCode } from "../../../src/core/errors";
import type { SeenStore } from "../../../src/core/types";
import { isExactDocumentProviderOriginPattern } from "../../../src/core/document-provider";
import { normalizeIgdrasilApiBase } from "../../../src/ingest/igdrasil-sink";

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
  /** Legacy alias retained for diagnostics and older extension builds. */
  lastRunAt?: number;
  /** Most recent attempt, including failed and rate-limited runs. */
  lastAttemptAt?: number;
  /** Most recent run that completely traversed every available scope. */
  lastCompleteSyncAt?: number;
  /** Most recent run that committed at least one new document. */
  lastNewInvoiceAt?: number;
  lastStatus?: ConnectionStatus;
  lastError?: string;
  lastCount?: number;
  lastCode?: OperationalOutcomeCode;
  lastFailedScopes?: number;
  lastEmptyScopes?: number;
  nextEligibleRunAt?: number;
  /** Exact provider redirect origins approved for this connection. Capability
   * paths and signed query values are never persisted. */
  documentOrigins?: string[];
}

const KEY = { config: "config", connections: "connections", seen: "seen", ledger: "ledger" } as const;
const SEEN_CAP = 20_000;
const LEDGER_CAP = 1_000;
const MAX_RATE_LIMIT_DELAY_MS = 24 * 60 * 60 * 1_000;
const MIN_RATE_LIMIT_DELAY_MS = 5_000;
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1_000;
const SEEN_RESERVATION_LEASE_MS = 5 * 60 * 1_000;
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
    all[conn.vendorId] = {
      ...conn,
      ...(conn.documentOrigins ? { documentOrigins: safeDocumentOrigins(conn.documentOrigins) } : {}),
    };
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
): Promise<void> {
  await mutate<Record<string, Connection>>(KEY.connections, {}, (all) => {
    const existing = all[vendorId];
    // Connection removal is a user-controlled lifecycle boundary. A stale
    // collection completion may report telemetry only while its original
    // connection still exists; it must never resurrect a disconnected vendor.
    if (!existing) return all;
    const attemptedAt = Date.now();
    const next: Connection = {
      vendorId,
      connectedAt: existing.connectedAt,
      documentOrigins: existing.documentOrigins,
      lastRunAt: attemptedAt,
      lastAttemptAt: attemptedAt,
      lastCompleteSyncAt: patch.lastStatus === "ok" ? attemptedAt : existing.lastCompleteSyncAt,
      lastNewInvoiceAt: typeof patch.lastCount === "number" && patch.lastCount > 0
        ? attemptedAt
        : existing.lastNewInvoiceAt,
      ...patch,
    };
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) delete (next as unknown as Record<string, unknown>)[key];
    }
    if (next.documentOrigins) next.documentOrigins = safeDocumentOrigins(next.documentOrigins);
    all[vendorId] = next;
    return all;
  });
}

function safeDocumentOrigins(values: readonly string[]): string[] {
  if (values.length > 8 || values.some((value) => !isExactDocumentProviderOriginPattern(value))) {
    throw new Error("invalid document provider origins");
  }
  return [...new Set(values)];
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
      return isAcceptedSeenRecord(map[key]) || isActiveSeenReservation(map[key]);
    },
    async isAccepted(key) {
      const map = (await get<Record<string, unknown>>(KEY.seen)) ?? {};
      return isAcceptedSeenRecord(map[key]);
    },
    async claimIfAbsent(key, source) {
      const reservationId = crypto.randomUUID();
      let claimed: string | undefined;
      await mutate<Record<string, unknown>>(KEY.seen, {}, (map) => {
        if (isAcceptedSeenRecord(map[key]) || isActiveSeenReservation(map[key])) return map;
        map[key] = { source: source ?? "", reservedAt: Date.now(), reservationId } satisfies SeenReservation;
        claimed = reservationId;
        return map;
      });
      return claimed;
    },
    async release(key, reservationId) {
      await mutate<Record<string, unknown>>(KEY.seen, {}, (map) => {
        if (isSeenReservation(map[key]) && map[key].reservationId === reservationId) delete map[key];
        return map;
      });
    },
    async add(key, source) {
      await mutate<Record<string, unknown>>(KEY.seen, {}, (map) => {
        map[key] = { source: source ?? "", acceptedAt: Date.now() } satisfies SeenRecord;
        const entries = Object.entries(map);
        if (entries.length > SEEN_CAP) {
          entries
            .filter(([, value]) => !isSeenReservation(value))
            .sort((left, right) => seenAcceptedAt(left[1]) - seenAcceptedAt(right[1]))
            .slice(0, entries.length - SEEN_CAP)
            .forEach(([oldestKey]) => delete map[oldestKey]);
        }
        return map;
      });
    },
  };
}

interface SeenRecord {
  source: string;
  acceptedAt: number;
}

interface SeenReservation {
  source: string;
  reservedAt: number;
  reservationId: string;
}

function isSeenReservation(value: unknown): value is SeenReservation {
  return Boolean(
    value && typeof value === "object"
    && typeof (value as SeenReservation).reservedAt === "number"
    && typeof (value as SeenReservation).reservationId === "string",
  );
}

function isActiveSeenReservation(value: unknown, now = Date.now()): boolean {
  return isSeenReservation(value) && Number.isFinite(value.reservedAt) && value.reservedAt > now - SEEN_RESERVATION_LEASE_MS;
}

function isAcceptedSeenRecord(value: unknown): boolean {
  return value !== undefined && !isSeenReservation(value);
}

function seenSource(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const source = (value as { source?: unknown }).source;
  return typeof source === "string" ? source : undefined;
}

function seenAcceptedAt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return 0;
  const acceptedAt = (value as { acceptedAt?: unknown }).acceptedAt;
  return typeof acceptedAt === "number" && Number.isFinite(acceptedAt) ? acceptedAt : 0;
}

/** Explicitly forget one vendor's download history. Legacy values remain
 * readable, while only entries that can be safely attributed are removed. */
export async function clearSeenForSource(source: string): Promise<void> {
  await mutate<Record<string, unknown>>(KEY.seen, {}, (map) => {
    for (const [k, v] of Object.entries(map)) {
      if (seenSource(v) === source) delete map[k];
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

/** Remove a vendor's user-facing history only after an explicit reset. */
export async function clearLedgerForVendor(vendorId: string): Promise<void> {
  await mutate<LedgerEntry[]>(KEY.ledger, [], (existing) => existing.filter((entry) => entry.vendorId !== vendorId));
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
    const normalizedEndpoint = cfg.kind === "igdrasil"
      ? normalizeIgdrasilApiBase(cfg.endpoint)
      : endpoint.toString().replace(/\/$/, "");
    return { kind: cfg.kind, endpoint: normalizedEndpoint, companyId: cfg.companyId.trim() };
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
