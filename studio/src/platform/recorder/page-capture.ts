/**
 * Silent MAIN-world capture is deliberately disabled.
 *
 * A page-visible relay cannot carry request headers or bodies safely: any page
 * script can observe a page-visible relay before extension-side sanitization.
 * Studio therefore uses the extension-private chrome.debugger backend for all
 * recording. Keeping this explicit function avoids a future caller quietly
 * reintroducing an unsafe fallback.
 */
export async function startPageCapture(_tabId: number): Promise<never> {
  throw new Error("Silent page capture is disabled; use the debugger recorder");
}
