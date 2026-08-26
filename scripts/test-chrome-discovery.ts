import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page, type Worker } from "playwright-core";
import type { LiveAcceptanceSnapshot } from "../src/core/live-acceptance";

const FIXTURE_HOST = "discovery-fixture.ratatosk.test";
const FIXTURE_ORIGIN = `https://${FIXTURE_HOST}`;
const blindSeed = process.env.RATATOSK_BLIND_SEED ?? "a10393d04be2";
if (!/^[a-f0-9]{12}$/.test(blindSeed)) throw new Error("blind seed must be 12 lowercase hex characters");
const acceptanceNonce = randomBytes(16).toString("hex");
const BLIND_ROUTE = `/x${blindSeed.slice(0, 6)}/z${blindSeed.slice(6)}`;
const BLIND_WRAPPER = `w${blindSeed}`;
const BLIND_DELAY_MS = 200 + Number.parseInt(blindSeed.slice(0, 2), 16) % 700;
const BLIND_MENU_ORDER = [1, 2, 3, 4].map((value, index, values) =>
  values[(index + Number.parseInt(blindSeed.slice(2, 4), 16)) % values.length]);
const ACQUISITION_CASES = [
  { name: "network", host: "network-acquisition.ratatosk.test", route: "/network-acquisition", adapterId: "network-json", expectedActions: 0, fallback: false },
  { name: "direct-dom", host: "direct-acquisition.ratatosk.test", route: "/direct-acquisition", adapterId: "dom-links", expectedActions: 0, fallback: false },
  { name: "semantic-dom", host: "semantic-acquisition.ratatosk.test", route: "/semantic-acquisition", adapterId: "dom-actions", expectedActions: 1, fallback: false },
  { name: "candidate-fallback", host: "fallback-acquisition.ratatosk.test", route: "/fallback-acquisition", adapterId: "network-json", expectedActions: 0, fallback: true },
  { name: "blind-synthetic", host: "blind-acquisition.ratatosk.test", route: "/blind-home", adapterId: "dom-actions", expectedActions: 1, fallback: false },
] as const;
const NEGATIVE_ACQUISITION_CASES = [
  { name: "invalid-pdf", host: "invalid-acquisition.ratatosk.test", route: "/invalid-acquisition", adapterId: "dom-links", result: "document_invalid" },
  { name: "partial-traversal", host: "partial-acquisition.ratatosk.test", route: "/partial-acquisition", adapterId: "network-json", result: "retrieval_incomplete" },
] as const;
const DESTINATION_RETRY_CASE = {
  name: "destination-retry",
  host: "destination-acquisition.ratatosk.test",
  route: "/destination-acquisition",
  adapterId: "dom-links",
} as const;
const FIXTURE_HOSTS = [
  FIXTURE_HOST,
  ...ACQUISITION_CASES.map((item) => item.host),
  ...NEGATIVE_ACQUISITION_CASES.map((item) => item.host),
  DESTINATION_RETRY_CASE.host,
];

type DiscoveryStatus = {
  stage: string;
  vendorId?: string;
  adapterId?: string;
  candidateCount?: number;
  diagnostic?: {
    result?: string;
    attempts?: Array<{
      result?: string;
      probeCause?: string;
      replay?: {
        phases?: Array<{ phase?: string; result?: string; durationMs?: number }>;
        firstFailure?: { phase?: string; result?: string };
      };
    }>;
  };
  message?: string;
};

let activeFixtureCase = "";
const iterationOptions = parseIterationOptions(process.argv.slice(2));
const iterationResults: Array<{
  case: string;
  repeat: number;
  stage: string;
  candidateCount: number;
  firstFailure?: { phase: string; result: string };
}> = [];

const suppliedTemporary = process.env.RATATOSK_CHROME_TEST_DIRECTORY;
const temporary = suppliedTemporary
  ? validatedTestDirectory(suppliedTemporary)
  : await mkdtemp(join(tmpdir(), "ratatosk-chrome-discovery-"));
let context: BrowserContext | undefined;
let server: ReturnType<typeof createServer> | undefined;
let cleanupPromise: Promise<void> | undefined;
const cleanupResources = (): Promise<void> => cleanupPromise ??= (async () => {
  const activeContext = context;
  context = undefined;
  await activeContext?.close().catch(() => undefined);
  if (server?.listening) {
    await new Promise<void>((resolvePromise) => server?.close(() => resolvePromise()));
  }
  server = undefined;
  await rm(temporary, { recursive: true, force: true });
})();
const stopAfterCleanup = (code: number): void => { void cleanupResources().finally(() => process.exit(code)); };
const onInterrupt = (): void => stopAfterCleanup(130);
const onTerminate = (): void => stopAfterCleanup(143);
process.once("SIGINT", onInterrupt);
process.once("SIGTERM", onTerminate);
try {
  const extensionPath = join(temporary, "collector");
  await cp(resolve("dist/collector"), extensionPath, { recursive: true });
  const manifestPath = join(extensionPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { host_permissions?: string[] };
  manifest.host_permissions = [...new Set([
    ...(manifest.host_permissions ?? []),
    ...FIXTURE_HOSTS.map((host) => `https://${host}/*`),
  ])];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const keyPath = join(temporary, "fixture.key");
  const certPath = join(temporary, "fixture.crt");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", `/CN=${FIXTURE_HOST}`,
    "-addext", `subjectAltName=${FIXTURE_HOSTS.map((host) => `DNS:${host}`).join(",")}`,
    "-keyout", keyPath,
    "-out", certPath,
  ], { stdio: "ignore" });

  let opaqueDirectVisits = 0;
  let replayFailureVisits = 0;
  const documentRequests = new Map<string, number>();
  server = createServer({
    key: await readFile(keyPath),
    cert: await readFile(certPath),
  }, (request, response) => {
    const requestHost = String(request.headers.host ?? FIXTURE_HOST).split(":", 1)[0];
    const requestOrigin = `https://${requestHost}`;
    const path = new URL(request.url ?? "/", requestOrigin).pathname;
    if (path.startsWith("/documents/") && path.endsWith(".pdf")) {
      const key = `${requestHost}${path}`;
      documentRequests.set(key, (documentRequests.get(key) ?? 0) + 1);
      response.writeHead(200, { "content-type": path.includes("invalid") ? "text/plain" : "application/pdf" });
      response.end(path.includes("invalid") ? "not a pdf" : "%PDF-1.4\n%%EOF\n");
      return;
    }
    if (path === "/api/invoices") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ invoices: [{
        id: "fixture-invoice-1",
        issued_at: "2026-08-01",
        pdf_url: `${requestOrigin}/documents/network.pdf`,
      }] }));
      return;
    }
    if (path === "/api/fallback-invoices") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ invoices: [{
        id: "fixture-invalid-1",
        issued_at: "2026-08-01",
        pdf_url: `${requestOrigin}/documents/invalid.pdf`,
      }] }));
      return;
    }
    if (path === "/api/partial-invoices") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        has_more: true,
        next_cursor: "cur_2",
        results: [{
          invoice_number: "FIXTURE-PARTIAL-1",
          invoice_date: "2026-08-01",
          download_url: `${requestOrigin}/documents/partial.pdf`,
        }],
      }));
      return;
    }
    if (path === "/frame-content") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><script>fetch('/api/invoices').then(response => response.json())</script>");
      return;
    }
    if (path === "/telemetry") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (path === "/9012345678901/direct-billing") {
      opaqueDirectVisits += 1;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(opaqueDirectVisits === 1
        ? `<!doctype html><html><head><title>Invoices | Active-only Fixture</title></head><body>
            <main><h1>Invoices</h1><a href="/documents/invoice-1.pdf" aria-label="More"></a></main>
          </body></html>`
        : "<!doctype html><html><head><title>Workspace</title></head><body><main>Workspace home</main></body></html>");
      return;
    }
    if (path === "/9012345678901/replay-timeout") {
      replayFailureVisits += 1;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(replayFailureVisits === 1
        ? `<!doctype html><html><head><title>Invoices | Replay Failure Fixture</title></head><body>
            <main><h1>Invoices</h1><button data-href="/documents/invoice-1.pdf">Download invoice</button></main>
          </body></html>`
        : "<!doctype html><html><head><title>Workspace</title></head><body><main>Workspace home</main></body></html>");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixturePage(path));
  });
  const fixtureServer = server;
  await new Promise<void>((resolvePromise, reject) => {
    fixtureServer.once("error", reject);
    fixtureServer.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = fixtureServer.address();
  assert(address && typeof address === "object", "fixture server did not bind");

  try {
    context = await chromium.launchPersistentContext(join(temporary, "profile"), {
      channel: "chromium",
      headless: true,
      ignoreHTTPSErrors: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        `--host-resolver-rules=${FIXTURE_HOSTS.map((host) => `MAP ${host} 127.0.0.1:${address.port}`).join(", ")}`,
      ],
    });
    const worker = await extensionWorker(context);
    const extensionId = new URL(worker.url()).host;
    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/collector/src/ui/popup/popup.html`);
    const page = await context.newPage();
    if (iterationOptions.acquisition) {
      for (const testCase of ACQUISITION_CASES) {
        if (iterationOptions.caseName && iterationOptions.caseName !== testCase.name) continue;
        const origin = `https://${testCase.host}`;
        await page.goto(`${origin}${testCase.route}`, { waitUntil: "domcontentloaded" });
        await page.bringToFront();
        const result = await runAcquisition(extensionPage, origin, testCase.adapterId);
        assert.equal(result.first.count, 1, `${testCase.name}: first run did not accept one document`);
        assert.equal(result.first.verifiedCount, 1, `${testCase.name}: first run did not verify one document`);
        assert.equal(result.first.documentActionCount ?? 0, testCase.expectedActions, `${testCase.name}: unexpected first-run action count`);
        assert.equal(result.immediate.count, 0, `${testCase.name}: immediate rerun delivered a duplicate`);
        assert.equal(result.immediate.documentActionCount ?? 0, 0, `${testCase.name}: immediate rerun activated an accepted control`);
        assert.equal(result.cadenceActionCount, 0, `${testCase.name}: cadence rerun activated an accepted control`);
        assert.equal(result.ledgerDelta, 1, `${testCase.name}: ledger did not commit exactly one document`);
        assert.equal(result.downloadDelta, 1, `${testCase.name}: browser created an unexpected download`);
        if (testCase.fallback) {
          assert((documentRequests.get(`${testCase.host}/documents/invalid.pdf`) ?? 0) >= 1, "fallback case did not exercise the failed candidate");
          assert((documentRequests.get(`${testCase.host}/documents/fallback.pdf`) ?? 0) >= 1, "fallback case did not reach the working candidate");
        }
        console.info(`[chrome-acquisition] ${testCase.name} first=1 immediate=0 cadence=0 actions=${testCase.expectedActions}/0/0 downloads=1 page_owned=0`);
      }
      for (const testCase of NEGATIVE_ACQUISITION_CASES) {
        if (iterationOptions.caseName && iterationOptions.caseName !== testCase.name) continue;
        const origin = `https://${testCase.host}`;
        await page.goto(`${origin}${testCase.route}`, { waitUntil: "domcontentloaded" });
        await page.bringToFront();
        const result = await runFailedAcquisition(extensionPage, origin, testCase.adapterId);
        assert.equal(result, testCase.result, `${testCase.name}: wrong closed verification result`);
        console.info(`[chrome-acquisition] ${testCase.name} rejected=${result} ledger=0 downloads=0 committed=0`);
      }
      if (!iterationOptions.caseName || iterationOptions.caseName === DESTINATION_RETRY_CASE.name) {
        const origin = `https://${DESTINATION_RETRY_CASE.host}`;
        await page.goto(`${origin}${DESTINATION_RETRY_CASE.route}`, { waitUntil: "domcontentloaded" });
        await page.bringToFront();
        await fillFilesystemDeliveryJournal(extensionPage);
        const rejected = await runFailedAcquisition(extensionPage, origin, DESTINATION_RETRY_CASE.adapterId);
        assert.equal(rejected, "destination_unavailable", "destination rejection did not fail at delivery");
        await clearFilesystemDeliveryJournal(extensionPage);
        const retry = await runAcquisition(extensionPage, origin, DESTINATION_RETRY_CASE.adapterId);
        assert.equal(retry.first.count, 1, "destination retry did not accept the previously rejected document");
        assert.equal(retry.immediate.count, 0, "destination retry immediate run duplicated the document");
        assert.equal(retry.cadenceActionCount, 0, "destination retry cadence run activated a document control");
        console.info("[chrome-acquisition] destination-retry rejected=destination_unavailable retry=1 immediate=0 cadence=0 committed_after_acceptance=1");
      }
      assert(
        !iterationOptions.caseName ||
        ACQUISITION_CASES.some((item) => item.name === iterationOptions.caseName) ||
        NEGATIVE_ACQUISITION_CASES.some((item) => item.name === iterationOptions.caseName) ||
        DESTINATION_RETRY_CASE.name === iterationOptions.caseName,
        `unknown acquisition case ${iterationOptions.caseName}`,
      );
      await writeFile(join(temporary, "iteration-result.json"), `${JSON.stringify({ results: iterationResults }, null, 2)}\n`);
    } else {
      const requestedCase = iterationOptions.caseName ?? process.env.RATATOSK_CHROME_CASE;
    const cases = [
      { name: "semantic-replay-timeout", route: "/9012345678901/replay-timeout", expected: "failed" },
      { name: "server", route: "/server", expected: "preview" },
      { name: "delayed", route: "/delayed", expected: "preview" },
      { name: "frame", route: "/frame", expected: "preview" },
      { name: "menus", route: "/menus", expected: "preview" },
      { name: "semantic", route: "/semantic", expected: "preview" },
      { name: "avatar-menus", route: "/avatar-menus", expected: "preview" },
      { name: "opaque-active", route: "/9012345678901/billing", expected: "preview" },
      { name: "opaque-direct-active", route: "/9012345678901/direct-billing", expected: "preview" },
      { name: "blocked", route: "/blocked", expected: "preview" },
    ] as const;
    const selectedCases = requestedCase ? cases.filter((item) => item.name === requestedCase) : cases;
    assert(selectedCases.length > 0, `unknown discovery case ${requestedCase}`);
    for (const testCase of selectedCases) {
      const signatures = new Set<string>();
      for (let repeat = 1; repeat <= iterationOptions.repeat; repeat += 1) {
        const { name, route, expected } = testCase;
        activeFixtureCase = name;
        opaqueDirectVisits = 0;
        replayFailureVisits = 0;
        await page.goto(`${FIXTURE_ORIGIN}${route}`, { waitUntil: "domcontentloaded" });
        await page.bringToFront();
        const startedAt = Date.now();
        const status = await runDiscovery(extensionPage, FIXTURE_ORIGIN);
        const elapsedMs = Date.now() - startedAt;
        if (status.stage !== expected) {
          const frames = await inspectFixtureFrames(page);
          console.error(`[chrome-discovery] ${name} frame_state=${JSON.stringify(frames)}`);
        }
        assert.equal(status.stage, expected, `${route}: expected ${expected}, received ${JSON.stringify(status)}`);
        assert(elapsedMs <= 15_000, `${route}: iteration exceeded 15 seconds (${elapsedMs}ms)`);
        if (expected === "failed") {
          const replay = status.diagnostic?.attempts
            ?.find((attempt) => attempt.result === "list_failed" || attempt.result === "no_documents" || attempt.result === "limit_reached")
            ?.replay;
          const replayFailure = replay?.firstFailure;
          assert(replayFailure?.phase, `${route}: missing closed replay failure phase in ${JSON.stringify(status)}`);
          assert(replayFailure.result, `${route}: missing closed replay failure result in ${JSON.stringify(status)}`);
          const timeline = replay?.phases?.map((phase) => `${phase.phase}:${phase.result}:${phase.durationMs ?? 0}ms`).join(",") ?? "";
          const signature = `${status.stage}|${replayFailure.phase}|${replayFailure.result}`;
          signatures.add(signature);
          iterationResults.push({
            case: name,
            repeat,
            stage: status.stage,
            candidateCount: status.candidateCount ?? 0,
            firstFailure: { phase: replayFailure.phase, result: replayFailure.result },
          });
          console.info(`[chrome-discovery] ${name} repeat=${repeat} replay_failed phase=${replayFailure.phase} result=${replayFailure.result} elapsed=${elapsedMs}ms timeline=${timeline}`);
          continue;
        }
        assert((status.candidateCount ?? 0) >= 1, `${route}: Chrome discovery returned no candidate`);
        assert(elapsedMs <= 10_000, `${route}: Chrome discovery exceeded the fast envelope (${elapsedMs}ms)`);
        signatures.add(`${status.stage}|candidate_found`);
        iterationResults.push({ case: name, repeat, stage: status.stage, candidateCount: status.candidateCount ?? 0 });
        console.info(`[chrome-discovery] ${name} repeat=${repeat} candidate_found count=${status.candidateCount} elapsed=${elapsedMs}ms`);
      }
      assert.equal(signatures.size, 1, `${testCase.name}: nondeterministic terminal signatures ${[...signatures].join(", ")}`);
    }
      await writeFile(join(temporary, "iteration-result.json"), `${JSON.stringify({ results: iterationResults }, null, 2)}\n`);
    }
  } finally {
    await cleanupResources();
  }
} finally {
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onTerminate);
  await cleanupResources();
}

function parseIterationOptions(args: readonly string[]): { caseName?: string; repeat: number; acquisition: boolean } {
  let caseName: string | undefined;
  let repeat = 1;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--case") caseName = args[index + 1];
    if (args[index] === "--repeat") repeat = Number(args[index + 1]);
  }
  if (caseName !== undefined && !/^[a-z0-9-]{1,80}$/.test(caseName)) throw new Error("invalid discovery case name");
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error("repeat must be an integer from 1 to 20");
  return { ...(caseName ? { caseName } : {}), repeat, acquisition: args.includes("--acquisition") };
}

function validatedTestDirectory(value: string): string {
  const directory = resolve(value);
  const root = resolve(tmpdir());
  if (!directory.startsWith(`${root}/ratatosk-chrome-discovery-`)) {
    throw new Error("browser test directory must be a dedicated temporary directory");
  }
  return directory;
}

async function inspectFixtureFrames(page: Page): Promise<unknown> {
  return Promise.all(page.frames().map(async (frame) => ({
    url: new URL(frame.url()).pathname,
    observer: await frame.evaluate(() => typeof (globalThis as typeof globalThis & {
      __ratatoskDiscoveryObserverV1?: { snapshot?: unknown };
    }).__ratatoskDiscoveryObserverV1?.snapshot === "function"),
  })));
}

async function extensionWorker(browser: BrowserContext): Promise<Worker> {
  const current = browser.serviceWorkers()[0];
  if (current) return current;
  return browser.waitForEvent("serviceworker", { timeout: 15_000 });
}

async function runDiscovery(extensionPage: Page, origin: string): Promise<DiscoveryStatus> {
  return extensionPage.evaluate(async (fixtureOrigin) => {
    const extensionChrome = (globalThis as typeof globalThis & {
      chrome: {
        tabs: { query(input: unknown): Promise<Array<{ id?: number }>> };
        runtime: { sendMessage(input: unknown): Promise<Record<string, unknown>> };
      };
    }).chrome;
    await extensionChrome.runtime.sendMessage({ type: "dismissDiscovery" });
    const [tab] = await extensionChrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("fixture tab is not active");
    const destination = await extensionChrome.runtime.sendMessage({
      type: "setLocalDestination",
      destination: { kind: "filesystem", rootFolder: "Ratatosk Browser Test", dateMode: "extraction" },
    });
    if (!destination?.ok) throw new Error(String(destination?.error ?? "could not prepare test destination"));
    const begin = await extensionChrome.runtime.sendMessage({ type: "beginDiscovery", tabId: tab.id, origin: fixtureOrigin });
    if (!begin?.ok) throw new Error(String(begin?.error ?? "could not begin discovery"));
    const completed = await extensionChrome.runtime.sendMessage({ type: "completeDiscovery" });
    if (!completed?.ok) throw new Error(String(completed?.error ?? "could not complete discovery"));
    const discovery = completed.discovery as DiscoveryStatus | undefined;
    if (discovery?.stage === "failed") {
      const detail = await extensionChrome.runtime.sendMessage({ type: "getDiscoveryDiagnostic" });
      return { ...discovery, ...(detail?.ok ? { diagnostic: detail.discoveryDiagnostic } : {}) };
    }
    return discovery;
  }, origin) as Promise<DiscoveryStatus>;
}

type RunSummary = {
  count: number;
  verifiedCount?: number;
  documentActionCount?: number;
};

async function runAcquisition(
  extensionPage: Page,
  origin: string,
  expectedAdapter: string,
): Promise<{
  first: RunSummary;
  immediate: RunSummary;
  cadenceActionCount: number;
  ledgerDelta: number;
  downloadDelta: number;
}> {
  type Source = {
    id: string;
    connection?: { lastAttemptAt?: number; lastCount?: number; lastDocumentActionCount?: number } | null;
  };
  await sendExtensionMessage(extensionPage, { type: "dismissDiscovery" });
  await sendExtensionMessage(extensionPage, {
      type: "setLocalDestination",
      destination: { kind: "filesystem", rootFolder: "Ratatosk Browser Acquisition", dateMode: "extraction" },
  });
  const tabId = await extensionPage.evaluate(async () => {
    const extensionChrome = (globalThis as typeof globalThis & {
      chrome: { tabs: { query(input: unknown): Promise<Array<{ id?: number }>> } };
    }).chrome;
    const [tab] = await extensionChrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id;
  });
  if (tabId === undefined) throw new Error("fixture tab is not active");
  const ledgerBefore = ((await sendExtensionMessage(extensionPage, { type: "getLedger" })).ledger as unknown[]).length;
  const downloadsBefore = await extensionDownloadCount(extensionPage);
  await sendExtensionMessage(extensionPage, { type: "beginDiscovery", tabId, origin });
  const preview = (await sendExtensionMessage(extensionPage, { type: "completeDiscovery" })).discovery as DiscoveryStatus;
  if (preview.stage !== "preview" || !preview.vendorId || preview.adapterId !== expectedAdapter) {
    throw new Error(`unexpected acquisition preview ${JSON.stringify(preview)}`);
  }
  const hostname = new URL(origin).hostname;
  const previewSnapshot = (await sendExtensionMessage(extensionPage, {
    type: "getLiveAcceptanceSnapshot", hostname, sessionNonce: acceptanceNonce,
  })).acceptanceSnapshot as LiveAcceptanceSnapshot;
  assert.equal(previewSnapshot.stage, "preview", "live snapshot did not preserve preview evidence");
  await sendExtensionMessage(extensionPage, { type: "beginDiscoveryConnect", vendorId: preview.vendorId, destinationId: "local" });
  const connected = await sendExtensionMessage(extensionPage, { type: "completeDiscoveryConnect", vendorId: preview.vendorId });
  let first = (connected.summaries as RunSummary[] | undefined)?.[0];
  if (!first) {
    const firstDeadline = Date.now() + 12_000;
    while (Date.now() < firstDeadline) {
      const status = (await sendExtensionMessage(extensionPage, { type: "getDiscoveryStatus" })).discovery as DiscoveryStatus & { count?: number };
      const source = ((await sendExtensionMessage(extensionPage, { type: "listSources" })).sources as Source[])
        .find((candidate) => candidate.id === preview.vendorId);
      if (status.stage === "complete" && source?.connection) {
        first = {
          count: status.count ?? source.connection.lastCount ?? 0,
          verifiedCount: status.count ?? source.connection.lastCount ?? 0,
          documentActionCount: source.connection.lastDocumentActionCount ?? 0,
        };
        break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  if (!first) throw new Error("discovered connection returned no first-run result");
  const firstSnapshot = (await sendExtensionMessage(extensionPage, {
    type: "getLiveAcceptanceSnapshot", hostname, sessionNonce: acceptanceNonce,
  })).acceptanceSnapshot as LiveAcceptanceSnapshot;

  const immediateReply = await sendExtensionMessage(extensionPage, { type: "runNow", vendorId: preview.vendorId });
  const immediate = (immediateReply.summaries as RunSummary[] | undefined)?.[0];
  if (!immediate) throw new Error("immediate rerun returned no summary");
  const immediateSnapshot = (await sendExtensionMessage(extensionPage, {
    type: "getLiveAcceptanceSnapshot", hostname, sessionNonce: acceptanceNonce,
  })).acceptanceSnapshot as LiveAcceptanceSnapshot;
  const sourceBeforeCadence = ((await sendExtensionMessage(extensionPage, { type: "listSources" })).sources as Source[])
    .find((source) => source.id === preview.vendorId);
  const attemptBeforeCadence = sourceBeforeCadence?.connection?.lastAttemptAt ?? 0;
  await sendExtensionMessage(extensionPage, { type: "setSchedule", schedule: { mode: "daily" } });
  await extensionPage.evaluate(async (when) => {
    const extensionChrome = (globalThis as typeof globalThis & {
      chrome: { alarms: { create(name: string, info: { when: number }): Promise<void> } };
    }).chrome;
    await extensionChrome.alarms.create("collector-sync", { when });
  }, Date.now() + 250);
  const cadenceDeadline = Date.now() + 12_000;
  let cadenceActionCount: number | undefined;
  while (Date.now() < cadenceDeadline) {
    const source = ((await sendExtensionMessage(extensionPage, { type: "listSources" })).sources as Source[])
      .find((candidate) => candidate.id === preview.vendorId);
    if ((source?.connection?.lastAttemptAt ?? 0) > attemptBeforeCadence) {
      cadenceActionCount = source?.connection?.lastDocumentActionCount ?? 0;
      break;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  if (cadenceActionCount === undefined) throw new Error("scheduled acquisition did not complete");
  const cadenceSnapshot = (await sendExtensionMessage(extensionPage, {
    type: "getLiveAcceptanceSnapshot", hostname, sessionNonce: acceptanceNonce,
  })).acceptanceSnapshot as LiveAcceptanceSnapshot;
  if (
    previewSnapshot.stage !== "preview" || firstSnapshot.stage !== "connected" ||
    immediateSnapshot.stage !== "connected" || cadenceSnapshot.stage !== "connected" ||
    previewSnapshot.planCount < 1 || !previewSnapshot.planKinds.includes(firstSnapshot.selectedPlanKind) ||
    firstSnapshot.destinationToken !== immediateSnapshot.destinationToken ||
    firstSnapshot.destinationToken !== cadenceSnapshot.destinationToken ||
    firstSnapshot.run.acceptedCount !== 1 || immediateSnapshot.run.acceptedCount !== 0 ||
    immediateSnapshot.run.actionCount !== 0 || cadenceSnapshot.run.acceptedCount !== 0 ||
    cadenceSnapshot.run.actionCount !== 0
  ) throw new Error("extension-generated live acceptance snapshots were inconsistent");
  const ledgerAfter = ((await sendExtensionMessage(extensionPage, { type: "getLedger" })).ledger as unknown[]).length;
  const downloadsAfter = await extensionDownloadCount(extensionPage);
  return {
    first,
    immediate,
    cadenceActionCount,
    ledgerDelta: ledgerAfter - ledgerBefore,
    downloadDelta: downloadsAfter - downloadsBefore,
  };
}

async function sendExtensionMessage(
  extensionPage: Page,
  message: Record<string, unknown>,
): Promise<Record<string, unknown> & { ok?: boolean; error?: string }> {
  const reply = await sendRawExtensionMessage(extensionPage, message);
  if (!reply?.ok) throw new Error(String(reply?.error ?? `message ${message.type} failed`));
  return reply;
}

async function sendRawExtensionMessage(
  extensionPage: Page,
  message: Record<string, unknown>,
): Promise<Record<string, unknown> & { ok?: boolean; error?: string }> {
  return extensionPage.evaluate(async (input) => {
    const extensionChrome = (globalThis as typeof globalThis & {
      chrome: { runtime: { sendMessage(value: unknown): Promise<Record<string, unknown>> } };
    }).chrome;
    return extensionChrome.runtime.sendMessage(input);
  }, message) as Promise<Record<string, unknown> & { ok?: boolean; error?: string }>;
}

function extensionDownloadCount(extensionPage: Page): Promise<number> {
  return extensionPage.evaluate(async () => {
    const extensionChrome = (globalThis as typeof globalThis & {
      chrome: { downloads: { search(query: Record<string, never>): Promise<unknown[]> } };
    }).chrome;
    return (await extensionChrome.downloads.search({})).length;
  });
}

function fillFilesystemDeliveryJournal(extensionPage: Page): Promise<void> {
  return extensionPage.evaluate(async () => {
    const journal: Record<string, unknown> = {};
    for (let index = 0; index < 500; index += 1) {
      journal[index.toString(16).padStart(64, "0")] = {
        source: "ext:seed",
        destination: "blocked",
        path: `blocked/${index}`,
        status: "pending",
        updatedAt: index,
      };
    }
    const extensionChrome = (globalThis as typeof globalThis & {
      chrome: { storage: { local: { set(value: Record<string, unknown>): Promise<void> } } };
    }).chrome;
    await extensionChrome.storage.local.set({ filesystemDeliveryJournalV1: journal });
  });
}

function clearFilesystemDeliveryJournal(extensionPage: Page): Promise<void> {
  return extensionPage.evaluate(async () => {
    const extensionChrome = (globalThis as typeof globalThis & {
      chrome: { storage: { local: { remove(key: string): Promise<void> } } };
    }).chrome;
    await extensionChrome.storage.local.remove("filesystemDeliveryJournalV1");
  });
}

async function runFailedAcquisition(
  extensionPage: Page,
  origin: string,
  expectedAdapter: string,
): Promise<string> {
  await sendExtensionMessage(extensionPage, { type: "dismissDiscovery" });
  await sendExtensionMessage(extensionPage, {
    type: "setLocalDestination",
    destination: { kind: "filesystem", rootFolder: "Ratatosk Browser Acquisition", dateMode: "extraction" },
  });
  const tabId = await extensionPage.evaluate(async () => {
    const extensionChrome = (globalThis as typeof globalThis & {
      chrome: { tabs: { query(input: unknown): Promise<Array<{ id?: number }>> } };
    }).chrome;
    return (await extensionChrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  });
  if (tabId === undefined) throw new Error("fixture tab is not active");
  const ledgerBefore = ((await sendExtensionMessage(extensionPage, { type: "getLedger" })).ledger as unknown[]).length;
  const downloadsBefore = await extensionDownloadCount(extensionPage);
  await sendExtensionMessage(extensionPage, { type: "beginDiscovery", tabId, origin });
  const preview = (await sendExtensionMessage(extensionPage, { type: "completeDiscovery" })).discovery as DiscoveryStatus;
  if (preview.stage !== "preview" || !preview.vendorId || preview.adapterId !== expectedAdapter) {
    throw new Error(`unexpected negative acquisition preview ${JSON.stringify(preview)}`);
  }
  await sendExtensionMessage(extensionPage, { type: "beginDiscoveryConnect", vendorId: preview.vendorId, destinationId: "local" });
  await sendRawExtensionMessage(extensionPage, { type: "completeDiscoveryConnect", vendorId: preview.vendorId });
  const deadline = Date.now() + 12_000;
  let result: string | undefined;
  let lastStatus: DiscoveryStatus | undefined;
  while (Date.now() < deadline) {
    const status = (await sendExtensionMessage(extensionPage, { type: "getDiscoveryStatus" })).discovery as DiscoveryStatus;
    lastStatus = status;
    if (status.stage === "failed") {
      const diagnostic = (await sendExtensionMessage(extensionPage, { type: "getDiscoveryDiagnostic" })).discoveryDiagnostic as {
        verification?: { outcomes?: Array<{ result?: string }> };
      };
      result = diagnostic.verification?.outcomes?.[0]?.result;
      if (result) break;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  if (!result) throw new Error(`negative acquisition did not reach a closed verification result: ${JSON.stringify(lastStatus)}`);
  const ledgerAfter = ((await sendExtensionMessage(extensionPage, { type: "getLedger" })).ledger as unknown[]).length;
  const downloadsAfter = await extensionDownloadCount(extensionPage);
  const sources = (await sendExtensionMessage(extensionPage, { type: "listSources" })).sources as Array<{ id?: string }>;
  assert.equal(ledgerAfter, ledgerBefore, "failed acquisition changed the ledger");
  assert.equal(downloadsAfter, downloadsBefore, "failed acquisition created a browser download");
  assert(!sources.some((source) => source.id === preview.vendorId), "failed acquisition persisted a supplier");
  return result;
}

function fixturePage(path: string): string {
  if (path === "/network-acquisition") {
    return `<!doctype html><html><head><title>Invoices | Network Acquisition</title></head><body>
      <h1>Invoices</h1><script>fetch('/api/invoices').then(response => response.json())</script></body></html>`;
  }
  if (path === "/direct-acquisition") {
    return `<!doctype html><html><head><title>Invoices | Direct Acquisition</title></head><body>
      <h1>Invoices</h1><a href="/documents/direct.pdf">Download invoice</a></body></html>`;
  }
  if (path === "/semantic-acquisition") {
    return `<!doctype html><html><head><title>Invoices | Semantic Acquisition</title></head><body>
      <h1>Invoices</h1><table><thead><tr><th>Invoice Number</th><th>Actions</th></tr></thead>
      <tbody><tr data-invoice-id="fixture-semantic-1"><td>FIXTURE-SEM-1</td><td><button id="download">Download invoice</button></td></tr></tbody></table>
      <script>document.querySelector('#download').addEventListener('click', () => { fetch('/documents/semantic.pdf').catch(() => undefined); });</script>
      </body></html>`;
  }
  if (path === "/fallback-acquisition") {
    return `<!doctype html><html><head><title>Invoices | Candidate Fallback</title></head><body>
      <h1>Invoices</h1><a href="/documents/fallback.pdf">Download invoice</a>
      <script>fetch('/api/fallback-invoices').then(response => response.json())</script></body></html>`;
  }
  if (path === "/invalid-acquisition") {
    return `<!doctype html><html><head><title>Invoices | Invalid Document</title></head><body>
      <h1>Invoices</h1><a href="/documents/invalid.pdf">Download invoice</a></body></html>`;
  }
  if (path === "/partial-acquisition") {
    return `<!doctype html><html><head><title>Invoices | Partial Traversal</title></head><body>
      <h1>Invoices</h1><script>fetch('/api/partial-invoices?cursor=cur_1&limit=25').then(response => response.json())</script></body></html>`;
  }
  if (path === "/destination-acquisition") {
    return `<!doctype html><html><head><title>Invoices | Destination Retry</title></head><body>
      <h1>Invoices</h1><a href="/documents/destination-retry.pdf">Download invoice</a></body></html>`;
  }
  if (path === "/blind-home") {
    return `<!doctype html><html><head><title>Workspace | Blind Shape</title></head><body>
      <header>${BLIND_MENU_ORDER.map((value) => `<button aria-haspopup="menu" data-menu="${value}" class="${BLIND_WRAPPER}-${value}">Workspace ${value}</button>`).join("")}</header>
      <div id="overlay"></div><main id="main"><h1>Workspace home</h1></main>
      <script>
        document.querySelectorAll('[data-menu]').forEach(button => button.addEventListener('click', () => {
          document.querySelector('#overlay').innerHTML = button.getAttribute('data-menu') === '4'
            ? '<div role="menu"><button id="blind-settings">Settings</button></div>'
            : '<div role="menu"><button>Activity</button></div>';
          document.querySelector('#blind-settings')?.addEventListener('click', () => {
            document.querySelector('#overlay').innerHTML = '<button id="blind-billing">Billing</button>';
            document.querySelector('#blind-billing').addEventListener('click', () => {
              setTimeout(() => {
                history.pushState({}, '', '${BLIND_ROUTE}');
                document.querySelector('#main').innerHTML = '<h1>Invoices</h1><table><tr data-invoice-id="blind-1"><td>BLIND-1</td><td><button id="blind-download">Download invoice</button></td></tr></table>';
                document.querySelector('#blind-download').addEventListener('click', () => { fetch('/documents/blind.pdf').catch(() => undefined); });
              }, ${BLIND_DELAY_MS});
            });
          });
        }));
      </script></body></html>`;
  }
  if (path === BLIND_ROUTE) {
    return `<!doctype html><html><head><title>Invoices | Blind Shape</title></head><body class="${BLIND_WRAPPER}">
      <h1>Invoices</h1><table><tr data-invoice-id="blind-1"><td>BLIND-1</td><td><button id="blind-download">Download invoice</button></td></tr></table>
      <script>document.querySelector('#blind-download').addEventListener('click', () => { fetch('/documents/blind.pdf').catch(() => undefined); });</script></body></html>`;
  }
  if (path === "/") {
    return activeFixtureCase === "semantic-replay-timeout"
      ? "<!doctype html><html><head><title>Workspace</title></head><body><main>Workspace home</main></body></html>"
      : fixturePage("/semantic");
  }
  if (path === "/9012345678901/billing") {
    return `<!doctype html><html><head><title>Invoices | Opaque Active Fixture</title></head><body>
      <main><h1>Invoices</h1><button data-href="/documents/invoice-1.pdf">Download invoice</button></main>
    </body></html>`;
  }
  if (path === "/delayed") {
    return `<!doctype html><html><head><title>Invoices | Delayed Fixture</title></head>
      <body><main><h1>Billing history</h1><div id="invoices"></div></main>
      <script>setTimeout(() => { document.querySelector('#invoices').innerHTML =
        '<a href="/documents/invoice-1.pdf">Download invoice</a>'; }, 1100)</script></body></html>`;
  }
  if (path === "/frame") {
    return `<!doctype html><html><head><title>Account | Frame Fixture</title></head>
      <body><main><h1>Account billing</h1><iframe src="/frame-content"></iframe></main></body></html>`;
  }
  if (path === "/menus") {
    return `<!doctype html><html><head><title>Workspace | Menu Fixture</title></head><body>
      <header>${[1, 2, 3, 4].map((index) => `<button aria-haspopup="menu" data-menu="${index}">Workspace ${index}</button>`).join("")}</header>
      <div id="overlay"></div><main id="main"><h1>Workspace home</h1></main>
      <script>
        document.querySelectorAll('[data-menu]').forEach(button => button.addEventListener('click', () => {
          const index = button.getAttribute('data-menu');
          document.querySelector('#overlay').innerHTML = index === '4'
            ? '<div role="menu"><button id="settings">Settings</button></div>'
            : '<div role="menu"><button>Activity</button></div>';
          document.querySelector('#settings')?.addEventListener('click', () => {
            document.querySelector('#overlay').innerHTML = '<button id="billing">Billing</button>';
            document.querySelector('#billing').addEventListener('click', () => {
              history.pushState({}, '', '/menus/invoices');
              document.querySelector('#main').innerHTML = '<h1>Invoices</h1><a href="/documents/invoice-1.pdf">Download invoice</a>';
            });
          });
        }));
      </script></body></html>`;
  }
  if (path === "/semantic") {
    return `<!doctype html><html><head><title>Invoices | Semantic Fixture</title></head><body>
      <main><h1>Invoices</h1><button data-href="/documents/invoice-1.pdf">Download invoice</button></main>
      </body></html>`;
  }
  if (path === "/avatar-menus") {
    return `<!doctype html><html><head><title>Workspace | Avatar Fixture</title></head><body>
      <header><button role="button" data-testid="personal-avatar-menu">Personal</button>
        <button role="button" data-testid="workspace-avatar">Acme</button></header>
      <div id="overlay"></div><main id="main"><h1>Workspace home</h1></main>
      <script>
        document.querySelector('[data-testid="personal-avatar-menu"]').addEventListener('click', () => {
          document.querySelector('#overlay').innerHTML = '<div role="menu"><button>Settings</button></div>';
        });
        document.querySelector('[data-testid="workspace-avatar"]').addEventListener('click', () => {
          document.querySelector('#overlay').innerHTML = '<div role="menu"><button id="workspace-settings">Settings</button></div>';
          document.querySelector('#workspace-settings').addEventListener('click', () => {
            document.querySelector('#overlay').innerHTML = '<button id="workspace-billing">Billing</button>';
            document.querySelector('#workspace-billing').addEventListener('click', () => {
              document.querySelector('#main').innerHTML = '<h1>Invoices</h1><button data-href="/documents/invoice-1.pdf">Download invoice</button>';
            });
          });
        });
      </script></body></html>`;
  }
  if (path === "/blocked") {
    return `<!doctype html><html><head><title>Workspace | Blocked Effect Fixture</title></head><body>
      <button aria-haspopup="menu" id="workspace">Workspace menu</button>
      <a href="/billing">Billing and invoices</a>
      <script>document.querySelector('#workspace').addEventListener('click', () => {
        fetch('/telemetry', { method: 'POST', body: '{}' }).catch(() => undefined);
      });</script></body></html>`;
  }
  return `<!doctype html><html><head><title>Invoices | Browser Fixture</title></head>
    <body><main><h1>Billing history</h1>
      <a href="/documents/invoice-1.pdf">Download invoice</a>
    </main></body></html>`;
}
