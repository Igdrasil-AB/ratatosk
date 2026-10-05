import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FEEDBACK_ORIGIN, FEEDBACK_URL, createFeedbackReport, deliverPendingFeedback,
  feedbackStatus, normalizeFeedbackNote, pendingFeedback, pendingFeedbackDecision, queueFeedback,
} from "../../collector/src/platform/feedback";

const collection = JSON.parse(readFileSync(new URL("../fixtures/ratatosk/feedback-collection.json", import.meta.url), "utf8"));
const discovery = JSON.parse(readFileSync(new URL("../fixtures/ratatosk/feedback-discovery.json", import.meta.url), "utf8"));
const stored = new Map<string, unknown>();
let granted = true;

beforeEach(() => {
  stored.clear();
  granted = true;
  vi.stubGlobal("chrome", {
    storage: { local: {
      get: async (key: string) => ({ [key]: stored.get(key) }),
      set: async (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) stored.set(key, value); },
      remove: async (key: string) => { stored.delete(key); },
    } },
    permissions: { contains: async ({ origins }: { origins: string[] }) => {
      expect(origins).toEqual([FEEDBACK_ORIGIN]);
      return granted;
    } },
  });
});

describe("reviewed feedback transport", () => {
  it("strips non-diagnostic canaries and rejects unsafe notes", () => {
    const diagnostic = { ...collection.diagnostic, rawCapture: "https://secret.invalid/?token=canary" };
    const report = createFeedbackReport("collection_failure", diagnostic, "  Invoices   are missing.  ");
    expect(report.note).toBe("Invoices are missing.");
    expect(JSON.stringify(report)).not.toContain("secret.invalid");
    const discoveryReport = createFeedbackReport("discovery", { ...discovery.diagnostic, rawUrl: "https://secret.invalid/" }, "");
    expect(JSON.stringify(discoveryReport)).not.toContain("rawUrl");
    expect(() => normalizeFeedbackNote("https://private.invalid/invoice/12345678")).toThrow();
    expect(() => normalizeFeedbackNote("Bearer secret-token")).toThrow();
  });

  it("reuses an unchanged pending report, creates a new ID for an edit, and preserves another report", () => {
    const first = createFeedbackReport("collection_failure", collection.diagnostic, "Initial note");
    const repeat = createFeedbackReport("collection_failure", collection.diagnostic, "Initial note");
    const edit = createFeedbackReport("collection_failure", collection.diagnostic, "Edited note");
    const other = createFeedbackReport("discovery", discovery.diagnostic, "");
    expect(pendingFeedbackDecision(first, repeat)).toBe("reuse");
    expect(pendingFeedbackDecision(first, edit)).toBe("replace");
    expect(pendingFeedbackDecision(first, other)).toBe("blocked");
  });

  it("uses one exact ID and body across an interrupted send and manual retry", async () => {
    const report = createFeedbackReport("collection_failure", collection.diagnostic, "Missing September invoices");
    await queueFeedback(report);
    const first = await deliverPendingFeedback(async () => { throw new Error("offline"); });
    expect(first).toEqual({ state: "retryable", reportId: report.reportId });
    expect((await pendingFeedback())?.reportId).toBe(report.reportId);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await deliverPendingFeedback(async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return Response.json({ receipt: { reportId: report.reportId, acceptedAt: "2026-09-30T12:00:00.000Z", status: "received" } }, { status: 200 });
    });
    expect(result?.state).toBe("received");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(FEEDBACK_URL);
    expect(calls[0].init.redirect).toBe("error");
    expect(calls[0].init.credentials).toBe("omit");
    expect((calls[0].init.headers as Record<string, string>)["Idempotency-Key"]).toBe(report.reportId);
    expect(calls[0].init.body).toBe(JSON.stringify(report));
    expect(await pendingFeedback()).toBeNull();
    expect((await feedbackStatus()).receipt?.reportId).toBe(report.reportId);
  });

  it("keeps a rejected report local and never sends without exact permission", async () => {
    const report = createFeedbackReport("discovery", discovery.diagnostic, "");
    await queueFeedback(report);
    granted = false;
    const blocked = await deliverPendingFeedback(async () => { throw new Error("must not send"); });
    expect(blocked).toEqual({ state: "permission_required", reportId: report.reportId });
    granted = true;
    const rejected = await deliverPendingFeedback(async () => new Response(null, { status: 400 }));
    expect(rejected).toEqual({ state: "rejected", reportId: report.reportId });
    expect((await feedbackStatus()).pending?.reportId).toBe(report.reportId);
  });

  it("keeps one pending ID after rate limits and service errors", async () => {
    const report = createFeedbackReport("collection_failure", collection.diagnostic, "");
    await queueFeedback(report);
    for (const status of [429, 503]) {
      expect(await deliverPendingFeedback(async () => new Response(null, { status })))
        .toEqual({ state: "retryable", reportId: report.reportId });
      expect((await pendingFeedback())?.reportId).toBe(report.reportId);
    }
  });
});
