import type { StudioMessage, StudioResponse } from "./messaging";
import { isRecording, recordingProgress, startRecording, stopRecording } from "./recorder/orchestrator";
import { CaptureRecoveryError, CaptureStorageError, clearAllRecorderState } from "./recorder/session-store";
import { approveSupplierFingerprint } from "../../../src/core/recorder/supplier-fingerprint";
import {
  clearFingerprintOutbox,
  deliverFingerprintSubmission,
  enqueueFingerprintSubmission,
  fingerprintOutboxStatus,
  getFingerprintOutboxSubmission,
  listFingerprintOutboxItems,
  requeueRejectedFingerprintSubmissions,
} from "./fingerprint-outbox";
import { disconnectSvalaFingerprintTransport, pairSvalaFingerprintTransport } from "./fingerprint-transport";
import { isSecureRecordingPage } from "./recording-page";
import { RecorderCommandQueue } from "./recorder-command-queue";

const recorderCommands = new RecorderCommandQueue();

chrome.runtime.onInstalled.addListener(() => {
  void Promise.all([clearAllRecorderState(), fingerprintOutboxStatus()]).finally(() => setRecordingBadge(false));
});
chrome.runtime.onStartup.addListener(() => {
  // Startup may recover local state, but it must never turn a prior approval
  // into a network delivery. Delivery remains an explicit popup action.
  void Promise.all([clearAllRecorderState(), fingerprintOutboxStatus()]).finally(() => setRecordingBadge(false));
});

chrome.runtime.onMessage.addListener(
  (message: StudioMessage, sender, sendResponse) => {
    if (!isTrustedExtensionPage(sender)) {
      sendResponse({ ok: false, error: "untrusted sender" } satisfies StudioResponse);
      return false;
    }
    const studioMessage = message as StudioMessage;
    const response = studioMessage.type === "recorderStart" || studioMessage.type === "recorderStop"
      ? recorderCommands.run(() => handle(studioMessage))
      : handle(studioMessage);
    response
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof CaptureStorageError
          ? "Capture storage failed; the recording was discarded as incomplete"
          : error instanceof CaptureRecoveryError
            ? "The recorder restarted; the incomplete recording was discarded. Please retry."
          : "Studio could not complete that action",
      } satisfies StudioResponse));
    return true;
  },
);

function isTrustedExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  const ownOrigin = `chrome-extension://${chrome.runtime.id}/`;
  return sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(ownOrigin);
}

async function handle(message: StudioMessage): Promise<StudioResponse> {
  switch (message.type) {
    case "recorderStart": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !isSecureRecordingPage(tab.url)) {
        return { ok: false, error: "Open an HTTPS billing page before recording" };
      }
      await startRecording(tab.id, tab.url, "deep");
      setRecordingBadge(true);
      return { ok: true };
    }
    case "recorderStop": {
      try {
        const result = await stopRecording();
        return { ok: true, ...result };
      } finally {
        setRecordingBadge(false);
      }
    }
    case "recorderStatus":
      return { ok: true, recording: await isRecording() };
    case "recorderProgress":
      return { ok: true, progress: await recordingProgress() };
    case "fingerprintApprove": {
      const submission = approveSupplierFingerprint({
        fingerprint: message.fingerprint,
        approvedAt: new Date().toISOString(),
        authorityConfirmed: message.authorityConfirmed,
        shareApproved: message.shareApproved,
      });
      return { ok: true, submission, outbox: await enqueueFingerprintSubmission(submission) };
    }
    case "fingerprintOutboxStatus":
      return { ok: true, outbox: await fingerprintOutboxStatus() };
    case "fingerprintOutboxList":
      return { ok: true, items: await listFingerprintOutboxItems() };
    case "fingerprintOutboxGet": {
      const submission = await getFingerprintOutboxSubmission(message.fingerprintId);
      return submission
        ? { ok: true, submission }
        : { ok: false, error: "That saved fingerprint is missing, expired, or invalid." };
    }
    case "fingerprintDeliver": {
      const item = await deliverFingerprintSubmission(message.fingerprintId);
      return item
        ? { ok: true, item }
        : { ok: false, error: "That saved fingerprint is missing, expired, or invalid." };
    }
    case "fingerprintPair":
      await pairSvalaFingerprintTransport(message.token);
      return { ok: true, outbox: await requeueRejectedFingerprintSubmissions() };
    case "fingerprintDisconnect":
      await disconnectSvalaFingerprintTransport();
      return { ok: true, outbox: await fingerprintOutboxStatus() };
    case "fingerprintClearOutbox":
      return { ok: true, outbox: await clearFingerprintOutbox() };
  }
}

function setRecordingBadge(on: boolean): void {
  void chrome.action.setBadgeText({ text: on ? "REC" : "" });
  if (on) void chrome.action.setBadgeBackgroundColor({ color: "#a5402c" });
}
