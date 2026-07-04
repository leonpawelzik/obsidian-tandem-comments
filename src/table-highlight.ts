import type { EditorView } from "@codemirror/view";
import type { TrackedAnchor } from "./reanchor";

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

interface Line {
  text: string;
  from: number;
}

function splitLines(text: string, limit: number): Line[] {
  const lines: Line[] = [];
  let from = 0;
  for (const part of text.slice(0, limit).split("\n")) {
    lines.push({ text: part, from });
    from += part.length + 1; // +1 für das entfernte "\n"
  }
  return lines;
}

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
  ranges: { from: number; to: number }[]
): boolean {
  const tables = findTables(text, proseLen);
  return tables.some((t) => ranges.some((r) => r.from <= t.to && r.to >= t.from));
}

/** Zelle, deren Inhaltsspanne die Position enthält (oder null, z.B. Delimiter-Zeile). */
export function locateCell(table: ParsedTable, pos: number): Cell | null {
  for (const c of table.cells) {
    if (pos >= c.from && pos < c.to) return c;
  }
  return null;
}

/**
 * Sichtbarer Text einer Inline-Markdown-Spanne — Syntax wird entfernt, sodass
 * er dem gerenderten textContent der Zelle entspricht (z.B. `**Preis**` → `Preis`).
 * Der Anker-`exact` stammt aus dem Quelltext (mit Syntax); im Tabellen-DOM steht
 * aber nur der gerenderte Text, daher muss danach gesucht werden.
 */
export function visibleText(md: string): string {
  return md
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2") // [[Ziel|Alias]] → Alias
    .replace(/\[\[([^\]]+)\]\]/g, "$1") // [[Ziel]] → Ziel
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [Label](url) / ![alt](url) → Label
    .replace(/(\*\*|__)(.+?)\1/g, "$2") // **fett** / __fett__
    .replace(/(\*|_)(.+?)\1/g, "$2") // *kursiv* / _kursiv_
    .replace(/~~(.+?)~~/g, "$1") // ~~durchgestrichen~~
    .replace(/==(.+?)==/g, "$1") // ==hervorgehoben==
    .replace(/`([^`]+)`/g, "$1"); // `code`
}

/** Findet das DOM-<table>, dessen Quell-Position im Bereich des Tabellenblocks liegt. */
function findDomTable(view: EditorView, table: ParsedTable): HTMLTableElement | null {
  const tables = view.contentDOM.querySelectorAll("table");
  for (const el of Array.from(tables)) {
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

/** Umschließt [start, start+len) im Element mit <span class="tc-highlight">, über Textknoten hinweg. */
function wrapRange(
  root: HTMLElement,
  start: number,
  len: number,
  id: string,
  onClick: (id: string) => void
): boolean {
  const doc = root.ownerDocument;
  const end = start + len;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: { node: Text; s: number; e: number }[] = [];
  let pos = 0;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const node = n as Text;
    const nodeLen = node.nodeValue?.length ?? 0;
    const nodeStart = pos;
    const nodeEnd = pos + nodeLen;
    if (nodeEnd > start && nodeStart < end) {
      targets.push({ node, s: Math.max(0, start - nodeStart), e: Math.min(nodeLen, end - nodeStart) });
    }
    pos = nodeEnd;
    if (pos >= end) break;
  }
  if (targets.length === 0) return false;
  for (const t of targets) {
    const range = doc.createRange();
    range.setStart(t.node, t.s);
    range.setEnd(t.node, t.e);
    const span = doc.createElement("span");
    span.className = "tc-highlight";
    span.dataset.tcId = id;
    span.dataset.tcTable = "1";
    // CM-eventHandlers greifen nicht im Widget-DOM der Tabelle — Listener direkt
    // am Span setzen. Das Event wird abgefangen, damit das Tabellen-Widget NICHT
    // in den interaktiven Edit-Modus springt: dort würde der Highlight
    // verschwinden (CM-mark-Dekorationen rendern im Tabellen-Editor nicht).
    // Zum Editieren woanders in die Zelle klicken.
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    span.addEventListener("pointerdown", (e) => {
      swallow(e);
      onClick(id);
    });
    span.addEventListener("mousedown", swallow);
    span.addEventListener("click", swallow);
    try {
      range.surroundContents(span);
    } catch {
      return false;
    }
  }
  return true;
}

/** Entfernt alle von uns injizierten Tabellen-Highlights (vor jedem Re-Apply). */
export function clearTableHighlights(view: EditorView): void {
  view.contentDOM.querySelectorAll<HTMLElement>("span.tc-highlight[data-tc-table]").forEach((span) => {
    const parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  });
}

/**
 * Setzt für jeden Anker, der in einer (als Widget gerenderten) Tabelle liegt,
 * den Highlight direkt im Tabellen-DOM. Idempotent: räumt vorher auf.
 */
export function applyTableHighlights(
  view: EditorView,
  anchors: TrackedAnchor[],
  text: string,
  proseLen: number,
  onClick: (id: string) => void
): void {
  clearTableHighlights(view);
  const tables = findTables(text, proseLen);
  if (tables.length === 0) return;
  for (const a of anchors) {
    // Pro Anker absichern, damit ein Sonderfall nicht die übrigen Highlights killt.
    try {
      const table = tables.find((t) => a.from >= t.from && a.to <= t.to);
      if (!table) continue;
      const cell = locateCell(table, a.from);
      if (!cell) continue;
      const domTable = findDomTable(view, table);
      if (!domTable) continue;
      const cellEl = domCell(domTable, cell);
      if (!cellEl) continue;
      // Quell-Offsets passen nicht zum gerenderten Zelltext: Inline-Markdown
      // (**fett**, [Label](url) …) wird gerendert weggekürzt, und Syntax *vor*
      // dem Anker verschiebt den Offset. Daher im gerenderten Text nach dem
      // sichtbaren Text suchen statt zu rechnen.
      const visible = visibleText(text.slice(a.from, a.to));
      if (!visible) continue;
      const k = cellEl.textContent?.indexOf(visible) ?? -1;
      if (k >= 0) wrapRange(cellEl, k, visible.length, a.id, onClick);
    } catch {
      // ignorieren — dieser Anker wird in diesem Durchlauf einfach nicht markiert.
    }
  }
}
