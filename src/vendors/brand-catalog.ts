/**
 * Presentation-only brand hints for generically discovered suppliers.
 *
 * These entries never select a route, API, selector, permission, or collection
 * recipe. Keeping branding separate lets a familiar supplier retain its logo
 * while all acquisition behavior comes from the generic discovery engine.
 */
const ICON_BY_ORIGIN: Readonly<Record<string, string>> = Object.freeze({
  "https://chatgpt.com": "openai",
  "https://claude.ai": "anthropic",
});

export function knownSupplierIcon(origin: string): string | undefined {
  try {
    return ICON_BY_ORIGIN[new URL(origin).origin];
  } catch {
    return undefined;
  }
}
