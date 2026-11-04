import { describe, expect, it } from "vitest";
import { visibleText } from "../src/markdown-text";
import { findTables, locateCell, locateInTable, rangesTouchTable } from "../src/table-highlight";

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

// Wie gerendert: Zellinhalt ohne umgebende Leerzeichen und ohne Inline-Markdown.
const renderCell = (cellSource: string) => visibleText(cellSource.trim());

/** Markiert `needle` (n-tes Vorkommen) im Tabellen-Quelltext; liefert den Zelltext und die Spanne darin. */
function spanOf(source: string, needle: string, nth = 0) {
  let from = source.indexOf(needle);
  for (let i = 0; i < nth; i++) from = source.indexOf(needle, from + 1);
  const span = locateInTable(source, findTables(source), from, from + needle.length,
    (_table, cell) => ({ textContent: renderCell(source.slice(cell.from, cell.to)) }));
  return span && { searched: span.root.textContent, start: span.start, end: span.end };
}

/** Markierter Text samt `context` Zeichen davor, um das Vorkommen zu unterscheiden. */
function highlighted(source: string, needle: string, nth = 0, context = 0): string | null {
  const span = spanOf(source, needle, nth);
  return span ? span.searched.slice(span.start - context, span.end) : null;
}

describe("locateInTable", () => {
  const PRICES = ["| Item | Notes |", "| ---- | ----- |", "| Pricing | old price, new price |"].join("\n");

  it("highlights the occurrence the anchor is, not the first one in the cell", () => {
    expect(highlighted(PRICES, "price", 0, 4)).toBe("old price");
    expect(highlighted(PRICES, "price", 1, 4)).toBe("new price");
  });

  it("counts occurrences in the rendered text, ignoring inline Markdown before the anchor", () => {
    const source = ["| a |", "| - |", "| **price** cut, price |"].join("\n");
    expect(highlighted(source, "price", 1, 5)).toBe("cut, price");
  });

  it("strips inline Markdown from the anchor", () => {
    expect(highlighted(TABLE, "Pricing")).toBe("Pricing");
    const bold = ["| a |", "| - |", "| cut **prices** hard |"].join("\n");
    expect(highlighted(bold, "**prices** hard")).toBe("prices hard");
  });

  it("returns null outside of tables and when the cell is not rendered", () => {
    expect(highlighted("Prose with price.\n\n" + PRICES, "price")).toBeNull();
    const from = PRICES.indexOf("price");
    expect(locateInTable(PRICES, findTables(PRICES), from, from + 5, () => null)).toBeNull();
  });
});
