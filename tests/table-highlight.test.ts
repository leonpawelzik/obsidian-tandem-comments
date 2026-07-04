import { describe, expect, it } from "vitest";
import { findTables, locateCell, rangesTouchTable, visibleText } from "../src/table-highlight";

const TABLE = ["| Item | Notes |", "| ---- | ----- |", "| Pricing | cut prices hard |"].join("\n");

describe("findTables", () => {
  it("finds a basic GFM table with header, delimiter and body", () => {
    const tables = findTables(TABLE);
    expect(tables).toHaveLength(1);
    expect(tables[0].from).toBe(0);
    expect(tables[0].to).toBe(TABLE.length);
  });

  it("does not emit cells for the delimiter row", () => {
    const [t] = findTables(TABLE);
    expect(t.cells.every((c) => c.row !== 1)).toBe(true);
    // Header row (0) + one body row (2), two columns each.
    expect(t.cells.filter((c) => c.row === 0)).toHaveLength(2);
    expect(t.cells.filter((c) => c.row === 2)).toHaveLength(2);
  });

  it("captures cell content spans (offsets point at the raw text between pipes)", () => {
    const [t] = findTables(TABLE);
    const cell = t.cells.find((c) => c.row === 2 && c.col === 1)!;
    expect(TABLE.slice(cell.from, cell.to)).toBe(" cut prices hard ");
  });

  it("ignores text after the prose limit (e.g. the comment block)", () => {
    const withBlock = TABLE + "\n\n```tandem-comments\n{}\n```\n";
    expect(findTables(withBlock, TABLE.length)).toHaveLength(1);
  });

  it("handles tables without surrounding pipes", () => {
    const t = findTables("a | b\n--- | ---\nc | d");
    expect(t).toHaveLength(1);
    expect(t[0].cells.filter((c) => c.row === 0)).toHaveLength(2);
  });

  it("returns nothing when there is no delimiter row", () => {
    expect(findTables("| a | b |\n| c | d |")).toHaveLength(0);
  });

  it("does not treat a setext heading as a table (delimiter column count must match header)", () => {
    // `some | text` followed by `---`: header has 2 columns, delimiter has 1.
    expect(findTables("some | text\n---")).toHaveLength(0);
    expect(findTables("Heading\n---")).toHaveLength(0);
  });
});

describe("locateCell", () => {
  it("maps a prose offset to the cell that contains it", () => {
    const [t] = findTables(TABLE);
    const pos = TABLE.indexOf("cut prices hard");
    const cell = locateCell(t, pos)!;
    expect(cell.row).toBe(2);
    expect(cell.col).toBe(1);
  });

  it("returns null for a position in the delimiter row", () => {
    const [t] = findTables(TABLE);
    const pos = TABLE.indexOf("----");
    expect(locateCell(t, pos)).toBeNull();
  });
});

describe("rangesTouchTable", () => {
  it("is true when an edit falls inside a table", () => {
    const pos = TABLE.indexOf("cut prices hard");
    expect(rangesTouchTable(TABLE, TABLE.length, [{ from: pos, to: pos + 3 }])).toBe(true);
  });

  it("is true when a row is appended at the table's end", () => {
    expect(rangesTouchTable(TABLE, TABLE.length, [{ from: TABLE.length, to: TABLE.length }])).toBe(true);
  });

  it("is false for an edit in prose outside any table", () => {
    const doc = "Some prose here.\n\n" + TABLE;
    expect(rangesTouchTable(doc, doc.length, [{ from: 5, to: 8 }])).toBe(false);
  });

  it("is false when there are no tables", () => {
    expect(rangesTouchTable("just prose", 10, [{ from: 0, to: 4 }])).toBe(false);
  });
});

describe("visibleText", () => {
  it("strips bold and italic", () => {
    expect(visibleText("cut **prices** hard")).toBe("cut prices hard");
    expect(visibleText("a *very* nice _idea_")).toBe("a very nice idea");
  });

  it("strips strikethrough, highlight and code", () => {
    expect(visibleText("~~old~~ ==new== `code`")).toBe("old new code");
  });

  it("reduces links and wikilinks to their visible label", () => {
    expect(visibleText("see [the docs](https://x.com)")).toBe("see the docs");
    expect(visibleText("[[Note|alias]] and [[Other]]")).toBe("alias and Other");
  });

  it("leaves plain text untouched", () => {
    expect(visibleText("just plain text")).toBe("just plain text");
  });
});
