import { zipSync, type Zippable } from "fflate";

/**
 * ZIP stores a timezone-free DOS timestamp. Constructing this date in local
 * time keeps those encoded clock fields identical in UTC and non-UTC builders.
 */
export function zipDeterministically(files: Readonly<Record<string, Uint8Array>>): Uint8Array {
  const mtime = new Date(1980, 0, 1, 0, 0, 0, 0);
  const entries: Zippable = Object.fromEntries(
    Object.entries(files).map(([name, contents]) => [name, [contents, { mtime }]]),
  );
  return zipSync(entries, { level: 9 });
}
