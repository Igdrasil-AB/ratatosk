import { describe, expect, it } from "vitest";
import { render } from "../../src/core/template";
import { extract, extractString, MAX_REGEX_INPUT_CHARS } from "../../src/core/extract";
import { get, getArray } from "../../src/core/jsonpath";

describe("template.render", () => {
  it("interpolates variables", () => {
    expect(render("https://{host}/inv/{id}.pdf", { host: "x.com", id: "9" })).toBe("https://x.com/inv/9.pdf");
  });
  it("throws on a missing variable rather than emitting an empty string", () => {
    expect(() => render("{missing}", {})).toThrow();
  });
  it("rejects inherited variables but permits explicitly supplied names", () => {
    expect(() => render("{constructor}", {})).toThrow(/missing template variable/);
    expect(() => render("{toString}", {})).toThrow(/missing template variable/);
    expect(render("{constructor}/{toString}", { constructor: "ctor", toString: "stringifier" })).toBe("ctor/stringifier");
  });
});

describe("jsonpath", () => {
  it("reads dotted paths and array indices", () => {
    expect(get({ a: { b: [{ c: 1 }] } }, "a.b.0.c")).toBe(1);
  });
  it("returns the whole object for $", () => {
    const o = { x: 1 };
    expect(get(o, "$")).toBe(o);
  });
  it("getArray yields [] for non-arrays", () => {
    expect(getArray({ a: 5 }, "a")).toEqual([]);
  });
});

describe("extract transforms", () => {
  it("divides minor units into a 2-dp decimal string", () => {
    expect(extract({ c: 4900 }, { path: "c", transforms: [{ kind: "divide", by: 100 }] })).toBe("49.00");
  });
  it("normalizes timestamps to ISO dates", () => {
    expect(extract({ d: "2026-06-30T10:00:00Z" }, { path: "d", transforms: [{ kind: "date" }] })).toBe("2026-06-30");
  });
  it("applies a regex capture group", () => {
    expect(
      extract({ ref: "invoice_776" }, { path: "ref", transforms: [{ kind: "regex", pattern: "_(\\d+)$", group: 1 }] }),
    ).toBe("776");
  });
  it("does not run recipe regexes over unbounded supplier values", () => {
    expect(extract(
      { value: "a".repeat(MAX_REGEX_INPUT_CHARS + 1) },
      { path: "value", transforms: [{ kind: "regex", pattern: "a+" }] },
    )).toBeUndefined();
  });
  it("preserves absent values through transforms and trims extracted strings", () => {
    for (const transform of [
      { kind: "divide", by: 100 },
      { kind: "date" },
      { kind: "regex", pattern: "x" },
      { kind: "template", pattern: "{value}" },
      { kind: "replace", pattern: "x", with: "y" },
      { kind: "trim" },
      { kind: "upper" },
      { kind: "lower" },
    ] as const) {
      expect(extract({}, { path: "missing", transforms: [transform] })).toBeUndefined();
      expect(extract({ missing: null }, { path: "missing", transforms: [transform] })).toBeNull();
    }
    expect(extractString({ value: "  invoice-1  " }, "value")).toBe("invoice-1");
  });
});
