/**
 * Closed, packaged semantic policy shared by discovery and verification.
 *
 * The injected page functions receive this data explicitly because Chrome
 * serializes the function body without module closures. Keep this object free
 * of supplier names, selectors supplied by pages, and executable strings.
 */
export const DISCOVERY_DOM_POLICY = {
  controlSelector: [
    "button",
    "a:not([href])",
    '[role="button"]',
    '[role="menuitem"]',
    'input[type="button"]',
    'input[type="submit"]',
    "[data-href]",
    "[data-url]",
  ].join(","),
  sectionSelector: [
    '[role="tab"]',
    '[role="tablist"] button',
    '[role="tablist"] a',
    "button[aria-controls]",
    "a[aria-controls]",
    '[data-test*="tab" i]',
    '[data-testid*="tab" i]',
  ].join(","),
  rowSelector: [
    "tr",
    '[role="row"]',
    "li",
    '[role="listitem"]',
    "article",
    '[class*="invoice" i][class*="row" i]',
    '[class*="receipt" i][class*="row" i]',
    '[class*="statement" i][class*="row" i]',
  ].join(","),
  cellSelector: [
    ":scope > td",
    ":scope > th",
    ':scope > [role="cell"]',
    ':scope > [role="gridcell"]',
    ':scope > [role="columnheader"]',
    ':scope > [class*="cell" i]',
  ].join(","),
  headerRowSelector: 'thead tr,[role="row"],[class*="header" i][class*="row" i]',
  headerCellSelector: [
    ":scope > th",
    ':scope > [role="columnheader"]',
    ':scope > [class*="col" i]',
    ':scope > [class*="cell" i]',
  ].join(","),
  contextSelector: 'tr,[role="row"],li,[role="listitem"],article,section',
  tableSelector: 'table,[role="table"],[role="grid"]',
  explicitActionPattern: "(?:download|save|pdf|ladda\\s*ner|hämta|herunterladen|télécharger|descargar|baixar|scarica|downloaden)",
  strongDocumentPattern: "(?:pdf|receipt|invoice|kvitto|faktura|beleg|rechnung|reçu|facture|recibo|factura|ricevuta|fattura)",
  documentIconPattern: "(?:^|[\\s_-])(?:download|file-down|file-text|receipt|scroll-text|document|invoice|pdf)(?:$|[\\s_-])",
  invoiceContextPattern: "(?:billing|past\\s+invoices?|invoice\\s+history|receipt\\s+history|statement|receipt|invoice|kvitto|faktura|beleg|rechnung|reçu|facture|recibo|factura|ricevuta|fattura)",
  invoiceRowPattern: "(?:invoice|receipt|statement|kvitto|faktura|beleg|rechnung|reçu|facture|recibo|factura|ricevuta|fattura|\\b\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}\\b|\\b(?:USD|EUR|SEK|NOK|DKK|GBP|CHF)\\b)",
  actionColumnPattern: "^(?:actions?|documents?|downloads?|invoices?|receipts?)$",
  documentNumberPattern: "(?:invoice|receipt|statement|reference|document).*(?:number|no\\.?|#|id)|^(?:number|no\\.?|invoice|receipt|statement)$",
  unsafeLabelPattern: "(?:\\b(?:delete|remove|cancel|pay|purchase|checkout|upgrade|downgrade|authorize|logout)\\b|sign\\s*out|log\\s*out)",
  unsafePathPattern: "(?:^|/)(?:logout|signout|delete|cancel|checkout|purchase|upgrade|downgrade|authorize|oauth)(?:/|$)",
  invoiceSectionPattern: "^(?:invoices?|invoice history|receipts?|receipt history|billing history|past invoices?)$",
  semanticNavigationPattern: "^(?:(?:[^,]{1,80},\\s*)?(?:open\\s+)?(?:profile|account)(?:\\s+menu)?|settings|preferences|billing|subscriptions?|invoice\\s+history|receipt\\s+history|billing\\s+history|past\\s+invoices?)$",
  stableMs: 350,
} as const;

export interface SemanticControlEvidence {
  material: string;
  rowContext: string;
  columnContext: string;
  tableContext: string;
  pageContext: string;
  visible: boolean;
  enabled: boolean;
  formBacked: boolean;
}

export type SemanticControlEvidenceBasis =
  | "explicit_document_label"
  | "invoice_context_action"
  | "invoice_table_action";

/**
 * Return the closed structural reason that admits an invoice action.
 *
 * `pageContext` must contain only independently rendered page evidence such as
 * the title and headings. A speculative pathname is a search hypothesis, not
 * proof that a global "Download" button belongs to an invoice.
 */
export function semanticControlEvidenceBasis(
  evidence: SemanticControlEvidence,
  policy: typeof DISCOVERY_DOM_POLICY = DISCOVERY_DOM_POLICY,
): SemanticControlEvidenceBasis | undefined {
  if (!evidence.visible || !evidence.enabled || evidence.formBacked) return undefined;
  const material = bounded(evidence.material, 320);
  const row = bounded(evidence.rowContext, 500);
  const column = bounded(evidence.columnContext, 120);
  const table = bounded(evidence.tableContext, 500);
  const page = bounded(evidence.pageContext, 240);
  if (!material || new RegExp(policy.unsafeLabelPattern, "i").test(material)) return undefined;

  const explicit = new RegExp(policy.explicitActionPattern, "i").test(material);
  const strongDocument = new RegExp(policy.strongDocumentPattern, "i").test(material);
  if (explicit && strongDocument) return "explicit_document_label";
  if (explicit && new RegExp(policy.invoiceContextPattern, "i").test(`${row} ${table} ${page}`)) {
    return "invoice_context_action";
  }

  const contextualIcon = new RegExp(policy.documentIconPattern, "i").test(material) &&
    new RegExp(policy.actionColumnPattern, "i").test(column) &&
    (
      new RegExp(policy.invoiceRowPattern, "i").test(row) ||
      new RegExp(policy.invoiceContextPattern, "i").test(table)
    ) &&
    new RegExp(policy.invoiceContextPattern, "i").test(`${table} ${page}`);
  return contextualIcon ? "invoice_table_action" : undefined;
}

/** Browser-independent contract used by synthetic shape tests. */
export function isSemanticControlEvidenceEligible(
  evidence: SemanticControlEvidence,
  policy: typeof DISCOVERY_DOM_POLICY = DISCOVERY_DOM_POLICY,
): boolean {
  return semanticControlEvidenceBasis(evidence, policy) !== undefined;
}

export function isSafeSemanticInvoiceSection(
  value: string,
  policy: typeof DISCOVERY_DOM_POLICY = DISCOVERY_DOM_POLICY,
): boolean {
  return new RegExp(policy.invoiceSectionPattern, "i").test(bounded(value, 120));
}

export function isSafeSemanticNavigationLabel(
  value: string,
  policy: typeof DISCOVERY_DOM_POLICY = DISCOVERY_DOM_POLICY,
): boolean {
  const label = bounded(value, 120);
  return Boolean(
    label &&
    !new RegExp(policy.unsafeLabelPattern, "i").test(label) &&
    new RegExp(policy.semanticNavigationPattern, "i").test(label),
  );
}

function bounded(value: string, maximum: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maximum);
}
