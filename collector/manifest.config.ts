import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "../package.json";

/**
 * Vendor access remains optional and is requested as an exact HTTPS origin only
 * after the user clicks Connect or Search This App. The wildcard declaration
 * lets unsupported suppliers use that same runtime consent flow; it does not
 * grant access at install time.
 *
 * SINGLE PURPOSE (Chrome Web Store policy): this public extension only collects a
 * user's own supplier invoices and receipts into a destination they confirm.
 * Supplier support comes from user-initiated discovery inside this extension, so
 * Collector never ships the broad `debugger` permission or recording machinery.
 */
export default defineManifest({
  manifest_version: 3,
  name: "Ratatosk — Invoice Collector",
  version: pkg.version,
  description:
    "Collect your own supplier invoices and receipts from vendor billing pages using your existing browser session — no passwords stored.",
  minimum_chrome_version: "128",
  // webRequest is observation-only: a bounded listener follows the request ID
  // of a user-approved Stripe capability URL so a changed exact redirect origin
  // can be offered through the existing runtime permission flow. No headers,
  // bodies, cookies, blocking, or request modification are exposed.
  // declarativeNetRequest uses one temporary session rule scoped to the exact
  // disposable action tab. Chrome 128 response-header conditions let Collector
  // stop attachment responses before a global DownloadItem exists.
  permissions: [
    "storage",
    "alarms",
    "notifications",
    "scripting",
    "downloads",
    "activeTab",
    "webRequest",
    "declarativeNetRequest",
    "sidePanel",
  ],
  // Required for service-worker fetches that upload to the Igdrasil API. Keep
  // exact-origin; vendor access remains optional and is requested on connect.
  host_permissions: ["https://accounting.igdrasil.se/*"],
  optional_host_permissions: ["https://*/*"],
  // Optional rather than install-time: users who want the persistent side
  // panel to follow tab switches grant URL/title metadata access once. This
  // does not grant page access; exact supplier hosts remain separately gated.
  optional_permissions: ["tabs"],
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
  side_panel: {
    default_path: "collector/src/ui/popup/popup.html",
  },
  action: {
    default_title: "Ratatosk — Invoice Collector",
  },
  icons: { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" },
});
