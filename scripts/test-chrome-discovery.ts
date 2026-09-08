import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page, type Worker } from "playwright-core";

const FIXTURE_HOST = "discovery-fixture.ratatosk.test";
const FIXTURE_ORIGIN = `https://${FIXTURE_HOST}`;

type DiscoveryStatus = {
  stage: string;
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

const temporary = await mkdtemp(join(tmpdir(), "ratatosk-chrome-discovery-"));
let context: BrowserContext | undefined;
try {
  const extensionPath = join(temporary, "collector");
  await cp(resolve("dist/collector"), extensionPath, { recursive: true });
  const manifestPath = join(extensionPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { host_permissions?: string[] };
  manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), `${FIXTURE_ORIGIN}/*`])];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const keyPath = join(temporary, "fixture.key");
  const certPath = join(temporary, "fixture.crt");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", `/CN=${FIXTURE_HOST}`,
    "-addext", `subjectAltName=DNS:${FIXTURE_HOST}`,
    "-keyout", keyPath,
    "-out", certPath,
  ], { stdio: "ignore" });

  let opaqueDirectVisits = 0;
  let replayFailureVisits = 0;
  const server = createServer({
    key: await readFile(keyPath),
    cert: await readFile(certPath),
  }, (request, response) => {
    const path = new URL(request.url ?? "/", FIXTURE_ORIGIN).pathname;
    if (request.url === "/documents/invoice-1.pdf") {
      response.writeHead(200, { "content-type": "application/pdf" });
      response.end("%PDF-1.4\n%%EOF\n");
      return;
    }
    if (path === "/api/invoices") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ invoices: [{
        id: "fixture-invoice-1",
        issued_at: "2026-08-01",
        pdf_url: "/documents/invoice-1.pdf",
      }] }));
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
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert(address && typeof address === "object", "fixture server did not bind");

  try {
    context = await chromium.launchPersistentContext(join(temporary, "profile"), {
      channel: "chromium",
      headless: true,
      ignoreHTTPSErrors: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        `--host-resolver-rules=MAP ${FIXTURE_HOST} 127.0.0.1:${address.port}`,
      ],
    });
    const worker = await extensionWorker(context);
    const extensionId = new URL(worker.url()).host;
    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/collector/src/ui/popup/popup.html`);
    const page = await context.newPage();
    const requestedCase = iterationOptions.caseName ?? process.env.RATATOSK_CHROME_CASE;
    const cases = [
      { name: "server", route: "/server", expected: "preview" },
      { name: "delayed", route: "/delayed", expected: "preview" },
      { name: "frame", route: "/frame", expected: "preview" },
      { name: "menus", route: "/menus", expected: "preview" },
      { name: "semantic", route: "/semantic", expected: "preview" },
      { name: "avatar-menus", route: "/avatar-menus", expected: "preview" },
      { name: "opaque-active", route: "/9012345678901/billing", expected: "preview" },
      { name: "opaque-direct-active", route: "/9012345678901/direct-billing", expected: "preview" },
      { name: "semantic-replay-timeout", route: "/9012345678901/replay-timeout", expected: "failed" },
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
  } finally {
    await context?.close();
    context = undefined;
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
} finally {
  await context?.close();
  await rm(temporary, { recursive: true, force: true });
}

function parseIterationOptions(args: readonly string[]): { caseName?: string; repeat: number } {
  let caseName: string | undefined;
  let repeat = 1;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--case") caseName = args[index + 1];
    if (args[index] === "--repeat") repeat = Number(args[index + 1]);
  }
  if (caseName !== undefined && !/^[a-z0-9-]{1,80}$/.test(caseName)) throw new Error("invalid discovery case name");
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error("repeat must be an integer from 1 to 20");
  return { ...(caseName ? { caseName } : {}), repeat };
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

function fixturePage(path: string): string {
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
