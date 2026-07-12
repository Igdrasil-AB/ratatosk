/**
 * CI guard. Importing the registry validates every recipe against the schema
 * (defineVendor throws on invalid), and this script additionally enforces that
 * every vendor has a fixture test — so the long tail can't silently rot.
 *
 *   npm run validate
 */
import { existsSync } from "node:fs";
import { VENDORS } from "../src/vendors";
import { ICONS } from "../src/vendors/icons.generated";

let failures = 0;

for (const vendor of VENDORS) {
  const testPath = `test/vendors/${vendor.id}.test.ts`;
  if (!existsSync(testPath)) {
    console.error(`✗ ${vendor.id}: missing required test at ${testPath}`);
    failures++;
  }
  // A declared icon slug must resolve, or the logo silently falls back — usually a typo.
  if (vendor.icon && !ICONS[vendor.icon]) {
    console.error(`✗ ${vendor.id}: icon "${vendor.icon}" isn't in simple-icons (run npm run gen:icons; check the slug).`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`\n${failures} vendor(s) failed validation.`);
  process.exit(1);
}

console.log(`✓ ${VENDORS.length} vendors: schema-valid and covered by tests.`);
