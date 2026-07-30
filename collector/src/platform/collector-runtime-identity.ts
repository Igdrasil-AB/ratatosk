import pkg from "../../../package.json";
import {
  DISCOVERY_ENGINE_REVISION,
  EXPLORATION_DEADLINE_MS,
  MAX_EXPLORATION_DEPTH,
  MAX_EXPLORATION_PAGES,
} from "./discovery-explorer";
import {
  DOCUMENT_ACQUISITION_REVISION,
  DOCUMENT_ACQUISITION_RUNTIME_MARKER,
} from "./acquisition-revision";

/**
 * One immutable identity for the code and bounded search policy that Chrome is
 * actually running. Keep this free of timestamps so release builds remain
 * reproducible and support logs can be compared exactly.
 */
export const COLLECTOR_RUNTIME_IDENTITY = Object.freeze({
  collectorVersion: pkg.version,
  discoveryEngine: DISCOVERY_ENGINE_REVISION,
  documentAcquisition: DOCUMENT_ACQUISITION_REVISION,
  pages: MAX_EXPLORATION_PAGES,
  depth: MAX_EXPLORATION_DEPTH,
  durationMs: EXPLORATION_DEADLINE_MS,
});

export function formatCollectorRuntimeIdentity(): string {
  const identity = COLLECTOR_RUNTIME_IDENTITY;
  return `v${identity.collectorVersion} discovery-engine=${identity.discoveryEngine} ${DOCUMENT_ACQUISITION_RUNTIME_MARKER} pages=${identity.pages} depth=${identity.depth} budget=${identity.durationMs}ms`;
}
