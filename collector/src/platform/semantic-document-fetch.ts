import { DocumentPermissionRequired, UnexpectedResponse } from "../../../src/core/errors";
import { exactPublicHttpsOriginPattern } from "../../../src/core/origin-policy";
import { render } from "../../../src/core/template";
import type { HttpResponse, RequestSpec } from "../../../src/core/types";
import { hasHostPermissions } from "./permissions";

type SemanticDocumentFetch = (
  spec: RequestSpec,
  vars: Record<string, unknown>,
) => Promise<HttpResponse>;

interface RedirectEventDetails {
  requestId: string;
  url: string;
  redirectUrl: string;
}

interface RedirectEvent {
  addListener(
    listener: (details: RedirectEventDetails) => void,
    filter: { urls: string[] },
  ): void;
  removeListener(listener: (details: RedirectEventDetails) => void): void;
}

interface SemanticDocumentFetchOptions {
  redirectEvent?: RedirectEvent;
  hasOrigins?: (origins: readonly string[]) => Promise<boolean>;
}

/**
 * Follow an action-produced document URL while carrying exact-origin redirect
 * proof. Chrome can expose the redirecting response before a worker fetch fails
 * for lack of permission on the destination. Turn that otherwise opaque
 * TypeError into the existing, user-reviewable permission continuation.
 */
export function createSemanticDocumentFetch(
  baseFetch: SemanticDocumentFetch,
  allowedOrigins: ReadonlySet<string>,
  vendorId: string,
  options: SemanticDocumentFetchOptions = {},
): SemanticDocumentFetch {
  return async (spec, vars) => {
    const rendered = render(spec.url, vars);
    let initial: URL;
    try {
      initial = new URL(rendered);
    } catch {
      throw new UnexpectedResponse(0, "semantic document URL is invalid", vendorId);
    }
    if (!allowedOrigins.has(initial.origin)) {
      throw new UnexpectedResponse(0, "semantic document origin is outside the supplier permission set", vendorId);
    }

    const event = options.redirectEvent ?? chrome.webRequest.onBeforeRedirect as unknown as RedirectEvent;
    const hasOrigins = options.hasOrigins ?? hasHostPermissions;
    const sourcePatterns = [...allowedOrigins].slice(0, 9).map((origin) =>
      exactPublicHttpsOriginPattern(origin));
    const requiredOrigins = new Set<string>();
    let requestId: string | undefined;
    let rejectedRedirect = false;
    const listener = (details: RedirectEventDetails): void => {
      if (!requestId) {
        if (details.url !== rendered) return;
        requestId = details.requestId;
      }
      if (details.requestId !== requestId) return;
      try {
        requiredOrigins.add(exactPublicHttpsOriginPattern(new URL(details.redirectUrl).origin));
      } catch {
        rejectedRedirect = true;
      }
    };

    event.addListener(listener, { urls: sourcePatterns });
    let result: HttpResponse | undefined;
    let failure: unknown;
    try {
      result = await baseFetch(spec, vars);
    } catch (error) {
      failure = error;
    } finally {
      event.removeListener(listener);
    }

    if (rejectedRedirect) {
      throw new UnexpectedResponse(0, "semantic document redirect was rejected", vendorId);
    }
    if (result?.url) {
      try {
        requiredOrigins.add(exactPublicHttpsOriginPattern(new URL(result.url).origin));
      } catch {
        throw new UnexpectedResponse(0, "semantic document final URL was rejected", vendorId);
      }
    }
    const missing: string[] = [];
    for (const origin of requiredOrigins) {
      if (!(await hasOrigins([origin]))) missing.push(origin);
    }
    if (missing.length) {
      throw new DocumentPermissionRequired("semantic_action", missing, vendorId);
    }
    if (failure) {
      throw new UnexpectedResponse(0, "semantic document transport failed", vendorId);
    }
    if (!result) {
      throw new UnexpectedResponse(0, "semantic document transport returned no response", vendorId);
    }
    return result;
  };
}
