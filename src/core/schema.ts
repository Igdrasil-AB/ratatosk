/**
 * Runtime validation for vendor recipes — and the FREEZE that keeps recipes on
 * the allowed side of Chrome's remote-code policy.
 *
 * Recipes are plain data that can be hot-served as JSON from a backend. Chrome
 * Web Store policy bans "building an interpreter to run complex commands fetched
 * from a remote source, even if those commands are fetched as data." To stay
 * firmly clear of that line — and to make a hostile recipe un-authorable — this
 * schema FREEZES the recipe vocabulary:
 *
 *   1. Transforms are a CLOSED enum of simple, non-Turing-complete operations
 *      (divide/date/regex/template/replace/trim/upper/lower). New behavior can
 *      only ship INSIDE the extension package — never via a fetched recipe.
 *   2. Every object is `.strict()` — an unknown field (a smuggled `code`,
 *      `eval`, `script`, …) is REJECTED, not silently dropped. A recipe carries
 *      only the exact declared shape and nothing else.
 *   3. The only pattern languages (regex/replace/rowRegex) are LENGTH-BOUNDED
 *      and must COMPILE, and transform pipelines are LENGTH-CAPPED — "an
 *      industry-standard simple template processor, limited by design", not an
 *      interpreter.
 *
 * Every recipe passes {@link validateRecipe} at registration time, whether it is
 * compiled in or hot-loaded, so a malformed or over-reaching recipe fails
 * immediately with a precise message rather than misbehaving at 3am in a service
 * worker. The Zod schema is also the single source of truth for the published
 * JSON Schema.
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

/** True when the string is a valid regular expression the engine can compile. */
const compiles = (p: string): boolean => {
  try {
    new RegExp(p);
    return true;
  } catch {
    return false;
  }
};

/** A bounded, compilable regular-expression string (the only "pattern language" recipes may carry). */
const boundedRegex = (max: number) =>
  z.string().min(1).max(max).refine(compiles, { message: "must be a valid regular expression" });

const RegexPattern = boundedRegex(MAX_PATTERN);

// The closed, frozen transform vocabulary. Adding a kind is a CODE change (it
// ships in the package); a fetched recipe can only select and parametrize these.
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
    z.object({ and: z.array(Predicate) }).strict(),
    z.object({ or: z.array(Predicate) }).strict(),
  ]),
);

const HttpProbe = z.object({ request: RequestSpec, expect: Predicate }).strict();

const TokenSpec = z.object({ request: RequestSpec, value: Extractor, as: z.string().optional() }).strict();

const ConfigOption = z
  .object({
    id: z.string().min(1),
    discover: z
      .object({
        request: RequestSpec,
        items: z.string().optional(), // omit → discover a single scalar value from the root
        value: Extractor,
        label: Extractor.optional(),
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

const NetworkListSpec = z
  .object({
    request: RequestSpec,
    items: z.string(),
    map: FieldMap,
    paginate: z
      .object({ cursor: z.string(), maxPages: z.number().int().positive().optional() })
      .strict()
      .optional(),
  })
  .strict();

const DomStep = z.union([
  z.object({ action: z.literal("waitFor"), selector: z.string(), timeoutMs: z.number().int().optional() }).strict(),
  z.object({ action: z.literal("click"), selector: z.string() }).strict(),
  z.object({ action: z.literal("extractAll"), selector: z.string(), attr: z.string(), as: z.string() }).strict(),
]);

const DomListSpec = z.object({ open: z.string(), steps: z.array(DomStep), hrefsFrom: z.string() }).strict();

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
    config: z.array(ConfigOption).optional(),
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
