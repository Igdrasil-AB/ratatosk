import type { OperationalOutcomeCode } from "../../../src/core/errors";
import type { SeenStore } from "../../../src/core/types";
import { isExactDocumentProviderOriginPattern } from "../../../src/core/document-provider";
import { normalizeIgdrasilApiBase } from "../../../src/ingest/igdrasil-sink";
import { folderPath } from "./download-path";
import type { InvoiceMetadataEvidence, ResolvedInvoiceMetadata } from "../../../src/core/types";

/**
 * Typed wrapper over `chrome.storage.local`.
 *
 * Holds four things: the destination map, the set of connected vendors with
 * their last-run state and the destination each one is bound to, and the
 * seen-set of idempotency keys (bounded, so it cannot grow without limit).
 *
 * Destinations are plural by design. A bureau user may connect several Igdrasil
 * companies from one browser, and each supplier feeds exactly one of them. That
 * is enforced by the data shape — a `Connection` holds one `destinationId` —
 * rather than by a validation rule that can be forgotten.
 */

/** The one filesystem destination. Every supplier bound to it shares it. */
export const LOCAL_DESTINATION_ID = "local";

export type DestinationId = typeof LOCAL_DESTINATION_ID | `igdrasil:${string}`;

/** A sparse map: `local` is one destination among many, not a required key. */
export type DestinationMap = Partial<Record<DestinationId, Destination>>;

export function igdrasilDestinationId(companyId: string): DestinationId {
  return `igdrasil:${companyId}`;
}

/** Why a persisted destination can no longer be delivered to. */
export type DestinationUnavailableReason =
  /** The stored value did not survive re-validation (an older build wrote it). */
  | "invalid_stored_destination"
  /** The company credential was revoked, expired, or refused. */
  | "connection_expired";

export type Destination =
  | { kind: "filesystem"; rootFolder: string; dateMode: "extraction" | "invoice" }
  | { kind: "igdrasil"; endpoint: string; companyId: string; companyName: string; connectedAt: number; expiresAt?: string }
  /**
   * A destination that exists but cannot be delivered to. It is deliberately
   * retained rather than deleted: dropping it would leave its suppliers looking
   * unbound, and reverting them to Downloads is exactly the silent fallback
   * `docs/igdrasil-connect.md` forbids.
   */
  | { kind: "unavailable"; reason: DestinationUnavailableReason; companyId?: string; companyName?: string };

/** Legacy single-destination shape, read once by the migration and never written. */
export type LegacySinkConfig =
  | { kind: "filesystem"; rootFolder: string; dateMode: "extraction" | "invoice" }
  | { kind: "http"; endpoint: string; companyId: string }
  | { kind: "igdrasil"; endpoint: string; companyId: string };

/** The tenant id used for dedup keys: a constant for local files, else the bound company. */
export function sinkCompanyId(destination: Destination | undefined): string {
  if (!destination) return "dry-run";
  if (destination.kind === "filesystem") return "local";
  if (destination.kind === "igdrasil") return destination.companyId;
  return destination.companyId ?? "unavailable";
}

export type ConnectionStatus = "ok" | "partial" | "auth_expired" | "rate_limited" | "error";

export interface Connection {
  vendorId: string;
  connectedAt: number;
  /**
   * Exactly one destination. Absent means the supplier was left unbound by a
   * company disconnect: it is paused until the user rebinds it, and never
   * silently falls back to another destination.
   */
  destinationId?: DestinationId;
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
  /** Bounded count of document-producing semantic controls activated during
   * the most recent run. No action identity or supplier data is retained. */
  lastDocumentActionCount?: number;
  /** Page-owned download responses observed inside the guarded run. */
  lastPageOwnedDownloadCount?: number;
  lastCode?: OperationalOutcomeCode;
  lastFailedScopes?: number;
  lastEmptyScopes?: number;
  nextEligibleRunAt?: number;
  /** Exact provider redirect origins approved for this connection. Capability
   * paths and signed query values are never persisted. */
  documentOrigins?: string[];
}

const KEY = {
  destinations: "destinations",
  /** Legacy single-destination key. Read by the migration, then removed. */
  config: "config",
  connections: "connections",
  seen: "seen",
  ledger: "ledger",
} as const;
const SEEN_CAP = 20_000;
const LEDGER_CAP = 1_000;
const MAX_RATE_LIMIT_DELAY_MS = 24 * 60 * 60 * 1_000;
const MIN_RATE_LIMIT_DELAY_MS = 5_000;
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1_000;
const SEEN_RESERVATION_LEASE_MS = 5 * 60 * 1_000;
const writeChains = new Map<string, Promise<void>>();

// ---- destinations ---------------------------------------------------------

/**
 * Every destination, re-validated on the way out.
 *
 * A persisted value is untrusted across extension upgrades and external
 * mutation, exactly as a persisted credential is. The previous single-config
 * reader was an unchecked cast, so a config written by an older build was
 * trusted on the way back in. Anything that fails to re-validate here becomes
 * `unavailable` — visible, refusing delivery, and offering reconnection —
 * rather than silently disappearing or silently working.
 */
export async function getDestinations(): Promise<DestinationMap> {
  const stored = (await get<Record<string, unknown>>(KEY.destinations)) ?? {};
  const destinations: Record<string, Destination> = {};
  for (const [id, value] of Object.entries(stored)) {
    if (!isDestinationId(id)) continue;
    destinations[id] = readDestination(id, value);
  }
  return destinations as DestinationMap;
}

export async function getDestination(id: DestinationId): Promise<Destination | undefined> {
  return (await getDestinations())[id];
}

/** True once at least one destination exists — the setup gate for connecting. */
export async function hasAnyDestination(): Promise<boolean> {
  return Object.keys(await getDestinations()).length > 0;
}

export async function setLocalDestination(
  destination: Extract<Destination, { kind: "filesystem" }>,
): Promise<void> {
  const validated = validateDestination(destination);
  await mutate<Record<string, unknown>>(KEY.destinations, {}, (all) => {
    all[LOCAL_DESTINATION_ID] = validated;
    return all;
  });
}

/**
 * Add one Igdrasil company. Adding is the whole point: a second company must
 * not evict the first, which is what the single-config shape made unavoidable.
 */
export async function addIgdrasilDestination(input: {
  endpoint: string;
  companyId: string;
  companyName: string;
  expiresAt?: string;
  connectedAt?: number;
}): Promise<DestinationId> {
  const validated = validateDestination({
    kind: "igdrasil",
    endpoint: input.endpoint,
    companyId: input.companyId,
    companyName: input.companyName,
    connectedAt: input.connectedAt ?? Date.now(),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  });
  const id = igdrasilDestinationId(input.companyId.trim());
  await mutate<Record<string, unknown>>(KEY.destinations, {}, (all) => {
    all[id] = validated;
    return all;
  });
  return id;
}

export async function removeDestination(id: DestinationId): Promise<void> {
  await mutate<Record<string, unknown>>(KEY.destinations, {}, (all) => {
    delete all[id];
    return all;
  });
}

/**
 * Retire a destination without deleting it, keeping the label its suppliers
 * are shown. A revoked company token must produce a per-company reconnect
 * state, not a generic delivery failure with no route back.
 */
export async function markDestinationUnavailable(
  id: DestinationId,
  reason: DestinationUnavailableReason,
): Promise<void> {
  await mutate<Record<string, unknown>>(KEY.destinations, {}, (all) => {
    const current = all[id];
    const previous = current && typeof current === "object" ? current as Record<string, unknown> : {};
    const companyId = typeof previous.companyId === "string" ? previous.companyId : undefined;
    const companyName = typeof previous.companyName === "string" ? previous.companyName : undefined;
    all[id] = {
      kind: "unavailable",
      reason,
      ...(companyId ? { companyId } : {}),
      ...(companyName ? { companyName } : {}),
    } satisfies Destination;
    return all;
  });
}

function isDestinationId(value: string): value is DestinationId {
  return value === LOCAL_DESTINATION_ID || (value.startsWith("igdrasil:") && value.length > "igdrasil:".length);
}

function readDestination(id: DestinationId, value: unknown): Destination {
  try {
    const destination = validateDestination(value as Destination);
    // A company destination filed under another company's key would send one
    // company's token with another company's id. Refuse rather than reconcile.
    if (destination.kind === "igdrasil" && igdrasilDestinationId(destination.companyId) !== id) {
      throw new Error("destination key does not match its company");
    }
    if (destination.kind === "filesystem" && id !== LOCAL_DESTINATION_ID) {
      throw new Error("filesystem destination filed under a company key");
    }
    return destination;
  } catch {
    const previous = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const storedCompanyId = typeof previous.companyId === "string" ? previous.companyId : undefined;
    const companyId = storedCompanyId ?? (id === LOCAL_DESTINATION_ID ? undefined : id.slice("igdrasil:".length));
    return {
      kind: "unavailable",
      reason: previous.kind === "unavailable" && previous.reason === "connection_expired"
        ? "connection_expired"
        : "invalid_stored_destination",
      ...(companyId ? { companyId } : {}),
      ...(typeof previous.companyName === "string" ? { companyName: previous.companyName } : {}),
    };
  }
}

// ---- connections ----------------------------------------------------------

/** Bind one supplier to exactly one destination. */
export async function setConnectionDestination(
  vendorId: string,
  destinationId: DestinationId,
): Promise<void> {
  await mutate<Record<string, Connection>>(KEY.connections, {}, (all) => {
    if (all[vendorId]) all[vendorId].destinationId = destinationId;
    return all;
  });
}

/**
 * Leave every supplier bound to a destination unbound and paused, and report
 * which ones. They are never reassigned: a destination the user did not choose
 * is exactly the divergence this whole shape exists to prevent.
 */
export async function unbindConnectionsFrom(destinationId: DestinationId): Promise<string[]> {
  const unbound: string[] = [];
  await mutate<Record<string, Connection>>(KEY.connections, {}, (all) => {
    for (const [vendorId, connection] of Object.entries(all)) {
      if (connection.destinationId !== destinationId) continue;
      delete all[vendorId].destinationId;
      unbound.push(vendorId);
    }
    return all;
  });
  return unbound;
}

export async function vendorIdsBoundTo(destinationId: DestinationId): Promise<string[]> {
  return Object.values(await getConnections())
    .filter((connection) => connection.destinationId === destinationId)
    .map((connection) => connection.vendorId);
}

// ---- migration surface ----------------------------------------------------

/** The pre-multi-company single destination, read only by the migration. */
export const readLegacySinkConfig = () => get<LegacySinkConfig>(KEY.config);
export const clearLegacySinkConfig = () => remove(KEY.config);

/** Write the whole migrated map in one commit, so a partial shape is never left. */
export async function writeMigratedDestinations(
  destinations: DestinationMap,
  bindings: Record<string, DestinationId>,
): Promise<void> {
  await set(KEY.destinations, destinations);
  await mutate<Record<string, Connection>>(KEY.connections, {}, (all) => {
    for (const [vendorId, destinationId] of Object.entries(bindings)) {
      if (all[vendorId]) all[vendorId].destinationId = destinationId;
    }
    return all;
  });
}

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
      // A run outcome must never rebind or unbind a supplier. `next` is rebuilt
      // field by field, so every identity-carrying field has to be carried over
      // explicitly or a completed run silently drops it.
      destinationId: existing.destinationId,
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
  vendorInvoiceId?: string;
  invoiceNumber?: string;
  issuedAt?: string;
  total?: string;
  currency?: string;
  filename?: string;
  metadataEvidence?: InvoiceMetadataEvidence[];
  metadataConflicts?: ResolvedInvoiceMetadata["conflicts"];
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
    for (const entry of entries) {
      const previous = byKey.get(entry.key);
      byKey.set(entry.key, previous ? mergeLedgerEntry(previous, entry) : entry);
    }
    return [...byKey.values()].sort((a, b) => b.collectedAt - a.collectedAt).slice(0, LEDGER_CAP);
  });
}

/** Enrich an already delivered invoice without making the retry look new. */
export function mergeLedgerEntry(previous: LedgerEntry, incoming: LedgerEntry): LedgerEntry {
  const metadataEvidence = [
    ...(previous.metadataEvidence ?? []),
    ...(incoming.metadataEvidence ?? []),
  ].filter((item, index, all) =>
    index === all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(item))
  ).slice(0, 32);
  return {
    ...previous,
    ...definedValues(incoming),
    collectedAt: Math.min(previous.collectedAt, incoming.collectedAt),
    ...(metadataEvidence.length ? { metadataEvidence } : {}),
  };
}

function definedValues<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}

/** Remove a vendor's user-facing history only after an explicit reset. */
export async function clearLedgerForVendor(vendorId: string): Promise<void> {
  await mutate<LedgerEntry[]>(KEY.ledger, [], (existing) => existing.filter((entry) => entry.vendorId !== vendorId));
}

// ---- low-level ------------------------------------------------------------

export function validateDestination(destination: Destination): Destination {
  if (!destination || typeof destination !== "object") throw new Error("invalid destination");
  if (destination.kind === "filesystem") {
    const raw = typeof destination.rootFolder === "string" ? destination.rootFolder.trim() : "";
    if (!raw || raw.length > 200) throw new Error("invalid download folder");
    // Store the folders that will actually be created, so what the panel shows
    // and what lands on disk cannot drift apart.
    const rootFolder = folderPath(raw);
    // Empty means nothing survived sanitizing — `..`, `/`, dots. Refusing beats
    // substituting: a person who typed one of those would otherwise be told
    // nothing and find their invoices in a folder they never named.
    if (!rootFolder) throw new Error("invalid download folder");
    if (destination.dateMode !== "extraction" && destination.dateMode !== "invoice") {
      throw new Error("invalid date mode");
    }
    return { kind: "filesystem", rootFolder, dateMode: destination.dateMode };
  }
  if (destination.kind === "igdrasil") {
    if (typeof destination.companyId !== "string" || !destination.companyId.trim() || destination.companyId.length > 200) {
      throw new Error("invalid company id");
    }
    if (typeof destination.companyName !== "string" || !destination.companyName.trim() || destination.companyName.length > 200) {
      throw new Error("invalid company name");
    }
    // The exact reviewed origin, or nothing. A v0.6.x leftover carrying an
    // `/api` path fails here and surfaces as needs-reconnect.
    const endpoint = normalizeIgdrasilApiBase(destination.endpoint);
    const connectedAt = Number.isFinite(destination.connectedAt) ? destination.connectedAt : Date.now();
    const expiresAt = destination.expiresAt;
    if (expiresAt !== undefined && (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)))) {
      throw new Error("invalid connection expiry");
    }
    return {
      kind: "igdrasil",
      endpoint,
      companyId: destination.companyId.trim(),
      companyName: destination.companyName.trim(),
      connectedAt,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
  }
  if (destination.kind === "unavailable") {
    if (destination.reason !== "invalid_stored_destination" && destination.reason !== "connection_expired") {
      throw new Error("invalid destination state");
    }
    return {
      kind: "unavailable",
      reason: destination.reason,
      ...(typeof destination.companyId === "string" ? { companyId: destination.companyId } : {}),
      ...(typeof destination.companyName === "string" ? { companyName: destination.companyName } : {}),
    };
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
