/**
 * CI guard. Importing the registry validates every recipe against the schema
 * (defineVendor throws on invalid), and this script additionally enforces that
 * every vendor has a fixture test — so the long tail can't silently rot.
 *
 *   npm run validate
 */
import { ALL_VENDORS, VENDORS } from "../src/vendors";
import { brandIcon } from "../src/vendors/icons";
import pkg from "../package.json";
import {
  lifecycleCoverageIssues,
  publicVendorCapabilityIssues,
  releaseLifecycleIssues,
} from "../src/vendors/lifecycle";
import { parseVerificationMaxAgeDays, vendorFileIssues } from "./vendor-validation-files";

let failures = 0;
const release = process.argv.includes("--release");

for (const vendor of ALL_VENDORS) {
  for (const issue of vendorFileIssues(vendor.id)) {
    console.error(`✗ ${issue}`);
    failures++;
  }
  // A declared icon slug must resolve, or the logo silently falls back — usually a typo.
  if (vendor.icon && !brandIcon(vendor.icon)) {
    console.error(`✗ ${vendor.id}: icon "${vendor.icon}" isn't in simple-icons (run npm run gen:icons; check the slug).`);
    failures++;
  }
}

for (const issue of lifecycleCoverageIssues(ALL_VENDORS)) {
  console.error(`✗ ${issue}`);
  failures++;
}

for (const issue of publicVendorCapabilityIssues(VENDORS)) {
  console.error(`✗ ${issue}`);
  failures++;
}

for (const vendor of VENDORS) {
  for (const host of vendor.hosts) {
    if (!host.startsWith("https://")) {
      console.error(`✗ ${vendor.id}: public Collector hosts must use HTTPS (${host})`);
      failures++;
    }
    if (/^https:\/\/\*\./.test(host)) {
      console.error(`✗ ${vendor.id}: public Collector cannot ship a wildcard subdomain; verify the exact host (${host})`);
      failures++;
    }
  }
}

if (release) {
  let maxAgeDays: number | undefined;
  try {
    maxAgeDays = parseVerificationMaxAgeDays(process.env.VENDOR_VERIFICATION_MAX_AGE_DAYS);
  } catch (error) {
    console.error(`✗ release: ${error instanceof Error ? error.message : "invalid verification age policy"}`);
    failures++;
  }
  for (const issue of releaseLifecycleIssues(VENDORS.map((vendor) => vendor.id), { collectorVersion: pkg.version, maxAgeDays })) {
    console.error(`✗ release: ${issue}`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`\n${failures} vendor(s) failed validation.`);
  process.exit(1);
}

console.log(`✓ ${ALL_VENDORS.length} vendors: schema-valid, lifecycle-covered, and tested (${VENDORS.length} ship in Collector).`);
