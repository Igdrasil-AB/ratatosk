/**
 * Service-worker entry point — the extension's only long-lived wiring.
 *
 * It does no business logic itself; it routes browser events to the collector
 * and the persistent side panel:
 *   - onInstalled / onStartup → make sure the sync alarm exists
 *   - onAlarm                 → run every connected vendor
 *   - onMessage               → handle popup commands
 *   - notifications.onClicked → open the vendor login on a "reconnect" nudge
 */
import { isLifecycleRunnable } from "../../../src/vendors/lifecycle";
import { runAllConnected, runDiscoveredCandidate, runVendorById } from "./collector";
import { ensureSyncAlarm, getScheduleInfo, isSyncAlarm, isSyncCatchUpDue, setSchedulePeriod } from "./scheduler";
import { hasHostPermissions, missingHostPermissions, revokeHostPermissions, vendorPermissionOrigins } from "./permissions";
import { notifyReconnect, openLoginFor } from "./notifications";
import {
  clearSeenForSource,
  clearLedgerForVendor,
  getConnections,
  getLedger,
  getSinkConfig,
  removeConnection,
  setSinkConfig,
  upsertConnection,
} from "./storage";
import { clearHostToken, getHostToken, initializeHostTokenStorage, setHostToken } from "./auth";
import { clearFilesystemDeliveryJournalForSource } from "./filesystem-sink";
import { clearPendingConnect, getPendingConnect, setPendingConnect } from "./pending-connect";
import { configureSidePanelAction } from "./side-panel";
import {
  consumeIgdrasilConnectIntent,
  createIgdrasilConnectIntent,
  validateIgdrasilConnectIntent,
} from "./igdrasil-connect-intent";
import type { Message, Response, SourceView } from "./messaging";
import pkg from "../../../package.json";
import { buildCollectorDiagnostic } from "./diagnostics";
import { discoverSupplierInTab, removeStaleDiscoveryObserverRegistration, SupplierDiscoveryError } from "./discovery";
import {
  beginSupplierDiscovery,
  beginSupplierDiscoveryConnect,
  cancelSupplierDiscovery,
  checkpointSupplierDiscovery,
  clearSupplierDiscovery,
  completeSupplierDiscovery,
  DISCOVERY_FAILURE_MESSAGES,
  failSupplierDiscovery,
  getPendingSupplierDiscoveryConnect,
  getPendingSupplierDiscoveryDiagnostic,
  getSupplierDiscoveryDiagnostic,
  getSupplierDiscoveryStatus,
  markSupplierDiscoveryScanning,
  restoreSupplierDiscoveryPreview,
  requireSupplierDiscoveryDocumentOrigins,
  setSupplierDiscoveryPreview,
} from "./discovery-state";
import {
  assertDiscoveredSupplierCapacity,
  DiscoveredSupplierCapacityError,
  removeDiscoveredSupplier,
  upsertDiscoveredSupplier,
} from "./discovered-suppliers";
import { listCollectorSources, resolveCollectorSource } from "./source-catalog";
import { formatCollectorRuntimeIdentity } from "./collector-runtime-identity";
import { operationalOutcomeLabel } from "../../../src/core/errors";
import { requiredCandidateOrigins } from "../../../src/core/discovery";
import { collectFirstWorkingCandidate } from "./discovery-candidates";
import { withCandidateVerification } from "./discovery-diagnostic";
import { canContinueSupplierDiscovery } from "./discovery-continuation";
import { CollectionRunCoordinator } from "../../../src/core/concurrency";
import { isIgdrasilApiBase } from "../../../src/ingest/igdrasil-sink";
import { disconnectIgdrasil } from "./igdrasil-disconnect";

console.info(`[collector] ready ${formatCollectorRuntimeIdentity()}`);
void initializeHostTokenStorage().catch((error: unknown) => {
  // Credential operations fail closed until Chrome confirms this access level.
  console.error("[collector] credential storage hardening failed", error instanceof Error ? error.name : "error");
});

const collectionRuns = new CollectionRunCoordinator();

chrome.runtime.onInstalled.addListener(() => {
  void ensureSyncAlarm().catch((error) => {
    console.error("[collector] schedule initialization failed", error instanceof Error ? error.name : "unknown");
  });
  void removeStaleDiscoveryObserverRegistration();
  void configureSidePanelAction();
});
chrome.runtime.onStartup.addListener(() => {
  void resumeScheduledSync().catch((error) => {
    console.error("[collector] startup sync recovery failed", error instanceof Error ? error.name : "unknown");
  });
  void removeStaleDiscoveryObserverRegistration();
  void configureSidePanelAction();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (isSyncAlarm(alarm.name)) {
    void collectionRuns.runScheduled(() => runAllConnected()).then((summaries) => {
      if (summaries === undefined) console.info("[collector] scheduled sync already queued");
    }).catch((error) => {
      console.error("[collector] scheduled sync failed", error instanceof Error ? error.name : "unknown");
    });
  }
});

async function resumeScheduledSync(): Promise<void> {
  await ensureSyncAlarm();
  const [schedule, connections] = await Promise.all([getScheduleInfo(), getConnections()]);
  if (isSyncCatchUpDue(connections, schedule.periodMinutes)) {
    await collectionRuns.runScheduled(() => runAllConnected());
  }
}

chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith("reconnect:")) {
    void resolveCollectorSource(id.slice("reconnect:".length)).then((source) => {
      if (source) openLoginFor(source.recipe);
    });
  }
});

// Finish a fresh, validated handoff in the worker so connection setup does not
// depend on any extension-page JavaScript context surviving the browser-owned
// permission dialog. The side panel itself remains visible throughout.
chrome.permissions.onAdded.addListener((permissions) => {
  if (permissions.origins?.length) {
    void (async () => {
      const completed = await completePendingConnect(permissions.origins!);
      const discovered = await completePendingDiscoveryPermission(permissions.origins!);
      if (completed || discovered) console.info("[collector] permission handoff completed");
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
      if (!isIgdrasilApiBase(apiBaseUrl)) return { ok: false, error: "backend host not allowed" };
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
      return disconnectIgdrasil();
    }
  }
}

async function handle(message: Message): Promise<Response> {
  switch (message.type) {
    case "listSources": {
      const connections = await getConnections();
      const sources: SourceView[] = await Promise.all((await listCollectorSources()).map(async (source) => {
        const connection = connections[source.recipe.id] ?? null;
        const hosts = vendorPermissionOrigins(source.recipe, connection);
        return {
          kind: source.kind,
          id: source.recipe.id,
          name: source.recipe.name,
          category: source.recipe.category,
          icon: source.presentationIcon ?? source.recipe.icon,
          hosts,
          missingHosts: connection ? await missingHostPermissions(hosts) : [],
          lifecycle: source.lifecycle,
          primaryOrigin: source.primaryOrigin,
          runnable: source.kind === "discovered" || Boolean(source.lifecycle && isLifecycleRunnable(source.lifecycle)),
          connection,
        };
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
      const recipe = (await resolveCollectorSource(message.vendorId))?.recipe;
      if (!recipe) return { ok: false, error: "Unknown vendor." };
      if (!(await getSinkConfig())) return { ok: false, error: "Choose a destination before connecting a vendor." };
      const connection = (await getConnections())[recipe.id];
      await setPendingConnect(recipe.id, vendorPermissionOrigins(recipe, connection));
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
      // A run records its result into the connection at completion. Queue the
      // destructive lifecycle transition behind that run so it cannot recreate
      // a supplier the user just disconnected.
      return collectionRuns.runInteractive(async () => {
        const source = await resolveCollectorSource(message.vendorId);
        const recipe = source?.recipe;
        const connection = (await getConnections())[message.vendorId];
        await removeConnection(message.vendorId);
        if (source?.kind === "discovered") await removeDiscoveredSupplier(message.vendorId);
        if (recipe) await revokeUnusedPermissions(vendorPermissionOrigins(recipe, connection));
        return { ok: true };
      });
    }

    case "forgetVendorHistory":
      // Serialize the reset with collection so a finishing run cannot recreate
      // history immediately after the user clears it.
      return collectionRuns.runInteractive(async () => {
        const source = `ext:${message.vendorId}`;
        await Promise.all([
          clearSeenForSource(source),
          clearLedgerForVendor(message.vendorId),
          clearFilesystemDeliveryJournalForSource(source),
        ]);
        return { ok: true };
      });

    case "runNow": {
      if (message.vendorId) {
        // Background contexts cannot open permission prompts. If a recipe gains
        // hosts, send the user back through Connect rather than silently failing.
        const recipe = (await resolveCollectorSource(message.vendorId))?.recipe;
        const connection = (await getConnections())[message.vendorId];
        if (recipe && !(await hasHostPermissions(vendorPermissionOrigins(recipe, connection)))) {
          return { ok: false, error: "vendor access changed; reconnect this vendor" };
        }
        const summary = await collectionRuns.runInteractive(() => runVendorById(message.vendorId!));
        return { ok: true, summaries: [summary] };
      }
      return { ok: true, summaries: await collectionRuns.runInteractive(() => runAllConnected()) };
    }

    case "getVendorDiagnostic": {
      const source = await resolveCollectorSource(message.vendorId);
      if (!source) return { ok: false, error: "Unknown vendor." };
      const connection = (await getConnections())[message.vendorId];
      return {
        ok: true,
        diagnostic: buildCollectorDiagnostic({
          vendorId: message.vendorId,
          collectorVersion: pkg.version,
          lifecycleRevision: source.lifecycle?.recipeRevision ?? "local-discovery-v1",
          connection,
        }),
      };
    }

    case "getDiscoveryStatus":
      return { ok: true, discovery: await getSupplierDiscoveryStatus() };

    case "getDiscoveryDiagnostic": {
      const diagnostic = await getSupplierDiscoveryDiagnostic();
      return diagnostic
        ? { ok: true, discoveryDiagnostic: diagnostic }
        : { ok: false, error: "No discovery diagnostic is available." };
    }

    case "beginDiscovery": {
      if (!(await getSinkConfig())) return { ok: false, error: "Choose a destination before trying this supplier." };
      if ((await listCollectorSources()).some((source) => source.primaryOrigin === message.origin)) {
        await failSupplierDiscovery(undefined, DISCOVERY_FAILURE_MESSAGES.alreadySupported, [`${message.origin}/*`]);
        return { ok: false, error: DISCOVERY_FAILURE_MESSAGES.alreadySupported };
      }
      const tab = await chrome.tabs.get(message.tabId);
      if (!tab.active || !tab.url || new URL(tab.url).origin !== message.origin) {
        return { ok: false, error: "Open the supplier app in the active tab and try again." };
      }
      await beginSupplierDiscovery(message.tabId, message.origin);
      // Covers an already-granted origin and the narrow race where Chrome adds
      // permission just before the onAdded listener observes the durable state.
      if (await chrome.permissions.contains({ origins: [`${message.origin}/*`] })) void completeSupplierScan();
      return { ok: true };
    }

    case "completeDiscovery":
      await completeSupplierScan();
      return { ok: true, discovery: await getSupplierDiscoveryStatus() };

    case "cancelDiscovery":
      await cancelCurrentDiscovery();
      return { ok: true };

    case "dismissDiscovery":
      await clearSupplierDiscovery();
      return { ok: true };

    case "beginDiscoveryConnect": {
      const pending = await beginSupplierDiscoveryConnect(message.vendorId);
      if (pending && await hasHostPermissions(requiredCandidateOrigins(pending.candidates))) void completeDiscoveredConnect(pending.candidates.id, pending.runId);
      return pending ? { ok: true } : { ok: false, error: "The discovery preview expired. Try the supplier again." };
    }

    case "completeDiscoveryConnect":
      return completeDiscoveredConnect(message.vendorId);

    case "cancelDiscoveryConnect":
      const pending = await getPendingSupplierDiscoveryConnect();
      if (pending) await restoreSupplierDiscoveryPreview(pending.runId);
      return { ok: true };

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

  const recipe = (await resolveCollectorSource(pending.vendorId))?.recipe;
  const connection = (await getConnections())[pending.vendorId];
  const expectedOrigins = recipe ? vendorPermissionOrigins(recipe, connection) : [];
  if (!recipe || !sameOrigins(pending.origins, expectedOrigins)) {
    await clearPendingConnect(pending.vendorId);
    return false;
  }
  if (!(await hasHostPermissions(expectedOrigins))) return false;
  await completeVendorConnect(recipe.id);
  return true;
}

function completeVendorConnect(vendorId: string): Promise<Response> {
  const existing = connectionInFlight.get(vendorId);
  if (existing) return existing;

  const task = collectionRuns.runInteractive(async (): Promise<Response> => {
    const recipe = (await resolveCollectorSource(vendorId))?.recipe;
    if (!recipe) return { ok: false, error: "Unknown vendor." };
    if (!(await getSinkConfig())) return { ok: false, error: "Choose a destination before connecting a vendor." };
    const existingConnection = (await getConnections())[recipe.id];
    const requiredOrigins = vendorPermissionOrigins(recipe, existingConnection);
    if (!(await hasHostPermissions(requiredOrigins))) return { ok: false, error: "Vendor access was not granted." };

    await clearPendingConnect(recipe.id);
    await upsertConnection({
      ...existingConnection,
      vendorId: recipe.id,
      connectedAt: existingConnection?.connectedAt ?? Date.now(),
    });

    const summary = await runVendorById(recipe.id);
    if (summary.status === "auth_expired") notifyReconnect(recipe);
    return { ok: true, summaries: [summary] };
  }).finally(() => connectionInFlight.delete(vendorId));

  connectionInFlight.set(vendorId, task);
  return task;
}

function sameOrigins(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((origin) => right.includes(origin));
}

let supplierScanInFlight: Promise<void> | undefined;
const discoveredConnectionsInFlight = new Map<string, Promise<Response>>();

async function completeSupplierScan(): Promise<void> {
  if (supplierScanInFlight) return supplierScanInFlight;
  supplierScanInFlight = (async () => {
    const pending = await markSupplierDiscoveryScanning();
    if (!pending) return;
    const granted = await chrome.permissions.contains({ origins: [`${pending.origin}/*`] });
    if (!granted) return;
    try {
      console.info(`[collector] discovery start ${formatCollectorRuntimeIdentity()}`);
      const discovery = await discoverSupplierInTab(pending.tabId, pending.origin, {
        // A user explicitly chose Find Invoices. Use the deep envelope here so
        // that route-family coverage is meaningful instead of failing after a
        // handful of SPA guesses; scheduled syncs never enter this pathway.
        mode: pending.checkpoint?.mode ?? "deep",
        checkpoint: pending.checkpoint,
        onCheckpoint: (checkpoint) => checkpointSupplierDiscovery(pending.runId, checkpoint).then(() => undefined),
        shouldContinue: () => canContinueSupplierDiscovery(pending.origin),
      });
      const current = await getSupplierDiscoveryStatus();
      if (current.stage === "scanning" && current.origin === pending.origin) {
        await setSupplierDiscoveryPreview(pending.runId, discovery.candidates, discovery.diagnostic);
      }
    } catch (error) {
      const current = await getSupplierDiscoveryStatus();
      if (current.stage !== "scanning" || current.origin !== pending.origin) return;
      const changed = error instanceof Error && /tab changed|did not match/.test(error.message);
      await failSupplierDiscovery(pending.runId,
        changed
          ? DISCOVERY_FAILURE_MESSAGES.pageChanged
          : supplierDiscoveryFailureMessage(error),
        [`${pending.origin}/*`],
        error instanceof SupplierDiscoveryError ? error.diagnostic : undefined,
      );
      await revokeUnusedPermissions([`${pending.origin}/*`]);
    }
  })().finally(() => {
    supplierScanInFlight = undefined;
    void resumeSupplierScanIfPending();
  });
  return supplierScanInFlight;
}

function supplierDiscoveryFailureMessage(error: unknown): string {
  if (!(error instanceof SupplierDiscoveryError)) {
    return DISCOVERY_FAILURE_MESSAGES.notFoundApp;
  }
  const results = new Set(error.diagnostic.attempts.map((attempt) => attempt.result));
  if (results.has("auth_expired")) return DISCOVERY_FAILURE_MESSAGES.authExpired;
  if (results.has("auth_scope_denied")) return DISCOVERY_FAILURE_MESSAGES.scopeDenied;
  if (results.has("auth_blocked")) return DISCOVERY_FAILURE_MESSAGES.authBlocked;
  if (results.has("transport_failed")) return DISCOVERY_FAILURE_MESSAGES.transportFailed;
  if (error.diagnostic.termination === "time_cap") return DISCOVERY_FAILURE_MESSAGES.timeCap;
  if (error.diagnostic.termination === "page_cap") return DISCOVERY_FAILURE_MESSAGES.pageCap;
  return DISCOVERY_FAILURE_MESSAGES.notFoundApp;
}

async function resumeSupplierScanIfPending(): Promise<void> {
  const state = await getSupplierDiscoveryStatus();
  if (state.stage !== "scanning") return;
  if (await chrome.permissions.contains({ origins: [`${state.origin}/*`] })) void completeSupplierScan();
}

async function completePendingDiscoveryPermission(addedOrigins: readonly string[]): Promise<boolean> {
  const pending = await getPendingSupplierDiscoveryConnect();
  const candidates = pending?.candidates;
  const requiredOrigins = candidates ? requiredCandidateOrigins(candidates) : [];
  if (pending && candidates && requiredOrigins.some((origin) => addedOrigins.includes(origin))) {
    if (await hasHostPermissions(requiredOrigins)) {
      await completeDiscoveredConnect(candidates.id, pending.runId);
      return true;
    }
  }
  const before = await getSupplierDiscoveryStatus();
  if (before.stage !== "scanning" || !addedOrigins.includes(`${before.origin}/*`)) return false;
  await completeSupplierScan();
  return true;
}

function completeDiscoveredConnect(vendorId: string, expectedRunId?: string): Promise<Response> {
  const key = `${vendorId}:${expectedRunId ?? "current"}`;
  const existing = discoveredConnectionsInFlight.get(key);
  if (existing) return existing;
  const task = collectionRuns.runInteractive(async (): Promise<Response> => {
    const pending = await getPendingSupplierDiscoveryConnect();
    const candidates = pending?.candidates;
    if (!pending || !candidates || candidates.id !== vendorId || (expectedRunId && pending.runId !== expectedRunId)) {
      const source = await resolveCollectorSource(vendorId);
      return source?.kind === "discovered"
        ? { ok: true, summaries: [] }
        : { ok: false, error: "The discovery preview expired. Try the supplier again." };
    }
    if (!(await getSinkConfig())) {
      await restoreSupplierDiscoveryPreview(pending.runId);
      return { ok: false, error: "Choose a destination before collecting." };
    }
    const requiredOrigins = requiredCandidateOrigins(candidates);
    if (!(await hasHostPermissions(requiredOrigins))) {
      await restoreSupplierDiscoveryPreview(pending.runId);
      return { ok: false, error: "Supplier access was not granted." };
    }

    try {
      const scanDiagnostic = await getPendingSupplierDiscoveryDiagnostic(pending.runId);
      await assertDiscoveredSupplierCapacity(candidates.id);
      const result = await collectFirstWorkingCandidate(candidates, async (profile, index) => {
        let committed = false;
        const summary = await runDiscoveredCandidate(profile.recipe, async () => {
          await upsertDiscoveredSupplier(profile);
          await upsertConnection({ vendorId: profile.id, connectedAt: Date.now() });
          committed = true;
        });
        const proof = summary.retrievalProof;
        console.info(
          `[collector] discovery candidate ${index + 1}/${candidates.candidates.length} ${profile.adapter.id} -> ${summary.code ?? summary.status} retrieval=${summary.retrieval ?? "unknown"} documents=${summary.count}` +
          (proof ? ` controls=${proof.observedItems} resolved=${proof.resolvedItems} unresolved=${proof.unresolvedItems} pages=${proof.pagesVisited} end=${proof.termination}` : ""),
        );
        if (committed && !((summary.status === "ok" || summary.status === "partial") &&
          (summary.verifiedCount ?? summary.count) > 0)) {
          await rollbackDiscoveredSupplier(profile.id);
        }
        return summary;
      });
      if (result.kind === "success") {
        const { profile, summary } = result;
        // The collection itself succeeded. A transient session-state write must
        // not undo a delivered document or the now-proven local integration.
        try {
          await completeSupplierDiscovery(pending.runId, profile.id, profile.displayName, summary.count);
        } catch {
          await clearSupplierDiscovery().catch(() => undefined);
        }
        await revokeUnusedPermissions(requiredOrigins);
        return { ok: true, summaries: [summary] };
      }
      if (
        result.kind === "fatal" && result.summary.code === "document_permission_required" &&
        result.summary.requiredOrigins?.length
      ) {
        await rollbackDiscoveredSupplier(candidates.id);
        await requireSupplierDiscoveryDocumentOrigins(pending.runId, result.summary.requiredOrigins);
        return { ok: false, error: operationalOutcomeLabel("document_permission_required") };
      }
      const failure = result.summary?.code
        ? operationalOutcomeLabel(result.summary.code)
        : DISCOVERY_FAILURE_MESSAGES.verificationFailed;
      const diagnostic = scanDiagnostic
        ? withCandidateVerification(scanDiagnostic, result.outcomes)
        : undefined;
      await rollbackDiscoveredSupplier(candidates.id);
      await failSupplierDiscovery(pending.runId, failure, requiredOrigins, diagnostic);
      await revokeUnusedPermissions(requiredOrigins);
      return { ok: false, error: failure };
    } catch (error) {
      console.error("[collector] discovered candidate verification failed", error instanceof Error ? error.name : "unknown");
      await rollbackDiscoveredSupplier(candidates.id);
      const failure = error instanceof DiscoveredSupplierCapacityError
        ? DISCOVERY_FAILURE_MESSAGES.capacity
        : DISCOVERY_FAILURE_MESSAGES.verificationFailed;
      await failSupplierDiscovery(pending.runId, failure, requiredOrigins);
      await revokeUnusedPermissions(requiredOrigins);
      return { ok: false, error: failure };
    }
  }).finally(() => discoveredConnectionsInFlight.delete(key));
  discoveredConnectionsInFlight.set(key, task);
  return task;
}

async function rollbackDiscoveredSupplier(vendorId: string): Promise<void> {
  await Promise.allSettled([
    removeConnection(vendorId),
    removeDiscoveredSupplier(vendorId),
  ]);
}

async function cancelCurrentDiscovery(): Promise<void> {
  await revokeUnusedPermissions(await cancelSupplierDiscovery());
}

async function revokeUnusedPermissions(disconnectedHosts: readonly string[]): Promise<void> {
  const connections = await getConnections();
  const retained = new Set<string>();
  for (const vendorId of Object.keys(connections)) {
    const source = await resolveCollectorSource(vendorId);
    if (source) {
      for (const host of vendorPermissionOrigins(source.recipe, connections[vendorId])) retained.add(host);
    }
  }
  await revokeHostPermissions(disconnectedHosts.filter((host) => !retained.has(host)));
}
