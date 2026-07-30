import type {
  InvoiceMetadataEvidence,
  InvoiceRef,
  ResolvedInvoiceMetadata,
} from "./types";

type MetadataField = Exclude<keyof ResolvedInvoiceMetadata, "conflicts">;
const FIELDS: MetadataField[] = ["invoiceNumber", "issuedAt", "total", "currency", "filename"];
const WEIGHT = { low: 1, medium: 2, high: 3 } as const;

/**
 * Resolve metadata independently from document identity. A unique strongest
 * claim wins; equally strong disagreement is withheld and reported.
 */
export function resolveInvoiceMetadata(ref: InvoiceRef): ResolvedInvoiceMetadata {
  const evidence: InvoiceMetadataEvidence[] = [
    ...directRefEvidence(ref),
    ...(ref.metadataEvidence ?? []),
  ].slice(0, 32);
  const resolved: ResolvedInvoiceMetadata = {};
  const conflicts: NonNullable<ResolvedInvoiceMetadata["conflicts"]> = [];

  for (const field of FIELDS) {
    const claims = new Map<string, { value: string; weight: number; count: number }>();
    for (const item of evidence) {
      const value = normalizeField(field, item[field]);
      if (!value) continue;
      const key = field === "currency" ? value.toUpperCase() : value;
      const existing = claims.get(key);
      const weight = WEIGHT[item.confidence];
      claims.set(key, {
        value,
        weight: Math.max(existing?.weight ?? 0, weight),
        count: (existing?.count ?? 0) + 1,
      });
    }
    if (!claims.size) continue;
    const ranked = [...claims.values()].sort((left, right) =>
      right.weight - left.weight || right.count - left.count || left.value.localeCompare(right.value)
    );
    const winner = ranked[0];
    const runnerUp = ranked[1];
    if (runnerUp && runnerUp.weight === winner.weight && runnerUp.count === winner.count) {
      conflicts.push(field);
      continue;
    }
    resolved[field] = winner.value;
  }
  if (conflicts.length) resolved.conflicts = conflicts;
  return resolved;
}

/**
 * Resolve only the calendar month needed by month-bounded collection.
 * A supplier may expose a billing period as YYYY-MM even when it cannot supply
 * the full accounting date required by the destination metadata contract.
 * Evidence in the same month agrees even when its exact days differ.
 */
export function resolveInvoiceIssueMonth(ref: InvoiceRef): string | undefined {
  const evidence = [
    ...directRefEvidence(ref),
    ...(ref.metadataEvidence ?? []),
  ].slice(0, 32);
  const claims = new Map<string, { value: string; weight: number; count: number }>();
  for (const item of evidence) {
    const value = validIssueMonth(item.issuedAt);
    if (!value) continue;
    const existing = claims.get(value);
    const weight = WEIGHT[item.confidence];
    claims.set(value, {
      value,
      weight: Math.max(existing?.weight ?? 0, weight),
      count: (existing?.count ?? 0) + 1,
    });
  }
  const ranked = [...claims.values()].sort((left, right) =>
    right.weight - left.weight || right.count - left.count || left.value.localeCompare(right.value)
  );
  const winner = ranked[0];
  const runnerUp = ranked[1];
  if (!winner || (runnerUp && runnerUp.weight === winner.weight && runnerUp.count === winner.count)) {
    return undefined;
  }
  return winner.value;
}

function directRefEvidence(ref: InvoiceRef): InvoiceMetadataEvidence[] {
  if (!ref.issuedAt && !ref.total && !ref.currency) return [];
  return [{
    source: "network",
    confidence: "high",
    issuedAt: ref.issuedAt,
    total: ref.total,
    currency: ref.currency,
  }];
}

function normalizeField(field: MetadataField, raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.replace(/\s+/g, " ").trim().slice(0, field === "filename" ? 240 : 120);
  if (!value) return undefined;
  if (field === "issuedAt") return validDate(value);
  if (field === "total") return validDecimal(value);
  if (field === "currency") return /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : undefined;
  if (field === "filename") return value.replace(/[\/\\\u0000-\u001f\u007f]/g, "_");
  return value;
}

function validDate(value: string): string | undefined {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return undefined;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function validIssueMonth(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  const monthOnly = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  if (monthOnly) return `${monthOnly[1]}-${monthOnly[2]}`;
  const date = validDate(value);
  return date?.slice(0, 7);
}

function validDecimal(value: string): string | undefined {
  const normalized = value.replace(/\s/g, "").replace(/,/g, ".");
  if (!/^-?\d{1,18}(?:\.\d{1,6})?$/.test(normalized)) return undefined;
  return normalized;
}
