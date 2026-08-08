import { clearHostToken, getHostToken } from "./auth";
import {
  getDestination,
  igdrasilDestinationId,
  removeDestination,
  unbindConnectionsFrom,
} from "./storage";
import { isIgdrasilApiBase, normalizeIgdrasilApiBase } from "../../../src/ingest/igdrasil-sink";
import {
  igdrasilRefusal,
  IGDRASIL_CONNECT_PROTOCOL,
  type IgdrasilAppResponse,
} from "../../../src/ingest/igdrasil-protocol";

export type IgdrasilDisconnectResult = IgdrasilAppResponse & { unboundVendorIds?: string[] };

const productionDependencies = {
  getDestination,
  getHostToken,
  clearHostToken,
  removeDestination,
  unbindConnectionsFrom,
  fetch: (input: string, init: RequestInit) => fetch(input, init),
};

/**
 * Disconnect ONE company.
 *
 * Its suppliers are left unbound and paused, and reported so the panel can name
 * them. They are never moved to another destination — reverting them to
 * Downloads would deliver invoices somewhere the user never chose, which is the
 * invariant `docs/igdrasil-connect.md` exists to protect.
 */
export async function disconnectIgdrasil(
  companyId: string,
  dependencies: typeof productionDependencies = productionDependencies,
): Promise<IgdrasilDisconnectResult> {
  const destinationId = igdrasilDestinationId(companyId);
  const destination = await dependencies.getDestination(destinationId);
  if (!destination) return igdrasilRefusal("unknown_company");

  const token = await dependencies.getHostToken(companyId);
  if (destination.kind === "igdrasil" && token) {
    if (!isIgdrasilApiBase(destination.endpoint)) {
      // Nothing to revoke against a host this build will not talk to, but the
      // local credential must not survive the discovery either.
      await dependencies.clearHostToken(companyId);
      await dependencies.removeDestination(destinationId);
      const unboundVendorIds = await dependencies.unbindConnectionsFrom(destinationId);
      return { ...igdrasilRefusal("backend_not_allowed"), unboundVendorIds };
    }
    const response = await dependencies.fetch(
      `${normalizeIgdrasilApiBase(destination.endpoint)}/api/documents/ingest/token`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Company-Id": destination.companyId,
        },
      },
    );
    // 401 means the credential is already gone server-side, so disconnect stays
    // idempotent. Anything else retryable keeps the connected state.
    if (!response.ok && response.status !== 401) return igdrasilRefusal("revoke_failed");
  }

  await dependencies.clearHostToken(companyId);
  await dependencies.removeDestination(destinationId);
  const unboundVendorIds = await dependencies.unbindConnectionsFrom(destinationId);
  return { ok: true, protocol: IGDRASIL_CONNECT_PROTOCOL, unboundVendorIds };
}
