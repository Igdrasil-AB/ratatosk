import {
  canonicalDocumentProviderUrl,
  documentProviderForUrl,
  exactDocumentProviderOrigin,
} from "../../../src/core/document-provider";
import { DocumentPermissionRequired, DocumentRedirectRejected } from "../../../src/core/errors";
import { render } from "../../../src/core/template";
import type { HttpResponse, RequestSpec } from "../../../src/core/types";
import { hasHostPermissions } from "./permissions";

export interface RedirectEventDetails {
  requestId: string;
  url: string;
  redirectUrl: string;
  statusCode: number;
}

export interface RedirectEvent {
  addListener(
    listener: (details: RedirectEventDetails) => void,
    filter: { urls: string[] },
  ): void;
  removeListener(listener: (details: RedirectEventDetails) => void): void;
}

type ProviderFetch = (spec: RequestSpec, vars: Record<string, unknown>) => Promise<HttpResponse>;

interface ProviderFetchOptions {
  redirectEvent?: RedirectEvent;
  hasOrigins?: (origins: readonly string[]) => Promise<boolean>;
}

interface RedirectTrace {
  requiredOrigins: Set<string>;
  rejected: boolean;
}

/** Add shared document-provider resolution around the ordinary browser fetch.
 * Full signed URLs remain inside this call; only exact origins may escape in a
 * typed permission requirement. */
export function createDocumentProviderFetch(
  baseFetch: ProviderFetch,
  options: ProviderFetchOptions = {},
): ProviderFetch {
  const activeByCanonicalUrl = new Map<string, Promise<void>>();
  return async (spec, vars) => {
    const rendered = render(spec.url, vars);
    const provider = documentProviderForUrl(rendered);
    if (!provider) return baseFetch(spec, vars);

    const canonicalUrl = canonicalDocumentProviderUrl(rendered);
    const request = canonicalUrl === rendered ? spec : { ...spec, url: canonicalUrl };
    const predecessor = activeByCanonicalUrl.get(canonicalUrl);
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    activeByCanonicalUrl.set(canonicalUrl, turn);
    if (predecessor) await predecessor;

    try {
    const event = options.redirectEvent ?? chrome.webRequest.onBeforeRedirect as unknown as RedirectEvent;
    const hasOrigins = options.hasOrigins ?? hasHostPermissions;
    const trace: RedirectTrace = { requiredOrigins: new Set(), rejected: false };
    let requestId: string | undefined;
    const tracedSourceOrigins = new Set<string>();
    let listenerRegistered = false;
    const registerListener = (): void => {
      if (listenerRegistered) event.removeListener(listener);
      event.addListener(listener, { urls: [...tracedSourceOrigins] });
      listenerRegistered = true;
    };
    const listener = (details: RedirectEventDetails): void => {
      if (!requestId) {
        if (details.url !== canonicalUrl) return;
        requestId = details.requestId;
      }
      if (details.requestId !== requestId) return;
      const origin = exactDocumentProviderOrigin(details.redirectUrl);
      if (!origin || documentProviderForUrl(details.redirectUrl)?.id !== provider.id) {
        trace.rejected = true;
        return;
      }
      trace.requiredOrigins.add(origin);
      if (!tracedSourceOrigins.has(origin)) {
        // Chrome filters on the redirecting source URL. Subscribe to each
        // approved dynamic hop before the request can redirect again.
        tracedSourceOrigins.add(origin);
        registerListener();
      }
    };

    const requestOrigin = exactDocumentProviderOrigin(canonicalUrl);
    if (!requestOrigin) throw new DocumentRedirectRejected(provider.id);
    for (const origin of [...provider.stableHosts, requestOrigin]) tracedSourceOrigins.add(origin);
    registerListener();
    let result: HttpResponse | undefined;
    let failure: unknown;
    try {
      result = await baseFetch(request, vars);
    } catch (error) {
      failure = error;
    } finally {
      if (listenerRegistered) event.removeListener(listener);
    }

    if (trace.rejected) throw new DocumentRedirectRejected(provider.id);
    if (result?.url) {
      const finalProvider = documentProviderForUrl(result.url);
      const finalOrigin = exactDocumentProviderOrigin(result.url);
      if (!finalProvider || finalProvider.id !== provider.id || !finalOrigin) {
        throw new DocumentRedirectRejected(provider.id);
      }
      trace.requiredOrigins.add(finalOrigin);
    }
    const missing: string[] = [];
    for (const origin of trace.requiredOrigins) {
      if (!(await hasOrigins([origin]))) missing.push(origin);
    }
    if (missing.length) throw new DocumentPermissionRequired(provider.id, missing);
    if (failure) throw failure;
    if (!result) throw new Error("document provider fetch produced no result");
    return result;
    } finally {
      release();
      if (activeByCanonicalUrl.get(canonicalUrl) === turn) activeByCanonicalUrl.delete(canonicalUrl);
    }
  };
}
