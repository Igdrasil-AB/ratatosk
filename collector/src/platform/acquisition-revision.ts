/**
 * Increment only when the packaged DOM document-acquisition transaction
 * changes. This is separate from discovery search policy so live acceptance
 * evidence can name the exact resolver semantics that produced it.
 */
export const DOCUMENT_ACQUISITION_REVISION = 4;

/**
 * Keep the packaged revision directly inspectable without evaluating the
 * service worker. The packager also asserts that this literal matches the
 * numeric revision above, so either side drifting blocks the artifact.
 */
export const DOCUMENT_ACQUISITION_RUNTIME_MARKER = "document-acquisition=4";
