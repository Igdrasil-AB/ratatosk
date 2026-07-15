/**
 * Example React component for the Igdrasil web app: a one-click "Connect Invoice
 * Collector" control. Copy into the app (alongside `igdrasil-connect-client.ts`)
 * and swap the two placeholder hooks for your real auth + company context.
 *
 * This file is illustrative reference code (not built by the extension).
 */
import { useEffect, useState } from "react";
import {
  connectInvoiceCollector,
  disconnectInvoiceCollector,
  getInvoiceCollectorStatus,
  pingInvoiceCollector,
  prepareInvoiceCollectorConnect,
} from "./igdrasil-connect-client";

const API_BASE_URL = "https://api.igdrasil.se"; // your engine-api base
const STORE_URL = "https://chromewebstore.google.com/detail/<extension-id>";

// Replace these with your app's real hooks (e.g. Clerk's getToken + your company context).
declare function useIgdrasilGetToken(): () => Promise<string>;
declare function useActiveCompanyId(): string;

type State = "checking" | "not-installed" | "disconnected" | "connected" | "working";

export function ConnectInvoiceCollector() {
  const getToken = useIgdrasilGetToken();
  const companyId = useActiveCompanyId();
  const [state, setState] = useState<State>("checking");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { present } = await pingInvoiceCollector();
      if (cancelled) return;
      if (!present) return setState("not-installed");
      const status = await getInvoiceCollectorStatus();
      if (!cancelled) setState(status.ok && status.connected ? "connected" : "disconnected");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = async () => {
    setState("working");
    setError(null);
    const prepared = await prepareInvoiceCollectorConnect();
    if (!prepared.ok || !prepared.state) {
      setState("disconnected");
      setError(prepared.ok ? "The extension did not create a connection request." : prepared.error);
      return;
    }
    const response = await fetch(`${API_BASE_URL}/integrations/invoice-collector/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await getToken()}`, "X-Company-Id": companyId },
    });
    if (!response.ok) {
      setState("disconnected");
      setError("Could not create a secure Collector connection.");
      return;
    }
    const { token } = (await response.json()) as { token: string };
    const res = await connectInvoiceCollector({
      token,
      companyId,
      apiBaseUrl: API_BASE_URL,
      state: prepared.state,
    });
    if (res.ok) setState("connected");
    else {
      setState("disconnected");
      setError(res.error);
    }
  };

  const disconnect = async () => {
    setState("working");
    await disconnectInvoiceCollector();
    setState("disconnected");
  };

  if (state === "checking") return <span>Checking for Invoice Collector…</span>;
  if (state === "not-installed")
    return (
      <a href={STORE_URL} target="_blank" rel="noreferrer">
        Install Invoice Collector
      </a>
    );

  return (
    <div>
      {state === "connected" ? (
        <button onClick={disconnect}>Disconnect Invoice Collector</button>
      ) : (
        <button onClick={connect} disabled={state === "working"}>
          {state === "working" ? "Connecting…" : "Connect Invoice Collector"}
        </button>
      )}
      {error && <p role="alert">Couldn’t connect: {error}</p>}
    </div>
  );
}
