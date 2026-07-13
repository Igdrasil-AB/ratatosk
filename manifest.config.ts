import { defineManifest } from "@crxjs/vite-plugin";
import { allHosts } from "./src/vendors";

/**
 * The MV3 manifest is generated from the vendor registry: `optional_host_permissions`
 * is exactly the set of hosts the recipes touch. Vendors are optional (requested
 * at connect-time), so the install-time prompt stays minimal.
 *
 * SINGLE PURPOSE (Chrome Web Store policy): this extension does exactly one thing —
 * "collect a user's own supplier invoices and receipts into their accounting
 * backend." The recorder ("Studio", which uses the `debugger` permission) is an
 * AUTHORING AID for that same purpose — it teaches the collector how to read a new
 * vendor — NOT a general-purpose network-debugging tool. Keep the description and
 * every permission justification tied to that one purpose.
 */
export default defineManifest({
  manifest_version: 3,
  name: "Invoice Collector",
  version: "0.6.2",
  description:
    "Collect your own supplier invoices and receipts from vendor billing pages using your existing browser session — no passwords stored.",
  minimum_chrome_version: "116",
  // "debugger" powers deep-capture; "activeTab" lets the silent recorder inject
  // into whatever tab you're on (any vendor) without a broad host permission.
  permissions: ["storage", "alarms", "notifications", "scripting", "tabs", "downloads", "debugger", "activeTab"],
  optional_host_permissions: allHosts(),
  // Only the Igdrasil web app may message the extension (the one-click "Connect"
  // handshake that hands over the session token + company id). Exact origin, never
  // a wildcard TLD; the service worker re-validates sender.origin on every message.
  externally_connectable: { matches: ["https://accounting.igdrasil.se/*"] },
  // Explicit strict CSP: no remote scripts, no eval — all logic ships in the package.
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'",
  },
  background: {
    service_worker: "src/platform/service-worker.ts",
    type: "module",
  },
  action: {
    default_popup: "src/ui/popup/popup.html",
    default_title: "Invoice Collector",
  },
  icons: { "128": "icons/128.png" },
});
