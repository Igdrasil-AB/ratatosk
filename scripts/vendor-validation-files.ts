import { existsSync } from "node:fs";

export function vendorFileIssues(
  vendorId: string,
  fileExists: (path: string) => boolean = existsSync,
): string[] {
  const issues: string[] = [];
  const testPath = `test/vendors/${vendorId}.test.ts`;
  if (!fileExists(testPath)) issues.push(`${vendorId}: missing required test at ${testPath}`);

  const fixturePaths = [
    `test/vendors/fixtures/${vendorId}.invoices.json`,
    `test/vendors/fixtures/${vendorId}.invoices.html`,
  ];
  if (!fixturePaths.some(fileExists)) {
    issues.push(`${vendorId}: missing required invoice fixture (${fixturePaths.join(" or ")})`);
  }
  return issues;
}

export function parseVerificationMaxAgeDays(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error("VENDOR_VERIFICATION_MAX_AGE_DAYS must be a whole number from 1 to 365");
  }
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days > 365) {
    throw new Error("VENDOR_VERIFICATION_MAX_AGE_DAYS must be a whole number from 1 to 365");
  }
  return days;
}
