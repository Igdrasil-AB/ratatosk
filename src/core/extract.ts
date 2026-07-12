import type { Extractor, Transform } from "./types";
import { get } from "./jsonpath";
import { render } from "./template";

/**
 * Apply an {@link Extractor} to a JSON node: read a path, then run the optional
 * transform pipeline. Pure and synchronous — this is the heart of what vendor
 * tests exercise, so it must stay trivially predictable.
 */
export function extract(node: unknown, ex: Extractor): unknown {
  const spec = typeof ex === "string" ? { path: ex, transforms: undefined } : ex;
  let value = get(node, spec.path);
  for (const t of spec.transforms ?? []) value = applyTransform(value, t);
  return value;
}

/** Like {@link extract} but coerces to a trimmed string (or `undefined`). */
export function extractString(node: unknown, ex: Extractor | undefined): string | undefined {
  if (ex === undefined) return undefined;
  const v = extract(node, ex);
  return v === undefined || v === null ? undefined : String(v);
}

function applyTransform(value: unknown, t: Transform): unknown {
  switch (t.kind) {
    case "divide": {
      const n = typeof value === "number" ? value : Number(value);
      if (Number.isNaN(n)) return value;
      // Fixed to 2 decimals: money is the only thing we divide.
      return (n / t.by).toFixed(2);
    }
    case "date": {
      const input =
        t.epoch === "s" ? Number(value) * 1000 : t.epoch === "ms" ? Number(value) : value;
      const d = new Date(input as string | number);
      if (Number.isNaN(d.getTime())) return value;
      return d.toISOString().slice(0, 10); // YYYY-MM-DD
    }
    case "regex": {
      const m = String(value).match(new RegExp(t.pattern));
      return m ? m[t.group ?? 0] : undefined;
    }
    case "template":
      return render(t.pattern, { value: value as unknown });
    case "replace":
      return String(value).replace(new RegExp(t.pattern), t.with);
    case "trim":
      return String(value).trim();
    case "upper":
      return String(value).toUpperCase();
    case "lower":
      return String(value).toLowerCase();
  }
}
