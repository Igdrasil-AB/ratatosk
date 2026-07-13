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
import { appendEntry, clearAllRecorderState, getCurrentTab } from "./recorder/session-store";
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
      void acceptRecorderEntry(sender, message.entry);
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

/**
 * Accept a captured entry ONLY from the tab that is actively recording, and only
 * if it is a well-formed object. The relay runs inside the page, so this gate
 * stops a stray or hostile tab from injecting entries into a live capture.
 */
async function acceptRecorderEntry(sender: chrome.runtime.MessageSender, entry: unknown): Promise<void> {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;
  if (tabId !== (await getCurrentTab())) return; // not the recording tab → drop
  if (!entry || typeof entry !== "object") return;
  await appendEntry(tabId, entry as CapturedEntry);
}

// --- External connect: the ONLY message path open to a web page --------------
// `externally_connectable` already restricts senders to accounting.igdrasil.se;
// we re-validate sender.origin here (defense in depth) before touching a token.
const ALLOWED_CONNECT_ORIGINS = new Set(["https://accounting.igdrasil.se"]);

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!sender.origin || !ALLOWED_CONNECT_ORIGINS.has(sender.origin)) {
    sendResponse({ ok: false, error: "origin not allowed" });
    return false;
  }
  handleExternal(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err) } satisfies Response));
  return true;
});

interface ConnectMessage {
  type: "igdrasil:connect";
  token: string;
  companyId: string;
  apiBaseUrl: string;
}

function isConnectMessage(m: unknown): m is ConnectMessage {
  const o = m as Partial<ConnectMessage> | null;
  return (
    !!o &&
    o.type === "igdrasil:connect" &&
    typeof o.token === "string" &&
    typeof o.companyId === "string" &&
    typeof o.apiBaseUrl === "string"
  );
}

/** True only for the Igdrasil backend itself — https and an `*.igdrasil.se` host. */
function isIgdrasilBackend(apiBaseUrl: string): boolean {
  try {
    const u = new URL(apiBaseUrl);
    return u.protocol === "https:" && (u.hostname === "igdrasil.se" || u.hostname.endsWith(".igdrasil.se"));
  } catch {
    return false;
  }
}

async function handleExternal(message: unknown): Promise<Response> {
  if (!isConnectMessage(message)) return { ok: false, error: "unsupported message" };
  if (!isIgdrasilBackend(message.apiBaseUrl)) return { ok: false, error: "backend host not allowed" };
  await setHostToken(message.token);
  await setSinkConfig({ kind: "igdrasil", endpoint: message.apiBaseUrl, companyId: message.companyId });
  return { ok: true };
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
