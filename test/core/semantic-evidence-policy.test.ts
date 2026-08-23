import { describe, expect, it } from "vitest";
import {
  isSafeSemanticNavigationTrigger,
  isSafeSemanticNavigationLabel,
  semanticControlEvidenceBasis,
} from "../../collector/src/platform/discovery-dom-policy";

describe("semantic invoice evidence policy", () => {
  it("does not let a guessed invoice pathname turn a global app download into invoice evidence", () => {
    expect(semanticControlEvidenceBasis({
      material: "Download apps",
      rowContext: "",
      columnContext: "",
      tableContext: "",
      pageContext: "ChatGPT Chat history Recents Ready when you are.",
      visible: true,
      enabled: true,
      formBacked: false,
    })).toBeUndefined();
  });

  it("keeps icon-only actions backed by an independent invoice table shape", () => {
    expect(semanticControlEvidenceBasis({
      material: "lucide lucide-scroll-text",
      rowContext: "May 13, 2026 $44.03 CSRECT-00006 Paid",
      columnContext: "Actions",
      tableContext: "Icon Date Amount Invoice number Status Actions",
      pageContext: "Billing | Example Organization | Supplier Billing",
      visible: true,
      enabled: true,
      formBacked: false,
    })).toBe("invoice_table_action");
  });

  it("keeps explicit document actions without relying on the current route", () => {
    expect(semanticControlEvidenceBasis({
      material: "Download invoice PDF",
      rowContext: "",
      columnContext: "",
      tableContext: "",
      pageContext: "Account",
      visible: true,
      enabled: true,
      formBacked: false,
    })).toBe("explicit_document_label");
  });

  it("allows only inert navigation labels used to reveal billing surfaces", () => {
    for (const label of [
      "Open profile menu", "Example User Pro, open profile menu", "Account menu",
      "Settings", "Preferences", "Billing", "Subscription", "Invoice history",
      "Inställningar", "Fakturering", "Einstellungen", "Abrechnung",
      "Paramètres", "Facturation", "Configuración", "Facturación",
    ]) {
      expect(isSafeSemanticNavigationLabel(label)).toBe(true);
    }
    for (const label of ["Download apps", "Upgrade now", "Pay invoice", "Delete account", "Add payment method", "Sign out"]) {
      expect(isSafeSemanticNavigationLabel(label)).toBe(false);
    }
  });

  it("admits only structurally identified account/workspace menu triggers", () => {
    expect(isSafeSemanticNavigationTrigger({
      structural: "workspace-picker-toggle__button cdk-menu-trigger",
      hasPopupMenu: true,
      visible: true,
      enabled: true,
      formBacked: false,
    })).toBe(true);
    // Opening a native menu is the harmless speculative step. The branch is
    // retained only if the revealed popup contains a safe Settings intent.
    expect(isSafeSemanticNavigationTrigger({
      structural: "create-task-menu cdk-menu-trigger",
      hasPopupMenu: true,
      visible: true,
      enabled: true,
      formBacked: false,
    })).toBe(true);
    expect(isSafeSemanticNavigationTrigger({
      structural: "workspace-picker-toggle__button",
      hasPopupMenu: false,
      visible: true,
      enabled: true,
      formBacked: false,
    })).toBe(false);
  });
});
