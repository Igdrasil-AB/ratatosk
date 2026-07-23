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
  contextSelector: 'tr,[role="row"],li,[role="listitem"],article,section',
  tableSelector: 'table,[role="table"],[role="grid"]',
  explicitActionPattern: "(?:download|save|pdf|ladda\\s*ner|hämta|herunterladen|télécharger|descargar|baixar|scarica|downloaden)",
  strongDocumentPattern: "(?:pdf|receipt|invoice|kvitto|faktura|beleg|rechnung|reçu|facture|recibo|factura|ricevuta|fattura)",
  documentIconPattern: "(?:^|[\\s_-])(?:download|file-down|file-text|receipt|scroll-text|document|invoice|pdf)(?:$|[\\s_-])",
  invoiceContextPattern: "(?:billing|past\\s+invoices?|invoice\\s+history|receipt\\s+history|statement|receipt|invoice|kvitto|faktura|beleg|rechnung|reçu|facture|recibo|factura|ricevuta|fattura)",
  invoiceRowPattern: "(?:invoice|receipt|statement|kvitto|faktura|beleg|rechnung|reçu|facture|recibo|factura|ricevuta|fattura|\\b\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}\\b|\\b(?:USD|EUR|SEK|NOK|DKK|GBP|CHF)\\b)",
  actionColumnPattern: "^(?:actions?|documents?|downloads?|invoices?|receipts?)$",
  unsafeLabelPattern: "(?:\\b(?:delete|remove|cancel|pay|purchase|checkout|upgrade|downgrade|authorize|logout)\\b|sign\\s*out|log\\s*out)",
  unsafePathPattern: "(?:^|/)(?:logout|signout|delete|cancel|checkout|purchase|upgrade|downgrade|authorize|oauth)(?:/|$)",
  invoiceSectionPattern: "^(?:invoices?|invoice history|receipts?|receipt history|billing history|past invoices?)$",
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

/** Browser-independent contract used by synthetic shape tests. */
export function isSemanticControlEvidenceEligible(
  evidence: SemanticControlEvidence,
  policy: typeof DISCOVERY_DOM_POLICY = DISCOVERY_DOM_POLICY,
): boolean {
  if (!evidence.visible || !evidence.enabled || evidence.formBacked) return false;
  const material = bounded(evidence.material, 320);
  const row = bounded(evidence.rowContext, 500);
  const column = bounded(evidence.columnContext, 120);
  const table = bounded(evidence.tableContext, 500);
  const page = bounded(evidence.pageContext, 240);
  if (!material || new RegExp(policy.unsafeLabelPattern, "i").test(material)) return false;

  const explicit = new RegExp(policy.explicitActionPattern, "i").test(material);
  const strongDocument = new RegExp(policy.strongDocumentPattern, "i").test(material);
  const invoiceContext = new RegExp(policy.invoiceContextPattern, "i").test(`${row} ${page}`);
  if (explicit && (strongDocument || invoiceContext)) return true;

  return new RegExp(policy.documentIconPattern, "i").test(material) &&
    new RegExp(policy.actionColumnPattern, "i").test(column) &&
    (
      new RegExp(policy.invoiceRowPattern, "i").test(row) ||
      new RegExp(policy.invoiceContextPattern, "i").test(table)
    ) &&
    new RegExp(policy.invoiceContextPattern, "i").test(page);
}

export function isSafeSemanticInvoiceSection(
  value: string,
  policy: typeof DISCOVERY_DOM_POLICY = DISCOVERY_DOM_POLICY,
): boolean {
  return new RegExp(policy.invoiceSectionPattern, "i").test(bounded(value, 120));
}

function bounded(value: string, maximum: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maximum);
}
