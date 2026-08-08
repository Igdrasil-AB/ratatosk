/**
 * Row 16 — both repositories assert the identical fixture bytes.
 *
 * The fixtures under `test/fixtures/igdrasil-connect/` are the contract. They
 * are mirrored byte-for-byte into the Igdrasil repository, and BOTH sides hash
 * their own copy against `manifest.json`. Change a shape in one repository and
 * forget the other, and the manifest no longer matches on either side.
 *
 * This gate exists because the previous arrangement — "copy
 * `examples/igdrasil-connect-client.ts` into Igdrasil" — diverged for three
 * weeks with nothing able to notice: no build and no test spanned the two.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  contractFileHashes,
  sharedClientRegion,
  CONTRACT_CLIENT_FILE,
  CONTRACT_FIXTURE_DIR,
  DROP_IN_CLIENT_FILE,
  readContractManifest,
} from "../../scripts/build-contract-manifest";
import {
  IGDRASIL_CONNECT_ERROR_CODES,
  IGDRASIL_CONNECT_MESSAGE_TYPES,
  IGDRASIL_CONNECT_PROTOCOL,
  IGDRASIL_RELAYED_MESSAGE_TYPES,
} from "../../src/ingest/igdrasil-protocol";
import { IGDRASIL_INGEST_PATH } from "../../src/ingest/igdrasil-sink";

const fixture = (name: string) =>
  JSON.parse(readFileSync(`${CONTRACT_FIXTURE_DIR}/${name}`, "utf8")) as Record<string, never>;

const protocol = fixture("protocol-v2.json") as unknown as {
  protocol: number;
  tag: string;
  origin: string;
  tokenPattern: string;
  statePattern: string;
  errorCodes: string[];
  messages: Record<string, { relayedToWorker: boolean; request: string[]; response: string[] }>;
  presentAnnouncement: string[];
};
const ingest = fixture("ingest.json") as unknown as {
  method: string;
  path: string;
  headers: { sent: string[]; collector: string };
  fields: { required: string[]; optional: string[]; alwaysSentByCollector: string[] };
  importSource: string;
  slidingRenewal: { lifetimeDays: number; minimumAdvanceDays: number };
};
const token = fixture("token.json") as unknown as {
  mint: { method: string; path: string; request: { connection_state: string } };
  revoke: { method: string; path: string; idempotent: { status: number; collectorTreatsAsSuccess: boolean } };
  credential: { pattern: string; lifetimeDays: number; sessionJwtAccepted: boolean };
};

describe("Igdrasil shared contract fixtures", () => {
  it("hashes to the manifest both repositories carry", () => {
    // A mismatch here means one side edited a fixture. Regenerate with
    // `npx tsx scripts/build-contract-manifest.ts` and mirror BOTH the fixture
    // and the manifest into the other repository.
    expect(contractFileHashes(CONTRACT_FIXTURE_DIR)).toEqual(readContractManifest(CONTRACT_FIXTURE_DIR).files);
  });

  it("declares the same protocol version the code speaks", () => {
    expect(protocol.protocol).toBe(IGDRASIL_CONNECT_PROTOCOL);
    expect(readContractManifest(CONTRACT_FIXTURE_DIR).protocol).toBe(IGDRASIL_CONNECT_PROTOCOL);
  });

  it("declares exactly the message types and relay decisions the bridge implements", () => {
    expect(Object.keys(protocol.messages).sort()).toEqual([...IGDRASIL_CONNECT_MESSAGE_TYPES].sort());
    const relayed = Object.entries(protocol.messages)
      .filter(([, shape]) => shape.relayedToWorker)
      .map(([type]) => type)
      .sort();
    expect(relayed).toEqual([...IGDRASIL_RELAYED_MESSAGE_TYPES].sort());
  });

  it("declares exactly the refusal codes the protocol module can produce", () => {
    expect([...protocol.errorCodes].sort()).toEqual([...IGDRASIL_CONNECT_ERROR_CODES].sort());
  });

  it("pins the multi-company shape that makes this plan's whole point", () => {
    expect(protocol.messages["igdrasil:connect"].request).toContain("companyName");
    expect(protocol.messages["igdrasil:disconnect"].request).toEqual(["companyId"]);
    expect(protocol.messages["igdrasil:status"].response).toContain("companies");
    expect(protocol.presentAnnouncement).toContain("protocol");
  });

  it("pins the ingest wire format HttpSink actually builds", () => {
    expect(ingest.path).toBe(`/api${IGDRASIL_INGEST_PATH.replace("/api", "")}`);
    expect(ingest.method).toBe("POST");
    expect(ingest.headers.collector).toBe("invoice-collector-extension");
    // Every field the sink always sends must be one engine-api accepts.
    for (const field of ingest.fields.alwaysSentByCollector) {
      expect([...ingest.fields.required, ...ingest.fields.optional]).toContain(field);
    }
    expect(ingest.importSource).toBe("invoice_collector");
  });

  it("pins the credential contract both sides enforce", () => {
    expect(token.credential.pattern).toBe(protocol.tokenPattern);
    expect(token.credential.sessionJwtAccepted).toBe(false);
    expect(token.credential.lifetimeDays).toBe(ingest.slidingRenewal.lifetimeDays);
    // Disconnect stays idempotent only because a 401 counts as already-revoked.
    expect(token.revoke.idempotent.collectorTreatsAsSuccess).toBe(true);
    expect(token.revoke.path).toBe("/api/documents/ingest/token");
    expect(token.mint.request).toHaveProperty("connection_state");
  });

  it("keeps the drop-in web-app client on the same protocol", () => {
    const shared = sharedClientRegion(readFileSync(DROP_IN_CLIENT_FILE, "utf8"));
    expect(shared).toContain(`export const INVOICE_COLLECTOR_PROTOCOL = ${IGDRASIL_CONNECT_PROTOCOL};`);
    expect(shared).toContain(protocol.origin);
    // Every refusal code has to be expressible by the client, or the app has
    // no way to translate a failure it will nonetheless receive.
    for (const code of protocol.errorCodes) expect(shared).toContain(`"${code}"`);
    for (const type of IGDRASIL_CONNECT_MESSAGE_TYPES) expect(shared).toContain(`type: "${type}"`);
    // Disconnect names a company; a no-argument disconnect is protocol v1.
    expect(shared).toContain("disconnectInvoiceCollector(companyId: string)");
  });

  it("keeps the committed shared-client fixture identical to the drop-in client", () => {
    // The Igdrasil repository cannot read this one, so the canonical region is
    // committed as a fixture and hashed into the manifest. Igdrasil extracts
    // the SAME region from the client it actually ships and compares it to
    // this file — which is what makes a silent divergence impossible.
    const shared = sharedClientRegion(readFileSync(DROP_IN_CLIENT_FILE, "utf8"));
    expect(readFileSync(`${CONTRACT_FIXTURE_DIR}/${CONTRACT_CLIENT_FILE}`, "utf8")).toBe(shared);
    expect(shared).not.toContain("---8<---");
    expect(shared.length).toBeGreaterThan(1_000);
  });
});
