import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

/**
 * @crxjs handles MV3: it transpiles the TS service worker / popup entries
 * referenced by the manifest and emits a loadable `dist/` extension.
 */
export default defineConfig({
  plugins: [crx({ manifest })],
  build: { target: "esnext" },
});
