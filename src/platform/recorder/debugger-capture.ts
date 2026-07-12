import { buildEntry, isCapturableBody, normalizeContentType } from "../../core/recorder/cdp";
import { activeSessionTabIds, appendEntry } from "./session-store";

/**
 * DEEP capture backend — chrome.debugger / Chrome DevTools Protocol.
 *
 * Attaches to the tab, enables the Network domain, and reads full response
 * bodies via Network.getResponseBody. Captures EVERYTHING (no injection race),
 * at the cost of the "started debugging this browser" banner — acceptable for a
 * deliberate one-time capture. Bodies are fetched promptly on loadingFinished
 * because Chrome evicts them shortly after a request completes.
 */
interface RespMeta {
  url: string;
  method: string;
  status: number;
  mimeType: string;
  requestBody?: string;
  requestHeaders?: Record<string, string>;
}

// requestId → metadata, per captured tab.
const perTab = new Map<number, Map<string, RespMeta>>();

// The worker can restart mid-capture (idle sleep), wiping perTab. Re-seed it from
// the persisted sessions so events for a recording tab aren't silently dropped.
void activeSessionTabIds().then((ids) => {
  for (const id of ids) if (!perTab.has(id)) perTab.set(id, new Map());
});

chrome.debugger?.onDetach.addListener((source, reason) => {
  console.warn(`[recorder] debugger detached from tab ${source.tabId} — reason: ${reason}`);
});

chrome.debugger?.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  const metas = perTab.get(tabId);
  if (!metas) return;
  const p = params as Record<string, unknown> | undefined;
  if (!p) return;

  // A cross-origin iframe (e.g. an embedded Stripe billing widget) is a separate
  // CDP target whose network the tab debugger can't see. Auto-attach surfaces it
  // here; enable Network on the child session so its requests are captured too.
  if (method === "Target.attachedToTarget") {
    const ap = p as unknown as { sessionId: string; targetInfo: { url: string; type: string } };
    console.info(`[recorder] child target attached: ${ap.targetInfo.type} ${ap.targetInfo.url}`);
    chrome.debugger.sendCommand(
      { tabId, sessionId: ap.sessionId } as unknown as chrome.debugger.Debuggee,
      "Network.enable",
      {},
      () => {
        if (chrome.runtime.lastError) {
          console.warn(`[recorder] child Network.enable failed: ${chrome.runtime.lastError.message}`);
        }
      },
    );
    return;
  }

  if (method === "Network.requestWillBeSent") {
    const req = (p.request as { method?: string; url?: string; postData?: string; headers?: Record<string, string> }) ?? {};
    metas.set(String(p.requestId), {
      url: req.url ?? "",
      method: req.method ?? "GET",
      status: 0,
      mimeType: "",
      requestBody: req.postData,
      requestHeaders: req.headers,
    });
  } else if (method === "Network.responseReceived") {
    const res = (p.response as { url?: string; status?: number; mimeType?: string }) ?? {};
    console.info(`[recorder] saw ${res.status ?? "?"} ${res.mimeType ?? "?"} ${res.url ?? "?"}`);
    const existing = metas.get(String(p.requestId));
    metas.set(String(p.requestId), {
      url: res.url ?? existing?.url ?? "",
      method: existing?.method ?? "GET",
      status: res.status ?? 0,
      mimeType: res.mimeType ?? "",
      requestBody: existing?.requestBody,
      requestHeaders: existing?.requestHeaders,
    });
  } else if (method === "Network.loadingFinished") {
    const requestId = String(p.requestId);
    const meta = metas.get(requestId);
    if (!meta) return;
    metas.delete(requestId);
    const ct = normalizeContentType(meta.mimeType);
    if (!isCapturableBody(ct) && !ct.includes("pdf")) return; // JSON/HTML bodies + PDFs; skip binary noise

    if (isCapturableBody(ct)) {
      chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId }, (result) => {
        if (chrome.runtime.lastError || !result) {
          console.warn(`[recorder] getResponseBody failed for ${meta.url}: ${chrome.runtime.lastError?.message ?? "no result"}`);
          return;
        }
        const r = result as { body: string; base64Encoded: boolean };
        const body = r.base64Encoded ? safeAtob(r.body) : r.body;
        console.info(`[recorder] captured ${ct} ${meta.status} ${meta.url}`);
        void appendEntry(tabId, buildEntry({ url: meta.url, method: meta.method, status: meta.status, contentType: meta.mimeType, body, requestBody: meta.requestBody, requestHeaders: meta.requestHeaders }));
      });
    } else {
      console.info(`[recorder] captured PDF ${meta.status} ${meta.url}`);
      void appendEntry(tabId, buildEntry({ url: meta.url, method: meta.method, status: meta.status, contentType: meta.mimeType, requestBody: meta.requestBody, requestHeaders: meta.requestHeaders }));
    }
  }
});

export async function startDebuggerCapture(tabId: number): Promise<void> {
  perTab.set(tabId, new Map());
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    // A previous session may have left a debugger attached — detach and retry once.
    console.warn(`[recorder] attach failed (${String(error)}); detaching stale debugger and retrying`);
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      /* nothing to detach */
    }
    await chrome.debugger.attach({ tabId }, "1.3");
  }
  await chrome.debugger.sendCommand({ tabId }, "Network.enable");
  // Follow into iframes/workers so an embedded (cross-origin) billing widget's
  // requests are captured, not just the top frame's.
  await chrome.debugger.sendCommand({ tabId }, "Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  console.info(`[recorder] debugger attached + Network enabled (+ auto-attach) on tab ${tabId}`);
}

export async function stopDebuggerCapture(tabId: number): Promise<void> {
  perTab.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* not attached */
  }
}

function safeAtob(b64: string): string {
  try {
    return atob(b64);
  } catch {
    return "";
  }
}
