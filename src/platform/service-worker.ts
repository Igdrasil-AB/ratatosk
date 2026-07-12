/**
 * Service-worker entry point — the extension's only long-lived wiring.
 *
 * It does no business logic itself; it routes browser events to the collector
 * and the popup:
 *   - onInstalled / onStartup → make sure the sync alarm exists
 *   - onAlarm                 → run every connected vendor
 *   - onMessage               → handle popup commands
 *   - notifications.onClicked → open the vendor login on a "reconnect" nudge
 */
import { getVendor, VENDORS } from "../vendors";
import { runAllConnected, runVendorById } from "./collector";
import { ensureSyncAlarm, getScheduleInfo, isSyncAlarm, setSchedulePeriod } from "./scheduler";
import { ensureVendorPermissions, requestVendorPermissions, revokeVendorPermissions } from "./permissions";
import { notifyReconnect, openLoginFor } from "./notifications";
import {
  clearSeenForSource,
  getConnections,
  getLedger,
  getSinkConfig,
  removeConnection,
  setSinkConfig,
  upsertConnection,
} from "./storage";
import { setHostToken } from "./auth";
import { isRecording, recordingProgress, startRecording, stopRecording } from "./recorder/orchestrator";
import { appendEntry, clearAllRecorderState } from "./recorder/session-store";
import type { CapturedEntry } from "../core/recorder/types";
import type { Message, Response, SourceView } from "./messaging";

chrome.runtime.onInstalled.addListener(async () => {
  ensureSyncAlarm();
  await clearAllRecorderState(); // a reload shouldn't inherit a half-finished recording
  setRecordingBadge(false);
  // Default the OSS build to saving into a Downloads subfolder.
  if (!(await getSinkConfig())) {
    await setSinkConfig({ kind: "filesystem", rootFolder: "InvoiceCollector", dateMode: "extraction" });
  }
});
chrome.runtime.onStartup.addListener(async () => {
  ensureSyncAlarm();
  await clearAllRecorderState();
  setRecordingBadge(false);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (isSyncAlarm(alarm.name)) void runAllConnected();
});

chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith("reconnect:")) {
    const recipe = getVendor(id.slice("reconnect:".length));
    if (recipe) openLoginFor(recipe);
  }
});

chrome.runtime.onMessage.addListener(
  (message: Message | RecorderEntryMessage, sender, sendResponse) => {
    // Captured entries stream in from the page's content-script relay (not the popup).
    if (message?.type === "recorder:entry") {
      if (sender.tab?.id !== undefined) void appendEntry(sender.tab.id, message.entry);
      sendResponse({ ok: true });
      return false;
    }
    handle(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err) } satisfies Response));
    return true; // keep the channel open for the async response
  },
);

interface RecorderEntryMessage {
  type: "recorder:entry";
  entry: CapturedEntry;
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function handle(message: Message): Promise<Response> {
  switch (message.type) {
    case "listSources": {
      const connections = await getConnections();
      const sources: SourceView[] = VENDORS.map((v) => ({
        id: v.id,
        name: v.name,
        category: v.category,
        icon: v.icon,
        connection: connections[v.id] ?? null,
      }));
      return { ok: true, sources };
    }

    case "getConfig":
      return { ok: true, config: (await getSinkConfig()) ?? null };

    case "setConfig":
      await setSinkConfig(message.config);
      return { ok: true };

    case "setToken":
      await setHostToken(message.token);
      return { ok: true };

    case "connect": {
      const recipe = getVendor(message.vendorId);
      if (!recipe) return { ok: false, error: "unknown vendor" };

      const granted = await requestVendorPermissions(recipe);
      if (!granted) return { ok: false, error: "host permission denied" };

      await upsertConnection({ vendorId: recipe.id, connectedAt: Date.now() });

      // First run right away; if the session isn't live yet, the collector will
      // fire a reconnect nudge rather than fail hard.
      const summary = await runVendorById(recipe.id);
      if (summary.status === "auth_expired") notifyReconnect(recipe);
      return { ok: true, summaries: [summary] };
    }

    case "disconnect": {
      const recipe = getVendor(message.vendorId);
      await removeConnection(message.vendorId);
      await clearSeenForSource(`ext:${message.vendorId}`); // forget its history → reconnect re-fetches
      if (recipe) await revokeVendorPermissions(recipe);
      return { ok: true };
    }

    case "runNow": {
      if (message.vendorId) {
        // A recipe may have gained hosts since it was connected — grant any missing.
        const recipe = getVendor(message.vendorId);
        if (recipe) await ensureVendorPermissions(recipe);
        return { ok: true, summaries: [await runVendorById(message.vendorId)] };
      }
      return { ok: true, summaries: await runAllConnected() };
    }

    case "recorderStart": {
      const tab = await activeTab();
      if (!tab?.id || !tab.url) return { ok: false, error: "no active tab to record" };
      await startRecording(tab.id, tab.url, message.mode);
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

    case "getLedger":
      return { ok: true, ledger: await getLedger() };

    case "getSchedule":
      return { ok: true, schedule: await getScheduleInfo() };

    case "setSchedule":
      await setSchedulePeriod(message.periodMinutes);
      return { ok: true, schedule: await getScheduleInfo() };
  }
}

/** A visible cue that recording is live, even when the popup is closed. */
function setRecordingBadge(on: boolean): void {
  chrome.action.setBadgeText({ text: on ? "REC" : "" });
  if (on) chrome.action.setBadgeBackgroundColor({ color: "#a5402c" });
}
