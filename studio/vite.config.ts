import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [crx({ manifest })],
  // Studio has no public catch-all directory. Every shipped asset must be
  // referenced by its manifest or an entry point so Collector-only artwork
  // cannot drift into the developer package.
  publicDir: false,
  build: { target: "esnext", outDir: "dist/studio", emptyOutDir: true },
});
