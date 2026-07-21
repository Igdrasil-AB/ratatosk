/** Studio records only pages whose transport protects captured billing traffic. */
export function isSecureRecordingPage(url: string | undefined): url is string {
  if (!url) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
