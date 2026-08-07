import { describe, expect, it } from "vitest";
import { deriveSupplierDisplayName, withSupplierDisplayName, createDiscoveredSupplierProfile } from "../../src/core/discovery";
import type { VendorRecipe } from "../../src/core/types";

/**
 * Naming is inference, not configuration: nothing here may depend on knowing a
 * particular supplier in advance. Each test states which independent sources
 * agree, and the expected name follows from that alone.
 */

function pages(...titles: string[]) {
  return titles.map((title) => ({ title }));
}

describe("supplier display name", () => {
  it("prefers the domain over a page title that only names a route", () => {
    // The reported case: Clerk's billing route is titled "Overview", which
    // corroborates nothing, while the origin already names the party.
    expect(deriveSupplierDisplayName({
      origin: "https://dashboard.clerk.com",
      observations: pages("Overview", "Invoices", "Settings"),
    })).toEqual({ name: "Clerk", source: "domain", confidence: "low" });
  });

  it("takes a page name the domain corroborates", () => {
    expect(deriveSupplierDisplayName({
      origin: "https://dashboard.clerk.com",
      observations: pages("Overview | Clerk"),
    })).toEqual({ name: "Clerk", source: "page", confidence: "medium" });

    // Spacing and punctuation differ between DNS and display; the party does not.
    expect(deriveSupplierDisplayName({
      origin: "https://app.my-vendor.com",
      observations: pages("Billing – My Vendor"),
    })).toEqual({ name: "My Vendor", source: "page", confidence: "medium" });
  });

  it("keeps what follows the label but drops a trailing page word", () => {
    expect(deriveSupplierDisplayName({
      origin: "https://billing.example.com",
      observations: pages("Invoices | Example Cloud"),
    }).name).toBe("Example Cloud");

    expect(deriveSupplierDisplayName({
      origin: "https://dashboard.clerk.com",
      observations: pages("Clerk Dashboard"),
    }).name).toBe("Clerk");
  });

  it("takes the fragment that survives across differing pages", () => {
    // The brand is what two unlike routes have in common. Here it matches no
    // part of the domain, so only cross-page agreement can find it.
    expect(deriveSupplierDisplayName({
      origin: "https://console.acme-hosting-eu.io",
      observations: pages("Overview · Northwind", "Invoices · Northwind"),
    })).toEqual({ name: "Northwind", source: "page", confidence: "medium" });
  });

  it("does not treat one page seen twice as agreement", () => {
    expect(deriveSupplierDisplayName({
      origin: "https://console.acme-hosting-eu.io",
      observations: pages("Northwind Overview", "Northwind Overview"),
    }).source).toBe("domain");
  });

  it("uses a site-wide declaration before the domain", () => {
    expect(deriveSupplierDisplayName({
      origin: "https://console.acme-hosting-eu.io",
      observations: [{ title: "Overview", siteName: "Northwind" }],
    })).toEqual({ name: "Northwind", source: "page", confidence: "medium" });
  });

  it("does not depend on the order pages were probed in", () => {
    const titles = ["Overview", "Invoices | Clerk", "Settings"];
    const forward = deriveSupplierDisplayName({ origin: "https://dashboard.clerk.com", observations: pages(...titles) });
    const reversed = deriveSupplierDisplayName({ origin: "https://dashboard.clerk.com", observations: pages(...[...titles].reverse()) });

    expect(forward).toEqual(reversed);
    expect(forward.name).toBe("Clerk");
  });

  it("re-stamps a compiled profile without touching its recipe", () => {
    const origin = "https://dashboard.clerk.com";
    const recipe: VendorRecipe = {
      id: "candidate",
      name: "Overview",
      homepage: origin,
      hosts: [`${origin}/*`],
      fetchContext: "page",
      auth: { check: { request: { url: `${origin}/api/me` }, expect: { statusIn: [200] } }, loginUrl: origin },
      invoices: {
        strategy: "network",
        list: { request: { url: `${origin}/api/invoices` }, items: "invoices", map: { id: "id", issuedAt: "issued_at", documentUrl: "pdf_url" } },
        document: { contentType: "application/pdf" },
      },
    };
    const profile = createDiscoveredSupplierProfile({
      primaryOrigin: origin,
      entryUrl: `${origin}/settings/billing`,
      displayName: "Overview",
      nameSource: "page",
      nameConfidence: "medium",
      adapterId: "network-json",
      candidateCount: 3,
      recipe,
    });

    const renamed = withSupplierDisplayName(profile, { name: "Clerk", source: "domain", confidence: "low" });

    expect(renamed.displayName).toBe("Clerk");
    expect(renamed.recipe.name).toBe("Clerk");
    expect(renamed.nameSource).toBe("domain");
    // Identity and behavior are settled before the name is; neither may move.
    expect(renamed.id).toBe(profile.id);
    expect(renamed.recipe.invoices).toEqual(profile.recipe.invoices);
    expect(renamed.entryUrl).toBe(profile.entryUrl);
  });
});
