import type { ChangeSet, Text } from "@codemirror/state";
import type { TrackedAnchor } from "./reanchor";
import { makeAnchor } from "./store";
import type { Anchor } from "./types";

/**
 * Zitate, die der Nutzer gelöscht hat. Ihr Kommentar darf nicht auf denselben
 * Text an anderer Stelle springen, soll aber mit dem Zitat zurückkommen (Undo,
 * Ausschneiden und Einfügen, Zeile verschieben).
 */
export interface LostAnchor {
  /** Gespeicherter Anker beim Löschen; weicht er später ab, wurde neu verankert. */
  stored: string;
  /** Anker mit dem Kontext unmittelbar vor dem Löschen. */
  anchor: Anchor;
  /** Gelöschter Text ohne Leerraum am Rand und die Lage des Zitats darin (-1: nicht ganz enthalten). */
  text: string;
  offset: number;
}

export interface TextChange {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
  inserted: string;
}

export function textChanges(changes: ChangeSet): TextChange[] {
  const out: TextChange[] = [];
  changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    out.push({ fromA, toA, fromB, toB, inserted: inserted.toString() });
  }, true);
  return out;
}

type Range = { from: number; to: number };

/** Findet ein verlorenes Zitat im Text, der seine Passage ersetzt hat — nur, wenn es dort eindeutig ist. */
export function findInReplacement(anchor: TrackedAnchor, changes: TextChange[], oldDoc: Text): Range | null {
  const quote = oldDoc.sliceString(anchor.from, anchor.to);
  const change = changes.find((c) => c.fromA < anchor.to && c.toA > anchor.from);
  if (!change) return null;
  const at = change.inserted.indexOf(quote);
  if (at < 0 || change.inserted.indexOf(quote, at + 1) >= 0) return null;
  return { from: change.fromB + at, to: change.fromB + at + quote.length };
}

export function loseAnchor(anchor: TrackedAnchor, stored: Anchor, changes: TextChange[], oldDoc: Text, oldProse: string): LostAnchor {
  const quote = oldDoc.sliceString(anchor.from, anchor.to);
  const change = changes.find((c) => c.fromA <= anchor.from && c.toA >= anchor.to);
  const deleted = change ? oldDoc.sliceString(change.fromA, change.toA) : "";
  const text = deleted.trim();
  // Zeichenweise gelöscht: Übrig ist nur ein Rest, das gespeicherte Zitat bleibt maßgeblich.
  const whole = quote === stored.exact;
  const offset = change && whole ? anchor.from - change.fromA - (deleted.length - deleted.trimStart().length) : -1;
  return {
    stored: JSON.stringify(stored),
    anchor: whole ? makeAnchor(oldProse, anchor.from, anchor.to) : stored,
    text,
    offset: text.startsWith(quote, offset) ? offset : -1,
  };
}

/** Wo ein gelöschtes Zitat mit dieser Änderung zurückkommt, oder null. */
export function findReturned(anchor: Anchor, lost: LostAnchor | undefined, changes: TextChange[], prose: string): Range | null {
  const length = anchor.exact.length;
  if (lost && lost.offset >= 0) {
    for (const change of changes) {
      const at = change.inserted.indexOf(lost.text);
      if (at < 0) continue;
      const from = change.fromB + at + lost.offset;
      if (from + length <= prose.length) return { from, to: from + length };
    }
  }
  const prefix = anchor.prefix ?? "";
  const context = prefix + anchor.exact + (anchor.suffix ?? "");
  if (context === anchor.exact) return null;
  for (let at = prose.indexOf(context); at >= 0; at = prose.indexOf(context, at + 1)) {
    const from = at + prefix.length;
    if (changes.some((c) => c.fromB < from + length && c.toB > from)) return { from, to: from + length };
  }
  return null;
}
