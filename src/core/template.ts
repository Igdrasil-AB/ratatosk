import { TemplateError } from "./errors";

/**
 * Interpolate `{name}` placeholders from a flat variable bag.
 *
 *   render("https://{host}/inv/{id}.pdf", { host: "x.com", id: "9" })
 *   // => "https://x.com/inv/9.pdf"
 *
 * A missing variable is a hard error rather than an empty string, so a broken
 * recipe fails loudly during testing instead of silently fetching a bad URL.
 */
export function render(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined || value === null) {
      throw new TemplateError(`missing template variable "{${key}}" in: ${tpl}`);
    }
    return String(value);
  });
}

/** Render every value in a headers map. */
export function renderHeaders(
  headers: Record<string, string> | undefined,
  vars: Record<string, unknown>,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = render(v, vars);
  return out;
}
