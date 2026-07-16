import type { OperationalOutcomeCode } from "../../../src/core/errors";

const MINUTE_MS = 60_000;
const TRANSIENT_RETRY_DELAYS_MS = [5 * MINUTE_MS, 30 * MINUTE_MS, 2 * 60 * MINUTE_MS] as const;
const TRANSIENT_CODES = new Set<OperationalOutcomeCode>(["destination_unavailable", "unknown"]);

export function isTransientRetryCode(code: OperationalOutcomeCode | undefined): boolean {
  return code !== undefined && TRANSIENT_CODES.has(code);
}

/**
 * Return the next retry time for failures that can reasonably recover without
 * user or recipe changes. The final delay is a hard cap, so a broken supplier
 * cannot create an unbounded retry loop.
 */
export function nextTransientRetryAt(
  code: OperationalOutcomeCode,
  consecutiveFailures: number,
  now = Date.now(),
): number | undefined {
  if (!isTransientRetryCode(code)) return undefined;
  const failureIndex = Math.max(0, Math.floor(consecutiveFailures) - 1);
  const delay = TRANSIENT_RETRY_DELAYS_MS[Math.min(failureIndex, TRANSIENT_RETRY_DELAYS_MS.length - 1)];
  return now + delay;
}
