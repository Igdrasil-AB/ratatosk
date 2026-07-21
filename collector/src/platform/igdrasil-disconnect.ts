import { clearHostToken, getHostToken } from "./auth";
import { clearSinkConfig, getSinkConfig } from "./storage";
import { isIgdrasilApiBase, normalizeIgdrasilApiBase } from "../../../src/ingest/igdrasil-sink";

export type IgdrasilDisconnectResult = { ok: true } | { ok: false; error: string };

const productionDependencies = {
  getSinkConfig,
  getHostToken,
  clearHostToken,
  clearSinkConfig,
  fetch: (input: string, init: RequestInit) => fetch(input, init),
};

export async function disconnectIgdrasil(
  dependencies: typeof productionDependencies = productionDependencies,
): Promise<IgdrasilDisconnectResult> {
  const cfg = await dependencies.getSinkConfig();
  const token = await dependencies.getHostToken();
  if (cfg?.kind === "igdrasil" && token) {
    if (!isIgdrasilApiBase(cfg.endpoint)) {
      await dependencies.clearHostToken();
      await dependencies.clearSinkConfig();
      return { ok: false, error: "Igdrasil connection uses an untrusted backend; reconnect it" };
    }
    const response = await dependencies.fetch(`${normalizeIgdrasilApiBase(cfg.endpoint)}/api/documents/ingest/token`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Company-Id": cfg.companyId,
      },
    });
    if (!response.ok && response.status !== 401) {
      return { ok: false, error: "could not revoke the Igdrasil connection; try again" };
    }
  }
  await dependencies.clearHostToken();
  await dependencies.clearSinkConfig();
  return { ok: true };
}
