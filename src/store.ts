import { ChangeSet } from "@codemirror/state";
import { mapAnchors } from "./reanchor";
import type {
  Anchor,
  AnchorResolution,
  CommentMap,
  CommentStatus,
  ParsedDoc,
  ResolvedComment,
  SuggestionResult,
  ThreadEntry,
} from "./types";

export const SCHEMA_HINT_LINES = [
  '// Schema: { "<id>": { anchor:{exact,prefix,suffix,pos?}, status:open|resolved, thread:[{author,ts,text}], suggestion?:{replacement,author,ts,result?} } }',
  '// Anchor = quote from the prose. To locate: search for "exact", disambiguate via prefix/suffix.',
];

export const FENCE_OPEN = "```tandem-comments";
const FENCE_AT_START = FENCE_OPEN + "\n";
const FENCE_NEEDLE = "\n" + FENCE_OPEN + "\n";
const FENCE_SCAN_CHUNK = 4096;
const CONTEXT_LEN = 20;

/** Minimal CodeMirror Text surface — locate the fence without flattening the doc. */
export interface TextSlice {
  readonly length: number;
  sliceString(from: number, to?: number): string;
}

export function parseBlockBody(body: string): CommentMap {
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && (lines[i].startsWith("//") || lines[i].trim() === "")) i++;
  const data: unknown = JSON.parse(lines.slice(i).join("\n"));
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("tandem-comments: top level must be an object");
  }
  return data as CommentMap;
}

/** Geometry of the last tandem-comments fence — no JSON parse. */
export interface BlockLocation {
  /** Exclusive end offset of prose (start of `\n```tandem-comments` or 0). */
  proseEnd: number;
  /** Raw fence body between open and close lines (may include // hints). */
  body: string;
  /** Byte-exact content after the closing fence (e.g. footnote defs). */
  trailing: string;
}

/**
 * Locates the last ```tandem-comments fence without parsing its JSON.
 * Use this on the keystroke path when only prose length / block bounds matter.
 */
export function locateBlock(raw: string): BlockLocation | null {
  // Letzter Block der Datei; danach darf weiterer Inhalt folgen (z.B. Fußnoten-
  // Definitionen, die Obsidian ans Dateiende hängt — Issue #2).
  const idx = raw.lastIndexOf("\n" + FENCE_OPEN + "\n");
  let proseEnd: number;
  let bodyStart: number;
  if (idx >= 0) {
    proseEnd = idx;
    bodyStart = idx + FENCE_OPEN.length + 2;
  } else if (raw.startsWith(FENCE_OPEN + "\n")) {
    proseEnd = 0;
    bodyStart = FENCE_OPEN.length + 1;
  } else {
    return null;
  }
  const rest = raw.slice(bodyStart);
  // Die eigene schließende Fence ist die erste vollständige ```-Zeile; der Body
  // kann keine enthalten (JSON escapet Newlines, Hint-Zeilen beginnen mit //).
  let closeIdx = rest.indexOf("\n```");
  while (closeIdx >= 0 && closeIdx + 4 < rest.length && rest[closeIdx + 4] !== "\n") {
    closeIdx = rest.indexOf("\n```", closeIdx + 1);
  }
  if (closeIdx < 0) return null;
  const trailing = closeIdx + 5 <= rest.length ? rest.slice(closeIdx + 5) : "";
  return { proseEnd, body: rest.slice(0, closeIdx), trailing };
}

/** Prose length only — fence scan, never JSON.parse. */
export function proseEndOf(raw: string): number {
  const blk = locateBlock(raw);
  return blk ? blk.proseEnd : raw.length;
}

/** True when `pos` is the exclusive prose end of a tandem-comments fence. */
export function fenceStartsAt(doc: TextSlice, pos: number): boolean {
  if (pos === 0) {
    return doc.length >= FENCE_AT_START.length && doc.sliceString(0, FENCE_AT_START.length) === FENCE_AT_START;
  }
  const end = pos + FENCE_NEEDLE.length;
  return end <= doc.length && doc.sliceString(pos, end) === FENCE_NEEDLE;
}

function lastOpenFence(doc: TextSlice): { proseEnd: number; bodyStart: number } | null {
  const n = doc.length;
  const overlap = FENCE_NEEDLE.length - 1;
  let end = n;
  while (end > 0) {
    const start = Math.max(0, end - FENCE_SCAN_CHUNK);
    const slice = doc.sliceString(start, end);
    const idx = slice.lastIndexOf(FENCE_NEEDLE);
    if (idx >= 0) {
      const proseEnd = start + idx;
      return { proseEnd, bodyStart: proseEnd + FENCE_NEEDLE.length };
    }
    if (start === 0) break;
    end = start + overlap;
  }
  if (n >= FENCE_AT_START.length && doc.sliceString(0, FENCE_AT_START.length) === FENCE_AT_START) {
    return { proseEnd: 0, bodyStart: FENCE_AT_START.length };
  }
  return null;
}

function closingFenceIndex(rest: string): number {
  let closeIdx = rest.indexOf("\n```");
  while (closeIdx >= 0 && closeIdx + 4 < rest.length && rest[closeIdx + 4] !== "\n") {
    closeIdx = rest.indexOf("\n```", closeIdx + 1);
  }
  return closeIdx;
}

/**
 * Prose end on a CodeMirror Text (or any sliceable buffer). Reads a suffix
 * around the fence instead of materializing the whole note.
 */
export function proseEndOfText(doc: TextSlice): number {
  const open = lastOpenFence(doc);
  if (!open) return doc.length;
  const rest = doc.sliceString(open.bodyStart);
  return closingFenceIndex(rest) >= 0 ? open.proseEnd : doc.length;
}

export function parseDocument(raw: string): ParsedDoc {
  const blk = locateBlock(raw);
  if (!blk) return { prose: raw, comments: {} };
  try {
    const comments = parseBlockBody(blk.body);
    const doc: ParsedDoc = { prose: raw.slice(0, blk.proseEnd), comments };
    if (blk.trailing) doc.trailing = blk.trailing;
    return doc;
  } catch (e) {
    return { prose: raw, comments: {}, error: e instanceof Error ? e.message : String(e) };
  }
}

export function serializeDocument(
  doc: { prose: string; comments: CommentMap; trailing?: string; error?: string },
  schemaHint: boolean
): string {
  if (doc.error) throw new Error("refusing to serialize a document with a parse error: " + doc.error);
  const trailing = doc.trailing ?? "";
  if (Object.keys(doc.comments).length === 0) {
    const separator =
      doc.prose && trailing && !doc.prose.endsWith("\n") && !trailing.startsWith("\n") ? "\n" : "";
    return doc.prose + separator + trailing;
  }
  const hint = schemaHint ? SCHEMA_HINT_LINES.join("\n") + "\n" : "";
  return (
    doc.prose + "\n" + FENCE_OPEN + "\n" + hint + JSON.stringify(doc.comments, null, 2) + "\n```\n" + trailing
  );
}

/**
 * Plant die Minimal-Änderungen, die Inhalt hinter dem Block (getippte Prosa,
 * von Obsidian angehängte Fußnoten-Definitionen) vor den Block zurückfalten,
 * sodass der Block wieder das letzte Element der Datei ist. Zwei Teil-
 * Änderungen (Block löschen, am Ende wieder anfügen) statt Ganz-Ersetzung,
 * damit CodeMirror den Cursor eines gerade tippenden Users korrekt mappt.
 * Anker sind zitat-basiert und überleben die Verschiebung. null = kanonisch.
 * Invariante: doc muss parseDocument(raw) desselben raw sein, sonst sind die
 * berechneten Offsets Müll.
 */
export function normalizeTrailingChanges(
  raw: string,
  doc: ParsedDoc
): { from: number; to: number; insert: string }[] | null {
  if (doc.error || !doc.trailing || doc.trailing.trim() === "") return null;
  const blockStart = doc.prose.length;
  const blockEnd = raw.length - doc.trailing.length;
  const block = raw.slice(blockStart, blockEnd);
  const blockText = block.startsWith("\n") ? block.slice(1) : block;
  const sep = raw.endsWith("\n") ? "" : "\n";
  return [
    { from: blockStart, to: blockEnd, insert: blockStart === 0 ? "" : "\n" },
    { from: raw.length, to: raw.length, insert: sep + blockText },
  ];
}

/**
 * Strikter Kontext-Vergleich. Von makeAnchor erzeugte Prefixe/Suffixe sind auf
 * den tatsächlich vorhandenen Text geklemmt und matchen daher immer exakt;
 * truncated/vakuose Matches (z.B. leerer Prefix am Dokumentanfang) sind
 * absichtlich KEINE Treffer — sonst kippt die Disambiguierung.
 */
function contextMatches(prose: string, at: number, len: number, anchor: Anchor): boolean {
  if (anchor.prefix && prose.slice(Math.max(0, at - anchor.prefix.length), at) !== anchor.prefix) return false;
  if (anchor.suffix && prose.slice(at + len, at + len + anchor.suffix.length) !== anchor.suffix) return false;
  return true;
}

/** True when `prose[from:to]` is still this quote — skip a full-note search. */
export function anchorStillAt(prose: string, from: number, to: number, exact: string): boolean {
  return (
    exact.length > 0 &&
    from >= 0 &&
    to <= prose.length &&
    to - from === exact.length &&
    prose.slice(from, to) === exact
  );
}

function findExactMatches(prose: string, exact: string): number[] {
  if (!exact) return [];
  const matches: number[] = [];
  let i = prose.indexOf(exact);
  while (i !== -1) {
    matches.push(i);
    i = prose.indexOf(exact, i + 1);
  }
  return matches;
}

interface AcNode {
  children: Map<number, AcNode>;
  fail: AcNode | null;
  outputs: string[];
}

function acFindAll(prose: string, exacts: string[]): Map<string, number[]> {
  const root: AcNode = { children: new Map(), fail: null, outputs: [] };
  for (const exact of exacts) {
    let n = root;
    for (let i = 0; i < exact.length; i++) {
      const c = exact.charCodeAt(i);
      let next = n.children.get(c);
      if (!next) {
        next = { children: new Map(), fail: null, outputs: [] };
        n.children.set(c, next);
      }
      n = next;
    }
    n.outputs.push(exact);
  }
  const q: AcNode[] = [];
  for (const child of root.children.values()) {
    child.fail = root;
    q.push(child);
  }
  for (let qi = 0; qi < q.length; qi++) {
    const n = q[qi];
    for (const [c, child] of n.children) {
      let f: AcNode | null = n.fail;
      while (f && f !== root && !f.children.has(c)) f = f.fail;
      child.fail = f?.children.get(c) ?? root;
      if (child.fail.outputs.length) child.outputs = child.outputs.concat(child.fail.outputs);
      q.push(child);
    }
  }
  const found = new Map<string, number[]>();
  for (const exact of exacts) found.set(exact, []);
  let n: AcNode = root;
  for (let i = 0; i < prose.length; i++) {
    const c = prose.charCodeAt(i);
    while (n !== root && !n.children.has(c)) n = n.fail ?? root;
    n = n.children.get(c) ?? root;
    for (const exact of n.outputs) {
      found.get(exact)!.push(i - exact.length + 1);
    }
  }
  return found;
}

/**
 * All start offsets of each unique `exact` in `prose`. One scan of the text
 * when there are two or more quotes; native `indexOf` for a single quote.
 */
export function matchPositionsByExact(prose: string, exacts: Iterable<string>): Map<string, number[]> {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const exact of exacts) {
    if (!exact || seen.has(exact)) continue;
    seen.add(exact);
    unique.push(exact);
  }
  if (unique.length === 0) return new Map();
  if (unique.length === 1) return new Map([[unique[0], findExactMatches(prose, unique[0])]]);
  return acFindAll(prose, unique);
}

export function resolutionFromMatches(
  prose: string,
  anchor: Anchor,
  matches: readonly number[]
): AnchorResolution {
  const exact = anchor.exact;
  if (!exact || matches.length === 0) return { kind: "orphaned" };
  let cands: number[] = matches as number[];
  if (cands.length > 1) {
    const filtered = cands.filter((m) => contextMatches(prose, m, exact.length, anchor));
    if (filtered.length > 0) cands = filtered;
  }
  if (cands.length === 1) return { kind: "resolved", start: cands[0], end: cands[0] + exact.length };
  let best = cands[0];
  if (anchor.pos != null) {
    const pos = anchor.pos;
    best = cands.reduce((a, b) => (Math.abs(b - pos) < Math.abs(a - pos) ? b : a));
  }
  return { kind: "resolved", start: best, end: best + exact.length, ambiguous: true };
}

export function resolveAnchor(prose: string, anchor: Anchor): AnchorResolution {
  return resolutionFromMatches(prose, anchor, findExactMatches(prose, anchor.exact));
}

export function makeAnchor(prose: string, start: number, end: number): Anchor {
  const anchor: Anchor = { exact: prose.slice(start, end), pos: start };
  const prefix = prose.slice(Math.max(0, start - CONTEXT_LEN), start);
  const suffix = prose.slice(end, Math.min(prose.length, end + CONTEXT_LEN));
  if (prefix) anchor.prefix = prefix;
  if (suffix) anchor.suffix = suffix;
  return anchor;
}

export function addComment(
  comments: CommentMap,
  id: string,
  anchor: Anchor,
  author: string,
  ts: string,
  text: string
): void {
  comments[id] = { anchor, status: "open", thread: [{ author, ts, text }] };
}

export function addSuggestion(
  comments: CommentMap,
  id: string,
  anchor: Anchor,
  author: string,
  ts: string,
  replacement: string,
  note?: string
): void {
  comments[id] = {
    anchor,
    status: "open",
    thread: note ? [{ author, ts, text: note }] : [],
    suggestion: { replacement, author, ts },
  };
}

export function addReply(comments: CommentMap, id: string, author: string, ts: string, text: string): void {
  const c = comments[id];
  if (!c) throw new Error(`tandem-comments: unknown comment id "${id}"`);
  c.thread.push({ author, ts, text });
}

export function editThreadEntry(
  comments: CommentMap,
  id: string,
  index: number,
  expected: ThreadEntry,
  text: string
): { ok: true } | { ok: false; reason: "missing" | "conflict" } {
  const entry = comments[id]?.thread[index];
  if (!entry) return { ok: false, reason: "missing" };
  if (entry.author !== expected.author || entry.ts !== expected.ts || entry.text !== expected.text) {
    return { ok: false, reason: "conflict" };
  }
  entry.text = text;
  return { ok: true };
}

export function setStatus(comments: CommentMap, id: string, status: CommentStatus): void {
  const c = comments[id];
  if (!c) throw new Error(`tandem-comments: unknown comment id "${id}"`);
  c.status = status;
}

export function removeThreadEntry(comments: CommentMap, id: string, index: number): void {
  const comment = comments[id];
  if (!comment) throw new Error(`tandem-comments: unknown comment id "${id}"`);
  if (!comment.thread[index]) {
    throw new Error(`tandem-comments: thread entry ${index} out of range for comment "${id}"`);
  }
  // A plain comment's first entry is its root, so deleting it removes the whole
  // thread. A suggestion's first entry is only its optional explanation.
  if (index === 0 && !comment.suggestion) {
    delete comments[id];
    return;
  }
  comment.thread.splice(index, 1);
}

export function removeComment(comments: CommentMap, id: string): void {
  delete comments[id];
}

export type SuggestionFailureReason =
  | "missing"
  | "no-editor"
  | "invalid-document"
  | "invalid-suggestion"
  | "not-suggestion"
  | "already-resolved"
  | "empty-replacement"
  | "orphaned"
  | "ambiguous";

export type AcceptSuggestionResult =
  | { ok: true; start: number; end: number; replacement: string }
  | { ok: false; reason: SuggestionFailureReason };

export type DeclineSuggestionResult = { ok: true } | { ok: false; reason: SuggestionFailureReason };

export interface SuggestionTextChange {
  from: number;
  to: number;
  insert: string;
}

export type SuggestionAcceptancePlan =
  | {
      ok: true;
      changes: [SuggestionTextChange, SuggestionTextChange];
      cursor: number;
    }
  | { ok: false; reason: SuggestionFailureReason; error?: string };

function isSuggestionObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finishSuggestion(
  comments: CommentMap,
  id: string,
  result: SuggestionResult,
  behavior: "keep" | "remove"
): void {
  if (behavior === "remove") {
    delete comments[id];
    return;
  }
  const comment = comments[id];
  const suggestion: unknown = comment?.suggestion;
  if (!comment || !isSuggestionObject(suggestion)) return;
  comment.status = "resolved";
  suggestion.result = result;
}

/**
 * Applies an open replacement suggestion to a parsed document. The caller is
 * responsible for committing the returned prose + comment-block changes as one
 * editor transaction.
 */
export function acceptSuggestion(
  doc: ParsedDoc,
  id: string,
  behavior: "keep" | "remove"
): AcceptSuggestionResult {
  const comment = doc.comments[id];
  if (!comment) return { ok: false, reason: "missing" };
  const suggestion: unknown = comment.suggestion;
  if (suggestion === undefined) return { ok: false, reason: "not-suggestion" };
  if (!isSuggestionObject(suggestion)) return { ok: false, reason: "invalid-suggestion" };
  if (comment.status !== "open" || suggestion.result) {
    return { ok: false, reason: "already-resolved" };
  }
  const replacement = suggestion.replacement;
  if (typeof replacement !== "string") return { ok: false, reason: "invalid-suggestion" };
  if (replacement.length === 0) return { ok: false, reason: "empty-replacement" };

  const resolution = resolveAnchor(doc.prose, comment.anchor);
  if (resolution.kind === "orphaned") return { ok: false, reason: "orphaned" };
  if (resolution.ambiguous) return { ok: false, reason: "ambiguous" };
  if (doc.prose.slice(resolution.start, resolution.end) !== comment.anchor.exact) {
    return { ok: false, reason: "orphaned" };
  }

  const oldProse = doc.prose;
  const surviving = Object.entries(doc.comments).filter(
    ([otherId, other]) => otherId !== id && other.status === "open"
  );
  const survivingMatches = matchPositionsByExact(
    oldProse,
    surviving.map(([, other]) => other.anchor.exact)
  );
  const survivingAnchors = surviving.flatMap(([otherId, other]) => {
    const otherResolution = resolutionFromMatches(
      oldProse,
      other.anchor,
      survivingMatches.get(other.anchor.exact) ?? []
    );
    return otherResolution.kind === "resolved" && !otherResolution.ambiguous
      ? [{ id: otherId, from: otherResolution.start, to: otherResolution.end }]
      : [];
  });
  const replacementChange = ChangeSet.of(
    { from: resolution.start, to: resolution.end, insert: replacement },
    oldProse.length
  );
  doc.prose = oldProse.slice(0, resolution.start) + replacement + oldProse.slice(resolution.end);
  for (const mapped of mapAnchors(survivingAnchors, replacementChange)) {
    const surviving = doc.comments[mapped.id];
    if (surviving && mapped.to <= doc.prose.length) {
      surviving.anchor = makeAnchor(doc.prose, mapped.from, mapped.to);
    }
  }
  finishSuggestion(doc.comments, id, "accepted", behavior);
  return { ok: true, start: resolution.start, end: resolution.end, replacement };
}

export function declineSuggestion(
  comments: CommentMap,
  id: string,
  behavior: "keep" | "remove"
): DeclineSuggestionResult {
  const comment = comments[id];
  if (!comment) return { ok: false, reason: "missing" };
  const suggestion: unknown = comment.suggestion;
  if (suggestion === undefined) return { ok: false, reason: "not-suggestion" };
  if (!isSuggestionObject(suggestion)) return { ok: false, reason: "invalid-suggestion" };
  if (comment.status !== "open" || suggestion.result) {
    return { ok: false, reason: "already-resolved" };
  }
  finishSuggestion(comments, id, "declined", behavior);
  return { ok: true };
}

/**
 * Plans the two simultaneous changes used by the editor: one replacement in
 * the prose and one rewrite of the comment region. All coordinates refer to
 * the original string, making the operation a single undoable transaction.
 */
export function planSuggestionAcceptance(
  raw: string,
  id: string,
  behavior: "keep" | "remove",
  schemaHint: boolean
): SuggestionAcceptancePlan {
  const doc = parseDocument(raw);
  if (doc.error) return { ok: false, reason: "invalid-document", error: doc.error };
  const oldProseLength = doc.prose.length;
  const result = acceptSuggestion(doc, id, behavior);
  if (!result.ok) return result;
  const serialized = serializeDocument(doc, schemaHint);
  return {
    ok: true,
    changes: [
      { from: result.start, to: result.end, insert: result.replacement },
      { from: oldProseLength, to: raw.length, insert: serialized.slice(doc.prose.length) },
    ],
    cursor: result.start + result.replacement.length,
  };
}

export function generateId(existing: CommentMap): string {
  for (;;) {
    const id = Math.floor(Math.random() * 0xffff)
      .toString(16)
      .padStart(4, "0");
    if (!(id in existing)) return id;
  }
}

export function resolveAll(prose: string, comments: CommentMap): ResolvedComment[] {
  const entries = Object.entries(comments);
  const matches = matchPositionsByExact(
    prose,
    entries.map(([, comment]) => comment.anchor.exact)
  );
  return entries.map(([id, comment]) => {
    const acceptedHistory =
      comment.status === "resolved" &&
      isSuggestionObject(comment.suggestion) &&
      comment.suggestion.result === "accepted";
    return {
      id,
      comment,
      // The retained anchor describes the text that was replaced, not a safe
      // navigation target in the resulting prose.
      resolution: acceptedHistory
        ? { kind: "orphaned" }
        : resolutionFromMatches(prose, comment.anchor, matches.get(comment.anchor.exact) ?? []),
    };
  });
}
