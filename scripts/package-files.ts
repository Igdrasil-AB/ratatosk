import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";

const PRIVATE_KEY_EXTENSIONS = new Set([".jks", ".key", ".keystore", ".p12", ".pem", ".pfx"]);
const PRIVATE_KEY_MARKER = /-----BEGIN (?:[A-Z0-9 ]+PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/;

/** Reject repository-only and secret-bearing files before archive bytes exist. */
export function assertPackageFileSafe(name: string, contents: Uint8Array): void {
  const normalized = name.replaceAll("\\", "/");
  const leaf = basename(normalized).toLowerCase();
  if (normalized.endsWith(".map")) throw new Error(`source map must not ship: ${normalized}`);
  if (/(^|\/)\.env(?:\.|$)|(^|\/)(?:test|tests|fixtures?)(?:\/|$)/i.test(normalized)) {
    throw new Error(`repository-only file must not ship: ${normalized}`);
  }
  if (
    PRIVATE_KEY_EXTENSIONS.has(extname(leaf)) ||
    /^(?:\.netrc|\.npmrc|\.pypirc|credentials(?:\..+)?|id_(?:dsa|ecdsa|ed25519|rsa)|.*(?:client[-_]?secret|service[-_]?account).*\.json)$/.test(leaf)
  ) {
    throw new Error(`credential or private-key file must not ship: ${normalized}`);
  }
  if (PRIVATE_KEY_MARKER.test(Buffer.from(contents).toString("utf8"))) {
    throw new Error(`private-key material must not ship: ${normalized}`);
  }
}

/** Collect only real files physically contained by the extension build root. */
export function collectPackageFiles(root: string): string[] {
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`package root must be a real directory: ${root}`);
  }
  const resolvedRoot = realpathSync(root);
  return walk(root, resolvedRoot);
}

function walk(directory: string, resolvedRoot: string): string[] {
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`symbolic link must not ship: ${relative(resolvedRoot, path)}`);

      const resolvedPath = realpathSync(path);
      const containment = relative(resolvedRoot, resolvedPath);
      if (containment === ".." || containment.startsWith(`..${sep}`) || isAbsolute(containment)) {
        throw new Error(`package file escapes build root: ${path}`);
      }
      if (stat.isDirectory()) return walk(path, resolvedRoot);
      if (!stat.isFile()) throw new Error(`non-regular file must not ship: ${containment}`);
      return [path];
    });
}
