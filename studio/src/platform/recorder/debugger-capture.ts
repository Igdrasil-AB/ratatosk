import { isCapturableBody, normalizeContentType, sanitizeUrl } from "../../../../src/core/recorder/cdp";
import { activeSessionTabIds, appendEntry, buildSessionEntry, markSessionRecovered } from "./session-store";

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
  sessionId?: string;
}

interface CaptureState {
  metas: Map<string, RespMeta>;
  accepting: boolean;
  /** Preserves CDP event order and forms the stop-time drain barrier. */
  tail: Promise<void>;
}

const MAX_PENDING_REQUESTS = 2_000;

// Per captured tab. A state is retained until stop has detached and drained all
// event/body work that was accepted before its cutoff.
const perTab = new Map<number, CaptureState>();

function captureState(tabId: number): CaptureState {
  let state = perTab.get(tabId);
  if (!state) {
    state = { metas: new Map(), accepting: true, tail: Promise.resolve() };
    perTab.set(tabId, state);
  }
  return state;
}

// The worker can restart mid-capture (idle sleep), wiping perTab. Re-seed it from
// the persisted sessions so events for a recording tab aren't silently dropped.
// Every event waits for this barrier; stop waits for the same barrier before it
// closes intake, so a boundary event cannot be raced out by hydration.
const hydrationReady = activeSessionTabIds().then((ids) => {
  for (const id of ids) {
    markSessionRecovered(id);
    captureState(id);
  }
}).catch((error) => {
  console.warn(`[recorder] session hydration failed: ${String(error)}`);
});

export function waitForDebuggerHydration(): Promise<void> {
  return hydrationReady;
}

chrome.debugger?.onDetach.addListener((source, reason) => {
  console.warn(`[recorder] debugger detached from tab ${source.tabId} — reason: ${reason}`);
});

chrome.debugger?.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  const state = captureState(tabId);
  if (!state.accepting) return;
  const task = state.tail.then(async () => {
    await hydrationReady;
    await handleDebuggerEvent(tabId, state, source, method, params);
  });
  state.tail = task.then(() => undefined, (error) => {
    console.warn(`[recorder] capture event failed for tab ${tabId}: ${String(error)}`);
  });
});

async function handleDebuggerEvent(
  tabId: number,
  state: CaptureState,
  source: chrome.debugger.Debuggee,
  method: string,
  params: object | undefined,
): Promise<void> {
  const p = params as Record<string, unknown> | undefined;
  if (!p) return;
  const metas = state.metas;
  const sessionId = (source as chrome.debugger.Debuggee & { sessionId?: string }).sessionId;
  const requestKey = (requestId: unknown) => `${sessionId ?? "root"}:${String(requestId)}`;

  // A cross-origin iframe (e.g. an embedded Stripe billing widget) is a separate
  // CDP target whose network the tab debugger can't see. Auto-attach surfaces it
  // here; enable Network on the child session so its requests are captured too.
  if (method === "Target.attachedToTarget") {
    const ap = p as unknown as { sessionId: string; targetInfo: { url: string; type: string } };
    console.info(`[recorder] child target attached: ${ap.targetInfo.type} ${logOrigin(ap.targetInfo.url)}`);
    try {
      await chrome.debugger.sendCommand(
      { tabId, sessionId: ap.sessionId } as unknown as chrome.debugger.Debuggee,
      "Network.enable",
      {},
      );
    } catch (error) {
      console.warn(`[recorder] child Network.enable failed: ${String(error)}`);
    }
    return;
  }

  if (method === "Network.requestWillBeSent") {
    const req = (p.request as { method?: string; url?: string; postData?: string; headers?: Record<string, string> }) ?? {};
    setBoundedMeta(metas, requestKey(p.requestId), {
      url: req.url ?? "",
      method: req.method ?? "GET",
      status: 0,
      mimeType: "",
      requestBody: req.postData,
      requestHeaders: req.headers,
      sessionId,
    });
  } else if (method === "Network.responseReceived") {
    const res = (p.response as { url?: string; status?: number; mimeType?: string }) ?? {};
    console.info(`[recorder] saw ${res.status ?? "?"} ${res.mimeType ?? "?"} ${logOrigin(res.url)}`);
    const existing = metas.get(requestKey(p.requestId));
    setBoundedMeta(metas, requestKey(p.requestId), {
      url: res.url ?? existing?.url ?? "",
      method: existing?.method ?? "GET",
      status: res.status ?? 0,
      mimeType: res.mimeType ?? "",
      requestBody: existing?.requestBody,
      requestHeaders: existing?.requestHeaders,
      sessionId,
    });
  } else if (method === "Network.loadingFailed") {
    metas.delete(requestKey(p.requestId));
  } else if (method === "Network.loadingFinished") {
    const requestId = String(p.requestId);
    const key = requestKey(p.requestId);
    const meta = metas.get(key);
    if (!meta) return;
    metas.delete(key);
    const ct = normalizeContentType(meta.mimeType);
    if (!isCapturableBody(ct) && !ct.includes("pdf")) return; // JSON/HTML bodies + PDFs; skip binary noise

    if (isCapturableBody(ct)) {
      const debuggee = meta.sessionId
        ? ({ tabId, sessionId: meta.sessionId } as unknown as chrome.debugger.Debuggee)
        : { tabId };
      let result: unknown;
      try {
        result = await chrome.debugger.sendCommand(debuggee, "Network.getResponseBody", { requestId });
      } catch (error) {
        console.warn(`[recorder] getResponseBody failed for ${logOrigin(meta.url)}: ${String(error)}`);
        return;
      }
      if (!result) {
        console.warn(`[recorder] getResponseBody failed for ${logOrigin(meta.url)}: no result`);
        return;
      }
      const r = result as { body: string; base64Encoded: boolean };
      const body = r.base64Encoded ? safeAtob(r.body) : r.body;
      console.info(`[recorder] captured ${ct} ${meta.status} ${logOrigin(meta.url)}`);
      await appendEntry(tabId, buildSessionEntry(tabId, { url: meta.url, method: meta.method, status: meta.status, contentType: meta.mimeType, body, requestBody: meta.requestBody, requestHeaders: meta.requestHeaders }));
    } else {
      console.info(`[recorder] captured PDF ${meta.status} ${logOrigin(meta.url)}`);
      await appendEntry(tabId, buildSessionEntry(tabId, { url: meta.url, method: meta.method, status: meta.status, contentType: meta.mimeType, requestBody: meta.requestBody, requestHeaders: meta.requestHeaders }));
    }
  }
}

function setBoundedMeta(metas: Map<string, RespMeta>, key: string, meta: RespMeta): void {
  // CDP should send loadingFinished/loadingFailed, but a detached or incomplete
  // target can omit both. Keep the capture process bounded even then.
  if (!metas.has(key) && metas.size >= MAX_PENDING_REQUESTS) {
    const oldest = metas.keys().next().value;
    if (oldest !== undefined) metas.delete(oldest);
  }
  metas.set(key, meta);
}

export async function startDebuggerCapture(tabId: number): Promise<void> {
  // A new session must not race the module's restart-recovery snapshot and be
  // mislabeled as a recovered, correlation-incomplete recording.
  await hydrationReady;
  captureState(tabId);
  let attached = false;
  try {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      attached = true;
    } catch (error) {
      // A previous session may have left a debugger attached — detach and retry once.
      console.warn(`[recorder] attach failed (${String(error)}); detaching stale debugger and retrying`);
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        /* nothing to detach */
      }
      await chrome.debugger.attach({ tabId }, "1.3");
      attached = true;
    }
    await chrome.debugger.sendCommand({ tabId }, "Network.enable");
    // Follow into iframes/workers so an embedded (cross-origin) billing widget's
    // requests are captured, not just the top frame's.
    await chrome.debugger.sendCommand({ tabId }, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  } catch (error) {
    perTab.delete(tabId);
    if (attached) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        /* cleanup is best effort; retain the original setup failure */
      }
    }
    throw error;
  }
  console.info(`[recorder] debugger attached + Network enabled (+ auto-attach) on tab ${tabId}`);
}

export async function stopDebuggerCapture(tabId: number): Promise<void> {
  await hydrationReady;
  const state = perTab.get(tabId);
  if (state) state.accepting = false;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* not attached */
  }
  // Detaching blocks new CDP events. Await every request/body callback already
  // accepted before the cutoff before endSession closes persistent admission.
  await state?.tail;
  perTab.delete(tabId);
}

function safeAtob(b64: string): string {
  try {
    return atob(b64);
  } catch {
    return "";
  }
}

function logOrigin(url: string | undefined): string {
  try {
    return new URL(sanitizeUrl(url ?? "")).origin;
  } catch {
    return "unknown-origin";
  }
}
