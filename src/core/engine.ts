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
  HttpResponse,
  InvoiceRef,
  RunContext,
  RunResult,
  VendorRecipe,
  Predicate,
} from "./types";
import { AuthExpired, operationalCodeForError, RateLimited } from "./errors";
import { idempotencyKey } from "./dedup";
import { extract } from "./extract";
import { get, getArray } from "./jsonpath";

/** Raw bytes a strategy produces before the engine wraps them as a FetchedDocument. */
export interface RawDocument {
  bytes: ArrayBuffer;
  contentType: string;
  filename: string;
}

/** A fetch strategy (network-replay or DOM). Strategies are stateless and pure-ish. */
export interface Strategy {
  list(recipe: VendorRecipe, scopeVars: Record<string, unknown>, ctx: RunContext): Promise<InvoiceRef[]>;
  fetchDocument(
    recipe: VendorRecipe,
    ref: InvoiceRef,
    scopeVars: Record<string, unknown>,
    ctx: RunContext,
  ): Promise<RawDocument>;
}

export type StrategyMap = Record<"network" | "dom" | "html", Strategy>;

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
  await resolveAuthToken(recipe, ctx);
  await assertAuthenticated(recipe, ctx);

  const strategy = strategies[recipe.invoices.strategy];
  const source = `ext:${recipe.id}`;
  const scopes = await resolveScopes(recipe, ctx);

  const documents: FetchedDocument[] = [];
  const emittedThisRun = new Set<string>();
  const scopeErrors: unknown[] = [];
  let succeededScopes = 0;
  let emptyScopes = 0;

  for (const scopeVars of scopes) {
    const vars = { ...ctx.vars, ...scopeVars };
    try {
      const refs = await strategy.list(recipe, vars, ctx);
      succeededScopes++;
      if (refs.length === 0) emptyScopes++;

      for (const ref of refs) {
        const key = await idempotencyKey(ctx.companyId, source, ref.vendorInvoiceId);
        if (emittedThisRun.has(key) || (await ctx.seen.has(key))) continue;

        const raw = await strategy.fetchDocument(recipe, ref, vars, ctx);
        emittedThisRun.add(key);
        documents.push({
          source,
          vendorId: recipe.id,
          vendorName: recipe.name,
          vendorInvoiceId: ref.vendorInvoiceId,
          issuedAt: ref.issuedAt,
          total: ref.total,
          currency: ref.currency,
          filename: raw.filename,
          contentType: raw.contentType,
          bytes: raw.bytes,
          idempotencyKey: key,
        });
      }
    } catch (err) {
      // A dead session is vendor-wide, so abort. Any other per-scope failure
      // (e.g. one org with no billing 404s) must NOT sink the sibling scopes.
      if (err instanceof AuthExpired || err instanceof RateLimited) throw err;
      scopeErrors.push(err);
    }
  }

  // Only surface an error if EVERY scope failed and nothing was collected;
  // partial success (some scopes empty or failed) still returns what we have.
  if (documents.length === 0 && scopeErrors.length === scopes.length && scopeErrors.length > 0) {
    throw scopeErrors[0];
  }

  return {
    vendorId: recipe.id,
    documents,
    scopes: {
      total: scopes.length,
      succeeded: succeededScopes,
      empty: emptyScopes,
      failed: scopeErrors.length,
      failureCodes: [...new Set(scopeErrors.map(operationalCodeForError))],
    },
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function assertAuthenticated(recipe: VendorRecipe, ctx: RunContext): Promise<void> {
  const { request, expect } = recipe.auth.check;
  const res = await ctx.fetch(request, ctx.vars);
  const alive = await evaluatePredicate(expect, new ResponseView(res));
  if (!alive) throw new AuthExpired(recipe.id);
}

/**
 * Exchange the session cookie for a bearer token (for SPAs whose API needs
 * `Authorization: Bearer …`). Runs first so every later request — auth probe,
 * list, config — can template `{token}` into its headers. A missing token means
 * the session can't authorize the API, i.e. reconnect.
 */
async function resolveAuthToken(recipe: VendorRecipe, ctx: RunContext): Promise<void> {
  const spec = recipe.auth.token;
  if (!spec) return;
  const res = await ctx.fetch(spec.request, ctx.vars);
  if (!res.ok) throw new AuthExpired(recipe.id);
  const value = extract(await res.json().catch(() => undefined), spec.value);
  if (value === undefined || value === null || value === "") throw new AuthExpired(recipe.id);
  Object.assign(ctx.vars, { [spec.as ?? "token"]: value });
}

/** Lazily-parsed view so a predicate can inspect status and/or JSON body once. */
class ResponseView {
  private parsed: Promise<unknown> | undefined;
  constructor(private readonly res: HttpResponse) {}
  get status(): number {
    return this.res.status;
  }
  json(): Promise<unknown> {
    return (this.parsed ??= this.res.json().catch(() => undefined));
  }
}

async function evaluatePredicate(pred: Predicate, view: ResponseView): Promise<boolean> {
  if ("statusIn" in pred) return pred.statusIn.includes(view.status);
  if ("jsonPath" in pred) {
    const value = get(await view.json(), pred.jsonPath);
    if (pred.exists !== undefined) return pred.exists ? value !== undefined : value === undefined;
    if ("equals" in pred) return value === pred.equals;
    return value !== undefined;
  }
  if ("and" in pred) {
    for (const p of pred.and) if (!(await evaluatePredicate(p, view))) return false;
    return true;
  }
  // "or"
  for (const p of pred.or) if (await evaluatePredicate(p, view)) return true;
  return false;
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
    const res = await ctx.fetch(option.discover.request, ctx.vars);
    const root = await res.json();
    // With `items` it's a list (one scope per element); without, a single scalar
    // read off the root (e.g. `account_id` for a single-account API).
    const raw = option.discover.items
      ? getArray(root, option.discover.items).map((item) => extract(item, option.discover.value))
      : [extract(root, option.discover.value)];
    const values = raw.filter((v) => v !== undefined && v !== null && v !== "");

    const next: Record<string, unknown>[] = [];
    for (const scope of scopes) {
      for (const value of values) next.push({ ...scope, [option.id]: value });
    }
    scopes = next.length ? next : scopes;
  }
  return scopes;
}
