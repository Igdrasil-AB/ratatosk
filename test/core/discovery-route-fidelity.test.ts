import { describe, expect, it } from "vitest";
import { compileCandidates, type PageEvidence } from "../../collector/src/platform/discovery";

const base: Omit<PageEvidence, "html" | "resources"> = {
  url: "https://vendor.example/",
  origin: "https://vendor.example",
  title: "Vendor",
  navigationUrls: [],
  crossOriginHosts: [],
  stats: { documentLinks: 0, structuredData: 0, semanticControls: 0 },
};

describe("discovery route fidelity", () => {
  it("reopens the requested route when the application rewrites its address bar", () => {
    // The billing surface mounted for /settings/billing, but the application
    // settled the address bar back on its shell. Reopening "/" cannot restore
    // the surface, so the requested route is what the recipe must carry.
    const candidates = compileCandidates(
      { ...base, html: "<html><body></body></html>", resources: [], stats: { ...base.stats, semanticControls: 3 } },
      "https://vendor.example/",
      "Example Vendor",
      "https://vendor.example/settings/billing",
    );

    expect(candidates.map((candidate) => candidate.adapterId)).toEqual(["dom-actions"]);
    const recipe = candidates[0]?.recipe;
    expect(recipe?.invoices.strategy).toBe("dom");
    if (recipe?.invoices.strategy === "dom") {
      expect(recipe.invoices.list.open).toBe("https://vendor.example/settings/billing");
    }
  });

  it("can replay a proved semantic surface from a safe shell without persisting an opaque tenant route", () => {
    const candidates = compileCandidates(
      {
        ...base,
        url: "https://vendor.example/9012345678901/private/surface",
        html: "<html><body><h1>Invoices</h1><button>Download invoice</button></body></html>",
        resources: [],
        stats: {
          ...base.stats,
          semanticControls: 2,
          semanticNavigationSteps: 2,
          semanticNavigationStatus: "complete",
        },
      },
      "https://vendor.example/",
      "Example Vendor",
      "https://vendor.example/",
      null,
    );

    expect(candidates.map((candidate) => candidate.adapterId)).toEqual(["dom-actions"]);
    const recipe = candidates[0]?.recipe;
    expect(recipe?.invoices.strategy).toBe("dom");
    if (recipe?.invoices.strategy === "dom") {
      expect(recipe.invoices.list.open).toBe("https://vendor.example/");
      expect(JSON.stringify(recipe)).not.toContain("9012345678901");
    }
  });

  it("can verify a user-opened opaque billing surface from a safe shell", () => {
    const candidates = compileCandidates(
      {
        ...base,
        url: "https://vendor.example/9012345678901/private/billing",
        html: "<html><body><h1>Invoices</h1><button>Download invoice</button></body></html>",
        resources: [],
        stats: {
          ...base.stats,
          semanticControls: 1,
          semanticNavigationSteps: 0,
          semanticNavigationStatus: "disabled",
        },
      },
      "https://vendor.example/",
      "Example Vendor",
      "https://vendor.example/",
      null,
    );

    const recipe = candidates.find((candidate) => candidate.adapterId === "dom-actions")?.recipe;
    expect(recipe?.invoices.strategy).toBe("dom");
    if (recipe?.invoices.strategy === "dom") {
      expect(recipe.invoices.list.open).toBe("https://vendor.example/");
      expect(JSON.stringify(recipe)).not.toContain("9012345678901");
    }
  });

  it("can verify an active-only direct link without persisting its opaque route", () => {
    const candidates = compileCandidates(
      {
        ...base,
        url: "https://vendor.example/9012345678901/private/billing",
        html: '<html><body><h1>Invoices</h1><a href="/documents/invoice.pdf" aria-label="More"></a></body></html>',
        resources: [],
        stats: {
          ...base.stats,
          documentLinks: 1,
          semanticControls: 0,
          semanticNavigationSteps: 0,
          semanticNavigationStatus: "disabled",
        },
      },
      "https://vendor.example/",
      "Example Vendor",
      "https://vendor.example/",
      null,
    );

    expect(candidates.map((candidate) => candidate.adapterId)).toEqual(["dom-actions"]);
    const recipe = candidates[0]?.recipe;
    expect(recipe?.invoices.strategy).toBe("dom");
    if (recipe?.invoices.strategy === "dom") {
      expect(recipe.invoices.list.open).toBe("https://vendor.example/");
      expect(JSON.stringify(recipe)).not.toContain("9012345678901");
    }
  });

  it("keeps direct document links anchored to the requested route", () => {
    const candidates = compileCandidates(
      {
        ...base,
        html: '<html><h1>Billing</h1><body><a href="/invoices/one.pdf">Invoice</a></body></html>',
        resources: [],
      },
      "https://vendor.example/",
      "Example Vendor",
      "https://vendor.example/settings/billing",
    );

    const recipe = candidates.find((candidate) => candidate.adapterId === "dom-links")?.recipe;
    expect(recipe?.invoices.strategy).toBe("dom");
    if (recipe?.invoices.strategy === "dom") {
      expect(recipe.invoices.list.open).toBe("https://vendor.example/settings/billing");
    }
  });

  it("replays a captured response from the URL that served it, not the requested route", () => {
    // A network candidate replays a response we already hold. Its request URL
    // must stay the one that produced the body.
    const candidates = compileCandidates(
      {
        ...base,
        url: "https://vendor.example/account/billing",
        html: "<html></html>",
        resources: [{
          url: "https://vendor.example/api/invoices?limit=50",
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ invoices: [
            { id: "inv_1", created_at: "2026-07-01", amount_cents: 2500, currency: "sek", pdf_url: "/documents/inv_1.pdf" },
            { id: "inv_2", created_at: "2026-06-01", amount_cents: 4900, currency: "sek", pdf_url: "/documents/inv_2.pdf" },
          ] }),
        }],
      },
      "https://vendor.example/account/billing",
      "Example Vendor",
      "https://vendor.example/settings/billing",
    );

    const recipe = candidates.find((candidate) => candidate.adapterId === "network-json")?.recipe;
    expect(recipe?.invoices.strategy).toBe("network");
    if (recipe?.invoices.strategy === "network") {
      expect(recipe.invoices.list.request.url).toBe("https://vendor.example/api/invoices?limit=50");
    }
  });

  it("does not let a guessed billing route admit a site-wide download link", () => {
    // The route is a search hypothesis. Nothing this page rendered says the
    // application download belongs to an invoice.
    const candidates = compileCandidates(
      {
        ...base,
        url: "https://vendor.example/invoices",
        html: '<html><title>Vendor</title><body><h1>Ready when you are</h1><a href="/download">Download apps</a></body></html>',
        resources: [],
      },
      "https://vendor.example/invoices",
      "Example Vendor",
    );

    expect(candidates).toEqual([]);
  });

  it("still admits a download link on an independently billing-shaped page", () => {
    const candidates = compileCandidates(
      {
        ...base,
        url: "https://vendor.example/x",
        html: '<html><body><h1>Billing history</h1><a href="/download/statement-1">Statement</a></body></html>',
        resources: [],
      },
      "https://vendor.example/x",
      "Example Vendor",
    );

    expect(candidates.map((candidate) => candidate.adapterId)).toEqual(["dom-links"]);
  });

  it("re-finds every provider document host its own admission accepts", () => {
    // Admission accepts any Stripe document host. A recipe whose selector is
    // narrower than that fails a correct page as a selector miss.
    const candidates = compileCandidates(
      {
        ...base,
        url: "https://vendor.example/x",
        html: '<html><body><h1>Invoices</h1>' +
          '<a href="https://pay.stripe.com/invoice/acct_1/inv_1/pdf">Receipt</a>' +
          "</body></html>",
        resources: [],
      },
      "https://vendor.example/x",
      "Example Vendor",
    );

    const recipe = candidates.find((candidate) => candidate.adapterId === "dom-links")?.recipe;
    expect(recipe?.invoices.strategy).toBe("dom");
    if (recipe?.invoices.strategy === "dom") {
      const extract = recipe.invoices.list.steps.find((step) => step.action === "extractAll");
      expect(extract?.action).toBe("extractAll");
      if (extract?.action === "extractAll") {
        expect(extract.selector).toContain('a[href*="//pay.stripe.com/" i]');
        expect(extract.selector).toContain('a[href*="//invoice.stripe.com/" i]');
        expect(extract.selector).toContain('a[href*="//files.stripe.com/" i]');
      }
    }
  });
});
