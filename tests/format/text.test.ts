/**
 * Text formatting helpers: value rendering, tables that fit a budget, block fitting and truncation with a hint.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { describe, expect, it } from "vitest";
import { fitTable, formatValue, renderRecord, renderTable, truncate } from "../../src/format/text.js";

describe("renderTable", () => {
  it("renders fixed-width columns with a header rule", () => {
    const out = renderTable(
      [
        { id: "1", name: "Acme" },
        { id: "22", name: "Globex Corporation" },
      ],
      ["id", "name"]
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("id  name");
    expect(lines[1]).toBe("--  ------------------");
    expect(lines[2]).toBe("1   Acme");
    expect(lines[3]).toBe("22  Globex Corporation");
  });

  it("truncates cells at 60 characters and flattens newlines", () => {
    const out = renderTable([{ v: `${"a".repeat(70)}` }, { v: "two\nlines" }], ["v"]);
    expect(out).toContain(`${"a".repeat(59)}…`);
    expect(out).not.toContain("a".repeat(61));
    expect(out).toContain("two lines");
  });

  it("caps at 100 rows and reports the rest", () => {
    const rows = Array.from({ length: 105 }, (_, i) => ({ n: String(i) }));
    const out = renderTable(rows, ["n"]);
    expect(out.split("\n")).toHaveLength(2 + 100 + 1);
    expect(out).toContain("… and 5 more");
  });
});

describe("renderRecord", () => {
  it("renders key: value lines in the given order and skips empty values", () => {
    expect(renderRecord({ b: 2, a: "x", c: null, d: ["p", "q"] }, ["a", "b", "c", "d"])).toBe("a: x\nb: 2\nd: p, q");
  });

  it("renders every key when no field list is given", () => {
    expect(renderRecord({ z: true, y: { k: 1 } })).toBe('z: true\ny: {"k":1}');
  });
});

describe("formatValue", () => {
  it("formats scalars, arrays and objects", () => {
    expect(formatValue(null)).toBe("");
    expect(formatValue(3)).toBe("3");
    expect(formatValue([{ name: "A" }, "b"])).toBe("A, b");
    expect(formatValue({ value: "Won", color: "green" })).toBe("Won");
  });
});

describe("truncate", () => {
  it("returns short text unchanged", () => {
    expect(truncate("hello", 10, "hint")).toBe("hello");
  });

  it("cuts long text to the max and appends the hint", () => {
    const out = truncate("x".repeat(500), 100, "Narrow the query (filters, limit) or page with cursor.");
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out).toContain("Narrow the query (filters, limit) or page with cursor.");
  });
});

describe("fitTable", () => {
  it("uses the first layout that fits the budget", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: String(i).padStart(24, "0"), name: "n".repeat(60), extra: "e".repeat(60) }));
    const wide = renderTable(rows, ["id", "name", "extra"]);
    const out = fitTable(
      rows,
      [
        { columns: ["id", "name", "extra"], maxCell: 60 },
        { columns: ["id", "name"], maxCell: 30 },
      ],
      wide.length - 1
    );
    expect(out.split("\n")[0]).toBe(`${"id".padEnd(24)}  name`);
    expect(out.split("\n")).toHaveLength(102);
  });
});
