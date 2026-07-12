/**
 * A deliberately tiny "dotted pointer" resolver.
 *
 * This is NOT full JSONPath. It supports the 95% case that vendor billing APIs
 * actually need: dotted keys and numeric array indices, with an optional leading
 * `$`. That keeps the recipe language predictable and dependency-free.
 *
 *   get({ a: { b: [ { c: 1 } ] } }, "a.b.0.c")  // => 1
 *   get(obj, "$")                                // => obj
 *
 * If you find yourself wanting `$..` or filters, prefer capturing a cleaner
 * endpoint in the recipe instead of a cleverer path.
 */
export function get(obj: unknown, path: string): unknown {
  if (path === "" || path === "$") return obj;
  const parts = path.replace(/^\$\.?/, "").split(".").filter(Boolean);
  let cur: unknown = obj;
  for (const key of parts) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Resolve a path that must point at an array; returns `[]` when absent. */
export function getArray(obj: unknown, path: string): unknown[] {
  const v = get(obj, path);
  return Array.isArray(v) ? v : [];
}
