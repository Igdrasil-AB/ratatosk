import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiscoveredSupplierProfile } from "../../src/core/discovery";
import type { VendorRecipe } from "../../src/core/types";
import {
  getDiscoveredSuppliers,
  removeDiscoveredSupplier,
  upsertDiscoveredSupplier,
} from "../../collector/src/platform/discovered-suppliers";

describe("local discovered supplier catalog", () => {
  const values: Record<string, unknown> = {};

  beforeEach(() => {
    for (const key of Object.keys(values)) delete values[key];
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: values[key] })),
          set: vi.fn(async (next: Record<string, unknown>) => { Object.assign(values, next); }),
        },
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("round-trips only validated profiles and removes them on disconnect", async () => {
    const profile = createDiscoveredSupplierProfile({
      primaryOrigin: "https://vendor.example",
      entryUrl: "https://vendor.example/billing",
      displayName: "Example Vendor",
      nameSource: "page",
      nameConfidence: "medium",
      adapterId: "network-json",
      candidateCount: 2,
      recipe: recipe(),
    });
    await upsertDiscoveredSupplier(profile);
    await expect(getDiscoveredSuppliers()).resolves.toEqual({ [profile.id]: profile });
    await removeDiscoveredSupplier(profile.id);
    await expect(getDiscoveredSuppliers()).resolves.toEqual({});
  });

  it("fails closed when local storage is corrupt or policy-invalid", async () => {
    values["discoveredSuppliers.v1"] = {
      broken: { schema: "ratatosk.discovered-supplier.v1", recipe: { hosts: ["<all_urls>"] } },
    };
    await expect(getDiscoveredSuppliers()).resolves.toEqual({});
  });

  it("upgrades an existing rendered-link profile with packaged bounded continuation", async () => {
    const profile = createDiscoveredSupplierProfile({
      primaryOrigin: "https://vendor.example",
      entryUrl: "https://vendor.example/billing",
      displayName: "Example Vendor",
      nameSource: "page",
      nameConfidence: "medium",
      adapterId: "dom-links",
      candidateCount: 2,
      recipe: domRecipe(),
    });
    values["discoveredSuppliers.v1"] = { [profile.id]: profile };

    const restored = (await getDiscoveredSuppliers())[profile.id];
    expect(restored.recipe.invoices.strategy).toBe("dom");
    if (restored.recipe.invoices.strategy === "dom") {
      expect(restored.recipe.invoices.list.continuation).toMatchObject({ mode: "auto", maxActions: 8 });
    }
  });

  it("rejects a new profile at capacity without evicting a connected profile", async () => {
    for (let index = 0; index < 50; index += 1) {
      await upsertDiscoveredSupplier(profileFor(index));
    }
    const before = await getDiscoveredSuppliers();
    expect(Object.keys(before)).toHaveLength(50);

    await expect(upsertDiscoveredSupplier(profileFor(50))).rejects.toThrow(/capacity/i);
    await expect(getDiscoveredSuppliers()).resolves.toEqual(before);
  });
});

function profileFor(index: number) {
  const profileOrigin = `https://vendor-${index}.example`;
  return createDiscoveredSupplierProfile({
    primaryOrigin: profileOrigin,
    entryUrl: `${profileOrigin}/billing/invoices`,
    displayName: `Example Vendor ${index}`,
    nameSource: "page",
    nameConfidence: "medium",
    adapterId: "network-json",
    candidateCount: 2,
    recipe: recipe(profileOrigin),
    now: new Date(1_700_000_000_000 + index),
  });
}

function recipe(recipeOrigin = "https://vendor.example"): VendorRecipe {
  return {
    id: "candidate",
    name: "Example Vendor",
    homepage: recipeOrigin,
    hosts: [`${recipeOrigin}/*`],
    fetchContext: "page",
    auth: { check: { request: { url: `${recipeOrigin}/api/invoices?limit=50` }, expect: { statusIn: [200] } }, loginUrl: recipeOrigin },
    invoices: {
      strategy: "network",
      list: {
        request: { url: `${recipeOrigin}/api/invoices?limit=50` },
        items: "invoices",
        map: { id: "id", issuedAt: "date", documentUrl: "pdf_url" },
      },
      document: { contentType: "application/pdf" },
    },
  };
}

function domRecipe(): VendorRecipe {
  return {
    id: "candidate",
    name: "Example Vendor",
    homepage: "https://vendor.example",
    hosts: ["https://vendor.example/*"],
    fetchContext: "page",
    auth: { check: { request: { url: "https://vendor.example/billing" }, expect: { statusIn: [200] } }, loginUrl: "https://vendor.example" },
    invoices: {
      strategy: "dom",
      list: {
        open: "https://vendor.example/billing",
        steps: [
          { action: "waitFor", selector: 'a[href$=".pdf"]', timeoutMs: 5_000 },
          { action: "extractAll", selector: 'a[href$=".pdf"]', attr: "href", as: "documents" },
        ],
        hrefsFrom: "documents",
      },
      document: { contentType: "application/pdf" },
    },
  };
}
