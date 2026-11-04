import type { EditorView } from "@codemirror/view";
import { findCallouts, locateCalloutHighlight, type ParsedCallout } from "./callout-highlight";
import type { TrackedAnchor } from "./reanchor";
import { findTables, locateTableHighlight, type ParsedTable } from "./table-highlight";

/**
 * Live-Preview ersetzt Tabellen und Callouts durch gerenderte Widgets, in denen
 * CM-`mark`-Dekorationen nicht gezeichnet werden. Für Anker darin werden die
 * Highlights direkt ins Widget-DOM geschrieben: table-highlight.ts und
 * callout-highlight.ts finden die Stelle, dieser Modul setzt und entfernt die Spans.
 */

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
    // Reine Zeilenumbruch-Knoten zwischen Block-Elementen (z.B. zwischen zwei
    // <p> eines Callouts) nicht umschließen — das gäbe nur eine leere Markierung zwischen den Absätzen.
    const blockGap = /^\s*\n\s*$/.test(node.nodeValue ?? "");
    if (nodeEnd > start && nodeStart < end && !blockGap) {
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
    span.dataset.tcWidget = "1";
    // CM-eventHandlers greifen nicht im Widget-DOM (Tabelle, Callout) — Listener
    // direkt am Span setzen. Das Event wird abgefangen, damit das Widget NICHT
    // in den interaktiven Edit-Modus springt: dort würde der Highlight
    // verschwinden (CM-mark-Dekorationen rendern im Tabellen-Editor nicht).
    // Zum Editieren woanders in die Zelle bzw. das Callout klicken.
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

interface HighlightSnapshot {
  signature: string;
  widgets: HTMLElement[];
  contents: string[];
  spans: Element[];
}
const highlightedViews = new WeakMap<EditorView, HighlightSnapshot>();

const INJECTED = "span.tc-highlight[data-tc-widget]";

/** Remove injected highlights when their anchors or table/callout widgets change. */
export function clearWidgetHighlights(view: EditorView): void {
  highlightedViews.delete(view);
  view.contentDOM.querySelectorAll<HTMLElement>(INJECTED).forEach((span) => {
    const parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  });
}

/**
 * Setzt für jeden Anker, der in einer (als Widget gerenderten) Tabelle oder
 * einem Callout liegt, den Highlight direkt im Widget-DOM. Idempotent: räumt vorher auf.
 */
export function applyWidgetHighlights(
  view: EditorView,
  anchors: TrackedAnchor[],
  text: string,
  proseLen: number,
  onClick: (id: string) => void,
  tables: ParsedTable[] = findTables(text, proseLen),
  callouts: ParsedCallout[] = findCallouts(text, proseLen)
): void {
  const domTables = Array.from(view.contentDOM.querySelectorAll<HTMLTableElement>("table"));
  const domCallouts = Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-callout"));
  const widgets: HTMLElement[] = [...domTables, ...domCallouts];
  const signature = JSON.stringify(anchors.map((a) => [a.id, a.from, a.to, text.slice(a.from, a.to)]));
  const previous = highlightedViews.get(view);
  const spans = Array.from(view.contentDOM.querySelectorAll(INJECTED));
  if (previous && previous.signature === signature &&
      previous.widgets.length === widgets.length &&
      widgets.every((widget, i) => widget === previous.widgets[i] && widget.innerHTML === previous.contents[i]) &&
      spans.length === previous.spans.length && spans.every((span, i) => span === previous.spans[i])) return;
  clearWidgetHighlights(view);
  if (tables.length === 0 && callouts.length === 0) return;
  for (const a of anchors) {
    // Pro Anker absichern, damit ein Sonderfall nicht die übrigen Highlights killt.
    try {
      // Callouts zuerst: eine Tabelle in einem Callout (`> | a | b |`) erkennt findTables nicht.
      const target = locateCalloutHighlight(view, a, text, callouts, domCallouts)
        ?? locateTableHighlight(view, a, text, tables, domTables);
      if (target) wrapRange(target.root, target.start, target.end - target.start, a.id, onClick);
    } catch {
      // ignorieren — dieser Anker wird in diesem Durchlauf einfach nicht markiert.
    }
  }
  highlightedViews.set(view, { signature, widgets,
    contents: widgets.map((widget) => widget.innerHTML),
    spans: Array.from(view.contentDOM.querySelectorAll(INJECTED)),
  });
}
