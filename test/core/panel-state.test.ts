import { describe, expect, it } from "vitest";
import { parsePanelUiState } from "../../collector/src/ui/popup/panel-state";

describe("collector side panel state", () => {
  it("restores a validated navigation and invoice view", () => {
    expect(parsePanelUiState({
      screen: "vendors",
      ledgerDateFilter: "90d",
      expandedSupplierIds: ["github", "clickup", "github"],
    })).toEqual({
      screen: "vendors",
      ledgerDateFilter: "90d",
      expandedSupplierIds: ["github", "clickup"],
    });
  });

  it("defaults malformed state and bounds supplier expansion", () => {
    const expandedSupplierIds = Array.from({ length: 60 }, (_, index) => `vendor-${index}`);
    expect(parsePanelUiState({
      screen: "unknown",
      ledgerDateFilter: "forever",
      expandedSupplierIds: [...expandedSupplierIds, "", 42],
    })).toEqual({
      screen: "home",
      ledgerDateFilter: "all",
      expandedSupplierIds: expandedSupplierIds.slice(0, 50),
    });
  });
});
