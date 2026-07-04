import type { Anchor, AnchorResolution, CommentMap, CommentStatus, ParsedDoc, ResolvedComment } from "./types";

export const SCHEMA_HINT_LINES = [
  '// Schema: { "<id>": { anchor:{exact,prefix,suffix,pos?}, status:open|resolved, thread:[{author,ts,text}] } }',
  '// Anchor = quote from the prose. To locate: search for "exact", disambiguate via prefix/suffix.',
];

const FENCE_OPEN = "```tandem-comments";
const CONTEXT_LEN = 20;

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

interface BlockMatch {
  proseEnd: number;
  body: string;
  trailing: string;
}

function findBlock(raw: string): BlockMatch | null {
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

export function parseDocument(raw: string): ParsedDoc {
  const blk = findBlock(raw);
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
  if (Object.keys(doc.comments).length === 0) return doc.prose + trailing;
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

export function resolveAnchor(prose: string, anchor: Anchor): AnchorResolution {
  const exact = anchor.exact;
  if (!exact) return { kind: "orphaned" };
  const matches: number[] = [];
  let i = prose.indexOf(exact);
  while (i !== -1) {
    matches.push(i);
    i = prose.indexOf(exact, i + 1);
  }
  if (matches.length === 0) return { kind: "orphaned" };
  let cands = matches;
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

export function addReply(comments: CommentMap, id: string, author: string, ts: string, text: string): void {
  const c = comments[id];
  if (!c) throw new Error(`tandem-comments: unknown comment id "${id}"`);
  c.thread.push({ author, ts, text });
}

export function setStatus(comments: CommentMap, id: string, status: CommentStatus): void {
  const c = comments[id];
  if (!c) throw new Error(`tandem-comments: unknown comment id "${id}"`);
  c.status = status;
}

export function removeComment(comments: CommentMap, id: string): void {
  delete comments[id];
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
  return Object.entries(comments).map(([id, comment]) => ({
    id,
    comment,
    resolution: resolveAnchor(prose, comment.anchor),
  }));
}
