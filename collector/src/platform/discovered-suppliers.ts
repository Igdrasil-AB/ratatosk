import {
  parseDiscoveredSupplierProfile,
  type DiscoveredSupplierProfileV1,
} from "../../../src/core/discovery";

const KEY = "discoveredSuppliers.v1";
const PROFILE_CAP = 50;
let writeChain = Promise.resolve();

export class DiscoveredSupplierCapacityError extends Error {
  constructor() {
    super(`discovered supplier capacity of ${PROFILE_CAP} reached`);
    this.name = "DiscoveredSupplierCapacityError";
  }
}

export async function getDiscoveredSuppliers(): Promise<Record<string, DiscoveredSupplierProfileV1>> {
  await writeChain;
  const raw = (await chrome.storage.local.get(KEY))[KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const valid: Record<string, DiscoveredSupplierProfileV1> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>).slice(0, PROFILE_CAP)) {
    try {
      const profile = withCurrentPackagedBehavior(parseDiscoveredSupplierProfile(value));
      if (profile.id === id) valid[id] = profile;
    } catch {
      // Fail closed. Corrupt or legacy local data never reaches the recipe engine.
    }
  }
  return valid;
}

/** Existing local DOM profiles automatically gain the packaged revision-4 continuation primitive. */
function withCurrentPackagedBehavior(profile: DiscoveredSupplierProfileV1): DiscoveredSupplierProfileV1 {
  if (profile.adapter.id !== "dom-links" || profile.recipe.invoices.strategy !== "dom" || profile.recipe.invoices.list.continuation) {
    return profile;
  }
  const upgraded = structuredClone(profile);
  if (upgraded.recipe.invoices.strategy === "dom") {
    upgraded.recipe.invoices.list.continuation = {
      mode: "auto",
      maxActions: 8,
      maxDocuments: 500,
      timeoutMs: 30_000,
      allowScroll: true,
    };
  }
  return parseDiscoveredSupplierProfile(upgraded);
}

export async function getDiscoveredSupplier(id: string): Promise<DiscoveredSupplierProfileV1 | undefined> {
  return (await getDiscoveredSuppliers())[id];
}

export async function upsertDiscoveredSupplier(profile: DiscoveredSupplierProfileV1): Promise<void> {
  const validated = parseDiscoveredSupplierProfile(profile);
  await enqueue(async () => {
    const current = await readRaw();
    const valid = validProfiles(current);
    if (!valid.some((item) => item.id === validated.id) && valid.length >= PROFILE_CAP) {
      throw new DiscoveredSupplierCapacityError();
    }
    current[validated.id] = validated;
    const ordered = validProfiles(current)
      .sort((left, right) => Date.parse(right.discoveredAt) - Date.parse(left.discoveredAt));
    await chrome.storage.local.set({
      [KEY]: Object.fromEntries(ordered.map((value) => [value.id, value])),
    });
  });
}

/** Preflight capacity before a canary can deliver a document to its sink. */
export async function assertDiscoveredSupplierCapacity(id: string): Promise<void> {
  await writeChain;
  const valid = validProfiles(await readRaw());
  if (!valid.some((profile) => profile.id === id) && valid.length >= PROFILE_CAP) {
    throw new DiscoveredSupplierCapacityError();
  }
}

export async function removeDiscoveredSupplier(id: string): Promise<void> {
  await enqueue(async () => {
    const current = await readRaw();
    delete current[id];
    await chrome.storage.local.set({ [KEY]: current });
  });
}

async function readRaw(): Promise<Record<string, unknown>> {
  const raw = (await chrome.storage.local.get(KEY))[KEY];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
}

function validProfiles(values: Record<string, unknown>): DiscoveredSupplierProfileV1[] {
  return Object.values(values)
    .map((value) => {
      try { return parseDiscoveredSupplierProfile(value); } catch { return undefined; }
    })
    .filter((value): value is DiscoveredSupplierProfileV1 => Boolean(value));
}

async function enqueue(operation: () => Promise<void>): Promise<void> {
  const current = writeChain.then(operation, operation);
  writeChain = current.catch(() => undefined);
  await current;
}
