import { describe, expect, it, vi } from "vitest";
import { DocumentPermissionRequired, DocumentRedirectRejected } from "../../src/core/errors";
import type { HttpResponse, RequestSpec } from "../../src/core/types";
import {
  createDocumentProviderFetch,
  type RedirectEvent,
  type RedirectEventDetails,
} from "../../collector/src/platform/document-provider-fetch";

describe("document provider fetch", () => {
  it("captures a regional Stripe redirect and returns a typed exact-origin permission requirement", async () => {
    const event = fakeRedirectEvent();
    const base = vi.fn(async (spec: RequestSpec): Promise<HttpResponse> => {
      event.emit({
        requestId: "request-1",
        url: spec.url,
        redirectUrl: "https://stripe-upload-api.s3.eu-north-1.amazonaws.com/file-api/object?signature=secret",
        statusCode: 302,
      });
      throw new TypeError("fetch failed");
    });
    const fetch = createDocumentProviderFetch(base, {
      redirectEvent: event,
      hasOrigins: async () => false,
    });

    const error = await fetch({ url: "https://pay.stripe.com/a/future/path?token=secret" }, {})
      .then(() => undefined, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(DocumentPermissionRequired);
    expect((error as DocumentPermissionRequired).requiredOrigins).toEqual([
      "https://stripe-upload-api.s3.eu-north-1.amazonaws.com/*",
    ]);
    expect(JSON.stringify(error)).not.toContain("signature");
    expect(event.listenerCount()).toBe(0);
  });

  it("allows any Stripe path and validates a permitted final provider origin", async () => {
    const event = fakeRedirectEvent();
    const base = vi.fn(async (spec: RequestSpec): Promise<HttpResponse> => {
      event.emit({
        requestId: "request-2",
        url: spec.url,
        redirectUrl: "https://stripe-upload-api.s3.ap-southeast-2.amazonaws.com/file-api/object?secret=yes",
        statusCode: 302,
      });
      return response("https://stripe-upload-api.s3.ap-southeast-2.amazonaws.com/file-api/object?secret=yes");
    });
    const fetch = createDocumentProviderFetch(base, {
      redirectEvent: event,
      hasOrigins: async () => true,
    });

    await expect(fetch({ url: "https://pay.stripe.com/new/pdf/path?opaque=yes" }, {})).resolves.toMatchObject({ ok: true });
    expect(base).toHaveBeenCalledWith({ url: "https://pay.stripe.com/new/pdf/path?opaque=yes" }, {});
    expect(event.listenerCount()).toBe(0);
  });

  it("rejects a redirect from Stripe to an unrelated host even when the fetch succeeds", async () => {
    const event = fakeRedirectEvent();
    const fetch = createDocumentProviderFetch(async (spec) => {
      event.emit({
        requestId: "request-3",
        url: spec.url,
        redirectUrl: "https://attacker.example/invoice.pdf",
        statusCode: 302,
      });
      return response("https://attacker.example/invoice.pdf");
    }, { redirectEvent: event, hasOrigins: async () => true });

    await expect(fetch({ url: "https://pay.stripe.com/invoice/acct/token/pdf" }, {}))
      .rejects.toBeInstanceOf(DocumentRedirectRejected);
  });

  it("traces a fetch that starts at an approved regional upload origin", async () => {
    const event = fakeRedirectEvent();
    const fetch = createDocumentProviderFetch(async (spec) => {
      event.emit({
        requestId: "request-upload",
        url: spec.url,
        redirectUrl: "https://attacker.example/intermediate",
        statusCode: 302,
      });
      // A valid final provider URL must not hide the untrusted intermediate hop.
      return response("https://pay.stripe.com/invoice/acct/final/pdf");
    }, { redirectEvent: event, hasOrigins: async () => true });

    await expect(fetch({
      url: "https://stripe-upload-api.s3.eu-north-1.amazonaws.com/file.pdf",
    }, {})).rejects.toBeInstanceOf(DocumentRedirectRejected);
  });

  it("rejects an attacker redirect after an approved regional Stripe hop", async () => {
    const event = fakeRedirectEvent();
    const regional = "https://stripe-upload-api.s3.eu-north-1.amazonaws.com/file-api/object?secret=yes";
    const fetch = createDocumentProviderFetch(async (spec) => {
      event.emit({
        requestId: "request-chain",
        url: spec.url,
        redirectUrl: regional,
        statusCode: 302,
      });
      event.emit({
        requestId: "request-chain",
        url: regional,
        redirectUrl: "https://attacker.example/stolen.pdf",
        statusCode: 302,
      });
      throw new TypeError("fetch failed after redirect chain");
    }, { redirectEvent: event, hasOrigins: async () => true });

    await expect(fetch({ url: "https://pay.stripe.com/invoice/acct/token/pdf" }, {}))
      .rejects.toBeInstanceOf(DocumentRedirectRejected);
    expect(event.listenerCount()).toBe(0);
  });

  it("converts the proven hosted page shape before fetching", async () => {
    const base = vi.fn(async (spec: RequestSpec) => response(spec.url));
    const fetch = createDocumentProviderFetch(base, {
      redirectEvent: fakeRedirectEvent(),
      hasOrigins: async () => true,
    });

    await fetch({ url: "https://invoice.stripe.com/i/acct/token?s=ap" }, {});
    expect(base).toHaveBeenCalledWith({ url: "https://pay.stripe.com/invoice/acct/token/pdf?s=ap" }, {});
  });

  it("serializes identical URLs so concurrent redirect traces cannot cross", async () => {
    const event = fakeRedirectEvent();
    const origins: string[] = [];
    let active = 0;
    let maximum = 0;
    let call = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const base = vi.fn(async (spec: RequestSpec): Promise<HttpResponse> => {
      const current = ++call;
      active++;
      maximum = Math.max(maximum, active);
      event.emit({
        requestId: `request-${current}`,
        url: spec.url,
        redirectUrl: `https://stripe-upload-api.s3.region-${current}.amazonaws.com/file.pdf`,
        statusCode: 302,
      });
      if (current === 1) await firstGate;
      active--;
      return response(`https://stripe-upload-api.s3.region-${current}.amazonaws.com/file.pdf`);
    });
    const fetch = createDocumentProviderFetch(base, {
      redirectEvent: event,
      hasOrigins: async (values) => { origins.push(...values); return true; },
    });
    const url = "https://pay.stripe.com/invoice/acct/same/pdf";
    const first = fetch({ url }, {});
    const second = fetch({ url }, {});
    await vi.waitFor(() => expect(base).toHaveBeenCalledTimes(1));
    releaseFirst();
    await Promise.all([first, second]);

    expect(maximum).toBe(1);
    expect(origins).toEqual([
      "https://stripe-upload-api.s3.region-1.amazonaws.com/*",
      "https://stripe-upload-api.s3.region-2.amazonaws.com/*",
    ]);
    expect(event.listenerCount()).toBe(0);
  });
});

function fakeRedirectEvent(): RedirectEvent & { emit(details: RedirectEventDetails): void; listenerCount(): number } {
  const listeners = new Map<(details: RedirectEventDetails) => void, readonly string[]>();
  return {
    addListener(listener, filter) { listeners.set(listener, filter.urls); },
    removeListener(listener) { listeners.delete(listener); },
    emit(details) {
      for (const [listener, patterns] of listeners) {
        if (patterns.some((pattern) => patternOrigin(pattern) === new URL(details.url).origin)) listener(details);
      }
    },
    listenerCount: () => listeners.size,
  };
}

function patternOrigin(pattern: string): string {
  return new URL(pattern.slice(0, -2)).origin;
}

function response(url: string): HttpResponse {
  return {
    status: 200,
    ok: true,
    url,
    redirected: true,
    json: async () => ({}),
    arrayBuffer: async () => new TextEncoder().encode("%PDF").buffer,
    headers: { get: () => "application/pdf" },
  };
}
