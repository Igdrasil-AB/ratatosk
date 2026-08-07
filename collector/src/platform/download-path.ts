/**
 * Where saved invoices go, as a path.
 *
 * Separate from `filesystem-sink` because the side panel needs to name and
 * validate the destination while a person types it, and importing the sink to
 * do that dragged the delivery journal and the whole `IngestSink` implementation
 * into the panel bundle for two helpers.
 *
 * `chrome.downloads` resolves every path against the browser's download
 * directory and refuses to leave it, so nothing here can address the wider
 * filesystem — only how deep beneath that directory the tree is allowed to sit.
 */

/** Folders a save path may nest before the per-supplier folders are added. */
export const MAX_ROOT_FOLDER_DEPTH = 6;

const DOWNLOAD_ROOT_KEY = "filesystemDownloadRootV1";

/**
 * Split the configured root into folders.
 *
 * A single name forced every invoice into one folder directly under Downloads.
 * Accepting `Accounting/2026/Invoices` lets the tree live where the rest of a
 * person's filing already is.
 *
 * Returns empty when nothing usable remains, rather than substituting a name.
 * Callers that must produce a path supply their own fallback; the one that
 * validates what a person typed reports the problem instead.
 */
export function folderSegments(rootFolder: string): string[] {
  return rootFolder
    .split(/[/\\]+/)
    .map((part) => part.trim())
    // Dropped before sanitizing, so a navigation segment cannot survive as a
    // folder literally named after it. `chrome.downloads` rejects a path
    // containing one outright, which would turn a typo into a failed save.
    .filter((part) => part.length > 0 && !/^\.+$/.test(part))
    .map((part) => pathSegment(part))
    .filter((part) => part.length > 0)
    .slice(0, MAX_ROOT_FOLDER_DEPTH);
}

/** The configured root as one display string: `Accounting/2026/Invoices`. */
export function folderPath(rootFolder: string): string {
  return folderSegments(rootFolder).join("/");
}

/**
 * Sanitize one path segment.
 *
 * Returns empty rather than a placeholder so a caller can tell "the person
 * named nothing" from "the person named something unusable".
 */
export function pathSegment(value: string): string {
  return stripControl(value.replace(/[/\\:*?"<>|]/g, "-"))
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim();
}

/** Drop control characters (code point < 0x20) without a fragile regex. */
export function stripControl(value: string): string {
  let out = "";
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) >= 0x20) out += character;
  }
  return out;
}

/**
 * The absolute directory saves land in, once a save has revealed it.
 *
 * Extensions cannot ask Chrome where downloads go, so this is only known after
 * a completed download reported its absolute location.
 */
export async function getDownloadRoot(): Promise<string | undefined> {
  try {
    const value = (await chrome.storage.local.get(DOWNLOAD_ROOT_KEY))[DOWNLOAD_ROOT_KEY];
    return typeof value === "string" && value.length > 0 && value.length <= 4_096 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record the directory Chrome resolved a relative save path against.
 *
 * The difference between where a completed download landed and the relative
 * path that produced it is the root.
 */
export async function rememberDownloadRoot(absolute: string, relativePath: string): Promise<void> {
  // Windows reports backslashes; separators map one-to-one, so comparing
  // normalized copies keeps the offset valid in the original string.
  const normalize = (value: string) => value.replace(/\\/g, "/");
  const suffix = `/${normalize(relativePath)}`;
  if (!normalize(absolute).endsWith(suffix)) return;
  const root = absolute.slice(0, absolute.length - suffix.length);
  if (root) await chrome.storage.local.set({ [DOWNLOAD_ROOT_KEY]: root });
}
