import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "../package.json";
import { allHosts } from "../src/vendors";

/**
 * The MV3 manifest is generated from the vendor registry: `optional_host_permissions`
 * is exactly the set of hosts the recipes touch. Vendors are optional (requested
 * at connect-time), so the install-time prompt stays minimal.
 *
 * SINGLE PURPOSE (Chrome Web Store policy): this public extension only collects a
 * user's own supplier invoices and receipts into a destination they confirm.
 * Recipe authoring lives in the separately built `studio/` extension so Collector
 * never ships the broad `debugger` permission or recording machinery.
 */
export default defineManifest({
  manifest_version: 3,
  name: "Ratatosk — Invoice Collector",
  version: pkg.version,
  description:
    "Collect your own supplier invoices and receipts from vendor billing pages using your existing browser session — no passwords stored.",
  minimum_chrome_version: "116",
  permissions: ["storage", "alarms", "notifications", "scripting", "downloads"],
  // Required for service-worker fetches that upload to the Igdrasil API. Keep
  // exact-origin; vendor access remains optional and is requested on connect.
  host_permissions: ["https://accounting.igdrasil.se/*"],
  optional_host_permissions: allHosts(),
  // The one-click "Connect Igdrasil" bridge: a content script that runs ONLY on
  // the Igdrasil web app's exact origin. It announces the extension to the page
  // and relays the connect handshake to the service worker, which re-validates
  // sender.origin before touching a token. Narrow, first-party, no extension id
  // needed by the web app.
  content_scripts: [
    {
      matches: ["https://accounting.igdrasil.se/*"],
      js: ["collector/src/platform/connect-bridge.ts"],
      run_at: "document_idle",
    },
  ],
  // Explicit strict CSP: no remote scripts, no eval — all logic ships in the package.
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'",
  },
  background: {
    service_worker: "collector/src/platform/service-worker.ts",
    type: "module",
  },
  action: {
    default_popup: "collector/src/ui/popup/popup.html",
    default_title: "Ratatosk — Invoice Collector",
  },
  icons: { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" },
});
