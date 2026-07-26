/**
 * The engine — vendor-agnostic orchestration.
 *
 * There are no per-vendor branches here and there never should be. The engine
 * runs the same four moves for every recipe:
 *
 *   1. auth-probe    is the user's session alive?  (else AuthExpired → reconnect)
 *   2. scopes        discover config values (workspaces/accounts) → 0..n scopes
 *   3. list          enumerate invoices per scope  (delegated to a Strategy)
 *   4. dedup+fetch   skip already-seen, materialize the rest
 *
 * Adding a vendor means adding data (a recipe), not code. If you feel the urge
 * to special-case a vendor in this file, that's a signal the recipe schema is
 * missing a primitive — extend the schema instead.
 */
import type {
  FetchedDocument,
  InvoiceListResult,
  InvoiceRef,
  RetrievalCompleteness,
  RetrievalProof,
  RunContext,
  RunResult,
  SyncWindowStats,
  VendorRecipe,
} from "./types";
import {
  AuthExpired,
  collectionFailureEvidence,
  type CollectionFailureEvidence,
  DocumentPermissionRequired,
  operationalCodeForError,
  RateLimited,
  RetrievalIncomplete,
  UnexpectedResponse,
} from "./errors";
import { assertAuthenticated, resolveAuthToken } from "./auth";
import { contentIdempotencyKey, idempotencyKey } from "./dedup";
import { resolveInvoiceMetadata } from "./invoice-metadata";
import { extract } from "./extract";
import { get, getArray } from "./jsonpath";
import { DEFAULT_SAFE_CONCURRENCY, mapConcurrentOrdered } from "./concurrency";
import { isBoundedTenantIdentifierSegment } from "./discovery";
import { filterInvoiceRefsBySyncWindow } from "./sync-window";

/** Hard runtime limits complement recipe validation: runtime responses are
 * untrusted and config dimensions multiply one another. */
export const MAX_CONFIG_VALUES_PER_OPTION = 50;
export const MAX_EXPANDED_SCOPES = 100;

/** Raw bytes a strategy produces before the engine wraps them as a FetchedDocument. */
export interface RawDocument {
  bytes: ArrayBuffer;
  contentType: string;
  filename: string;
}

/** A fetch strategy (network-replay or DOM). Strategies are stateless and pure-ish. */
export interface Strategy {
  list(recipe: VendorRecipe, scopeVars: Record<string, unknown>, ctx: RunContext): Promise<InvoiceListResult>;
  fetchDocument(
    recipe: VendorRecipe,
    ref: InvoiceRef,
    scopeVars: Record<string, unknown>,
    ctx: RunContext,
    signal?: AbortSignal,
  ): Promise<RawDocument>;
  /** Release run-scoped capabilities even when every listed identity was
   * already accepted and therefore never resolved. */
  dispose?(): Promise<void>;
}

export type StrategyMap = Record<"network" | "dom" | "html", Strategy>;

export interface StreamRunResult {
  vendorId: string;
  documentCount: number;
  retrieval: RetrievalCompleteness;
  /** Every proof returned by listing, in deterministic scope traversal order. */
  retrievalProofs: RetrievalProof[];
  /** Exact single-scope traversal evidence for local candidate diagnostics. */
  retrievalProof?: InvoiceListResult["retrieval"];
  syncWindow?: SyncWindowStats;
  scopes: RunResult["scopes"];
}

export interface StreamVendorOptions {
  /** Candidate verification must not deliver from a path whose traversal could
   * not be exhausted; another retained candidate should be tried first. */
  requireCompleteRetrieval?: boolean;
  /** Closed evidence emitted before a boundary failure is recovered or thrown.
   * Callers decide whether a recovered scope failure is relevant to their UI. */
  onFailure?: (failure: CollectionFailureEvidence) => void;
}

/** Keeps memory bounded to at most three materialized PDFs per vendor run. */
export const DOCUMENT_FETCH_CONCURRENCY = DEFAULT_SAFE_CONCURRENCY.documentFetches;

/**
 * Run one vendor end to end and return the new documents. The engine does NOT
 * ingest or persist anything — it hands documents back so the caller can send
 * them to a sink and only then mark them seen (so a failed ingest is retried).
 */
export async function runVendor(
  recipe: VendorRecipe,
  ctx: RunContext,
  strategies: StrategyMap,
): Promise<RunResult> {
  const documents: FetchedDocument[] = [];
  const result = await executeVendorWithCleanup(recipe, ctx, strategies, async (document) => {
      documents.push(document);
    });
  return {
    vendorId: result.vendorId,
    documents,
    retrieval: result.retrieval,
    retrievalProofs: result.retrievalProofs,
    ...(result.syncWindow ? { syncWindow: result.syncWindow } : {}),
    scopes: result.scopes,
  };
}

/**
 * Fetch documents in small bounded batches, then emit them one at a time in
 * source order. The emitter runs outside the per-scope recovery boundary: a
 * destination failure must abort the run rather than being mistaken for a
 * supplier-scope failure. This keeps the irreversible destination commit lane
 * exclusive while allowing the read-only network work to overlap.
 */
export function streamVendor(
  recipe: VendorRecipe,
  ctx: RunContext,
  strategies: StrategyMap,
  emit: (document: FetchedDocument) => Promise<void>,
  options: StreamVendorOptions = {},
): Promise<StreamRunResult> {
  return executeVendorWithCleanup(recipe, ctx, strategies, emit, options);
}

async function executeVendorWithCleanup(
  recipe: VendorRecipe,
  ctx: RunContext,
  strategies: StrategyMap,
  emit: (document: FetchedDocument) => Promise<void>,
  options: StreamVendorOptions = {},
): Promise<StreamRunResult> {
  const strategy = strategies[recipe.invoices.strategy];
  try {
    return await executeVendor(recipe, ctx, strategies, emit, options);
  } finally {
    await strategy.dispose?.();
  }
}

async function executeVendor(
  recipe: VendorRecipe,
  ctx: RunContext,
  strategies: StrategyMap,
  emit: (document: FetchedDocument) => Promise<void>,
  options: StreamVendorOptions = {},
): Promise<StreamRunResult> {
  try {
    await resolveAuthToken(recipe, ctx);
    // A rendered-list strategy proves authentication by finding its document
    // structure in the exact supplier tab. A second scripted GET is weaker and
    // is commonly challenged even when the visible session is valid.
    if (recipe.invoices.strategy !== "dom") await assertAuthenticated(recipe, ctx);
  } catch (error) {
    options.onFailure?.(collectionFailureEvidence(error, "authentication"));
    throw error;
  }

  const strategy = strategies[recipe.invoices.strategy];
  const source = `ext:${recipe.id}`;
  let scopes: Record<string, unknown>[];
  try {
    scopes = await resolveScopes(recipe, ctx);
  } catch (error) {
    options.onFailure?.(collectionFailureEvidence(error, "scope_discovery"));
    throw error;
  }

  const emittedThisRun = new Set<string>();
  const scopeErrors: unknown[] = [];
  let retrievalErrorCount = 0;
  let succeededScopes = 0;
  let emptyScopes = 0;
  let documentCount = 0;
  const retrievalProofs: RetrievalProof[] = [];
  const syncWindowStats: SyncWindowStats | undefined = ctx.syncWindow
    ? {
        range: ctx.syncWindow,
        mode: "bounded",
        matched: 0,
        skippedBefore: 0,
        skippedAfter: 0,
        skippedUndated: 0,
      }
    : undefined;

  const listedPlans: Array<{
    vars: Record<string, unknown>;
    list: InvoiceListResult;
    boundedRefs?: InvoiceRef[];
    identityScope?: string;
  }> = [];

  for (const scopeVars of scopes) {
    const vars = { ...ctx.vars, ...scopeVars };
    try {
      const list = await strategy.list(recipe, vars, ctx);
      retrievalProofs.push(list.retrieval);
      if (list.retrieval.completeness !== "complete") {
        retrievalErrorCount += 1;
        scopeErrors.push(new RetrievalIncomplete(
          `retrieval ended at ${list.retrieval.termination} with ${list.retrieval.unresolvedItems} unresolved item(s)`,
          recipe.id,
          list.retrieval,
        ));
        continue;
      }
      let boundedRefs: InvoiceRef[] | undefined;
      if (ctx.syncWindow && syncWindowStats) {
        const filtered = filterInvoiceRefsBySyncWindow(list.refs, ctx.syncWindow);
        syncWindowStats.matched += filtered.matched;
        syncWindowStats.skippedBefore += filtered.skippedBefore;
        syncWindowStats.skippedAfter += filtered.skippedAfter;
        syncWindowStats.skippedUndated += filtered.skippedUndated;
        boundedRefs = filtered.refs;
      }
      succeededScopes++;
      listedPlans.push({
        vars,
        list,
        ...(boundedRefs ? { boundedRefs } : {}),
        identityScope: configIdentityScope(recipe, scopeVars),
      });
    } catch (err) {
      options.onFailure?.(collectionFailureEvidence(err, "invoice_list"));
      // A dead session or missing document-provider permission is vendor-wide,
      // so abort. Any other per-scope failure
      // (e.g. one org with no billing 404s) must NOT sink the sibling scopes.
      if (err instanceof AuthExpired || err instanceof RateLimited || err instanceof DocumentPermissionRequired) throw err;
      retrievalErrorCount += 1;
      scopeErrors.push(err);
    }
  }

  if (options.requireCompleteRetrieval && scopeErrors.length > 0) throw scopeErrors[0];
  if (listedPlans.length === 0 && scopeErrors.length === scopes.length && scopeErrors.length > 0) throw scopeErrors[0];

  // A mixed bounded/unbounded supplier run would be impossible to explain and
  // could still omit an undated invoice that belongs inside the requested
  // range. Decide once, after every scope list is available and before any
  // identity reservation or PDF fetch: either every invoice is date-bounded,
  // or every listed invoice falls back to normal all-history collection.
  if (syncWindowStats && syncWindowStats.skippedUndated > 0) {
    syncWindowStats.mode = "all_history_fallback";
  }
  const plans = listedPlans.map(({ boundedRefs, ...plan }) => ({
    ...plan,
    list: syncWindowStats?.mode === "bounded" && boundedRefs
      ? { ...plan.list, refs: boundedRefs }
      : plan.list,
  }));
  emptyScopes = plans.filter(({ list }) => list.refs.length === 0).length;

  // Reserve every equivalent supplier identity across all scopes before any
  // bounded concurrent fetch begins. A supplier can surface the same invoice
  // under a legacy and a current identity (including from two workspaces).
  // Reserving only the primary key would allow both aliases into `pending`.
  const scheduled = new Set<string>();
  for (const { vars, list, identityScope } of plans) {
    const refs = list.refs;
    const pending: Array<{ ref: InvoiceRef; vars: Record<string, unknown>; key: string; identityClaims: SeenClaim[] }> = [];
    for (const ref of refs) {
      const scopedIdentity = (identity: string) => identityScope ? `${identityScope}\u0000${identity}` : identity;
      const key = await idempotencyKey(ctx.companyId, source, scopedIdentity(ref.vendorInvoiceId));
      const aliasIdentities = (ref.identityAliases ?? []).slice(0, 4);
      const scopedAliases = aliasIdentities.map(scopedIdentity);
      // A single-scope recipe can safely recognize its pre-scope identity. For
      // multiple scopes that legacy key is ambiguous and exact-content dedup is
      // the safe migration path after fetching.
      const legacyAliases = identityScope && scopes.length === 1
        ? [ref.vendorInvoiceId, ...aliasIdentities]
        : [];
      const aliases = await Promise.all([...scopedAliases, ...legacyAliases].map((identity) =>
        idempotencyKey(ctx.companyId, source, identity)
      ));
      const seenKey = [key, ...aliases].find((candidate) => emittedThisRun.has(candidate) || scheduled.has(candidate)) ??
        await firstSeenKey(ctx, [key, ...aliases]);
      if (seenKey) {
        // Migrate an accepted legacy URL identity to the stable signed-URL
        // identity without delivering the document again.
        if (seenKey !== key) await ctx.seen.add(key, source);
        continue;
      }
      const identityClaims = await claimKeys(ctx, [key, ...aliases], source);
      if (!identityClaims) continue;
      for (const identityKey of [key, ...aliases]) scheduled.add(identityKey);
      pending.push({ ref, vars, key, identityClaims });
    }

    let firstScopeError: unknown;
    try {
    for (let offset = 0; offset < pending.length; offset += DOCUMENT_FETCH_CONCURRENCY) {
      const batch = pending.slice(offset, offset + DOCUMENT_FETCH_CONCURRENCY);
      const outcomes = await mapConcurrentOrdered(batch, {
        limit: DOCUMENT_FETCH_CONCURRENCY,
        stopOnError: isFatalDocumentError,
      }, async ({ ref, vars: documentVars, key }, _index, signal) => {
        const raw = await strategy.fetchDocument(recipe, ref, documentVars, ctx, signal);
        const contentKey = await contentIdempotencyKey(ctx.companyId, source, raw.bytes);
        const metadata = resolveInvoiceMetadata(ref);
        return {
          source,
          vendorId: recipe.id,
          vendorName: recipe.name,
          vendorInvoiceId: ref.vendorInvoiceId,
          invoiceNumber: metadata.invoiceNumber,
          issuedAt: metadata.issuedAt,
          total: metadata.total,
          currency: metadata.currency,
          metadataEvidence: ref.metadataEvidence,
          metadataConflicts: metadata.conflicts,
          filename: metadata.filename ?? raw.filename,
          contentType: raw.contentType,
          bytes: raw.bytes,
          idempotencyKey: key,
          contentIdempotencyKey: contentKey,
        } satisfies FetchedDocument;
      });

      // A vendor-wide failure invalidates the whole bounded batch. Inspect the
      // closed outcome set before any fulfilled sibling can enter the sink;
      // otherwise source ordering could emit an earlier result and only then
      // encounter the fatal rejection.
      const fatalOutcome = outcomes.find((outcome) =>
        outcome.status === "rejected" && isFatalDocumentError(outcome.error));
      if (fatalOutcome?.status === "rejected") {
        options.onFailure?.(collectionFailureEvidence(fatalOutcome.error, "document_fetch", list.retrieval));
        throw fatalOutcome.error;
      }

      for (const [outcomeIndex, outcome] of outcomes.entries()) {
        const { identityClaims } = batch[outcomeIndex];
        if (outcome.status === "cancelled") {
          await releaseClaims(ctx, identityClaims);
          continue;
        }
        if (outcome.status === "rejected") {
          await releaseClaims(ctx, identityClaims);
          options.onFailure?.(collectionFailureEvidence(outcome.error, "document_fetch", list.retrieval));
          firstScopeError ??= outcome.error;
          continue;
        }
        const document = outcome.value;
        const repeatedThisRun = emittedThisRun.has(document.contentIdempotencyKey);
        if (repeatedThisRun) {
          await releaseClaims(ctx, identityClaims);
          continue;
        }
        const contentReservation = await ctx.seen.claimIfAbsent(document.contentIdempotencyKey, document.source);
        if (!contentReservation) {
          try {
            // A durable content acceptance proves delivery completed even when
            // the final primary-key commit failed. Repair that retry guard now.
            // A competing reservation alone is not proof, so it remains untouched.
            if (await ctx.seen.isAccepted?.(document.contentIdempotencyKey)) {
              await ctx.seen.add(document.idempotencyKey, document.source);
            }
          } finally {
            await releaseClaims(ctx, identityClaims);
          }
          continue;
        }
        try {
          try {
            await emit(document);
          } catch (error) {
            options.onFailure?.(collectionFailureEvidence(error, "delivery", list.retrieval));
            throw error;
          }
          emittedThisRun.add(document.idempotencyKey);
          emittedThisRun.add(document.contentIdempotencyKey);
          documentCount++;
        } finally {
          // A successful production emitter promotes both reservations via
          // SeenStore.add after durable destination acceptance. On failure,
          // releasing them makes the invoice retryable.
          await ctx.seen.release(document.contentIdempotencyKey, contentReservation);
          await releaseClaims(ctx, identityClaims);
        }
      }
    }
    } catch (error) {
      // Claims are acquired before bounded fetches begin. A fatal supplier or
      // destination error can abandon this and later batches, so release every
      // still-owned reservation immediately instead of waiting for lease expiry.
      for (const item of pending) await releaseClaims(ctx, item.identityClaims);
      throw error;
    }
    if (firstScopeError !== undefined) {
      // A scope is successful only when its list and every eligible document
      // retrieval completed. Do not expose contradictory run telemetry where
      // the same scope appears in both the successful and failed counts.
      succeededScopes--;
      scopeErrors.push(firstScopeError);
    }
  }

  // Listing success is not final scope success. If materialization left no
  // successful/empty sibling and produced no document, surface the real first
  // failure instead of a contradictory zero-document partial result.
  if (documentCount === 0 && succeededScopes === 0 && scopeErrors.length > 0) throw scopeErrors[0];

  return {
    vendorId: recipe.id,
    documentCount,
    // Document materialization/delivery failures are reported through scopes,
    // but they do not change whether the list path itself was exhausted.
    retrieval: retrievalErrorCount === 0 ? "complete" : "partial",
    retrievalProofs,
    ...(retrievalProofs.length === 1 ? { retrievalProof: retrievalProofs[0] } : {}),
    ...(syncWindowStats ? { syncWindow: syncWindowStats } : {}),
    scopes: {
      total: scopes.length,
      succeeded: succeededScopes,
      empty: emptyScopes,
      failed: scopeErrors.length,
      failureCodes: [...new Set(scopeErrors.map(operationalCodeForError))],
    },
  };
}

function isFatalDocumentError(error: unknown): boolean {
  return error instanceof AuthExpired ||
    error instanceof RateLimited ||
    error instanceof DocumentPermissionRequired;
}

function configIdentityScope(recipe: VendorRecipe, scopeVars: Record<string, unknown>): string | undefined {
  const entries = (recipe.config ?? []).flatMap((option) =>
    Object.hasOwn(scopeVars, option.id) ? [[option.id, scopeVars[option.id]]] : []
  );
  return entries.length ? JSON.stringify(entries) : undefined;
}

async function firstSeenKey(ctx: RunContext, keys: readonly string[]): Promise<string | undefined> {
  for (const key of keys) if (await ctx.seen.has(key)) return key;
  return undefined;
}

interface SeenClaim {
  key: string;
  reservationId: string;
}

async function claimKeys(ctx: RunContext, keys: readonly string[], source: string): Promise<SeenClaim[] | undefined> {
  const claimed: SeenClaim[] = [];
  for (const key of [...new Set(keys)].sort()) {
    const reservationId = await ctx.seen.claimIfAbsent(key, source);
    if (!reservationId) {
      await releaseClaims(ctx, claimed);
      return undefined;
    }
    claimed.push({ key, reservationId });
  }
  return claimed;
}

async function releaseClaims(ctx: RunContext, claims: readonly SeenClaim[]): Promise<void> {
  for (const claim of claims) await ctx.seen.release(claim.key, claim.reservationId);
}

// ---------------------------------------------------------------------------
// Config discovery → scopes (cartesian product across options)
// ---------------------------------------------------------------------------

async function resolveScopes(
  recipe: VendorRecipe,
  ctx: RunContext,
): Promise<Record<string, unknown>[]> {
  if (!recipe.config?.length) return [{}];

  let scopes: Record<string, unknown>[] = [{}];
  for (const option of recipe.config) {
    const raw: unknown[] = [];
    const paginate = option.discover.paginate;
    if (paginate && !option.discover.items) {
      throw new UnexpectedResponse(200, `configuration pagination requires items for "${option.id}"`, recipe.id);
    }
    const cursorVariable = paginate?.variable ?? "cursor";
    let cursor = "";
    const cursors = new Set<string>();
    const maxPages = paginate?.maxPages ?? 20;
    for (let page = 0; page < (paginate ? maxPages : 1); page++) {
      const res = await ctx.fetch(option.discover.request, { ...ctx.vars, ...(paginate ? { [cursorVariable]: cursor } : {}) });
      if (res.status === 401) throw new AuthExpired(recipe.id);
      if (!res.ok) {
        throw new UnexpectedResponse(
          res.status,
          `configuration discovery failed for "${option.id}"`,
          recipe.id,
          res.headers.get("content-type") ?? undefined,
        );
      }
      const root = await res.json();
      // With `items` it's a list (one scope per element); without, a single scalar
      // read off the root (e.g. `account_id` for a single-account API).
      const items = option.discover.items ? getArray(root, option.discover.items) : undefined;
      raw.push(...(items
        ? items.map((item) => extract(item, option.discover.value))
        : [extract(root, option.discover.value)]));
      if (raw.length > MAX_CONFIG_VALUES_PER_OPTION) {
        throw new UnexpectedResponse(200, `configuration discovery exceeded ${MAX_CONFIG_VALUES_PER_OPTION} values for "${option.id}"`, recipe.id);
      }
      if (!paginate) break;
      const hasMore = paginate.hasMore ? Boolean(get(root, paginate.hasMore)) : true;
      if (!hasMore) break;
      const nextValue = get(root, paginate.cursor);
      if (nextValue === undefined || nextValue === null || nextValue === "") {
        if (paginate.hasMore) throw new UnexpectedResponse(200, `configuration discovery continuation failed for "${option.id}"`, recipe.id);
        break;
      }
      if ((typeof nextValue !== "string" && typeof nextValue !== "number") || String(nextValue).length > 2_048) {
        throw new UnexpectedResponse(200, `configuration discovery cursor is invalid for "${option.id}"`, recipe.id);
      }
      const nextCursor = String(nextValue);
      if (cursors.has(nextCursor)) throw new UnexpectedResponse(200, `configuration discovery cursor repeated for "${option.id}"`, recipe.id);
      if (page + 1 >= maxPages) throw new UnexpectedResponse(200, `configuration discovery reached its page cap for "${option.id}"`, recipe.id);
      cursors.add(nextCursor);
      cursor = nextCursor;
    }
    const values = raw.filter((v) => v !== undefined && v !== null && v !== "");
    if (values.length === 0) {
      throw new UnexpectedResponse(200, `configuration discovery yielded no value for "${option.id}"`, recipe.id);
    }
    if (recipe.id.startsWith("discovered-") && values.some((value) => !isBoundedTenantIdentifierSegment(String(value)))) {
      throw new UnexpectedResponse(200, `discovered configuration scope "${option.id}" is not a bounded tenant identifier`, recipe.id);
    }

    if (scopes.length > Math.floor(MAX_EXPANDED_SCOPES / values.length)) {
      throw new UnexpectedResponse(200, `configuration discovery exceeded ${MAX_EXPANDED_SCOPES} expanded scopes`, recipe.id);
    }
    const next: Record<string, unknown>[] = [];
    for (const scope of scopes) {
      for (const value of values) next.push({ ...scope, [option.id]: value });
    }
    if (next.length === 0) {
      throw new UnexpectedResponse(200, `configuration discovery yielded no scopes for "${option.id}"`, recipe.id);
    }
    scopes = next;
  }
  return scopes;
}
