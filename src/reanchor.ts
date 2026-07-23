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
