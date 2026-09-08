import { readFileSync } from "node:fs";
import { parseLiveAcceptanceSnapshot } from "../src/core/live-acceptance";

const snapshot = parseLiveAcceptanceSnapshot(JSON.parse(readFileSync(0, "utf8")));
const expected = {
  hostname: option("--hostname"),
  stage: option("--stage"),
  collectorVersion: option("--collector-version"),
  discoveryRevision: Number(option("--discovery-revision")),
  acquisitionRevision: Number(option("--acquisition-revision")),
  sessionNonce: option("--session-nonce"),
};
if (
  snapshot.hostname !== expected.hostname || snapshot.stage !== expected.stage ||
  snapshot.runtime.collectorVersion !== expected.collectorVersion ||
  snapshot.runtime.discoveryRevision !== expected.discoveryRevision ||
  snapshot.runtime.acquisitionRevision !== expected.acquisitionRevision ||
  snapshot.sessionNonce !== expected.sessionNonce
) throw new Error("live snapshot does not match the approved hostname, stage, or prepared runtime");
console.log(JSON.stringify(snapshot));

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}
