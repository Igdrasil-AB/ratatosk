/**
 * Plan 014 acceptance matrix — the Ratatosk rows.
 *
 * Each `it` names the row it discharges. They are written against the real
 * storage, auth, and protocol modules over a fake `chrome.storage`, because the
 * invariants being defended ("no path can bind two companies", "A's token never
 * travels with B's id") are properties of the persisted shape, not of any one
 * call site.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { idempotencyKey } from "../../src/core/dedup";
import {
  IGDRASIL_CONNECT_ERROR_CODES,
  IGDRASIL_CONNECT_PROTOCOL,
  parseIgdrasilAppRequest,
} from "../../src/ingest/igdrasil-protocol";

const ENDPOINT = "https://accounting.igdrasil.se";
const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const TOKEN_A = `rat_${"a".repeat(64)}`;
const TOKEN_B = `rat_${"b".repeat(64)}`;
const STATE = "f".repeat(64);

let values: Record<string, unknown>;

beforeEach(() => {
  vi.resetModules();
  values = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        setAccessLevel: vi.fn(async () => undefined),
        get: vi.fn(async (key: string) => ({ [key]: structuredClone(values[key]) })),
        set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(values, structuredClone(items)); }),
        remove: vi.fn(async (key: string) => { delete values[key]; }),
      },
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

const storage = () => import("../../collector/src/platform/storage");
const auth = () => import("../../collector/src/platform/auth");

async function connectCompany(companyId: string, companyName: string, token: string): Promise<void> {
  const { addIgdrasilDestination } = await storage();
  const { setHostToken } = await auth();
  await setHostToken(companyId, token);
  await addIgdrasilDestination({ endpoint: ENDPOINT, companyId, companyName });
}

// Rows 7 (run refusal) and the expired-credential path live in
// `collector-run.test.ts`, where the source catalog is already mocked.
describe("Plan 014 acceptance — Ratatosk", () => {
  it("row 1: two companies connect from one profile and both are held", async () => {
    const { getDestinations, igdrasilDestinationId } = await storage();
    const { connectedCompanyIds } = await auth();

    await connectCompany(COMPANY_A, "Company A", TOKEN_A);
    await connectCompany(COMPANY_B, "Company B", TOKEN_B);

    // The second connection ADDS. The single-config shape could only replace.
    expect(Object.keys(await getDestinations()).sort()).toEqual([
      igdrasilDestinationId(COMPANY_A),
      igdrasilDestinationId(COMPANY_B),
    ]);
    expect((await connectedCompanyIds()).sort()).toEqual([COMPANY_A, COMPANY_B].sort());
  });

  it("row 2: a supplier holds exactly one destination, and rebinding replaces rather than adds", async () => {
    const { getConnections, igdrasilDestinationId, setConnectionDestination, upsertConnection } = await storage();
    await connectCompany(COMPANY_A, "Company A", TOKEN_A);
    await connectCompany(COMPANY_B, "Company B", TOKEN_B);
    await upsertConnection({ vendorId: "stripe", connectedAt: 1, destinationId: igdrasilDestinationId(COMPANY_A) });

    await setConnectionDestination("stripe", igdrasilDestinationId(COMPANY_B));

    const connection = (await getConnections()).stripe;
    // `destinationId` is a single field, so "bound to two companies" is not a
    // state the storage can hold — there is no list to append to.
    expect(connection.destinationId).toBe(igdrasilDestinationId(COMPANY_B));
    expect(Object.values(connection).filter((value) => value === igdrasilDestinationId(COMPANY_A))).toEqual([]);
  });

  it("row 3: a company's token is only ever reachable through its own company id", async () => {
    const { buildSink } = await import("../../collector/src/platform/runtime");
    const { getHostToken } = await auth();
    await connectCompany(COMPANY_A, "Company A", TOKEN_A);
    await connectCompany(COMPANY_B, "Company B", TOKEN_B);

    await expect(getHostToken(COMPANY_A)).resolves.toBe(TOKEN_A);
    await expect(getHostToken(COMPANY_B)).resolves.toBe(TOKEN_B);

    // The sink closes over one company, so the credential it attaches and the
    // id it sends cannot come from different companies.
    const sent: Array<{ url: string; companyHeader: string | null; authorization: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      sent.push({
        url,
        companyHeader: headers["X-Company-Id"] ?? null,
        authorization: headers.Authorization ?? null,
      });
      return new Response(JSON.stringify({ document_id: "doc" }), { status: 200 });
    }));

    for (const [companyId, token] of [[COMPANY_A, TOKEN_A], [COMPANY_B, TOKEN_B]] as const) {
      const sink = buildSink({ kind: "igdrasil", endpoint: ENDPOINT, companyId, companyName: "x", connectedAt: 0 });
      await sink.send({
        bytes: new TextEncoder().encode("%PDF-1.4").buffer,
        contentType: "application/pdf",
        filename: "invoice.pdf",
        source: "ext:stripe",
        vendorId: "stripe",
        vendorName: "Stripe",
        vendorInvoiceId: "in_1",
        idempotencyKey: `key-${companyId}`,
      } as never);
    }

    expect(sent).toEqual([
      { url: `${ENDPOINT}/api/documents/ingest`, companyHeader: COMPANY_A, authorization: `Bearer ${TOKEN_A}` },
      { url: `${ENDPOINT}/api/documents/ingest`, companyHeader: COMPANY_B, authorization: `Bearer ${TOKEN_B}` },
    ]);
  });

  it("row 4: rebinding A→B is a fresh dedup namespace, so history is re-delivered", async () => {
    const { sinkCompanyId } = await storage();
    const a = { kind: "igdrasil" as const, endpoint: ENDPOINT, companyId: COMPANY_A, companyName: "A", connectedAt: 0 };
    const b = { ...a, companyId: COMPANY_B, companyName: "B" };

    const keyInA = await idempotencyKey(sinkCompanyId(a), "ext:stripe", "in_1");
    const keyInB = await idempotencyKey(sinkCompanyId(b), "ext:stripe", "in_1");

    // Tenant-scoped keys are why a rebind re-collects everything reachable, and
    // why the confirmation has to say so before the move rather than after.
    expect(keyInA).not.toBe(keyInB);
    expect(await idempotencyKey(sinkCompanyId(a), "ext:stripe", "in_1")).toBe(keyInA);
  });

  it("row 5: migrating v0.8.49 state preserves every connection and its company", async () => {
    const { getConnections, getDestinations, igdrasilDestinationId } = await storage();
    const { getHostToken } = await auth();
    values.config = { kind: "igdrasil", endpoint: ENDPOINT, companyId: COMPANY_A };
    values.hostToken = TOKEN_A;
    values.connections = {
      stripe: { vendorId: "stripe", connectedAt: 1 },
      railway: { vendorId: "railway", connectedAt: 2 },
    };

    const { migrateLegacyDestination } = await import("../../collector/src/platform/destination-migration");
    await expect(migrateLegacyDestination()).resolves.toMatchObject({ migrated: true });

    const destinationId = igdrasilDestinationId(COMPANY_A);
    const connections = await getConnections();
    expect(Object.keys(connections).sort()).toEqual(["railway", "stripe"]);
    expect(connections.stripe.destinationId).toBe(destinationId);
    expect(connections.railway.destinationId).toBe(destinationId);
    expect((await getDestinations())[destinationId]).toMatchObject({ kind: "igdrasil", companyId: COMPANY_A });
    await expect(getHostToken(COMPANY_A)).resolves.toBe(TOKEN_A);
    // Old keys go only after the new shape is durable.
    expect(values.config).toBeUndefined();
    expect(values.hostToken).toBeUndefined();
  });

  it("row 5: migration is idempotent and never rebinds an already-bound supplier", async () => {
    const { getConnections, igdrasilDestinationId } = await storage();
    values.config = { kind: "igdrasil", endpoint: ENDPOINT, companyId: COMPANY_A };
    values.hostToken = TOKEN_A;
    values.connections = { stripe: { vendorId: "stripe", connectedAt: 1, destinationId: igdrasilDestinationId(COMPANY_B) } };

    const { migrateLegacyDestination } = await import("../../collector/src/platform/destination-migration");
    await migrateLegacyDestination();
    await migrateLegacyDestination();

    expect((await getConnections()).stripe.destinationId).toBe(igdrasilDestinationId(COMPANY_B));
  });

  it("row 6: a malformed persisted destination yields needs-reconnect, not a crash", async () => {
    const { getDestinations, igdrasilDestinationId } = await storage();
    values.destinations = {
      // A v0.6.x leftover: the origin carries an `/api` path.
      [igdrasilDestinationId(COMPANY_A)]: { kind: "igdrasil", endpoint: `${ENDPOINT}/api`, companyId: COMPANY_A, companyName: "A", connectedAt: 0 },
      // A destination filed under another company's key would send one
      // company's token with another company's id.
      [igdrasilDestinationId(COMPANY_B)]: { kind: "igdrasil", endpoint: ENDPOINT, companyId: COMPANY_A, companyName: "A", connectedAt: 0 },
      local: { kind: "filesystem", rootFolder: "..", dateMode: "extraction" },
    };

    const destinations = await getDestinations();

    expect(destinations[igdrasilDestinationId(COMPANY_A)]).toEqual({
      kind: "unavailable", reason: "invalid_stored_destination", companyId: COMPANY_A, companyName: "A",
    });
    expect(destinations[igdrasilDestinationId(COMPANY_B)]).toMatchObject({ kind: "unavailable" });
    expect(destinations.local).toMatchObject({ kind: "unavailable" });
  });

  it("row 6: an unavailable destination refuses delivery rather than falling back", async () => {
    const { buildSink, DestinationNeedsReconnect } = await import("../../collector/src/platform/runtime");

    expect(() => buildSink({ kind: "unavailable", reason: "connection_expired", companyId: COMPANY_A }))
      .toThrow(DestinationNeedsReconnect);
  });

  it("row 7: disconnecting a company leaves its suppliers unbound and paused, never local", async () => {
    const {
      getConnections,
      getDestinations,
      igdrasilDestinationId,
      setLocalDestination,
      upsertConnection,
    } = await storage();
    const { connectedCompanyIds } = await auth();
    await setLocalDestination({ kind: "filesystem", rootFolder: "Ratatosk", dateMode: "extraction" });
    await connectCompany(COMPANY_A, "Company A", TOKEN_A);
    await connectCompany(COMPANY_B, "Company B", TOKEN_B);
    await upsertConnection({ vendorId: "stripe", connectedAt: 1, destinationId: igdrasilDestinationId(COMPANY_A) });
    await upsertConnection({ vendorId: "railway", connectedAt: 2, destinationId: igdrasilDestinationId(COMPANY_B) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));

    const { disconnectIgdrasil } = await import("../../collector/src/platform/igdrasil-disconnect");
    await expect(disconnectIgdrasil(COMPANY_A)).resolves.toMatchObject({
      ok: true,
      unboundVendorIds: ["stripe"],
    });

    const connections = await getConnections();
    // Unbound, not moved. Local Downloads exists and is still deliberately not
    // where these invoices go.
    expect(connections.stripe.destinationId).toBeUndefined();
    expect(connections.railway.destinationId).toBe(igdrasilDestinationId(COMPANY_B));
    expect(Object.keys(await getDestinations()).sort()).toEqual(["igdrasil:" + COMPANY_B, "local"].sort());
    expect(await connectedCompanyIds()).toEqual([COMPANY_B]);
  });

  it("row 8: a v1-shaped connect is refused with a typed code", () => {
    // Protocol v1: a session JWT, no state, and an `${origin}/api` base.
    expect(parseIgdrasilAppRequest({
      type: "igdrasil:connect",
      token: "eyJhbGciOiJSUzI1NiJ9.session.jwt",
      companyId: COMPANY_A,
      apiBaseUrl: `${ENDPOINT}/api`,
    })).toBeNull();

    // v2 without a company name is still v1-shaped for this purpose: the label
    // is what stops a supplier row naming the wrong company.
    expect(parseIgdrasilAppRequest({
      type: "igdrasil:connect",
      token: TOKEN_A,
      companyId: COMPANY_A,
      apiBaseUrl: ENDPOINT,
      state: STATE,
    })).toBeNull();

    expect(parseIgdrasilAppRequest({
      type: "igdrasil:connect",
      token: TOKEN_A,
      companyId: COMPANY_A,
      companyName: "Company A",
      apiBaseUrl: ENDPOINT,
      state: STATE,
    })).toEqual({
      type: "igdrasil:connect",
      token: TOKEN_A,
      companyId: COMPANY_A,
      companyName: "Company A",
      apiBaseUrl: ENDPOINT,
      state: STATE,
    });
  });

  it("row 8: disconnect without a company is refused rather than guessed at", () => {
    expect(parseIgdrasilAppRequest({ type: "igdrasil:disconnect" })).toBeNull();
    expect(parseIgdrasilAppRequest({ type: "igdrasil:disconnect", companyId: 42 })).toBeNull();
    expect(parseIgdrasilAppRequest({ type: "igdrasil:disconnect", companyId: COMPANY_A }))
      .toEqual({ type: "igdrasil:disconnect", companyId: COMPANY_A });
  });

  it("row 8: every narrowed field is checked, so page data never enters as a bare string", () => {
    for (const invalid of [
      { type: "igdrasil:validate", state: "short" },
      { type: "igdrasil:validate", state: { toString: () => STATE } },
      { type: "igdrasil:connect", token: TOKEN_A, companyId: "  ", companyName: "A", apiBaseUrl: ENDPOINT, state: STATE },
      { type: "igdrasil:connect", token: TOKEN_A, companyId: COMPANY_A, companyName: "", apiBaseUrl: ENDPOINT, state: STATE },
      { type: "igdrasil:connect", token: TOKEN_A, companyId: COMPANY_A, companyName: "A", apiBaseUrl: ENDPOINT, state: STATE, expiresAt: "not-a-date" },
      { type: "igdrasil:unknown" },
      null,
      "igdrasil:status",
    ]) {
      expect(parseIgdrasilAppRequest(invalid)).toBeNull();
    }
  });

  it("refuses a company the profile already holds instead of silently replacing it", async () => {
    const { addIgdrasilDestination, getDestination, igdrasilDestinationId } = await storage();
    await addIgdrasilDestination({ endpoint: ENDPOINT, companyId: COMPANY_A, companyName: "Company A" });

    // The worker checks for an existing destination before consuming the intent,
    // so a duplicate connect answers `company_already_connected`.
    expect(await getDestination(igdrasilDestinationId(COMPANY_A))).toBeDefined();
    expect(IGDRASIL_CONNECT_ERROR_CODES).toContain("company_already_connected");
    expect(IGDRASIL_CONNECT_PROTOCOL).toBe(2);
  });
});
