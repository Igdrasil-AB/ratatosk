import { beforeEach, describe, expect, it, vi } from "vitest";

let session: Record<string, unknown>;
let attach: ReturnType<typeof vi.fn>;
let detach: ReturnType<typeof vi.fn>;
let sendCommand: ReturnType<typeof vi.fn>;
let reload: ReturnType<typeof vi.fn>;
let storageGet: ReturnType<typeof vi.fn>;
let storageSet: ReturnType<typeof vi.fn>;
let debuggerEvent: ((source: chrome.debugger.Debuggee, method: string, params?: object) => void) | undefined;

beforeEach(() => {
  vi.resetModules();
  session = {};
  attach = vi.fn(async () => undefined);
  detach = vi.fn(async () => undefined);
  sendCommand = vi.fn(async () => undefined);
  reload = vi.fn(async () => undefined);
  storageGet = vi.fn(async (key: string | null, callback?: (items: Record<string, unknown>) => void) => {
    const value = key === null ? structuredClone(session) : { [key]: structuredClone(session[key]) };
    callback?.(value);
    return value;
  });
  storageSet = vi.fn(async (items: Record<string, unknown>) => { Object.assign(session, structuredClone(items)); });
  debuggerEvent = undefined;
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        get: storageGet,
        set: storageSet,
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete session[key];
        }),
      },
    },
    debugger: {
      attach,
      detach,
      sendCommand,
      onEvent: { addListener: vi.fn((listener) => { debuggerEvent = listener; }) },
      onDetach: { addListener: vi.fn() },
    },
    tabs: { reload },
    scripting: { executeScript: vi.fn(async () => []) },
    runtime: { getManifest: () => ({ version: "0.8.29" }), lastError: undefined },
  });
});

describe("Studio recorder orchestration", () => {
  it("reports an empty capture without synthetic evidence as zero requests and zero evidence", async () => {
    const recorder = await import("../../studio/src/platform/recorder/orchestrator");
    await recorder.startRecording(41, "https://vendor.example/billing", "deep");

    await expect(recorder.stopRecording()).resolves.toMatchObject({
      captured: 0,
      requestCount: 0,
      artifactCount: 0,
      evidenceCount: 0,
      samples: [],
    });
  });

  it("keeps a DOM-only inference artifact from masking zero captured requests", async () => {
    vi.mocked(chrome.scripting.executeScript).mockResolvedValueOnce([{ result: {
      url: "https://vendor.example/billing",
      html: "<html><body>invoice history</body></html>",
      truncated: false,
    } }] as any);
    const recorder = await import("../../studio/src/platform/recorder/orchestrator");
    await recorder.startRecording(41, "https://vendor.example/billing", "deep");

    const result = await recorder.stopRecording();

    expect(result).toMatchObject({ captured: 0, requestCount: 0, artifactCount: 1, evidenceCount: 1, samples: [] });
    expect(result.report).toContain("0 requests captured");
    expect(result.fingerprint?.evidence.requestCount).toBe(0);
  });

  it("rejects insecure pages before creating or attaching a recording", async () => {
    const recorder = await import("../../studio/src/platform/recorder/orchestrator");

    await expect(recorder.startRecording(41, "http://vendor.example/billing", "deep"))
      .rejects.toThrow("requires an HTTPS page");
    expect(attach).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();
    expect(session).toEqual({});
  });

  it("rolls back the session, current pointer, and debugger when startup fails", async () => {
    reload.mockRejectedValueOnce(new Error("reload failed"));
    const recorder = await import("../../studio/src/platform/recorder/orchestrator");

    await expect(recorder.startRecording(41, "https://vendor.example/billing", "deep")).rejects.toThrow("reload failed");

    expect(attach).toHaveBeenCalledWith({ tabId: 41 }, "1.3");
    expect(detach).toHaveBeenCalled();
    expect(session).toEqual({});
    await expect(recorder.isRecording()).resolves.toBe(false);
  });

  it("serializes overlapping starts so a second tab cannot replace the active recording", async () => {
    let releaseReload: (() => void) | undefined;
    reload.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseReload = resolve; }));
    const recorder = await import("../../studio/src/platform/recorder/orchestrator");

    const first = recorder.startRecording(41, "https://vendor.example/billing", "deep");
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
    const second = recorder.startRecording(42, "https://other.example/billing", "deep");
    releaseReload?.();

    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toThrow("already active");
    expect(session["recorder:current"]).toBe(41);
    expect(session["recorder:session:41"]).toBeDefined();
    expect(session["recorder:session:42"]).toBeUndefined();

    await recorder.stopRecording();
    expect(session).toEqual({});
    await expect(recorder.stopRecording()).rejects.toThrow("No active recorder session");
  });

  it("waits for restart hydration before persisting a fresh recording session", async () => {
    let releaseHydration: (() => void) | undefined;
    const hydration = new Promise<void>((resolve) => { releaseHydration = resolve; });
    storageGet.mockImplementation(async (key: string | null, callback?: (items: Record<string, unknown>) => void) => {
      if (key === null) await hydration;
      const value = key === null ? structuredClone(session) : { [key]: structuredClone(session[key]) };
      callback?.(value);
      return value;
    });
    const recorder = await import("../../studio/src/platform/recorder/orchestrator");

    const starting = recorder.startRecording(41, "https://vendor.example/billing", "deep");
    await Promise.resolve();
    expect(session).toEqual({});
    releaseHydration?.();
    await expect(starting).resolves.toBeUndefined();
    await expect(recorder.recordingProgress()).resolves.toMatchObject({ recording: true, recoveryFailed: false });
    await recorder.stopRecording();
  });

  it("detaches when debugger command setup fails after attaching", async () => {
    sendCommand.mockRejectedValueOnce(new Error("Network.enable failed"));
    const { startDebuggerCapture } = await import("../../studio/src/platform/recorder/debugger-capture");

    await expect(startDebuggerCapture(41)).rejects.toThrow("Network.enable failed");
    expect(detach).toHaveBeenCalledWith({ tabId: 41 });
  });

  it("rolls back persisted recording state when debugger command setup fails", async () => {
    sendCommand.mockRejectedValueOnce(new Error("Network.enable failed"));
    const recorder = await import("../../studio/src/platform/recorder/orchestrator");

    await expect(recorder.startRecording(41, "https://vendor.example/billing", "deep"))
      .rejects.toThrow("Network.enable failed");
    expect(detach).toHaveBeenCalledWith({ tabId: 41 });
    expect(session).toEqual({});
    await expect(recorder.isRecording()).resolves.toBe(false);
  });

  it("rolls back persisted recording state when debugger attachment fails", async () => {
    attach.mockRejectedValue(new Error("debugger unavailable"));
    const recorder = await import("../../studio/src/platform/recorder/orchestrator");

    await expect(recorder.startRecording(41, "https://vendor.example/billing", "deep"))
      .rejects.toThrow("debugger unavailable");
    expect(attach).toHaveBeenCalledTimes(2);
    expect(session).toEqual({});
    await expect(recorder.isRecording()).resolves.toBe(false);
  });

  it("sanitizes hostile debugger traffic before it reaches session storage", async () => {
    const responseSecret = "synthetic-response-secret";
    const requestSecret = "synthetic-request-secret";
    const headerSecret = "synthetic-header-secret";
    const accountId = "550e8400-e29b-41d4-a716-446655440000";
    sendCommand.mockImplementation((_debuggee, command: string) => command === "Network.getResponseBody"
      ? Promise.resolve({
        body: JSON.stringify({
          accessToken: responseSecret,
          owner: { email: "owner@example.com" },
          invoices: [{ id: "inv_1", issuedAt: "2026-07-16T00:00:00Z" }],
        }),
        base64Encoded: false,
      })
      : Promise.resolve(undefined));
    const recorder = await import("../../studio/src/platform/recorder/orchestrator");
    await recorder.startRecording(41, "https://vendor.example/billing", "deep");

    const source = { tabId: 41 } as chrome.debugger.Debuggee;
    debuggerEvent?.(source, "Network.requestWillBeSent", {
      requestId: "hostile-request",
      request: {
        method: "post",
        url: `https://vendor.example/api/invoices?account_id=${accountId}&sig=synthetic-url-secret`,
        postData: JSON.stringify({ operationName: "Invoices", variables: { accessToken: requestSecret } }),
        headers: {
          AUTHORIZATION: `Bearer ${headerSecret}`,
          Cookie: "sid=synthetic-cookie-secret",
          "Content-Type": "application/json; charset=utf-8",
        },
      },
    });
    debuggerEvent?.(source, "Network.responseReceived", {
      requestId: "hostile-request",
      response: {
        status: 200,
        mimeType: "application/json; charset=utf-8",
        url: `https://vendor.example/api/invoices?account_id=${accountId}&sig=synthetic-url-secret`,
      },
    });
    debuggerEvent?.(source, "Network.loadingFinished", { requestId: "hostile-request" });

    await vi.waitFor(() => expect((session["recorder:session:41"] as { entries: unknown[] }).entries).toHaveLength(1));
    const [entry] = (session["recorder:session:41"] as { entries: Array<Record<string, unknown>> }).entries;
    expect(entry).toMatchObject({
      method: "POST",
      status: 200,
      contentType: "application/json",
      requestHeaders: { "content-type": "application/json" },
      requestAuth: { scheme: "bearer", headerName: "authorization" },
      redactedRequestPaths: ["variables.accessToken"],
      redactedResponsePaths: ["accessToken", "owner.email"],
    });
    expect(entry.url).toBe("https://vendor.example/api/invoices?account_id=__ratatosk_ref_1__&sig=__ratatosk_ref_2__");
    expect(JSON.parse(String(entry.requestBody))).toEqual({ operationName: "Invoices", variables: { accessToken: "REDACTED" } });
    expect(JSON.parse(String(entry.responseBody))).toMatchObject({ accessToken: "REDACTED", owner: { email: "REDACTED" } });
    expect(JSON.stringify(entry)).not.toMatch(/synthetic-(?:response|request|header|cookie|url)-secret|owner@example\.com|550e8400/i);
    await recorder.stopRecording();
  });

  it("forgets failed and cancelled CDP requests instead of retaining their metadata", async () => {
    const recorder = await import("../../studio/src/platform/recorder/orchestrator");
    await recorder.startRecording(41, "https://vendor.example/billing", "deep");
    const source = { tabId: 41 } as chrome.debugger.Debuggee;

    for (let index = 0; index < 100; index += 1) {
      const requestId = `failed-${index}`;
      debuggerEvent?.(source, "Network.requestWillBeSent", {
        requestId,
        request: { method: "GET", url: `https://vendor.example/api/failed/${index}` },
      });
      debuggerEvent?.(source, "Network.responseReceived", {
        requestId,
        response: { status: 0, mimeType: "application/json", url: `https://vendor.example/api/failed/${index}` },
      });
      debuggerEvent?.(source, "Network.loadingFailed", { requestId, canceled: index % 2 === 0 });
      // A duplicate/late terminal event must find no retained metadata.
      debuggerEvent?.(source, "Network.loadingFinished", { requestId });
    }

    await recorder.stopRecording();
    expect(sendCommand.mock.calls.filter(([, command]) => command === "Network.getResponseBody")).toEqual([]);
    expect(session).toEqual({});
  });

  it("rolls back persisted recording state when the disabled silent backend is requested", async () => {
    const recorder = await import("../../studio/src/platform/recorder/orchestrator");

    await expect(recorder.startRecording(41, "https://vendor.example/billing", "silent"))
      .rejects.toThrow("Silent page capture is disabled");
    expect(session).toEqual({});
    await expect(recorder.isRecording()).resolves.toBe(false);
  });

  it("drains entries accepted before stop while rejecting later capture callbacks", async () => {
    const store = await import("../../studio/src/platform/recorder/session-store");
    const entry = (url: string) => ({ url, method: "GET", status: 200, contentType: "application/json" });
    await store.beginSession(41, "https://vendor.example");

    const first = store.appendEntry(41, entry("https://vendor.example/api/one"));
    const second = store.appendEntry(41, entry("https://vendor.example/api/two"));
    const ended = store.endSession(41);

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    await expect(store.appendEntry(41, entry("https://vendor.example/api/late"))).resolves.toBe(false);
    await expect(ended).resolves.toMatchObject({
      entries: [
        { url: "https://vendor.example/api/one" },
        { url: "https://vendor.example/api/two" },
      ],
    });
  });

  it("drains a response body already finishing when recording stops", async () => {
    let releaseBody: ((value: unknown) => void) | undefined;
    sendCommand.mockImplementation((_debuggee, command: string) => command === "Network.getResponseBody"
      ? new Promise((resolve) => { releaseBody = resolve; })
      : Promise.resolve(undefined));
    const recorder = await import("../../studio/src/platform/recorder/orchestrator");
    await recorder.startRecording(41, "https://vendor.example/billing", "deep");

    const source = { tabId: 41 } as chrome.debugger.Debuggee;
    debuggerEvent?.(source, "Network.requestWillBeSent", {
      requestId: "request-1",
      request: { method: "GET", url: "https://vendor.example/api/invoices" },
    });
    debuggerEvent?.(source, "Network.responseReceived", {
      requestId: "request-1",
      response: { status: 200, mimeType: "application/json", url: "https://vendor.example/api/invoices" },
    });
    debuggerEvent?.(source, "Network.loadingFinished", { requestId: "request-1" });
    await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledWith(source, "Network.getResponseBody", { requestId: "request-1" }));
    vi.mocked(chrome.scripting.executeScript).mockResolvedValueOnce([{ result: {
      url: "https://vendor.example/billing",
      html: "<html><body>invoice history</body></html>",
      truncated: false,
    } }] as any);

    const stopping = recorder.stopRecording();
    releaseBody?.({ body: '{"data":[]}', base64Encoded: false });

    await expect(stopping).resolves.toMatchObject({
      captured: 1,
      requestCount: 1,
      artifactCount: 1,
      evidenceCount: 2,
      samples: ["200 application/json https://vendor.example/api/invoices"],
      fingerprint: { evidence: { requestCount: 1 } },
    });
  });

  it("queues initial debugger traffic until a persisted session is hydrated after worker restart", async () => {
    session["recorder:session:41"] = { origin: "https://vendor.example", entries: [] };
    let releaseHydration: (() => void) | undefined;
    const hydration = new Promise<void>((resolve) => { releaseHydration = resolve; });
    storageGet.mockImplementation(async (key: string | null, callback?: (items: Record<string, unknown>) => void) => {
      if (key === null) await hydration;
      const value = key === null ? structuredClone(session) : { [key]: structuredClone(session[key]) };
      callback?.(value);
      return value;
    });
    sendCommand.mockImplementation((_debuggee, command: string) => command === "Network.getResponseBody"
      ? Promise.resolve({ body: '{"data":[]}', base64Encoded: false })
      : Promise.resolve(undefined));
    await import("../../studio/src/platform/recorder/debugger-capture");

    const source = { tabId: 41 } as chrome.debugger.Debuggee;
    debuggerEvent?.(source, "Network.requestWillBeSent", {
      requestId: "startup-request",
      request: { method: "GET", url: "https://vendor.example/api/invoices" },
    });
    debuggerEvent?.(source, "Network.responseReceived", {
      requestId: "startup-request",
      response: { status: 200, mimeType: "application/json", url: "https://vendor.example/api/invoices" },
    });
    debuggerEvent?.(source, "Network.loadingFinished", { requestId: "startup-request" });
    expect((session["recorder:session:41"] as { entries: unknown[] }).entries).toHaveLength(0);

    releaseHydration?.();
    await vi.waitFor(() => expect((session["recorder:session:41"] as { entries: unknown[] }).entries).toHaveLength(1));
    expect((session["recorder:session:41"] as { entries: Array<{ url: string }> }).entries[0]?.url)
      .toBe("https://vendor.example/api/invoices");
    const store = await import("../../studio/src/platform/recorder/session-store");
    expect(store.captureRecoveryFailed(41)).toBe(true);
    await expect(store.endSession(41)).rejects.toThrow("retry the recording to preserve identifier correlation");
    expect(session).toEqual({});
  });

  it("discards the session and rejects stop after an accepted capture write fails", async () => {
    sendCommand.mockImplementation((_debuggee, command: string) => command === "Network.getResponseBody"
      ? Promise.resolve({ body: '{"data":[]}', base64Encoded: false })
      : Promise.resolve(undefined));
    const recorder = await import("../../studio/src/platform/recorder/orchestrator");
    await recorder.startRecording(41, "https://vendor.example/billing", "deep");
    storageSet.mockRejectedValueOnce(new Error("session quota exceeded"));

    const source = { tabId: 41 } as chrome.debugger.Debuggee;
    debuggerEvent?.(source, "Network.requestWillBeSent", {
      requestId: "request-failed",
      request: { method: "GET", url: "https://vendor.example/api/invoices" },
    });
    debuggerEvent?.(source, "Network.responseReceived", {
      requestId: "request-failed",
      response: { status: 200, mimeType: "application/json", url: "https://vendor.example/api/invoices" },
    });
    debuggerEvent?.(source, "Network.loadingFinished", { requestId: "request-failed" });
    await vi.waitFor(async () => expect((await recorder.recordingProgress()).storageFailed).toBe(true));

    await expect(recorder.stopRecording()).rejects.toThrow("Capture storage failed");
    expect(session).toEqual({});
    await expect(recorder.isRecording()).resolves.toBe(false);
  });

  it("rejects a session that exceeds the recorder byte budget before writing it", async () => {
    const store = await import("../../studio/src/platform/recorder/session-store");
    await store.beginSession(41, "https://vendor.example");

    await expect(store.appendEntry(41, {
      url: "https://vendor.example/api/invoices",
      method: "GET",
      status: 200,
      contentType: "application/json",
      responseBody: "x".repeat(4 * 1024 * 1024),
    })).rejects.toThrow("Capture storage failed");
    await expect(store.endSession(41)).rejects.toThrow("Capture storage failed");
    expect(storageSet).toHaveBeenCalledTimes(1);
  });
});
