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
  diagnostic?: { result?: string; attempts?: Array<{ result?: string; probeCause?: string }> };
  message?: string;
};

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
    const requestedCase = process.env.RATATOSK_CHROME_CASE;
    const cases = [
      { name: "server", route: "/server" },
      { name: "delayed", route: "/delayed" },
      { name: "frame", route: "/frame" },
      { name: "menus", route: "/menus" },
      { name: "semantic", route: "/semantic" },
      { name: "opaque-active", route: "/9012345678901/billing" },
      { name: "opaque-direct-active", route: "/9012345678901/direct-billing" },
      { name: "blocked", route: "/blocked" },
    ] as const;
    for (const testCase of requestedCase ? cases.filter((item) => item.name === requestedCase) : cases) {
      const { name, route } = testCase;
      await page.goto(`${FIXTURE_ORIGIN}${route}`, { waitUntil: "domcontentloaded" });
      await page.bringToFront();
      const startedAt = Date.now();
      const status = await runDiscovery(extensionPage, FIXTURE_ORIGIN);
      const elapsedMs = Date.now() - startedAt;
      if (status.stage !== "preview") {
        const frames = await inspectFixtureFrames(page);
        console.error(`[chrome-discovery] ${name} frame_state=${JSON.stringify(frames)}`);
      }
      assert.equal(status.stage, "preview", `${route}: expected preview, received ${JSON.stringify(status)}`);
      assert((status.candidateCount ?? 0) >= 1, `${route}: Chrome discovery returned no candidate`);
      assert(elapsedMs <= 10_000, `${route}: Chrome discovery exceeded the fast envelope (${elapsedMs}ms)`);
      console.info(`[chrome-discovery] ${name} candidate_found count=${status.candidateCount} elapsed=${elapsedMs}ms`);
    }
  } finally {
    await context?.close();
    context = undefined;
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
} finally {
  await context?.close();
  await rm(temporary, { recursive: true, force: true });
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
  if (path === "/") return fixturePage("/semantic");
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
    return `<!doctype html><html><head><title>Workspace | Semantic Fixture</title></head><body>
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
              document.querySelector('#main').innerHTML = '<h1>Invoices</h1><button data-href="/documents/invoice-1.pdf">Download invoice</button>';
            });
          });
        }));
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
