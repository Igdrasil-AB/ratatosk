import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "../package.json";

/**
 * Development-only recipe authoring extension.
 *
 * Studio is intentionally separate from the public Collector because Chrome's
 * debugger permission is broad and cannot be optional. Do not publish this
 * package as the consumer-facing Collector.
 */
export default defineManifest({
  manifest_version: 3,
  name: "Ratatosk Studio — Development Build",
  version: pkg.version,
  description: "Developer tool for recording billing pages and drafting reviewed Ratatosk vendor recipes.",
  minimum_chrome_version: "116",
  permissions: ["storage", "scripting", "debugger", "activeTab"],
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'",
  },
  background: {
    service_worker: "studio/src/platform/service-worker.ts",
    type: "module",
  },
  action: {
    default_popup: "studio/src/ui/popup/popup.html",
    default_title: "Ratatosk Studio",
  },
  icons: { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" },
});
