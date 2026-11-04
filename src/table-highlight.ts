import type { EditorView } from "@codemirror/view";
import { splitLines, visibleText, type Line } from "./markdown-text";
import type { TrackedAnchor } from "./reanchor";
import type { HighlightTarget } from "./types";

/**
 * Live-Preview rendert Tabellen als Widget (ersetzt den Quelltext durch ein
 * <table>). CM-`mark`-Dekorationen innerhalb eines ersetzten Bereichs werden
 * nicht gezeichnet — der Highlight verschwindet also in Tabellen. Dieser Modul
 * findet die Zelle, in der ein Anker liegt, und setzt den Highlight direkt im
 * gerenderten Tabellen-DOM (siehe Issue #3).
 */

/** Rohe Zelle: Quell-Offsets des Inhalts zwischen zwei Pipes (ohne Trim). */
export interface Cell {
  /** 0-basierte Zeilen-Nummer innerhalb des Tabellenblocks (Delimiter-Zeile = 1, hat keine Zellen). */
  row: number;
  /** 0-basierte Spalten-Nummer. */
  col: number;
  from: number;
  to: number;
}

export interface ParsedTable {
  from: number;
  to: number;
  cells: Cell[];
}

/** Delimiter-Zeile einer GFM-Tabelle, z.B. `| --- | :--: |`. */
const DELIMITER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/**
 * Zerlegt eine Tabellenzeile in Zell-Inhaltsspannen (Offsets relativ zum Dok).
 * Führende/abschließende Whitespace-Segmente von umschließenden Pipes werden
 * verworfen, sodass Spalten 0-basiert ab der ersten echten Zelle zählen.
 */
function splitRow(line: Line): { from: number; to: number }[] {
  const segments: { start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i < line.text.length; i++) {
    if (line.text[i] === "\\") {
      i++; // escapte Pipe (\|) überspringen
      continue;
    }
    if (line.text[i] === "|") {
      segments.push({ start, end: i });
      start = i + 1;
    }
  }
  segments.push({ start, end: line.text.length });
  // Umschließende Pipes erzeugen leere Randsegmente — verwerfen.
  if (segments.length > 1 && line.text.slice(segments[0].start, segments[0].end).trim() === "") {
    segments.shift();
  }
  if (segments.length > 1) {
    const last = segments[segments.length - 1];
    if (line.text.slice(last.start, last.end).trim() === "") segments.pop();
  }
  return segments.map((s) => ({ from: line.from + s.start, to: line.from + s.end }));
}

/** Findet alle GFM-Tabellenblöcke im Prosa-Bereich [0, limit). */
export function findTables(text: string, limit: number = text.length): ParsedTable[] {
  const lines = splitLines(text, limit);
  const tables: ParsedTable[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i];
    const delim = lines[i + 1];
    if (!delim || !header.text.includes("|") || !DELIMITER.test(delim.text)) continue;
    // GFM verlangt gleiche Spaltenzahl in Header und Delimiter — schließt z.B.
    // eine Setext-Überschrift (`some | text` gefolgt von `---`) aus, die sonst
    // als 1-spaltige Tabelle durchginge.
    if (splitRow(header).length !== splitRow(delim).length) continue;

    let end = i; // letzte zum Block gehörende Zeile
    for (let j = i + 2; j < lines.length; j++) {
      if (lines[j].text.trim() === "" || !lines[j].text.includes("|")) break;
      end = j;
    }
    if (end < i + 2) end = i; // nur Header + Delimiter, kein Body → trotzdem gültig

    const cells: Cell[] = [];
    for (let r = i; r <= end; r++) {
      if (r === i + 1) continue; // Delimiter-Zeile hat keine Zellen
      const rowIndex = r - i;
      splitRow(lines[r]).forEach((span, col) => cells.push({ row: rowIndex, col, ...span }));
    }
    const last = lines[end];
    tables.push({ from: header.from, to: last.from + last.text.length, cells });
    i = end;
  }
  return tables;
}

/**
 * Prüft, ob eine der geänderten Spannen einen Tabellenblock berührt. Obsidian
 * formatiert editierte Tabellen neu (Spalten-Ausrichtung, neue Zeilen), was
 * Positions-Mapping unzuverlässig macht — in dem Fall sollten Anker per exaktem
 * Text neu aufgelöst statt umgeschrieben werden (sonst verwaisen Kommentare).
 */
export function rangesTouchTable(
  text: string,
  proseLen: number,
  ranges: { from: number; to: number }[],
  tables: ParsedTable[] = findTables(text, proseLen)
): boolean {
  return tables.some((t) => ranges.some((r) => r.from <= t.to && r.to >= t.from));
}

/** Zelle, deren Inhaltsspanne die Position enthält (oder null, z.B. Delimiter-Zeile). */
export function locateCell(table: ParsedTable, pos: number): Cell | null {
  for (const c of table.cells) {
    if (pos >= c.from && pos < c.to) return c;
  }
  return null;
}

/** Findet das DOM-<table>, dessen Quell-Position im Bereich des Tabellenblocks liegt. */
function findDomTable(view: EditorView, table: ParsedTable, tables: HTMLTableElement[]): HTMLTableElement | null {
  for (const el of tables) {
    let pos: number;
    try {
      pos = view.posAtDOM(el);
    } catch {
      continue;
    }
    if (pos >= table.from && pos <= table.to) return el as HTMLTableElement;
  }
  return null;
}

/** Liefert die gerenderte Zelle für eine Quell-(row,col): row 0 = Header, row≥2 = Body-Zeile row-2. */
function domCell(domTable: HTMLTableElement, cell: Cell): HTMLTableCellElement | null {
  if (cell.row === 0) {
    const headerRow = domTable.tHead?.rows[0] ?? domTable.rows[0];
    return (headerRow?.cells[cell.col] as HTMLTableCellElement) ?? null;
  }
  const body = domTable.tBodies[0];
  return (body?.rows[cell.row - 2]?.cells[cell.col] as HTMLTableCellElement) ?? null;
}

/**
 * Wo im gerenderten Tabellen-DOM der Anker markiert wird, oder null, wenn er
 * nicht in einer Tabellenzelle liegt.
 */
export function locateTableHighlight(
  view: EditorView,
  anchor: TrackedAnchor,
  text: string,
  tables: ParsedTable[],
  domTables: HTMLTableElement[]
): HighlightTarget | null {
  const table = tables.find((t) => anchor.from >= t.from && anchor.to <= t.to);
  if (!table) return null;
  const cell = locateCell(table, anchor.from);
  if (!cell) return null;
  const domTable = findDomTable(view, table, domTables);
  if (!domTable) return null;
  const cellEl = domCell(domTable, cell);
  if (!cellEl) return null;
  // Quell-Offsets passen nicht zum gerenderten Zelltext: Inline-Markdown
  // (**fett**, [Label](url) …) wird gerendert weggekürzt, und Syntax *vor*
  // dem Anker verschiebt den Offset. Daher im gerenderten Text nach dem
  // sichtbaren Text suchen statt zu rechnen.
  const visible = visibleText(text.slice(anchor.from, anchor.to));
  if (!visible) return null;
  const k = cellEl.textContent?.indexOf(visible) ?? -1;
  return k >= 0 ? { root: cellEl, start: k, end: k + visible.length } : null;
}
