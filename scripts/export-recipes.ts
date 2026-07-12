/**
 * Export every validated recipe as JSON.
 *
 * Because recipes are pure data, the same objects compiled into the extension
 * can be served from a backend and hot-loaded — letting you ship a new vendor
 * without a Web Store release. This writes them to `dist/recipes/`.
 *
 *   npm run export-recipes
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { VENDORS } from "../src/vendors";

const outDir = "dist/recipes";
mkdirSync(outDir, { recursive: true });

for (const vendor of VENDORS) {
  writeFileSync(`${outDir}/${vendor.id}.json`, JSON.stringify(vendor, null, 2));
}

const index = VENDORS.map((v) => ({ id: v.id, name: v.name, category: v.category, hosts: v.hosts }));
writeFileSync(`${outDir}/index.json`, JSON.stringify(index, null, 2));

console.log(`Exported ${VENDORS.length} recipes to ${outDir}/`);
