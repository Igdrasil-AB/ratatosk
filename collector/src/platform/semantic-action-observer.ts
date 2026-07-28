export interface DocumentObservation {
  url: string;
  method: string;
  contentType?: string;
  filename?: string;
  documentIntent?: boolean;
}

type BeforeRequestDetails = {
  requestId: string;
  tabId: number;
  url: string;
  method: string;
};

type ResponseDetails = BeforeRequestDetails & {
  responseHeaders?: Array<{ name?: string; value?: string }>;
};

type RedirectDetails = BeforeRequestDetails & {
  redirectUrl: string;
};

interface WebRequestEvent<T> {
  addListener(listener: (details: T) => void, filter: chrome.webRequest.RequestFilter, extraInfoSpec?: string[]): void;
  removeListener(listener: (details: T) => void): void;
}

export interface SemanticActionObserverPlatform {
  beforeRequest: WebRequestEvent<BeforeRequestDetails>;
  headersReceived: WebRequestEvent<ResponseDetails>;
  beforeRedirect: WebRequestEvent<RedirectDetails>;
}

const DOCUMENT_ROUTE = /(?:^|[/.?&=_-])(?:invoices?|receipts?|statements?|documents?|downloads?|pdf)(?:$|[/.?&=_-])/i;
const NON_DOCUMENT_TYPE = /(?:json|html|javascript|ecmascript|css|image\/|font\/|audio\/|video\/)/i;
const MAX_DOCUMENT_CANDIDATES = 100;

/**
 * Turn browser-owned request/download metadata into a fetchable document
 * candidate. This boundary deliberately admits only GET URLs on origins
 * already present in the reviewed or locally verified recipe.
 */
export function documentCandidateFromObservation(
  observation: DocumentObservation,
  allowedOrigins: ReadonlySet<string>,
): string | undefined {
  if (observation.method.toUpperCase() !== "GET" || observation.url.length > 2_048) return undefined;
  let url: URL;
  try { url = new URL(observation.url); } catch { return undefined; }
  if (
    url.protocol !== "https:" || url.username || url.password ||
    !allowedOrigins.has(url.origin)
  ) return undefined;
  const contentType = (observation.contentType ?? "").split(";", 1)[0].trim().toLowerCase();
  const typedDocument = contentType === "application/pdf";
  const documentShaped = DOCUMENT_ROUTE.test(`${url.pathname}${url.search} ${observation.filename ?? ""}`);
  if (!typedDocument && !observation.documentIntent && (NON_DOCUMENT_TYPE.test(contentType) || !documentShaped)) {
    return undefined;
  }
  url.hash = "";
  return url.toString();
}

/**
 * Independent, action-scoped observation for requests that a page-level
 * fetch/XHR wrapper cannot see (redirects, navigations, and Chrome downloads).
 * It retains only bounded HTTPS document candidates for the lifetime of one
 * disposable supplier tab.
 */
export class SemanticActionObserver {
  private readonly candidates = new Map<string, DocumentObservation>();
  private readonly actionRequestIds = new Set<string>();
  private nativeDownloadAttempted = false;
  private started = false;
  private actionActive = false;
  private tabId: number | undefined;

  constructor(
    private readonly allowedOrigins: ReadonlySet<string>,
    private platform?: SemanticActionObserverPlatform,
  ) {}

  start(tabId: number): boolean {
    if (this.started || this.allowedOrigins.size === 0) return false;
    const urls = [...this.allowedOrigins].slice(0, 9).map((origin) => `${origin}/*`);
    if (!urls.length) return false;
    const filter: chrome.webRequest.RequestFilter = { urls, tabId };
    try {
      this.platform ??= chromeSemanticActionObserverPlatform();
      this.platform.beforeRequest.addListener(this.onBeforeRequest, filter);
      this.platform.headersReceived.addListener(this.onHeadersReceived, filter, ["responseHeaders"]);
      this.platform.beforeRedirect.addListener(this.onBeforeRedirect, filter);
      this.tabId = tabId;
      this.started = true;
      return true;
    } catch {
      this.stop();
      return false;
    }
  }

  snapshotDocuments(): string[] {
    return [...this.candidates.keys()];
  }

  snapshotNativeDownloadAttempted(): boolean {
    return this.nativeDownloadAttempted;
  }

  beginAction(): void {
    if (!this.started) return;
    this.candidates.clear();
    this.actionRequestIds.clear();
    this.nativeDownloadAttempted = false;
    this.actionActive = true;
  }

  endAction(): void {
    this.actionActive = false;
  }

  snapshotDocumentObservations(): Array<{
    url: string;
    evidence: Array<{
      source: "download-filename" | "content-disposition";
      confidence: "medium";
      filename: string;
    }>;
  }> {
    return [...this.candidates].flatMap(([url, observation]) => {
      const filename = safeFilename(observation.filename);
      if (!filename) return [];
      return [{
        url,
        evidence: [{
          source: observation.documentIntent ? "download-filename" : "content-disposition",
          confidence: "medium",
          filename,
        }],
      }];
    });
  }

  stop(): void {
    try { this.platform?.beforeRequest.removeListener(this.onBeforeRequest); } catch { /* unavailable */ }
    try { this.platform?.headersReceived.removeListener(this.onHeadersReceived); } catch { /* unavailable */ }
    try { this.platform?.beforeRedirect.removeListener(this.onBeforeRedirect); } catch { /* unavailable */ }
    this.started = false;
    this.actionActive = false;
    this.tabId = undefined;
    this.candidates.clear();
    this.actionRequestIds.clear();
    this.nativeDownloadAttempted = false;
  }

  private readonly onBeforeRequest = (details: BeforeRequestDetails): void => {
    if (!this.actionActive || details.tabId !== this.tabId) return;
    this.actionRequestIds.add(details.requestId);
  };

  private readonly onHeadersReceived = (details: ResponseDetails): void => {
    if (!this.actionActive || details.tabId !== this.tabId || !this.actionRequestIds.has(details.requestId)) return;
    const contentType = details.responseHeaders?.find((header) =>
      header.name?.toLowerCase() === "content-type")?.value;
    const contentDisposition = details.responseHeaders?.find((header) =>
      header.name?.toLowerCase() === "content-disposition")?.value;
    if (isNativeDownloadResponse(contentType, contentDisposition)) {
      this.nativeDownloadAttempted = true;
    }
    const observation = {
      url: details.url,
      method: details.method,
      contentType,
      filename: filenameFromContentDisposition(contentDisposition),
    };
    this.keep(observation);
  };

  private readonly onBeforeRedirect = (details: RedirectDetails): void => {
    if (!this.actionActive || details.tabId !== this.tabId || !this.actionRequestIds.has(details.requestId)) return;
    const sourceIsDocument = Boolean(documentCandidateFromObservation({
      url: details.url,
      method: details.method,
    }, this.allowedOrigins));
    this.keep({
      url: details.redirectUrl,
      method: details.method,
      documentIntent: sourceIsDocument,
    });
  };

  private keep(observation: DocumentObservation): boolean {
    if (this.candidates.size >= MAX_DOCUMENT_CANDIDATES) return false;
    const candidate = documentCandidateFromObservation(observation, this.allowedOrigins);
    if (!candidate) return false;
    const previous = this.candidates.get(candidate);
    this.candidates.set(candidate, {
      ...previous,
      ...observation,
      url: candidate,
      filename: observation.filename ?? previous?.filename,
      documentIntent: observation.documentIntent ?? previous?.documentIntent,
    });
    return true;
  }

}

function isNativeDownloadResponse(
  contentType: string | undefined,
  contentDisposition: string | undefined,
): boolean {
  if (/(?:^|;)\s*attachment(?:\s*;|$)/i.test(contentDisposition ?? "")) return true;
  const type = (contentType ?? "").split(";", 1)[0].trim().toLowerCase();
  return type === "application/octet-stream" ||
    type === "application/force-download" ||
    type === "application/x-download";
}

function filenameFromContentDisposition(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const encoded = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded.replace(/^["']|["']$/g, "")); } catch { /* use basic form */ }
  }
  return value.match(/filename\s*=\s*"([^"]+)"/i)?.[1] ??
    value.match(/filename\s*=\s*([^;]+)/i)?.[1]?.trim();
}

function safeFilename(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const basename = value.split(/[\\/]/).pop()?.trim();
  if (!basename || basename.length > 240) return undefined;
  return basename.replace(/[\u0000-\u001f\u007f]/g, "_");
}

function chromeSemanticActionObserverPlatform(): SemanticActionObserverPlatform {
  return {
    beforeRequest: chrome.webRequest.onBeforeRequest as unknown as WebRequestEvent<BeforeRequestDetails>,
    headersReceived: chrome.webRequest.onHeadersReceived as unknown as WebRequestEvent<ResponseDetails>,
    beforeRedirect: chrome.webRequest.onBeforeRedirect as unknown as WebRequestEvent<RedirectDetails>,
  };
}
