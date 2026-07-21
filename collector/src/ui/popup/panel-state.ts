import type { LedgerDateFilter } from "./ledger-view";

export const PANEL_UI_STATE_KEY = "ui.panelState.v1";

export type PanelScreen = "home" | "vendors" | "settings";

export interface PanelUiState {
  screen: PanelScreen;
  ledgerDateFilter: LedgerDateFilter;
  expandedSupplierIds: string[];
}

const SCREENS = new Set<PanelScreen>(["home", "vendors", "settings"]);
const DATE_FILTERS = new Set<LedgerDateFilter>(["all", "30d", "90d", "year"]);

export function parsePanelUiState(value: unknown): PanelUiState {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const screen = typeof input.screen === "string" && SCREENS.has(input.screen as PanelScreen)
    ? input.screen as PanelScreen
    : "home";
  const ledgerDateFilter = typeof input.ledgerDateFilter === "string"
    && DATE_FILTERS.has(input.ledgerDateFilter as LedgerDateFilter)
    ? input.ledgerDateFilter as LedgerDateFilter
    : "all";
  const expandedSupplierIds = Array.isArray(input.expandedSupplierIds)
    ? [...new Set(input.expandedSupplierIds.filter((id): id is string => (
      typeof id === "string" && id.length > 0 && id.length <= 100
    )))].slice(0, 50)
    : [];

  return { screen, ledgerDateFilter, expandedSupplierIds };
}
