import type { HttpResponse, Predicate, RunContext, VendorRecipe } from "./types";
import { AuthExpired, AuthFailure, type AuthFailureKind } from "./errors";
import { extract } from "./extract";
import { get } from "./jsonpath";
import { render } from "./template";

export type AuthOutcome = "authenticated" | "session_expired" | AuthFailureKind;

/**
 * Classify transport and redirect evidence before interpreting a recipe's
 * structural predicate. This prevents a followed login redirect from becoming
 * a false status-200 success and keeps 403/challenge/transport failures out of
 * the reconnect flow.
 */
export function classifyAuthResponse(
  response: HttpResponse,
  predicateMatched: boolean,
  expectedUrl: string,
): AuthOutcome {
  if (response.status === 0) return "transport_failed";
  const redirectOutcome = classifyRedirect(response, expectedUrl);
  if (redirectOutcome) return redirectOutcome;
  if (response.status === 401) return "session_expired";
  // Proxy authentication is an intermediary transport condition, not evidence
  // that the supplier session has expired. Sending the user to reconnect would
  // not repair it and masks the actionable failure category.
  if (response.status === 407) return "transport_failed";
  if (response.status === 403) return "insufficient_scope";
  if (response.status === 408 || response.status === 425 || response.status >= 500) return "transport_failed";
  if (predicateMatched) return "authenticated";
  return "blocked_or_challenged";
}

export async function assertAuthenticated(recipe: VendorRecipe, ctx: RunContext): Promise<void> {
  const { request, expect } = recipe.auth.check;
  let response: HttpResponse;
  let expectedUrl: string;
  try {
    expectedUrl = render(request.url, ctx.vars);
    response = await ctx.fetch(request, ctx.vars);
  } catch {
    throw new AuthFailure("transport_failed", recipe.id);
  }
  const matched = await evaluatePredicate(expect, new ResponseView(response));
  throwUnlessAuthenticated(classifyAuthResponse(response, matched, expectedUrl), recipe.id);
}

/** Resolve a cookie-backed bearer token without collapsing every failure into "logged out". */
export async function resolveAuthToken(recipe: VendorRecipe, ctx: RunContext): Promise<void> {
  const spec = recipe.auth.token;
  if (!spec) return;
  let response: HttpResponse;
  let expectedUrl: string;
  try {
    expectedUrl = render(spec.request.url, ctx.vars);
    response = await ctx.fetch(spec.request, ctx.vars);
  } catch {
    throw new AuthFailure("transport_failed", recipe.id);
  }
  throwUnlessAuthenticated(classifyAuthResponse(response, response.ok, expectedUrl), recipe.id);
  const value = extract(await response.json().catch(() => undefined), spec.value);
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new AuthFailure("blocked_or_challenged", recipe.id);
  }
  Object.assign(ctx.vars, { [spec.as ?? "token"]: value });
}

function throwUnlessAuthenticated(outcome: AuthOutcome, vendorId: string): void {
  if (outcome === "authenticated") return;
  if (outcome === "session_expired") throw new AuthExpired(vendorId);
  throw new AuthFailure(outcome, vendorId);
}

function classifyRedirect(response: HttpResponse, expectedUrl: string): "session_expired" | "blocked_or_challenged" | undefined {
  if (!response.redirected) return undefined;
  if (!response.url) return "blocked_or_challenged";
  try {
    const expected = new URL(expectedUrl);
    const final = new URL(response.url, expected);
    const loginPath = /(?:^|\/)(?:auth|login|log-in|signin|sign-in|sso)(?:\/|$)/i.test(final.pathname);
    const loginHost = /^(?:auth|login|signin|sso)\./i.test(final.hostname);
    if (loginPath || loginHost) return "session_expired";
    if (final.origin !== expected.origin) return "blocked_or_challenged";
    const canonicalPath = (value: string) => value.length > 1 ? value.replace(/\/$/, "") : value;
    return canonicalPath(final.pathname) === canonicalPath(expected.pathname) && final.search === expected.search
      ? undefined
      : "blocked_or_challenged";
  } catch {
    return "blocked_or_challenged";
  }
}

class ResponseView {
  private parsed: Promise<unknown> | undefined;
  constructor(private readonly response: HttpResponse) {}
  get status(): number {
    return this.response.status;
  }
  json(): Promise<unknown> {
    return (this.parsed ??= this.response.json().catch(() => undefined));
  }
}

async function evaluatePredicate(predicate: Predicate, view: ResponseView): Promise<boolean> {
  if ("statusIn" in predicate) return predicate.statusIn.includes(view.status);
  if ("jsonPath" in predicate) {
    const value = get(await view.json(), predicate.jsonPath);
    if (predicate.exists !== undefined) return predicate.exists ? value !== undefined : value === undefined;
    if ("equals" in predicate) return value === predicate.equals;
    return value !== undefined;
  }
  if ("and" in predicate) {
    for (const child of predicate.and) if (!(await evaluatePredicate(child, view))) return false;
    return true;
  }
  for (const child of predicate.or) if (await evaluatePredicate(child, view)) return true;
  return false;
}
