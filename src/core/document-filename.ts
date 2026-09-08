/** Supplier names are untrusted path components, never document identities. */
export function safeDocumentFilename(value: string | null | undefined, contentType?: string): string | undefined {
  if (!value || value.length > 4_096) return undefined;
  let name = value.split(/[\\/]/).pop()!
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069:*?"<>|]/g, "-")
    .trim().replace(/[. ]+$/, "");
  if (!name || /^\.+$/.test(name)) return undefined;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  if (contentType?.split(";", 1)[0].trim().toLowerCase() === "application/pdf" && !/\.pdf$/i.test(name)) name += ".pdf";
  // Leave room for filesystem limits while preserving Unicode and the extension.
  const extension = name.match(/\.[a-z0-9]{1,10}$/i)?.[0] ?? "";
  const stem = extension ? name.slice(0, -extension.length) : name;
  let bounded = "";
  const encoder = new TextEncoder();
  let bytes = encoder.encode(extension).length;
  for (const character of stem) {
    bytes += encoder.encode(character).length;
    if (bytes > 240) break;
    bounded += character;
  }
  return bounded + extension;
}

/** RFC 6266: prefer a valid extended filename, then the basic quoted/token form. */
export function filenameFromContentDisposition(value: string | null | undefined): string | undefined {
  if (!value || value.length > 4_096 || /[\r\n]/.test(value)) return undefined;
  const parameters = new Map<string, string>();
  for (const match of value.matchAll(/;\s*([\w*-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g)) {
    const key = match[1].toLowerCase();
    // Duplicate filename parameters are ambiguous; use the generated fallback.
    if (parameters.has(key)) return undefined;
    parameters.set(key, match[2] !== undefined ? match[2].replace(/\\(["\\])/g, "$1") : match[3].trim());
  }
  const extended = parameters.get("filename*")?.match(/^UTF-8'[^']*'(.*)$/i);
  if (extended) {
    try {
      const name = safeDocumentFilename(decodeURIComponent(extended[1]));
      if (name) return name;
    } catch { /* malformed encoding: use the basic filename */ }
  }
  return safeDocumentFilename(parameters.get("filename"));
}
