/**
 * Service-worker entry point — the extension's only long-lived wiring.
 *
 * It does no business logic itself; it routes browser events to the collector
 * and the popup:
 *   - worker boot/startup     → reconcile persisted schedule and catch up
 *   - onAlarm                 → run due connected vendors
 *   - onMessage               → handle popup commands
 *   - notifications.onClicked → open the vendor login on a "reconnect" nudge
 */
import { getVendor, VENDORS, VENDOR_LIFECYCLE_BY_ID } from "../../../src/vendors";
import { isLifecycleRunnable } from "../../../src/vendors/lifecycle";
import { getScheduleInfo, isSyncAlarm, setSchedulePeriod } from "./scheduler";
import { requestSync } from "./sync-coordinator";
import { hasVendorPermissions, revokeVendorPermissions } from "./permissions";
import { notifyReconnect, openLoginFor } from "./notifications";
import {
  clearSeenForSource,
  clearLedgerForVendor,
  clearSinkConfig,
  getConnections,
  getLedger,
  getSinkConfig,
  removeConnection,
  setSinkConfig,
  upsertConnection,
} from "./storage";
import { clearHostToken, getHostToken, setHostToken } from "./auth";
import { clearPendingConnect, getPendingConnect, setPendingConnect } from "./pending-connect";
import { revealPopupAfterConnect } from "./popup-handoff";
import {
  consumeIgdrasilConnectIntent,
  createIgdrasilConnectIntent,
  validateIgdrasilConnectIntent,
} from "./igdrasil-connect-intent";
import type { Message, Response, SourceView } from "./messaging";
import pkg from "../../../package.json";
import { buildCollectorDiagnostic } from "./diagnostics";

chrome.runtime.onInstalled.addListener(() => {
  void runBackgroundSync("startup");
});
chrome.runtime.onStartup.addListener(() => {
  void runBackgroundSync("startup");
});

// MV3 workers may be recreated without an install or browser-start event. Check
// the persisted schedule on every worker boot so a missing alarm cannot strand
// background collection.
void runBackgroundSync("startup");

chrome.alarms.onAlarm.addListener((alarm) => {
  if (isSyncAlarm(alarm.name)) void runBackgroundSync("alarm");
});

chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith("reconnect:")) {
    const recipe = getVendor(id.slice("reconnect:".length));
    if (recipe) openLoginFor(recipe);
  }
});

// The native optional-host prompt may close the action popup. Finish a fresh,
// validated handoff here so connection setup no longer depends on that popup
// JavaScript context surviving the browser-owned dialog.
chrome.permissions.onAdded.addListener((permissions) => {
  if (permissions.origins?.length) {
    void (async () => {
      const completed = await completePendingConnect(permissions.origins!);
      if (completed) await revealPopupAfterConnect();
    })().catch((error) => {
      console.error("[collector] pending vendor connection failed", error);
    });
  }
});

chrome.runtime.onMessage.addListener(
  (message: Message | AppRequest, sender, sendResponse) => {
    // Connect handshake relayed by the bridge content script on the Igdrasil origin.
    if (isAppRequest(message)) {
      handleAppRequest(message, sender)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    // Consumer commands are accepted only from an extension page (the popup),
    // never from a content script running in a web tab.
    if (!isTrustedExtensionPage(sender)) {
      sendResponse({ ok: false, error: "untrusted sender" } satisfies Response);
      return false;
    }
    handle(message as Message)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err) } satisfies Response));
    return true; // keep the channel open for the async response
  },
);

function isTrustedExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  const ownOrigin = `chrome-extension://${chrome.runtime.id}/`;
  return sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(ownOrigin);
}

// --- Connect handshake (relayed by the bridge content script) ----------------
// The bridge (`connect-bridge.ts`) runs only on the Igdrasil origin; we STILL
// re-validate here that the message came from OUR content script on an
// allow-listed origin before touching a token — defense in depth.
const ALLOWED_CONNECT_ORIGINS = new Set(["https://accounting.igdrasil.se"]);

type AppRequest =
  | { type: "igdrasil:prepare" }
  | { type: "igdrasil:validate"; state: string }
  | { type: "igdrasil:connect"; token: string; companyId: string; apiBaseUrl: string; state: string }
  | { type: "igdrasil:status" }
  | { type: "igdrasil:disconnect" };

type AppResponse = { ok: true; connected?: boolean; companyId?: string; state?: string } | { ok: false; error: string };

function isAppRequest(m: unknown): m is AppRequest {
  const t = (m as { type?: unknown } | null)?.type;
  return t === "igdrasil:prepare" || t === "igdrasil:validate" || t === "igdrasil:connect" || t === "igdrasil:status" || t === "igdrasil:disconnect";
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
    case "igdrasil:prepare": {
      const intent = await createIgdrasilConnectIntent();
      return { ok: true, state: intent.state };
    }
    case "igdrasil:validate": {
      if (typeof message.state !== "string") return { ok: false, error: "invalid connection request" };
      const valid = await validateIgdrasilConnectIntent(message.state);
      return valid ? { ok: true } : { ok: false, error: "connection request expired; start again from Ratatosk" };
    }
    case "igdrasil:connect": {
      const { token, companyId, apiBaseUrl, state } = message;
      if (typeof token !== "string" || typeof companyId !== "string" || typeof apiBaseUrl !== "string" || typeof state !== "string") {
        return { ok: false, error: "invalid connect payload" };
      }
      if (!isIgdrasilBackend(apiBaseUrl)) return { ok: false, error: "backend host not allowed" };
      if (!(await consumeIgdrasilConnectIntent(state))) {
        return { ok: false, error: "connection request expired; start again from Ratatosk" };
      }
      await setHostToken(token);
      try {
        await setSinkConfig({ kind: "igdrasil", endpoint: apiBaseUrl, companyId });
      } catch (error) {
        await clearHostToken();
        throw error;
      }
      return { ok: true };
    }
    case "igdrasil:status": {
      const cfg = await getSinkConfig();
      const connected = cfg?.kind === "igdrasil" && !!(await getHostToken());
      return { ok: true, connected, companyId: cfg?.kind === "igdrasil" ? cfg.companyId : undefined };
    }
    case "igdrasil:disconnect": {
      const cfg = await getSinkConfig();
      const token = await getHostToken();
      if (cfg?.kind === "igdrasil" && token) {
        const response = await fetch(`${cfg.endpoint.replace(/\/+$/, "")}/documents/ingest/token`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Company-Id": cfg.companyId,
          },
        });
        if (!response.ok && response.status !== 401) {
          return { ok: false, error: "could not revoke the Igdrasil connection; try again" };
        }
      }
      await clearHostToken();
      await clearSinkConfig();
      return { ok: true };
    }
  }
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
        hosts: [...v.hosts],
        lifecycle: VENDOR_LIFECYCLE_BY_ID[v.id],
        runnable: isLifecycleRunnable(VENDOR_LIFECYCLE_BY_ID[v.id]),
        connection: connections[v.id] ?? null,
      }));
      return { ok: true, sources };
    }

    case "getConfig":
      return { ok: true, config: (await getSinkConfig()) ?? null };

    case "setConfig":
      await setSinkConfig(message.config);
      return { ok: true };

    case "beginIgdrasilConnect": {
      const intent = await createIgdrasilConnectIntent();
      return { ok: true, connectUrl: intent.url };
    }

    case "beginConnect": {
      const recipe = getVendor(message.vendorId);
      if (!recipe) return { ok: false, error: "Unknown vendor." };
      if (!(await getSinkConfig())) return { ok: false, error: "Choose a destination before connecting a vendor." };
      await setPendingConnect(recipe.id, recipe.hosts);
      return { ok: true };
    }

    case "cancelConnect":
      await clearPendingConnect(message.vendorId);
      return { ok: true };

    case "completeConnect": {
      const pending = await getPendingConnect();
      if (!pending || pending.vendorId !== message.vendorId) {
        const connection = (await getConnections())[message.vendorId];
        return connection
          ? { ok: true, summaries: [] }
          : { ok: false, error: "The connection request expired. Select Connect again." };
      }
      return completeVendorConnect(message.vendorId);
    }

    case "connect": {
      // Kept for compatible callers; new popup flows use begin/complete so the
      // browser may safely destroy the popup during its permission prompt.
      return completeVendorConnect(message.vendorId);
    }

    case "disconnect": {
      const recipe = getVendor(message.vendorId);
      await removeConnection(message.vendorId);
      await clearSeenForSource(`ext:${message.vendorId}`); // forget its history → reconnect re-fetches
      await clearLedgerForVendor(message.vendorId);
      if (recipe) await revokeVendorPermissions(recipe);
      return { ok: true };
    }

    case "runNow": {
      if (message.vendorId) {
        // Background contexts cannot open permission prompts. If a recipe gains
        // hosts, send the user back through Connect rather than silently failing.
        const recipe = getVendor(message.vendorId);
        if (recipe && !(await hasVendorPermissions(recipe))) {
          return { ok: false, error: "vendor access changed; reconnect this vendor" };
        }
        return { ok: true, summaries: await requestSync({ trigger: "manual", vendorId: message.vendorId }) };
      }
      return { ok: true, summaries: await requestSync({ trigger: "manual" }) };
    }

    case "getVendorDiagnostic": {
      const lifecycle = VENDOR_LIFECYCLE_BY_ID[message.vendorId];
      if (!lifecycle) return { ok: false, error: "Unknown vendor." };
      const connection = (await getConnections())[message.vendorId];
      return {
        ok: true,
        diagnostic: buildCollectorDiagnostic({
          vendorId: message.vendorId,
          collectorVersion: pkg.version,
          lifecycleRevision: lifecycle.recipeRevision,
          connection,
        }),
      };
    }

    case "getLedger":
      return { ok: true, ledger: await getLedger() };

    case "getSchedule":
      return { ok: true, schedule: await getScheduleInfo() };

    case "setSchedule":
      await setSchedulePeriod(message.periodMinutes);
      return { ok: true, schedule: await getScheduleInfo() };
  }
}

const connectionInFlight = new Map<string, Promise<Response>>();

async function completePendingConnect(addedOrigins: readonly string[]): Promise<boolean> {
  const pending = await getPendingConnect();
  if (!pending || !pending.origins.some((origin) => addedOrigins.includes(origin))) return false;

  const recipe = getVendor(pending.vendorId);
  if (!recipe || !sameOrigins(pending.origins, recipe.hosts)) {
    await clearPendingConnect(pending.vendorId);
    return false;
  }
  if (!(await hasVendorPermissions(recipe))) return false;
  await completeVendorConnect(recipe.id);
  return true;
}

function completeVendorConnect(vendorId: string): Promise<Response> {
  const existing = connectionInFlight.get(vendorId);
  if (existing) return existing;

  const task = (async (): Promise<Response> => {
    const recipe = getVendor(vendorId);
    if (!recipe) return { ok: false, error: "Unknown vendor." };
    if (!(await getSinkConfig())) return { ok: false, error: "Choose a destination before connecting a vendor." };
    if (!(await hasVendorPermissions(recipe))) return { ok: false, error: "Vendor access was not granted." };

    await clearPendingConnect(recipe.id);
    await upsertConnection({ vendorId: recipe.id, connectedAt: Date.now() });

    const [summary] = await requestSync({ trigger: "connect", vendorId: recipe.id });
    if (!summary) return { ok: false, error: "Vendor collection did not start." };
    if (summary.status === "auth_expired") notifyReconnect(recipe);
    return { ok: true, summaries: [summary] };
  })().finally(() => connectionInFlight.delete(vendorId));

  connectionInFlight.set(vendorId, task);
  return task;
}

async function runBackgroundSync(trigger: "alarm" | "startup"): Promise<void> {
  try {
    await requestSync({ trigger });
  } catch (error) {
    console.error("[collector] scheduled sync failed", error);
  }
}

function sameOrigins(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((origin) => right.includes(origin));
}
