import { describe, expect, it } from "vitest";
import {
  DISCOVERY_DOM_POLICY,
  isSemanticControlEvidenceEligible,
} from "../../collector/src/platform/discovery-dom-policy";

describe("shared discovery DOM policy", () => {
  it("recognizes an icon-only invoice action from bounded table context", () => {
    expect(isSemanticControlEvidenceEligible({
      material: "lucide lucide-scroll-text",
      rowContext: "INV-001 2026-07-01 SEK 25.00 Paid",
      columnContext: "Actions",
      tableContext: "Date Amount Invoice number Status Actions",
      pageContext: "Billing Past Invoices",
      visible: true,
      enabled: true,
      formBacked: false,
    })).toBe(true);
  });

  it("accepts icon-only actions when the table schema proves invoice context", () => {
    expect(isSemanticControlEvidenceEligible({
      material: "lucide lucide-scroll-text",
      rowContext: "Jul 1, 2026 Paid",
      columnContext: "Actions",
      tableContext: "Icon Date Amount Invoice number Status Actions",
      pageContext: "/dashboard/org/opaque-tenant/billing Billing",
      visible: true,
      enabled: true,
      formBacked: false,
    })).toBe(true);
  });

  it("rejects status buttons and identical icons outside invoice-shaped context", () => {
    expect(isSemanticControlEvidenceEligible({
      material: "Paid",
      rowContext: "INV-001 2026-07-01 SEK 25.00 Paid",
      columnContext: "Status",
      tableContext: "Date Amount Invoice number Status Actions",
      pageContext: "Billing Past Invoices",
      visible: true,
      enabled: true,
      formBacked: false,
    })).toBe(false);
    expect(isSemanticControlEvidenceEligible({
      material: "lucide lucide-scroll-text",
      rowContext: "Project notes",
      columnContext: "Actions",
      tableContext: "Name Owner Status Actions",
      pageContext: "Workspace",
      visible: true,
      enabled: true,
      formBacked: false,
    })).toBe(false);
  });

  it("keeps hidden, disabled, form-backed and unsafe actions out", () => {
    const base = {
      material: "Download invoice PDF",
      rowContext: "Invoice INV-001",
      columnContext: "Actions",
      tableContext: "Date Amount Invoice number Status Actions",
      pageContext: "Billing",
      visible: true,
      enabled: true,
      formBacked: false,
    };
    expect(isSemanticControlEvidenceEligible({ ...base, visible: false })).toBe(false);
    expect(isSemanticControlEvidenceEligible({ ...base, enabled: false })).toBe(false);
    expect(isSemanticControlEvidenceEligible({ ...base, formBacked: true })).toBe(false);
    expect(isSemanticControlEvidenceEligible({ ...base, material: "Pay invoice" })).toBe(false);
    expect(DISCOVERY_DOM_POLICY.controlSelector).toContain('[role="button"]');
  });
});
