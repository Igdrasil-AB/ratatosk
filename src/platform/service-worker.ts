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
import { clearHostToken, getHostToken, setHostToken } from "./auth";
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
  (message: Message | RecorderEntryMessage | AppRequest, sender, sendResponse) => {
    // Captured entries stream in from the page's content-script relay (not the popup).
    if (message?.type === "recorder:entry") {
      void acceptRecorderEntry(sender, (message as RecorderEntryMessage).entry);
      sendResponse({ ok: true });
      return false;
    }
    // Connect handshake relayed by the bridge content script on the Igdrasil origin.
    if (isAppRequest(message)) {
      handleAppRequest(message, sender)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    handle(message as Message)
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

// --- Connect handshake (relayed by the bridge content script) ----------------
// The bridge (`connect-bridge.ts`) runs only on the Igdrasil origin; we STILL
// re-validate here that the message came from OUR content script on an
// allow-listed origin before touching a token — defense in depth.
const ALLOWED_CONNECT_ORIGINS = new Set(["https://accounting.igdrasil.se"]);

type AppRequest =
  | { type: "igdrasil:connect"; token: string; companyId: string; apiBaseUrl: string }
  | { type: "igdrasil:status" }
  | { type: "igdrasil:disconnect" };

type AppResponse = { ok: true; connected?: boolean; companyId?: string } | { ok: false; error: string };

function isAppRequest(m: unknown): m is AppRequest {
  const t = (m as { type?: unknown } | null)?.type;
  return t === "igdrasil:connect" || t === "igdrasil:status" || t === "igdrasil:disconnect";
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

async function handleAppRequest(message: AppRequest, sender: chrome.runtime.MessageSender): Promise<AppResponse> {
  // It must be OUR own content script, running on an allow-listed page origin.
  if (sender.id !== chrome.runtime.id) return { ok: false, error: "bad sender" };
  if (!sender.origin || !ALLOWED_CONNECT_ORIGINS.has(sender.origin)) return { ok: false, error: "origin not allowed" };

  switch (message.type) {
    case "igdrasil:connect": {
      const { token, companyId, apiBaseUrl } = message;
      if (typeof token !== "string" || typeof companyId !== "string" || typeof apiBaseUrl !== "string") {
        return { ok: false, error: "invalid connect payload" };
      }
      if (!isIgdrasilBackend(apiBaseUrl)) return { ok: false, error: "backend host not allowed" };
      await setHostToken(token);
      await setSinkConfig({ kind: "igdrasil", endpoint: apiBaseUrl, companyId });
      return { ok: true };
    }
    case "igdrasil:status": {
      const cfg = await getSinkConfig();
      const connected = cfg?.kind === "igdrasil" && !!(await getHostToken());
      return { ok: true, connected, companyId: cfg?.kind === "igdrasil" ? cfg.companyId : undefined };
    }
    case "igdrasil:disconnect": {
      await clearHostToken();
      await setSinkConfig({ kind: "filesystem", rootFolder: "InvoiceCollector", dateMode: "extraction" });
      return { ok: true };
    }
  }
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
