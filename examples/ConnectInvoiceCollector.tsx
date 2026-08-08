/**
 * Example React component for the Igdrasil web app: connect a company to the
 * Invoice Collector, and list every company already connected. Copy into the
 * app (alongside `igdrasil-connect-client.ts`) and swap the three placeholder
 * hooks for your real auth + company context.
 *
 * Protocol v2 is multi-company: connecting ADDS a company, status returns them
 * all, and disconnect names one. There is deliberately no "active company"
 * notion here — showing the company the user happens to be looking at, rather
 * than the one a supplier actually feeds, is the defect this shape removes.
 *
 * This file is illustrative reference code (not built by the extension).
 */
import { useCallback, useEffect, useState } from "react";
import {
  collectorTokenFromResponse,
  connectInvoiceCollector,
  disconnectInvoiceCollector,
  disconnectInvoiceCollectorOutcome,
  getInvoiceCollectorStatus,
  isCollectorConnectionStale,
  pingInvoiceCollector,
  prepareInvoiceCollectorConnect,
  withValidatedInvoiceCollectorIntent,
  type ConnectedCompany,
  type InvoiceCollectorErrorCode,
} from "./igdrasil-connect-client";

const API_BASE_URL = "https://accounting.igdrasil.se"; // reviewed Collector API base
const STORE_URL = "https://chromewebstore.google.com/detail/<extension-id>";

// Replace these with your app's real hooks (e.g. Clerk's getToken + your company list).
declare function useIgdrasilGetToken(): () => Promise<string>;
declare function useSelectedCompany(): { id: string; name: string };
declare function useAccessibleCompanyIds(): readonly string[];

type State = "checking" | "not-installed" | "ready" | "working";

/** Every refusal the bridge can produce, mapped to app copy the user can act on. */
const COPY: Record<InvoiceCollectorErrorCode, string> = {
  intent_missing: "Start the connection again from Ratatosk.",
  intent_expired: "That connection request expired. Start again from Ratatosk.",
  origin_not_allowed: "Connect from the Igdrasil web app itself.",
  token_invalid: "Igdrasil issued a credential the extension refused. Try again.",
  backend_not_allowed: "The extension will only send invoices to accounting.igdrasil.se.",
  company_already_connected: "That company is already connected. Disconnect it first to reconnect.",
  unknown_company: "The extension is not connected to that company.",
  invalid_request: "The extension refused this request. Reload and try again.",
  revoke_failed: "The connection could not be revoked. It is still connected — try again.",
  extension_unavailable: "The Invoice Collector extension did not respond. Reload and try again.",
};

export function ConnectInvoiceCollector() {
  const getToken = useIgdrasilGetToken();
  const company = useSelectedCompany();
  const accessibleCompanyIds = useAccessibleCompanyIds();
  const [state, setState] = useState<State>("checking");
  const [companies, setCompanies] = useState<ConnectedCompany[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setState("checking");
    const { present } = await pingInvoiceCollector();
    if (!present) {
      setState("not-installed");
      return;
    }
    const status = await getInvoiceCollectorStatus();
    setCompanies(status.ok ? status.companies ?? [] : []);
    setState("ready");
    setError(status.ok ? null : COPY[status.code]);
  }, []);

  useEffect(() => {
    void refresh().catch(() => {
      setState("ready");
      setError("Could not check the Invoice Collector extension. Try again.");
    });
  }, [refresh]);

  const connect = async () => {
    setState("working");
    setError(null);
    try {
      const prepared = await prepareInvoiceCollectorConnect();
      if (!prepared.ok || !prepared.state) {
        setError(prepared.ok ? COPY.intent_missing : COPY[prepared.code]);
        await refresh();
        return;
      }
      const minted = await withValidatedInvoiceCollectorIntent(prepared.state, () => fetch(
        `${API_BASE_URL}/api/v1/integrations/invoice-collector/token`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${await getToken()}`,
            "Content-Type": "application/json",
            "X-Company-Id": company.id,
          },
          // The backend must bind this to its own short-lived, one-use minting
          // transaction; do not mint a Collector credential without it.
          body: JSON.stringify({ connection_state: prepared.state }),
        },
      ));
      if (!minted.ok) {
        setError(COPY[minted.code]);
        await refresh();
        return;
      }
      const response = minted.value;
      if (!response.ok) {
        setError("Could not create a secure Collector connection.");
        await refresh();
        return;
      }
      const body = (await response.json()) as { expires_at?: string };
      const token = collectorTokenFromResponse(body);
      if (!token) {
        setError("The server did not return a valid upload-only Collector credential.");
        await refresh();
        return;
      }
      const res = await connectInvoiceCollector({
        token,
        companyId: company.id,
        companyName: company.name,
        apiBaseUrl: API_BASE_URL,
        state: prepared.state,
        ...(body.expires_at ? { expiresAt: body.expires_at } : {}),
      });
      if (!res.ok) setError(COPY[res.code]);
      await refresh();
    } catch {
      setError("Could not complete the secure Collector connection. Try again.");
      await refresh();
    }
  };

  const disconnect = async (companyId: string) => {
    setState("working");
    setError(null);
    try {
      // Transition to disconnected ONLY on { ok: true }. A refusal or a timeout
      // leaves the connection standing and offers a retry; claiming success
      // here would tell the user a live credential had been revoked.
      const outcome = disconnectInvoiceCollectorOutcome(await disconnectInvoiceCollector(companyId));
      if (outcome.code) setError(COPY[outcome.code]);
      await refresh();
    } catch {
      setError("Could not disconnect Invoice Collector. Try again.");
      await refresh();
    }
  };

  if (state === "checking") return <span>Checking for Invoice Collector…</span>;
  if (state === "not-installed")
    return (
      <a href={STORE_URL} target="_blank" rel="noreferrer">
        Install Invoice Collector
      </a>
    );

  const alreadyConnected = companies.some((connected) => connected.companyId === company.id);

  return (
    <div>
      <ul>
        {companies.map((connected) => {
          // A company connected in this browser that the signed-in user cannot
          // reach is worth saying out loud rather than rendering as normal.
          const inaccessible = !accessibleCompanyIds.includes(connected.companyId);
          return (
            <li key={connected.companyId}>
              <strong>{connected.companyName}</strong>
              <span>
                {connected.supplierCount} supplier{connected.supplierCount === 1 ? "" : "s"}
              </span>
              {inaccessible && <span role="note">Connected in this browser, but not to your account.</span>}
              {isCollectorConnectionStale(connected) && (
                <span role="note">No invoices collected for 60 days. Collect something to keep this connection alive.</span>
              )}
              <button onClick={() => void disconnect(connected.companyId)} disabled={state === "working"}>
                Disconnect
              </button>
            </li>
          );
        })}
      </ul>
      <button onClick={connect} disabled={state === "working" || alreadyConnected}>
        {state === "working" ? "Connecting…" : `Connect ${company.name}`}
      </button>
      {error && <p role="alert">Invoice Collector action failed: {error}</p>}
    </div>
  );
}
