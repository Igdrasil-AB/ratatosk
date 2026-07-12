import { defineManifest } from "@crxjs/vite-plugin";
import { allHosts } from "./src/vendors";

/**
 * The MV3 manifest is generated from the vendor registry: `optional_host_permissions`
 * is exactly the set of hosts the recipes touch. Vendors are optional (requested
 * at connect-time), so the install-time prompt stays minimal.
 */
export default defineManifest({
  manifest_version: 3,
  name: "Invoice Collector",
  version: "0.6.2",
  description:
    "Collects supplier invoices and receipts from vendor portals using your own browser session — no passwords stored.",
  minimum_chrome_version: "116",
  // "debugger" powers deep-capture; "activeTab" lets the silent recorder inject
  // into whatever tab you're on (any vendor) without a broad host permission.
  permissions: ["storage", "alarms", "notifications", "scripting", "tabs", "downloads", "debugger", "activeTab"],
  optional_host_permissions: allHosts(),
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
