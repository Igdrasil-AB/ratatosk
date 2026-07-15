import type { CapturedEntry } from "../../../src/core/recorder/types";
import { buildEntry } from "../../../src/core/recorder/cdp";
import type { StudioMessage, StudioResponse } from "./messaging";
import { isRecording, recordingProgress, startRecording, stopRecording } from "./recorder/orchestrator";
import { appendEntry, clearAllRecorderState, getCurrentTab } from "./recorder/session-store";

interface RecorderEntryMessage {
  type: "recorder:entry";
  entry: CapturedEntry;
}

chrome.runtime.onInstalled.addListener(() => {
  void clearAllRecorderState().finally(() => setRecordingBadge(false));
});
chrome.runtime.onStartup.addListener(() => {
  void clearAllRecorderState().finally(() => setRecordingBadge(false));
});

chrome.runtime.onMessage.addListener(
  (message: StudioMessage | RecorderEntryMessage, sender, sendResponse) => {
    if (message?.type === "recorder:entry") {
      void acceptRecorderEntry(sender, message.entry);
      sendResponse({ ok: true });
      return false;
    }
    if (!isTrustedExtensionPage(sender)) {
      sendResponse({ ok: false, error: "untrusted sender" } satisfies StudioResponse);
      return false;
    }
    handle(message as StudioMessage)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, error: "Studio could not complete that action" } satisfies StudioResponse));
    return true;
  },
);

function isTrustedExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  const ownOrigin = `chrome-extension://${chrome.runtime.id}/`;
  return sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(ownOrigin);
}

async function acceptRecorderEntry(sender: chrome.runtime.MessageSender, entry: unknown): Promise<void> {
  const tabId = sender.tab?.id;
  if (tabId === undefined || tabId !== (await getCurrentTab())) return;
  if (!entry || typeof entry !== "object") return;
  const raw = entry as CapturedEntry;
  if (
    typeof raw.url !== "string" || raw.url.length > 8192 ||
    typeof raw.method !== "string" || raw.method.length > 16 ||
    typeof raw.status !== "number" || !Number.isFinite(raw.status) ||
    typeof raw.contentType !== "string" || raw.contentType.length > 256 ||
    (raw.responseBody !== undefined && typeof raw.responseBody !== "string") ||
    (raw.requestBody !== undefined && typeof raw.requestBody !== "string")
  ) return;
  const requestHeaders = raw.requestHeaders && typeof raw.requestHeaders === "object"
    ? Object.fromEntries(Object.entries(raw.requestHeaders).filter(([key, value]) => key.length <= 256 && typeof value === "string"))
    : undefined;
  await appendEntry(tabId, buildEntry({
    url: raw.url,
    method: raw.method,
    status: raw.status,
    contentType: raw.contentType,
    body: raw.responseBody,
    requestBody: raw.requestBody,
    requestHeaders,
  }));
}

async function handle(message: StudioMessage): Promise<StudioResponse> {
  switch (message.type) {
    case "recorderStart": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) {
        return { ok: false, error: "Open an HTTPS billing page before recording" };
      }
      await startRecording(tab.id, tab.url, "deep");
      setRecordingBadge(true);
      return { ok: true };
    }
    case "recorderStop": {
      const result = await stopRecording();
      setRecordingBadge(false);
      return { ok: true, ...result };
    }
    case "recorderStatus":
      return { ok: true, recording: await isRecording() };
    case "recorderProgress":
      return { ok: true, progress: await recordingProgress() };
  }
}

function setRecordingBadge(on: boolean): void {
  void chrome.action.setBadgeText({ text: on ? "REC" : "" });
  if (on) void chrome.action.setBadgeBackgroundColor({ color: "#a5402c" });
}
