import { DocumentTooLarge, ResponseTooLarge } from "./errors";
import type { HttpResponse } from "./types";

/** Maximum one invoice PDF may retain in extension memory. */
export const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

/** Enforce the document budget across every HttpResponse adapter. The declared
 * length is an early rejection only; the returned buffer remains authoritative
 * because remote servers may omit or lie about that header. */
export async function readDocumentBytes(response: HttpResponse, vendorId: string): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES) {
    throw new DocumentTooLarge(MAX_DOCUMENT_BYTES, vendorId);
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer(MAX_DOCUMENT_BYTES);
  } catch (error) {
    if (error instanceof ResponseTooLarge) throw new DocumentTooLarge(MAX_DOCUMENT_BYTES, vendorId);
    throw error;
  }
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new DocumentTooLarge(MAX_DOCUMENT_BYTES, vendorId);
  return bytes;
}
