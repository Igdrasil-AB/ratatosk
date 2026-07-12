/**
 * Runtime validation for vendor recipes.
 *
 * Because recipes are plain data, we can validate them the same way whether they
 * are compiled into the extension or hot-served as JSON from a backend. Every
 * recipe passes through {@link validateRecipe} at registration time, so a
 * malformed contribution fails immediately with a precise message rather than
 * misbehaving at 3am in a service worker.
 *
 * The Zod schema is also the single source of truth for the published JSON
 * Schema (see `scripts/build-manifest.ts` / `docs/recipe-schema`).
 */
import { z } from "zod";
import type { VendorRecipe } from "./types";
import { SchemaError } from "./errors";

const Transform = z.union([
  z.object({ kind: z.literal("divide"), by: z.number().positive() }),
  z.object({ kind: z.literal("date"), epoch: z.enum(["s", "ms"]).optional() }),
  z.object({ kind: z.literal("regex"), pattern: z.string(), group: z.number().int().optional() }),
  z.object({ kind: z.literal("template"), pattern: z.string() }),
  z.object({ kind: z.literal("replace"), pattern: z.string(), with: z.string() }),
  z.object({ kind: z.literal("trim") }),
  z.object({ kind: z.literal("upper") }),
  z.object({ kind: z.literal("lower") }),
]);

const Extractor = z.union([
  z.string(),
  z.object({ path: z.string(), transforms: z.array(Transform).optional() }),
]);

const RequestSpec = z.object({
  method: z.enum(["GET", "POST"]).optional(),
  url: z.string().min(1),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
});

const Predicate: z.ZodType = z.lazy(() =>
  z.union([
    z.object({ statusIn: z.array(z.number().int()) }),
    z.object({ jsonPath: z.string(), equals: z.unknown().optional(), exists: z.boolean().optional() }),
    z.object({ and: z.array(Predicate) }),
    z.object({ or: z.array(Predicate) }),
  ]),
);

const HttpProbe = z.object({ request: RequestSpec, expect: Predicate });

const TokenSpec = z.object({ request: RequestSpec, value: Extractor, as: z.string().optional() });

const ConfigOption = z.object({
  id: z.string().min(1),
  discover: z.object({
    request: RequestSpec,
    items: z.string().optional(), // omit → discover a single scalar value from the root
    value: Extractor,
    label: Extractor.optional(),
  }),
});

const FieldMap = z.object({
  id: Extractor,
  issuedAt: Extractor.optional(),
  total: Extractor.optional(),
  currency: Extractor.optional(),
  documentUrl: Extractor.optional(),
  documentRef: Extractor.optional(),
});

const NetworkListSpec = z.object({
  request: RequestSpec,
  items: z.string(),
  map: FieldMap,
  paginate: z.object({ cursor: z.string(), maxPages: z.number().int().positive().optional() }).optional(),
});

const DomStep = z.union([
  z.object({ action: z.literal("waitFor"), selector: z.string(), timeoutMs: z.number().int().optional() }),
  z.object({ action: z.literal("click"), selector: z.string() }),
  z.object({ action: z.literal("extractAll"), selector: z.string(), attr: z.string(), as: z.string() }),
]);

const DomListSpec = z.object({
  open: z.string(),
  steps: z.array(DomStep),
  hrefsFrom: z.string(),
});

const HtmlListSpec = z
  .object({
    request: RequestSpec,
    embeddedJson: z.boolean().optional(),
    rowRegex: z.string().optional(),
    items: z.string().optional(),
    map: FieldMap,
  })
  .refine((s) => s.embeddedJson || s.rowRegex, {
    message: "html list needs either embeddedJson or rowRegex",
  });

const DocumentSpec = z.object({
  request: RequestSpec.optional(),
  contentType: z.string().optional(),
  filename: z.string().optional(),
});

const VendorRecipeSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "id must be lowercase kebab-case"),
  name: z.string().min(1),
  homepage: z.string().url(),
  hosts: z.array(z.string().min(1)).min(1),
  category: z.string().optional(),
  icon: z.string().optional(),
  notes: z.string().optional(),
  fetchContext: z.enum(["worker", "page"]).optional(),
  auth: z.object({ check: HttpProbe, loginUrl: z.string().url(), token: TokenSpec.optional() }),
  config: z.array(ConfigOption).optional(),
  invoices: z.discriminatedUnion("strategy", [
    z.object({ strategy: z.literal("network"), list: NetworkListSpec, document: DocumentSpec }),
    z.object({ strategy: z.literal("dom"), list: DomListSpec, document: DocumentSpec }),
    z.object({ strategy: z.literal("html"), list: HtmlListSpec, document: DocumentSpec }),
  ]),
});

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
