/**
 * One-time, idempotent migration from the single-destination shape (≤ v0.8.49)
 * to the destination map.
 *
 * Rules this cannot break, because losing them is worse than not migrating:
 *   - no connection is lost;
 *   - no connection is rebound to a company the user did not choose;
 *   - a destination that no longer validates becomes needs-reconnect, never
 *     Downloads, and never a crash in the service worker;
 *   - the old keys are removed only after the new shape has been written.
 */
import {
  clearLegacyHostToken,
  readLegacyHostToken,
  setHostToken,
} from "./auth";
import {
  clearLegacySinkConfig,
  getConnections,
  getDestinations,
  igdrasilDestinationId,
  LOCAL_DESTINATION_ID,
  readLegacySinkConfig,
  validateDestination,
  writeMigratedDestinations,
  type Destination,
  type DestinationId,
  type DestinationMap,
  type LegacySinkConfig,
} from "./storage";

export interface DestinationMigrationResult {
  migrated: boolean;
  destinationId?: DestinationId;
  boundVendorIds: string[];
}

/**
 * Runs on service-worker start. Idempotent: with no legacy config there is
 * nothing to do, and a profile that already has destinations is left alone.
 */
export async function migrateLegacyDestination(): Promise<DestinationMigrationResult> {
  const legacy = await readLegacySinkConfig();
  if (!legacy) {
    // A profile with a legacy token but no legacy config would otherwise keep a
    // credential nothing can reach. Clearing it is safe: without a destination
    // it was already unusable.
    await clearLegacyHostToken();
    return { migrated: false, boundVendorIds: [] };
  }

  const existing = await getDestinations();
  const legacyToken = await readLegacyHostToken();
  const { id, destination } = legacyDestination(legacy);

  const destinations: DestinationMap = { ...existing };
  // An already-migrated destination wins: re-running must not overwrite a
  // company the user has since reconnected or renamed.
  if (!(id in destinations)) destinations[id] = destination;

  const bindings: Record<string, DestinationId> = {};
  for (const [vendorId, connection] of Object.entries(await getConnections())) {
    if (connection.destinationId) continue;
    bindings[vendorId] = id;
  }

  const companyId = legacyCompanyId(legacy);
  await writeMigratedDestinations(destinations, bindings);
  // Merge, never replace. The migration only stops re-running once
  // `clearLegacySinkConfig` has committed, so a worker killed between the two
  // writes runs it again — by which time the user may have connected another
  // company. Replacing the map would leave that company's destination standing
  // with no credential, which is a 401 and an unrepairable state.
  if (legacyToken && companyId) await setHostToken(companyId, legacyToken);

  // Only now: the new shape is durable, so removing the old keys cannot strand
  // a profile between the two.
  await clearLegacySinkConfig();
  await clearLegacyHostToken();

  return { migrated: true, destinationId: id, boundVendorIds: Object.keys(bindings) };
}

function legacyCompanyId(legacy: LegacySinkConfig): string | undefined {
  return legacy.kind === "filesystem" ? undefined : legacy.companyId?.trim() || undefined;
}

function legacyDestination(legacy: LegacySinkConfig): { id: DestinationId; destination: Destination } {
  if (legacy.kind === "filesystem") {
    try {
      return { id: LOCAL_DESTINATION_ID, destination: validateDestination({ ...legacy }) };
    } catch {
      return {
        id: LOCAL_DESTINATION_ID,
        destination: { kind: "unavailable", reason: "invalid_stored_destination" },
      };
    }
  }

  const companyId = legacyCompanyId(legacy) ?? "unknown";
  const id = igdrasilDestinationId(companyId);
  // A `http` destination was never an Igdrasil connection and has no company
  // name; an `igdrasil` one written by v0.6.x carries an `/api` path that fails
  // origin validation. Both become needs-reconnect rather than silently
  // continuing to deliver somewhere the current build cannot vouch for.
  if (legacy.kind === "http") {
    return { id, destination: { kind: "unavailable", reason: "invalid_stored_destination", companyId } };
  }
  try {
    return {
      id,
      destination: validateDestination({
        kind: "igdrasil",
        endpoint: legacy.endpoint,
        companyId,
        // The pre-v2 protocol never carried a company name. Showing the id is
        // honest; inventing a name, or borrowing the active company's, is the
        // exact defect multi-company exists to remove.
        companyName: companyId,
        connectedAt: Date.now(),
      }),
    };
  } catch {
    return { id, destination: { kind: "unavailable", reason: "invalid_stored_destination", companyId } };
  }
}
