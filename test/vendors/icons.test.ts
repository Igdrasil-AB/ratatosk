import { describe, expect, it } from "vitest";
import { brandIcon, iconSlugs } from "../../src/vendors/icons";
import { ALL_VENDORS } from "../../src/vendors";
import { knownSupplierIcon } from "../../src/vendors/brand-catalog";

/**
 * The logo pipeline: every vendor that declares an `icon` resolves to real SVG
 * path data, unknown slugs fall back cleanly, and the bundle carries a catalog of
 * common vendors ready for future integrations.
 */
describe("brand icons", () => {
  it("resolves every production and experimental vendor's declared icon to path data", () => {
    for (const v of ALL_VENDORS) {
      if (!v.icon) continue; // no icon → letter avatar, that's fine
      const icon = brandIcon(v.icon);
      expect(icon, `${v.id} icon "${v.icon}"`).toBeDefined();
      expect(icon!.path.length).toBeGreaterThan(10);
      expect(icon!.hex).toMatch(/^#[0-9a-f]{3,8}$/i);
    }
  });

  it("has GitHub's real mark bundled", () => {
    const gh = brandIcon("github");
    expect(gh?.title).toBe("GitHub");
    expect(gh?.path).toContain("M12"); // GitHub's path starts at the top-centre
  });

  it("falls back (undefined) for unknown or unset slugs", () => {
    expect(brandIcon(undefined)).toBeUndefined();
    expect(brandIcon("not-a-real-brand")).toBeUndefined();
    expect(brandIcon("toString")).toBeUndefined();
    expect(brandIcon("constructor")).toBeUndefined();
    expect(brandIcon("__proto__")).toBeUndefined();
  });

  it("uses icon-overrides for brands simple-icons dropped (OpenAI, Slack)", () => {
    expect(brandIcon("openai")?.title).toBe("OpenAI"); // hand-added, not from simple-icons
    expect(brandIcon("slack")?.title).toBe("Slack");
    expect(brandIcon("openai")!.path.length).toBeGreaterThan(50);
  });

  it("keeps presentation logos without restoring retired acquisition recipes", () => {
    expect(knownSupplierIcon("https://chatgpt.com/#settings/Billing")).toBe("openai");
    expect(knownSupplierIcon("https://claude.ai/settings/billing")).toBe("anthropic");
    expect(knownSupplierIcon("https://unknown.example/billing")).toBeUndefined();
  });

  it("pre-bundles a catalog beyond just the current vendors", () => {
    // Common billing SaaS ready for the future "add vendor" gallery.
    expect(iconSlugs().length).toBeGreaterThan(20);
    expect(brandIcon("stripe")).toBeDefined();
  });
});
