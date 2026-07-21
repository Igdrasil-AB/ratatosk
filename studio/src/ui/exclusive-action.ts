/** Suppress overlapping UI actions while allowing a later retry after failure. */
export function exclusiveAction(work: () => Promise<void>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await work();
    } finally {
      running = false;
    }
  };
}
