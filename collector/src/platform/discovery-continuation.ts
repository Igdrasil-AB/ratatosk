import { getSupplierDiscoveryStatus } from "./discovery-state";

type DiscoveryStatusReader = typeof getSupplierDiscoveryStatus;
type HostPermissionReader = (origin: string) => Promise<boolean>;

/** Recheck both run ownership and current host consent between discovery steps. */
export async function canContinueSupplierDiscovery(
  expectedOrigin: string,
  readStatus: DiscoveryStatusReader = getSupplierDiscoveryStatus,
  hasPermission: HostPermissionReader = (origin) => chrome.permissions.contains({ origins: [`${origin}/*`] }),
): Promise<boolean> {
  const current = await readStatus();
  if (current.stage !== "scanning" || current.origin !== expectedOrigin) return false;
  return await hasPermission(expectedOrigin);
}
