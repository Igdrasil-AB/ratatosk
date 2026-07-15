import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [crx({ manifest })],
  publicDir: "public",
  build: { target: "esnext", outDir: "dist/studio", emptyOutDir: true },
});
