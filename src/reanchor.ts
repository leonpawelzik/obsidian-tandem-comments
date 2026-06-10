import type { ChangeSet } from "@codemirror/state";

export interface TrackedAnchor {
  id: string;
  from: number;
  to: number;
}

/**
 * Mappt Anker-Bereiche durch eine Editor-Änderung. `from` klebt am Zeichen
 * danach (assoc 1), `to` am Zeichen davor (assoc -1) — Einfügungen exakt an
 * den Rändern wachsen nicht in den Anker hinein. Komplett gelöschte Bereiche
 * fallen raus (werden später als Orphan behandelt).
 */
export function mapAnchors(anchors: TrackedAnchor[], changes: ChangeSet): TrackedAnchor[] {
  return anchors
    .map((a) => ({ id: a.id, from: changes.mapPos(a.from, 1), to: changes.mapPos(a.to, -1) }))
    .filter((a) => a.to > a.from);
}

/**
 * Heuristik: Ersetzt eine Änderung >50% des alten Dokuments, ist es vermutlich
 * ein externer Full-Replace (z.B. vault.modify) — dann ist Positions-Mapping
 * nicht vertrauenswürdig und es muss aus dem Dokument neu geparst werden.
 */
export function isFullReplace(changes: ChangeSet): boolean {
  let covered = 0;
  changes.iterChangedRanges((fromA, toA) => {
    covered += toA - fromA;
  });
  return changes.length > 0 && covered / changes.length > 0.5;
}
