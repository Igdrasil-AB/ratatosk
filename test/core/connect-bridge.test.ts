import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installConnectBridge,
  type ConnectBridgeRuntime,
  type ConnectBridgeWindow,
} from "../../collector/src/platform/connect-bridge";

const ORIGIN = "https://accounting.igdrasil.se";

describe("Igdrasil connect bridge", () => {
  let listener: (event: MessageEvent) => void;
  let posts: Array<{ message: any; origin: string }>;
  let bridgeWindow: ConnectBridgeWindow;
  let runtime: ConnectBridgeRuntime;
  let sendMessage: ReturnType<typeof vi.fn> & ConnectBridgeRuntime["sendMessage"];

  beforeEach(() => {
    posts = [];
    bridgeWindow = {
      location: { origin: ORIGIN },
      postMessage: (message, origin) => { posts.push({ message, origin }); },
      addEventListener: (_type, callback) => { listener = callback; },
    };
    sendMessage = vi.fn((_payload: unknown, callback: (response: unknown) => void) => callback({ ok: true })) as typeof sendMessage;
    runtime = { getManifest: () => ({ version: "0.8.29" }), sendMessage };
    installConnectBridge(bridgeWindow, runtime);
    expect(posts).toEqual([{
      message: { __ic: "invoice-collector", kind: "present", version: "0.8.29" },
      origin: ORIGIN,
    }]);
  });

  it("ignores foreign-window, foreign-origin, malformed, and untagged messages", () => {
    for (const event of [
      requestEvent({ source: {}, origin: ORIGIN }),
      requestEvent({ source: bridgeWindow, origin: "https://attacker.example" }),
      requestEvent({ source: bridgeWindow, origin: ORIGIN, data: { __ic: "other", kind: "request", requestId: "r1", payload: { type: "igdrasil:connect" } } }),
      requestEvent({ source: bridgeWindow, origin: ORIGIN, data: { __ic: "invoice-collector", kind: "response", requestId: "r1" } }),
      requestEvent({ source: bridgeWindow, origin: ORIGIN, data: { __ic: "invoice-collector", kind: "request", payload: { type: "igdrasil:connect" } } }),
    ]) listener(event);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(posts).toHaveLength(1);
  });

  it("answers ping locally and rejects unsupported request types", () => {
    listener(requestEvent({ source: bridgeWindow, origin: ORIGIN, data: payload("ping", "igdrasil:ping") }));
    listener(requestEvent({ source: bridgeWindow, origin: ORIGIN, data: payload("bad", "igdrasil:unknown") }));

    expect(sendMessage).not.toHaveBeenCalled();
    expect(posts.slice(1).map(({ message }) => message)).toEqual([
      { __ic: "invoice-collector", kind: "response", requestId: "ping", result: { ok: true, present: true, version: "0.8.29" } },
      { __ic: "invoice-collector", kind: "response", requestId: "bad", result: { ok: false, error: "unsupported request" } },
    ]);
  });

  it.each(["prepare", "validate", "connect", "status", "disconnect"])(
    "relays igdrasil:%s and preserves its request ID",
    (operation) => {
      const requestId = `request-${operation}`;
      const request = payload(requestId, `igdrasil:${operation}`);
      listener(requestEvent({ source: bridgeWindow, origin: ORIGIN, data: request }));

      expect(sendMessage).toHaveBeenLastCalledWith(request.payload, expect.any(Function));
      expect(posts.at(-1)?.message).toEqual({
        __ic: "invoice-collector",
        kind: "response",
        requestId,
        result: { ok: true },
      });
    },
  );

  it("returns the runtime error to the originating request", () => {
    runtime = {
      getManifest: () => ({ version: "0.8.29" }),
      get lastError() { return { message: "worker unavailable" }; },
      sendMessage: (_message, callback) => callback(undefined),
    };
    posts = [];
    installConnectBridge(bridgeWindow, runtime);

    listener(requestEvent({ source: bridgeWindow, origin: ORIGIN, data: payload("failed", "igdrasil:connect") }));

    expect(posts.at(-1)?.message).toEqual({
      __ic: "invoice-collector",
      kind: "response",
      requestId: "failed",
      result: { ok: false, error: "worker unavailable" },
    });
  });
});

function payload(requestId: string, type: string) {
  return { __ic: "invoice-collector", kind: "request", requestId, payload: { type } };
}

function requestEvent(overrides: { source: unknown; origin: string; data?: unknown }): MessageEvent {
  return { data: overrides.data ?? payload("r1", "igdrasil:connect"), ...overrides } as unknown as MessageEvent;
}
