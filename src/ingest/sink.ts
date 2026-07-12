import type { FetchedDocument } from "../core/types";

/**
 * Where collected documents go.
 *
 * This interface is the seam between the open-source collector and any host
 * system. Ship the generic {@link HttpSink} by default; a host like Igdrasil
 * swaps in its own sink (see `igdrasil-sink.ts`) via config — never a fork.
 */
export interface IngestSink {
  send(doc: FetchedDocument): Promise<IngestResult>;
}

export interface IngestResult {
  accepted: boolean;
  /** True when the backend recognized the idempotency key and skipped a duplicate. */
  deduped?: boolean;
  /** Backend id for the created document, when returned. */
  id?: string;
}
