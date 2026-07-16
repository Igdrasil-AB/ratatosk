/**
 * SILENT capture backend — the MAIN-world fetch/XHR interceptor.
 *
 * Injects a monkey-patch of `fetch`/`XMLHttpRequest` into the page (MAIN world),
 * plus an ISOLATED-world relay that forwards captured entries to the service
 * worker. No debugger banner. It captures requests made after injection, which
 * covers the invoice-list call the user triggers by navigating to billing.
 *
 * (The research flagged the one caveat: a MAIN-world script has no formal
 * guarantee of running before the page's very first request. For the requests we
 * care about — fired on navigation/interaction — this is fine; the `debugger`
 * backend is the race-free fallback for the rare early-request tail.)
 */
export async function startPageCapture(tabId: number): Promise<void> {
  // A per-session token that ties the MAIN-world interceptor to its ISOLATED-world
  // relay. MAIN and ISOLATED worlds can only talk over the shared (page-visible)
  // DOM, so this doesn't make the channel secret — but it stops unrelated page or
  // extension messages from being relayed as captured entries, and the service
  // worker independently drops entries from any tab that isn't the recording one.
  // The high-integrity path is the debugger backend; silent capture only observes
  // the page's own traffic to DRAFT a recipe the user then reviews.
  const nonce = crypto.randomUUID();
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    injectImmediately: true,
    func: pageInterceptor,
    args: [nonce],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    func: pageRelay, // default (ISOLATED) world — has chrome.runtime
    args: [nonce],
  });
}

/** Runs in the page's MAIN world. Self-contained (serialized via toString). */
function pageInterceptor(nonce: string): void {
  const w = window as unknown as { __invRecInstalled?: boolean };
  if (w.__invRecInstalled) return;
  w.__invRecInstalled = true;

  const emit = (entry: unknown) => window.postMessage({ __invRec: nonce, entry }, "*");
  const cap = (s: string | undefined) => (s ? s.slice(0, 1500000) : undefined);
  const keep = (ct: string) => ct.includes("json") || ct.includes("html"); // invoices live in either
  // Copy bounded raw inputs only. The trusted service worker rebuilds every
  // relayed entry through the same shared sanitizer used by debugger capture.
  const normHeaders = (h: unknown): Record<string, string> | undefined => {
    if (!h) return undefined;
    const out: Record<string, string> = {};
    const put = (k: string, v: string) => {
      const key = String(k).toLowerCase();
      if (typeof v === "string") out[key] = v.slice(0, 8192);
    };
    try {
      if (h instanceof Headers) h.forEach((v, k) => put(k, v));
      else if (Array.isArray(h)) h.forEach((pair) => put(pair[0], pair[1]));
      else for (const k of Object.keys(h as object)) put(k, (h as Record<string, string>)[k]);
    } catch {
      /* ignore */
    }
    return Object.keys(out).length ? out : undefined;
  };

  const origFetch = window.fetch;
  window.fetch = async function (...args: Parameters<typeof fetch>) {
    const res = await origFetch.apply(this, args);
    try {
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      const first = args[0] as string | Request;
      const url = typeof first === "string" ? first : first.url;
      const method = (args[1]?.method || (typeof first !== "string" ? first.method : "GET") || "GET").toUpperCase();
      const reqBody = typeof args[1]?.body === "string" ? (args[1].body as string) : undefined;
      const reqHeaders = normHeaders(args[1]?.headers) ?? (typeof first !== "string" ? normHeaders(first.headers) : undefined);
      const body = keep(ct) ? await res.clone().text() : undefined;
      emit({ url, method, status: res.status, contentType: ct, requestBody: cap(reqBody), requestHeaders: reqHeaders, responseBody: cap(body) });
    } catch {
      /* ignore */
    }
    return res;
  };

  type XhrInv = { method: string; url: string; headers: Record<string, string> };
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  const setHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method: string, url: string) {
    (this as unknown as { __inv?: XhrInv }).__inv = { method, url, headers: {} };
    // eslint-disable-next-line prefer-rest-params
    return open.apply(this, arguments as unknown as Parameters<typeof open>);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name: string, value: string) {
    const inv = (this as unknown as { __inv?: XhrInv }).__inv;
    if (inv) inv.headers[String(name).toLowerCase()] = String(value).slice(0, 8192);
    // eslint-disable-next-line prefer-rest-params
    return setHeader.apply(this, arguments as unknown as Parameters<typeof setHeader>);
  };
  XMLHttpRequest.prototype.send = function (...sendArgs: unknown[]) {
    const reqBody = typeof sendArgs[0] === "string" ? (sendArgs[0] as string) : undefined;
    this.addEventListener("load", () => {
      try {
        const inv = (this as unknown as { __inv?: XhrInv }).__inv;
        const ct = (this.getResponseHeader("content-type") || "").toLowerCase();
        emit({
          url: inv?.url || this.responseURL,
          method: (inv?.method || "GET").toUpperCase(),
          status: this.status,
          contentType: ct,
          requestBody: cap(reqBody),
          requestHeaders: inv && Object.keys(inv.headers).length ? inv.headers : undefined,
          responseBody: keep(ct) ? cap(String(this.responseText)) : undefined,
        });
      } catch {
        /* ignore */
      }
    });
    return send.apply(this, sendArgs as unknown as Parameters<typeof send>);
  };
}

/** Runs in the ISOLATED world; bridges the page's postMessages to the worker.
 * Forwards only same-window messages carrying this session's nonce and a
 * well-formed entry — anything else is ignored. */
function pageRelay(nonce: string): void {
  const w = window as unknown as { __invRelayInstalled?: boolean };
  if (w.__invRelayInstalled) return;
  w.__invRelayInstalled = true;
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { __invRec?: unknown; entry?: unknown } | null;
    if (
      event.source === window &&
      data &&
      data.__invRec === nonce &&
      data.entry &&
      typeof data.entry === "object"
    ) {
      chrome.runtime.sendMessage({ type: "recorder:entry", entry: data.entry });
    }
  });
}
