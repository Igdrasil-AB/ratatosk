export type BoundedTaskOutcome<T> =
  | { status: "fulfilled"; index: number; value: T }
  | { status: "rejected"; index: number; error: unknown }
  | { status: "cancelled"; index: number; reason: "external_abort" | "fatal_error" };

export interface BoundedConcurrencyOptions {
  /** Maximum active tasks. Runtime-clamped to 1..16. */
  limit: number;
  /** Optional parent cancellation. Workers receive the derived signal. */
  signal?: AbortSignal;
  /** Abort scheduling after a failure known to invalidate sibling work. */
  stopOnError?: (error: unknown) => boolean;
}

export interface SafeConcurrencyPolicy {
  readonly routeProbes: number;
  readonly candidatePreviews: number;
  readonly documentFetches: number;
  /** This must remain one until prepare and commit are separate transactions. */
  readonly sinkCommits: 1;
}

export const DEFAULT_SAFE_CONCURRENCY = Object.freeze({
  routeProbes: 2,
  candidatePreviews: 2,
  documentFetches: 3,
  sinkCommits: 1,
} as const satisfies SafeConcurrencyPolicy);

/**
 * Serializes collection transactions. At most one scheduled run may wait
 * behind active work, preventing both concurrent destination writes and a
 * silently missed sync window.
 */
export class CollectionRunCoordinator {
  private active: Promise<unknown> | undefined;
  private scheduledWaiting: Promise<unknown> | undefined;

  runInteractive<T>(task: () => Promise<T>): Promise<T> {
    const predecessor = this.active;
    const run = (predecessor ? predecessor.catch(() => undefined) : Promise.resolve()).then(task);
    this.track(run);
    return run;
  }

  runScheduled<T>(task: () => Promise<T>): Promise<T | undefined> {
    if (this.scheduledWaiting) return Promise.resolve(undefined);
    const predecessor = this.active;
    let run!: Promise<T>;
    run = (predecessor ? predecessor.catch(() => undefined) : Promise.resolve()).then(async () => {
      // This task is no longer waiting. A trigger that arrives while it is
      // executing may reserve exactly one serialized follow-up run.
      if (this.scheduledWaiting === run) this.scheduledWaiting = undefined;
      return task();
    });
    this.scheduledWaiting = run;
    this.track(run);
    return run;
  }

  private track(run: Promise<unknown>): void {
    this.active = run;
    void run.finally(() => {
      if (this.active === run) this.active = undefined;
    }).catch(() => undefined);
  }
}

/**
 * Execute pure or read-only work with a hard concurrency cap.
 *
 * Results always retain input order and use a closed discriminated union. Once
 * cancelled, no new work is scheduled; already-running workers are expected to
 * cooperate with the supplied AbortSignal where their transport supports it.
 */
export async function mapConcurrentOrdered<Input, Output>(
  items: readonly Input[],
  options: BoundedConcurrencyOptions,
  task: (item: Input, index: number, signal: AbortSignal) => Promise<Output>,
): Promise<BoundedTaskOutcome<Output>[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(16, Math.trunc(options.limit) || 1));
  const controller = new AbortController();
  let cancellationReason: "external_abort" | "fatal_error" | undefined;
  let cursor = 0;
  const outcomes: Array<BoundedTaskOutcome<Output> | undefined> = Array(items.length);

  const abortFromParent = () => {
    if (cancellationReason) return;
    cancellationReason = "external_abort";
    controller.abort(options.signal?.reason);
  };
  if (options.signal?.aborted) abortFromParent();
  else options.signal?.addEventListener("abort", abortFromParent, { once: true });

  const worker = async () => {
    while (!controller.signal.aborted) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        const value = await task(items[index], index, controller.signal);
        outcomes[index] = controller.signal.aborted && cancellationReason
          ? { status: "cancelled", index, reason: cancellationReason }
          : { status: "fulfilled", index, value };
      } catch (error) {
        if (controller.signal.aborted && cancellationReason) {
          outcomes[index] = { status: "cancelled", index, reason: cancellationReason };
          continue;
        }
        outcomes[index] = { status: "rejected", index, error };
        if (options.stopOnError?.(error)) {
          if (!cancellationReason) {
            cancellationReason = "fatal_error";
            controller.abort(error);
          }
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  options.signal?.removeEventListener("abort", abortFromParent);
  const reason = cancellationReason ?? "external_abort";
  return Array.from(
    { length: items.length },
    (_, index) => outcomes[index] ?? { status: "cancelled", index, reason },
  );
}
