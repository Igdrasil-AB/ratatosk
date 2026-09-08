/**
 * Stable idempotency keys.
 *
 * The same invoice fetched on two different days must produce the same key, so
 * re-runs no-op instead of creating duplicates. The key is deliberately derived
 * only from identity (tenant + source + vendor invoice id), never from mutable
 * fields like amount or a signed URL.
 *
 * Uses Web Crypto (`crypto.subtle`), available in both the extension service
 * worker and modern Node — keeping this file platform-free.
 */
export async function idempotencyKey(
  companyId: string,
  source: string,
  vendorInvoiceId: string,
): Promise<string> {
  return sha256Hex(`${companyId}\0${source}\0${vendorInvoiceId}`);
}

/**
 * Destination- and supplier-scoped identity for delivered PDF content.
 *
 * Stable PDF wrapper fields are ignored so equivalent retrievals for one
 * supplier reach the destination only once.
 */
export async function contentIdempotencyKey(
  companyId: string,
  source: string,
  bytes: ArrayBuffer,
): Promise<string> {
  const contentDigest = await sha256Bytes(canonicalPdfIdentityBytes(bytes));
  return sha256Hex(`${companyId}\0${source}\0pdf-content\0${contentDigest}`);
}

const MAX_CANONICAL_PDF_BYTES = 16 * 1024 * 1024;
const PDF_HEADER = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

/**
 * Stripe regenerates invoice PDFs with a new wrapper on every download. The
 * visible invoice remains byte-for-byte identical after rendering, but PDF
 * timestamps, the document ID, and its temporary invoice.stripe.com link
 * change. Normalize only those closed-list container fields for identity.
 *
 * The delivered bytes are never modified. On malformed, non-PDF, or unusually
 * large input this fails closed and returns the exact bytes instead.
 */
function canonicalPdfIdentityBytes(bytes: ArrayBuffer): ArrayBuffer | Uint8Array<ArrayBuffer> {
  const view = new Uint8Array(bytes);
  if (
    view.byteLength > MAX_CANONICAL_PDF_BYTES
    || view.byteLength < PDF_HEADER.byteLength
    || !PDF_HEADER.every((byte, index) => view[index] === byte)
  ) {
    return bytes;
  }

  const text = new TextDecoder("latin1").decode(view);
  const streamRanges = findPdfStreamRanges(text);
  if (streamRanges === null) return bytes;

  const replacements: PdfIdentityReplacement[] = [];
  collectPdfIdentityReplacements(
    text,
    /\/(CreationDate|ModDate)\s*\(D:[^)\r\n]{4,64}\)/g,
    (match) => `/${match[1]} (D:VOLATILE)`,
    streamRanges,
    replacements,
  );
  collectPdfIdentityReplacements(
    text,
    /\/ID\s*\[\s*<[0-9A-Fa-f]{16,128}>\s*<[0-9A-Fa-f]{16,128}>\s*\]/g,
    () => "/ID [<VOLATILE> <VOLATILE>]",
    streamRanges,
    replacements,
  );
  collectPdfIdentityReplacements(
    text,
    /\/URI\s*\(https:\/\/invoice\.stripe\.com\/i\/[^)\r\n]{1,2048}\)/g,
    () => "/URI (https://invoice.stripe.com/i/VOLATILE)",
    streamRanges,
    replacements,
  );

  if (replacements.length === 0) return bytes;
  replacements.sort((left, right) => left.start - right.start);

  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  let cursor = 0;
  for (const replacement of replacements) {
    if (replacement.start < cursor) continue;
    parts.push(view.subarray(cursor, replacement.start));
    parts.push(encoder.encode(replacement.value));
    cursor = replacement.end;
  }
  parts.push(view.subarray(cursor));

  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const canonical = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    canonical.set(part, offset);
    offset += part.byteLength;
  }
  return canonical;
}

interface PdfIdentityReplacement {
  start: number;
  end: number;
  value: string;
}

interface PdfStreamRange {
  start: number;
  end: number;
}

function collectPdfIdentityReplacements(
  text: string,
  pattern: RegExp,
  replacement: (match: RegExpExecArray) => string,
  streamRanges: PdfStreamRange[],
  output: PdfIdentityReplacement[],
): void {
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const start = match.index;
    const end = start + match[0].length;
    if (streamRanges.some((range) => start < range.end && end > range.start)) continue;
    output.push({ start, end, value: replacement(match) });
  }
}

function findPdfStreamRanges(text: string): PdfStreamRange[] | null {
  const ranges: PdfStreamRange[] = [];
  const streamStart = /(?:^|[\r\n])stream[ \t]*(?:\r\n|\n|\r)/g;
  const streamEnd = /(?:\r\n|\n|\r)endstream\b/g;

  for (let startMatch = streamStart.exec(text); startMatch !== null; startMatch = streamStart.exec(text)) {
    streamEnd.lastIndex = streamStart.lastIndex;
    const endMatch = streamEnd.exec(text);
    if (endMatch === null) return null;
    ranges.push({ start: streamStart.lastIndex, end: endMatch.index });
    streamStart.lastIndex = streamEnd.lastIndex;
  }
  return ranges;
}

async function sha256Hex(input: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(input));
}

async function sha256Bytes(input: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
