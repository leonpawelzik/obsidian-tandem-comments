import { ChangeSet, type Text } from "@codemirror/state";

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

/** Zeichen, mit denen Obsidian Tabellenspalten auffüllt (Leerraum, Delimiter-Striche). */
const PADDING = /[\s-]/;

interface Replacement {
  from: number;
  to: number;
  insert: string;
}

/**
 * Grenzt eine Ersetzung auf das ein, was sich wirklich ändert: gleicher Text an
 * Anfang und Ende fällt weg, Unterschiede nur in der Auffüllung werden eigene
 * kleine Änderungen. Übrig bleibt höchstens eine echte Änderung in der Mitte.
 */
function refineReplacement(from: number, before: string, after: string): Replacement[] {
  const out: Replacement[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      i++;
      j++;
      continue;
    }
    let nextI = i;
    let nextJ = j;
    while (nextI < before.length && PADDING.test(before[nextI])) nextI++;
    while (nextJ < after.length && PADDING.test(after[nextJ])) nextJ++;
    if ((nextI === i && nextJ === j) || nextI === before.length || before[nextI] !== after[nextJ]) break;
    out.push({ from: from + i, to: from + nextI, insert: after.slice(j, nextJ) });
    i = nextI;
    j = nextJ;
  }
  let endI = before.length;
  let endJ = after.length;
  while (endI > i && endJ > j) {
    if (before[endI - 1] === after[endJ - 1]) {
      endI--;
      endJ--;
      continue;
    }
    let nextI = endI;
    let nextJ = endJ;
    while (nextI > i && PADDING.test(before[nextI - 1])) nextI--;
    while (nextJ > j && PADDING.test(after[nextJ - 1])) nextJ--;
    if ((nextI === endI && nextJ === endJ) || nextI === i || nextJ === j || before[nextI - 1] !== after[nextJ - 1]) break;
    out.push({ from: from + nextI, to: from + endI, insert: after.slice(nextJ, endJ) });
    endI = nextI;
    endJ = nextJ;
  }
  if (endI > i || endJ > j) out.push({ from: from + i, to: from + endI, insert: after.slice(j, endJ) });
  return out;
}

/** Dieselbe Änderung, mit eingegrenzten Ersetzungen; null, wenn sie gar keine Ersetzung enthält. */
export function refineChanges(changes: ChangeSet, oldDoc: Text): ChangeSet | null {
  const refined: Replacement[] = [];
  let hasReplacement = false;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const insert = inserted.toString();
    if (toA > fromA && insert) {
      hasReplacement = true;
      refined.push(...refineReplacement(fromA, oldDoc.sliceString(fromA, toA), insert));
    } else {
      refined.push({ from: fromA, to: toA, insert });
    }
  }, true);
  return hasReplacement ? ChangeSet.of(refined, changes.length) : null;
}

/**
 * Wie mapAnchors, aber auch durch Ersetzungen größerer Blöcke hindurch: Obsidian
 * ersetzt bei kleinen Edits ganze Tabellenzellen, Tabellen oder Callouts.
 * `torn` sind Anker, deren Rand mitten im wirklich Ersetzten liegt — ihre
 * Position ist dort nur geraten.
 */
export function mapAnchorsPrecisely(
  anchors: TrackedAnchor[],
  changes: ChangeSet,
  oldDoc: Text
): { mapped: TrackedAnchor[]; torn: Set<string> } {
  const refined = refineChanges(changes, oldDoc);
  if (!refined) return { mapped: mapAnchors(anchors, changes), torn: new Set() };
  const torn = new Set<string>();
  refined.iterChangedRanges((fromA, toA) => {
    for (const a of anchors) {
      if ((fromA < a.from && a.from < toA) || (fromA < a.to && a.to < toA)) torn.add(a.id);
    }
  }, true);
  const newDoc = changes.apply(oldDoc);
  const mapped = [
    ...mapAnchors(anchors.filter((a) => !torn.has(a.id)), refined),
    ...mapAnchors(anchors.filter((a) => torn.has(a.id)), changes),
  ]
    // Vom Zitat blieb nur Auffüllung übrig: Es wurde gelöscht.
    .filter((a) => newDoc.sliceString(a.from, a.to).trim())
    .sort((a, b) => a.from - b.from);
  return { mapped, torn };
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

/**
 * Whether a transaction changes the tandem-comments region in either its old
 * or new coordinate space. Mixed prose + block transactions (such as accepting
 * a suggestion) must rebuild anchors from the resulting document instead of
 * retaining IDs that may have been removed from the block.
 */
export function changesTouchCommentBlock(changes: ChangeSet, oldProseLength: number, newProseLength: number): boolean {
  let touches = false;
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (
      fromA >= oldProseLength ||
      toA > oldProseLength ||
      fromB >= newProseLength ||
      toB > newProseLength
    ) {
      touches = true;
    }
  });
  return touches;
}

/**
 * Whether tracked anchors can be mapped safely through a block-touching
 * transaction. Explicit mixed transactions and block-only rewrites retain
 * meaningful change coordinates; a single large prose replacement does not.
 */
export function canPreservePendingAnchors(changes: ChangeSet, oldProseLength: number): boolean {
  let ranges = 0;
  let touchesProse = false;
  changes.iterChangedRanges((fromA) => {
    ranges++;
    if (fromA < oldProseLength) touchesProse = true;
  });
  return !isFullReplace(changes) || ranges > 1 || !touchesProse;
}

export function shouldPreservePendingAnchors(
  changes: ChangeSet,
  oldProseLength: number,
  isSuggestionAcceptance: boolean
): boolean {
  return isSuggestionAcceptance || canPreservePendingAnchors(changes, oldProseLength);
}

/**
 * Restores in-memory anchors that disappeared only because a block rewrite
 * serialized stale quote data before the reanchor debounce could flush.
 */
export function mergePendingAnchors(
  current: TrackedAnchor[],
  pending: TrackedAnchor[],
  recoverableIds: ReadonlySet<string>
): TrackedAnchor[] {
  const result = [...current];
  const present = new Set(current.map((anchor) => anchor.id));
  for (const anchor of pending) {
    if (present.has(anchor.id) || !recoverableIds.has(anchor.id) || anchor.to <= anchor.from) continue;
    result.push(anchor);
    present.add(anchor.id);
  }
  result.sort((a, b) => a.from - b.from);
  return result;
}
