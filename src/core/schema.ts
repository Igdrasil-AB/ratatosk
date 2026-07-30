/**
 * Runtime validation for vendor recipes — and the FREEZE that keeps recipes on
 * the allowed side of Chrome's remote-code policy.
 *
 * Recipes are plain data bundled with the reviewed extension package. Collector
 * never fetches recipes from a backend. To keep the interpreter small and make a
 * hostile recipe un-authorable, this schema FREEZES the recipe vocabulary:
 *
 *   1. Transforms are a CLOSED enum of simple, non-Turing-complete operations
 *      (divide/date/regex/template/replace/trim/upper/lower). New behavior can
 *      only ship INSIDE the extension package — never via a fetched recipe.
 *   2. Every object is `.strict()` — an unknown field (a smuggled `code`,
 *      `eval`, `script`, …) is REJECTED, not silently dropped. A recipe carries
 *      only the exact declared shape and nothing else.
 *   3. The only pattern languages (regex/replace/rowRegex) are LENGTH-BOUNDED,
 *      must COMPILE, and reject backreferences, lookarounds, and ambiguous or
 *      nested unbounded repetition; transform pipelines are LENGTH-CAPPED — "an
 *      industry-standard simple template processor, limited by design", not an
 *      interpreter.
 *
 * Every packaged recipe passes {@link validateRecipe} at registration time, so a
 * malformed or over-reaching recipe fails immediately with a precise message
 * rather than misbehaving in a service worker.
 */
import { z } from "zod";
import type { VendorRecipe } from "./types";
import { SchemaError } from "./errors";

/** A regex/replace pattern is a bounded string that must compile — never code. */
const MAX_PATTERN = 200;
/** A rowRegex parses whole HTML pages, so it needs more room — still bounded + compiled. */
const MAX_ROW_REGEX = 2000;
/** A transform pipeline is a short, fixed sequence — not a program. */
const MAX_TRANSFORMS = 8;
/** Config discovery is deliberately small: each option expands collection work. */
export const MAX_CONFIG_OPTIONS = 4;

/** Names accepted by the `{name}` template renderer. */
const TemplateVariable = z.string().regex(
  /^[A-Za-z_][A-Za-z0-9_]*$/,
  "template variable must start with a letter or underscore and contain only letters, digits, and underscores",
);

/** A conservative JavaScript-regex subset for supplier-controlled inputs. */
export const isSafeRecipeRegex = (pattern: string): boolean => {
  try {
    new RegExp(pattern);
  } catch {
    return false;
  }
  if (/\\(?:[1-9][0-9]*|k<)/.test(pattern)) return false;
  if (/\(\?(?:[=!]|<[=!])/.test(pattern)) return false;

  type Group = { hasQuantifier: boolean; hasAlternation: boolean; nestedRisk: boolean };
  const stack: Group[] = [{ hasQuantifier: false, hasAlternation: false, nestedRisk: false }];
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[") {
      inClass = true;
      continue;
    }
    if (character === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (character === "(") {
      stack.push({ hasQuantifier: false, hasAlternation: false, nestedRisk: false });
      continue;
    }
    if (character === "|") {
      stack.at(-1)!.hasAlternation = true;
      continue;
    }
    if (character === ")" && stack.length > 1) {
      const group = stack.pop()!;
      const quantifier = readQuantifier(pattern, index + 1);
      const riskyContents = group.hasQuantifier || group.hasAlternation || group.nestedRisk;
      if (quantifier?.unbounded && riskyContents) return false;
      const parent = stack.at(-1)!;
      if (quantifier) parent.hasQuantifier = true;
      if (riskyContents) parent.nestedRisk = true;
      continue;
    }
    const quantifier = readQuantifier(pattern, index);
    if (quantifier) {
      if (quantifier.maximum !== undefined && quantifier.maximum > 100) return false;
      stack.at(-1)!.hasQuantifier = true;
      index = quantifier.end - 1;
    }
  }
  return true;
};

function readQuantifier(
  pattern: string,
  index: number,
): { end: number; unbounded: boolean; maximum?: number } | undefined {
  const character = pattern[index];
  if (character === "*" || character === "+") return { end: index + 1, unbounded: true };
  if (character === "?") return { end: index + 1, unbounded: false, maximum: 1 };
  if (character !== "{") return undefined;
  const match = /^\{(\d+)(?:,(\d*)?)?\}/.exec(pattern.slice(index));
  if (!match) return undefined;
  const hasComma = match[0].includes(",");
  const maximum = hasComma ? (match[2] ? Number(match[2]) : undefined) : Number(match[1]);
  return { end: index + match[0].length, unbounded: hasComma && maximum === undefined, maximum };
}

/** A bounded, compilable regular-expression string (the only "pattern language" recipes may carry). */
const boundedRegex = (max: number) =>
  z.string().min(1).max(max).refine(isSafeRecipeRegex, { message: "must be a safe regular expression" });

const RegexPattern = boundedRegex(MAX_PATTERN);

// The closed, frozen transform vocabulary. Adding a kind is a CODE change (it
// ships in the package); a recipe can only select and parametrize these.
const Transform = z.union([
  z.object({ kind: z.literal("divide"), by: z.number().positive() }).strict(),
  z.object({ kind: z.literal("date"), epoch: z.enum(["s", "ms"]).optional() }).strict(),
  z.object({ kind: z.literal("regex"), pattern: RegexPattern, group: z.number().int().nonnegative().optional() }).strict(),
  z.object({ kind: z.literal("template"), pattern: z.string().min(1).max(MAX_PATTERN) }).strict(),
  z.object({ kind: z.literal("replace"), pattern: RegexPattern, with: z.string().max(MAX_PATTERN) }).strict(),
  z.object({ kind: z.literal("trim") }).strict(),
  z.object({ kind: z.literal("upper") }).strict(),
  z.object({ kind: z.literal("lower") }).strict(),
]);

const Extractor = z.union([
  z.string(),
  z.object({ path: z.string().min(1), transforms: z.array(Transform).max(MAX_TRANSFORMS).optional() }).strict(),
]);

const RequestSpec = z
  .object({
    method: z.enum(["GET", "POST"]).optional(),
    url: z.string().min(1),
    headers: z.record(z.string()).optional(),
    body: z.string().optional(),
  })
  .strict();

const Predicate: z.ZodType = z.lazy(() =>
  z.union([
    z.object({ statusIn: z.array(z.number().int()) }).strict(),
    z.object({ jsonPath: z.string(), equals: z.unknown().optional(), exists: z.boolean().optional() }).strict(),
    z.object({ and: z.array(Predicate).min(1) }).strict(),
    z.object({ or: z.array(Predicate).min(1) }).strict(),
  ]),
);

const HttpProbe = z.object({ request: RequestSpec, expect: Predicate }).strict();

const TokenSpec = z.object({ request: RequestSpec, value: Extractor, as: TemplateVariable.optional() }).strict();

const ConfigOption = z
  .object({
    id: TemplateVariable,
    discover: z
      .object({
        request: RequestSpec,
        items: z.string().optional(), // omit → discover a single scalar value from the root
        value: Extractor,
        label: Extractor.optional(),
        paginate: z.object({
          kind: z.literal("cursor").optional(),
          cursor: z.string().min(1).max(240),
          variable: TemplateVariable.optional(),
          hasMore: z.string().min(1).max(240).optional(),
          maxPages: z.number().int().positive().max(100).optional(),
        }).strict().optional(),
      })
      .strict(),
  })
  .strict();

const FieldMap = z
  .object({
    id: Extractor,
    issuedAt: Extractor.optional(),
    total: Extractor.optional(),
    currency: Extractor.optional(),
    documentUrl: Extractor.optional(),
    documentRef: Extractor.optional(),
  })
  .strict();

const PaginationPath = z.string().min(1).max(240);
const PaginationVariable = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const PaginationLimit = z.number().int().positive().max(100).optional();
const PageSize = z.number().int().positive().max(500).optional();

const PaginateSpec = z.union([
  z.object({
    kind: z.literal("cursor").optional(),
    cursor: PaginationPath,
    variable: PaginationVariable.optional(),
    pageSize: PageSize,
    hasMore: PaginationPath.optional(),
    maxPages: PaginationLimit,
  }).strict(),
  z.object({
    kind: z.literal("next-url"),
    nextUrl: PaginationPath,
    hasMore: PaginationPath.optional(),
    maxPages: PaginationLimit,
  }).strict(),
  z.object({
    kind: z.literal("link-header"),
    hasMore: PaginationPath.optional(),
    maxPages: PaginationLimit,
  }).strict(),
  z.object({
    kind: z.literal("page"),
    variable: PaginationVariable.optional(),
    start: z.number().int().nonnegative().optional(),
    step: z.number().int().positive().max(500).optional(),
    pageSize: PageSize,
    hasMore: PaginationPath.optional(),
    maxPages: PaginationLimit,
  }).strict(),
  z.object({
    kind: z.literal("offset"),
    variable: PaginationVariable.optional(),
    start: z.number().int().nonnegative().optional(),
    step: z.number().int().positive().max(500),
    pageSize: PageSize,
    hasMore: PaginationPath.optional(),
    maxPages: PaginationLimit,
  }).strict(),
]);

const NetworkListSpec = z
  .object({
    request: RequestSpec,
    items: z.string(),
    map: FieldMap,
    paginate: PaginateSpec.optional(),
  })
  .strict();

const DomStep = z.union([
  z.object({ action: z.literal("waitFor"), selector: z.string(), timeoutMs: z.number().int().optional() }).strict(),
  z.object({ action: z.literal("extractAll"), selector: z.string(), attr: z.string(), as: z.string() }).strict(),
  z.object({
    action: z.literal("extractSemanticDownloads"),
    as: z.string().min(1).max(80),
    maxActions: z.number().int().positive().max(12).optional(),
  }).strict(),
]);

const DomContinuationSpec = z.object({
  mode: z.literal("auto"),
  maxActions: z.number().int().positive().max(12).optional(),
  maxDocuments: z.number().int().positive().max(500).optional(),
  timeoutMs: z.number().int().positive().max(60_000).optional(),
  allowScroll: z.boolean().optional(),
}).strict();

const DomListSpec = z.object({
  open: z.string(),
  steps: z.array(DomStep),
  continuation: DomContinuationSpec.optional(),
  hrefsFrom: z.string(),
}).strict();

const HtmlListSpec = z
  .object({
    request: RequestSpec,
    embeddedJson: z.boolean().optional(),
    rowRegex: boundedRegex(MAX_ROW_REGEX).optional(),
    items: z.string().optional(),
    map: FieldMap,
  })
  .strict()
  .refine((s) => s.embeddedJson || s.rowRegex, {
    message: "html list needs either embeddedJson or rowRegex",
  });

const DocumentSpec = z
  .object({
    request: RequestSpec.optional(),
    contentType: z.string().optional(),
    filename: z.string().optional(),
  })
  .strict();

const VendorRecipeSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "id must be lowercase kebab-case"),
    name: z.string().min(1),
    homepage: z.string().url(),
    hosts: z.array(z.string().min(1)).min(1),
    category: z.string().optional(),
    icon: z.string().optional(),
    notes: z.string().optional(),
    fetchContext: z.enum(["worker", "page"]).optional(),
    auth: z.object({ check: HttpProbe, loginUrl: z.string().url(), token: TokenSpec.optional() }).strict(),
    config: z.array(ConfigOption).max(MAX_CONFIG_OPTIONS).optional(),
    invoices: z.discriminatedUnion("strategy", [
      z.object({ strategy: z.literal("network"), list: NetworkListSpec, document: DocumentSpec }).strict(),
      z.object({ strategy: z.literal("dom"), list: DomListSpec, document: DocumentSpec }).strict(),
      z.object({ strategy: z.literal("html"), list: HtmlListSpec, document: DocumentSpec }).strict(),
    ]),
  })
  .strict();

/** Validate and return a recipe, or throw {@link SchemaError} with a readable message. */
export function validateRecipe(recipe: unknown): VendorRecipe {
  const result = VendorRecipeSchema.safeParse(recipe);
  if (!result.success) {
    const id = (recipe as { id?: string })?.id ?? "<unknown>";
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new SchemaError(`invalid recipe "${id}":\n${issues}`, typeof id === "string" ? id : undefined);
  }
  return result.data as VendorRecipe;
}

export { VendorRecipeSchema };
