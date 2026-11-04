import type { EditorView } from "@codemirror/view";
import { countOccurrences, locateVisibleText, splitLines, visibleText, withoutWhitespace } from "./markdown-text";
import type { TrackedAnchor } from "./reanchor";
import type { HighlightTarget } from "./types";

/**
 * Live-Preview rendert Callouts (`> [!type] Titel` samt ihrer `>`-Zeilen) wie
 * Tabellen als Widget, in dem CM-`mark`-Dekorationen nicht gerendert werden.
 * Dieses Modul findet das Callout, in dem ein Anker liegt, und die Stelle im
 * gerenderten Callout-DOM, an der er markiert wird.
 */

/** Callout-Block: von der `[!type]`-Zeile bis zur letzten `>`-Zeile. */
export interface ParsedCallout {
  from: number;
  /** Beginn der ersten Zeile nach der Kopfzeile (= `to`, wenn es keine gibt). */
  bodyFrom: number;
  to: number;
}

/** Kopfzeile eines Callouts, z.B. `> [!note]` oder `> [!tip]- Titel`. */
const CALLOUT_START = /^ {0,3}>\s*\[![^\]\s]+\][+-]?/;
const QUOTE_LINE = /^ {0,3}>/;
/**
 * Block-Syntax am Zeilenanfang, die gerendert verschwindet: Blockquote-Marker
 * (`> `, `>> `), danach optional ein Listen-, Aufgaben- oder Überschriften-Marker.
 */
const LINE_MARKERS = /^ {0,3}(?:>\s?)*\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?|#{1,6}\s+)?/;
const CALLOUT_TYPE = /^\[![^\]\s]+\][+-]?\s*/;

/** Findet alle Callout-Blöcke im Prosa-Bereich [0, limit). Ein Block endet an der ersten Zeile ohne `>`. */
export function findCallouts(text: string, limit: number = text.length): ParsedCallout[] {
  const lines = splitLines(text, limit);
  const callouts: ParsedCallout[] = [];
  for (let i = 0; i < lines.length; i++) {
    // `[!type]` macht nur in der ersten Zeile eines Blockquotes ein Callout.
    if (!CALLOUT_START.test(lines[i].text) || (i > 0 && QUOTE_LINE.test(lines[i - 1].text))) continue;
    const header = lines[i];
    while (i + 1 < lines.length && QUOTE_LINE.test(lines[i + 1].text)) i++;
    const to = lines[i].from + lines[i].text.length;
    callouts.push({ from: header.from, bodyFrom: lines[i] === header ? to : header.from + header.text.length + 1, to });
  }
  return callouts;
}

/**
 * Gerenderter Text einer Callout-Quellspanne, ohne jeden Whitespace: Block-
 * Marker am Zeilenanfang, der `[!type]`-Marker und Inline-Markdown werden
 * entfernt. Whitespace fällt komplett weg, weil das Rendering Zeilen und
 * Absätze anders verbindet als der Quelltext (`<p>`-Grenzen ohne Zeichen,
 * `<br>` statt `\n` …) — verglichen wird daher nur, was sicher sichtbar ist.
 * `atLineStart`: ob die erste Zeile der Spanne am Zeilenanfang beginnt (sonst
 * ist z.B. ein `- ` darin normaler Text, kein Listen-Marker).
 */
function calloutVisibleText(md: string, atLineStart: boolean, atCalloutStart = false): string {
  const unmarked = md
    .split("\n")
    .map((line, i) => (i === 0 && !atLineStart ? line : line.replace(LINE_MARKERS, "")))
    .join("\n");
  const untyped = atCalloutStart ? unmarked.replace(CALLOUT_TYPE, "") : unmarked;
  return withoutWhitespace(visibleText(untyped)).text;
}

/**
 * Durchsuchter Bereich im Callout-Widget (Selektor): nur der Inhalt
 * (`.callout-content`), wenn der Anker im Body beginnt, sonst das ganze Callout
 * samt Titel. Ein Callout ohne Titel zeigt den Typ-Namen ("Note") als Titel,
 * der nicht im Quelltext steht — der Titel darf daher nicht mitgezählt werden,
 * wenn der Anker im Body liegt.
 */
export type CalloutScope = ".callout-content" | ".callout";

/**
 * Wonach im gerenderten Callout für den Anker [from, to) gesucht wird: sein
 * sichtbarer Text (ohne Whitespace), wie oft dieser Text davor im durchsuchten
 * Bereich vorkommt — damit eine wiederholte Phrase an der richtigen Stelle
 * markiert wird — und welcher Bereich durchsucht wird.
 */
function calloutTarget(
  text: string,
  callout: ParsedCallout,
  from: number,
  to: number
): { visible: string; occurrence: number; scope: CalloutScope } | null {
  // Der `> [!type]`-Marker selbst wird nicht gerendert — dort gibt es nichts zu markieren.
  const markerEnd = callout.from + (CALLOUT_START.exec(text.slice(callout.from, callout.to))?.[0].length ?? 0);
  if (from < markerEnd) return null;
  const lineStart = text.lastIndexOf("\n", from - 1) + 1;
  // Beginnt der Anker direkt hinter den Block-Markern, zählt er als Zeilenanfang.
  const atLineStart = text.slice(lineStart, from).replace(LINE_MARKERS, "") === "";
  const visible = calloutVisibleText(text.slice(from, to), atLineStart);
  if (!visible) return null;
  const inBody = from >= callout.bodyFrom;
  const before = inBody
    ? calloutVisibleText(text.slice(callout.bodyFrom, from), true)
    : calloutVisibleText(text.slice(callout.from, from), true, true);
  return { visible, occurrence: countOccurrences(before, visible), scope: inBody ? ".callout-content" : ".callout" };
}

/**
 * Findet die Stelle des Ankers [from, to) im gerenderten Callout: das Element,
 * das `rootOf` für das Callout und den durchsuchten Bereich liefert, und die
 * Spanne in dessen textContent (passend für wrapRange). Whitespace wird dabei
 * wie in calloutVisibleText ignoriert. Der DOM-Zugriff steckt komplett in
 * `rootOf`, damit sich die Logik ohne DOM testen lässt.
 */
export function locateInCallout<T extends { textContent: string | null }>(
  text: string,
  callouts: ParsedCallout[],
  from: number,
  to: number,
  rootOf: (callout: ParsedCallout, scope: CalloutScope) => T | null
): { root: T; start: number; end: number } | null {
  const callout = callouts.find((c) => from >= c.from && to <= c.to);
  if (!callout) return null;
  const target = calloutTarget(text, callout, from, to);
  if (!target) return null;
  const root = rootOf(callout, target.scope);
  if (!root) return null;
  const span = locateVisibleText(root.textContent ?? "", target.visible, target.occurrence);
  return span && { root, ...span };
}

/** Findet das Callout-Widget, das im Bereich des Callout-Blocks beginnt. */
function findDomCallout(view: EditorView, callout: ParsedCallout, widgets: HTMLElement[]): HTMLElement | null {
  for (const el of widgets) {
    let pos: number;
    try {
      pos = view.posAtDOM(el);
    } catch {
      continue;
    }
    if (pos >= callout.from && pos <= callout.to) return el;
  }
  return null;
}

/**
 * Wo im gerenderten Callout-DOM der Anker markiert wird, oder null, wenn er
 * nicht in einem Callout liegt (oder dort nicht gefunden wird).
 */
export function locateCalloutHighlight(
  view: EditorView,
  anchor: TrackedAnchor,
  text: string,
  callouts: ParsedCallout[],
  domCallouts: HTMLElement[]
): HighlightTarget | null {
  return locateInCallout(text, callouts, anchor.from, anchor.to, (callout, scope) =>
    findDomCallout(view, callout, domCallouts)?.querySelector<HTMLElement>(scope) ?? null
  );
}
