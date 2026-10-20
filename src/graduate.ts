import {
  addReply,
  makeAnchor,
  parseDocument,
  replaceProse,
  resolveAnchor,
  serializeDocument,
  type SuggestionTextChange,
} from "./store";
import type { CommentEntry, CommentMap, ThreadEntry } from "./types";

/**
 * Graduating moves what a discussion settled on out of the thread: into the
 * note's text, as a task in the text, or into a new note. The thread gets a
 * reply saying where it went, and is resolved only when the user asks.
 */
export type GraduateKind = "text" | "task" | "note";

export type GraduateFailureReason =
  | "missing"
  | "no-editor"
  | "invalid-document"
  | "not-discussion"
  | "already-resolved"
  | "empty-text"
  | "orphaned"
  | "ambiguous"
  | "cursor-outside-prose";

export type GraduatePlan =
  | {
      ok: true;
      changes: [SuggestionTextChange, SuggestionTextChange];
      cursor: number;
    }
  | { ok: false; reason: GraduateFailureReason; error?: string };

/** Where the text goes: at an offset in the prose, or over the quoted passage. */
export type GraduatePlacement = { kind: "cursor"; offset: number } | { kind: "quote" };

export interface GraduateOptions {
  text: string;
  placement: GraduatePlacement;
  /** Reply that records the graduation in the thread. */
  record: ThreadEntry;
  resolve: boolean;
  behavior: "keep" | "remove";
  schemaHint: boolean;
}

/** Thread entries with text, as `[index, entry]` pairs in thread order. */
export function graduateEntries(comment: CommentEntry): [number, ThreadEntry][] {
  return [...comment.thread.entries()].filter(([, entry]) => entry.text.trim().length > 0);
}

/** The selected messages' text, without authors or timestamps, one paragraph each. */
export function graduateText(comment: CommentEntry, indices: ReadonlySet<number>): string {
  return graduateEntries(comment)
    .filter(([index]) => indices.has(index))
    .map(([, entry]) => entry.text.trim())
    .join("\n\n");
}

/** One Markdown task per line of `text`; lines that already are tasks stay as they are. */
export function asTaskLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/^- \[[ xX]\] /.test(line) ? line : `- [ ] ${line}`))
    .join("\n");
}

export function graduateRecordText(kind: GraduateKind, link?: string): string {
  switch (kind) {
    case "text":
      return "Graduated to the text.";
    case "task":
      return "Graduated to a task in the text.";
    case "note":
      return `Graduated to ${link ?? "a new note"}.`;
  }
}

/** Adds the record reply, then resolves or removes the thread when asked to. */
export function finishGraduate(
  comments: CommentMap,
  id: string,
  record: ThreadEntry,
  resolve: boolean,
  behavior: "keep" | "remove"
): void {
  if (!comments[id]) return;
  addReply(comments, id, record.author, record.ts, record.text);
  if (!resolve) return;
  if (behavior === "remove") delete comments[id];
  else comments[id].status = "resolved";
}

export function graduateFailure(comment: CommentEntry | undefined): GraduateFailureReason | null {
  if (!comment) return "missing";
  if (comment.suggestion !== undefined) return "not-discussion";
  if (comment.status !== "open") return "already-resolved";
  return null;
}

/**
 * Plans placing `text` in the prose and recording it in the thread, as the
 * two changes of one editor transaction (the same shape as accepting a
 * suggestion). Replacing the quote keeps an open thread on the new text.
 */
export function planGraduate(raw: string, id: string, opts: GraduateOptions): GraduatePlan {
  if (!opts.text.trim()) return { ok: false, reason: "empty-text" };
  const doc = parseDocument(raw);
  if (doc.error) return { ok: false, reason: "invalid-document", error: doc.error };
  const comment = doc.comments[id];
  const failure = graduateFailure(comment);
  if (failure || !comment) return { ok: false, reason: failure ?? "missing" };

  const oldProseLength = doc.prose.length;
  let from: number;
  let to: number;
  if (opts.placement.kind === "cursor") {
    from = to = opts.placement.offset;
    if (from < 0 || from > oldProseLength) return { ok: false, reason: "cursor-outside-prose" };
    replaceProse(doc, from, to, opts.text);
  } else {
    const resolution = resolveAnchor(doc.prose, comment.anchor);
    if (resolution.kind === "orphaned") return { ok: false, reason: "orphaned" };
    if (resolution.ambiguous) return { ok: false, reason: "ambiguous" };
    if (doc.prose.slice(resolution.start, resolution.end) !== comment.anchor.exact) {
      return { ok: false, reason: "orphaned" };
    }
    from = resolution.start;
    to = resolution.end;
    replaceProse(doc, from, to, opts.text, id);
    comment.anchor = makeAnchor(doc.prose, from, from + opts.text.length);
  }
  finishGraduate(doc.comments, id, opts.record, opts.resolve, opts.behavior);

  const serialized = serializeDocument(doc, opts.schemaHint);
  return {
    ok: true,
    changes: [
      { from, to, insert: opts.text },
      { from: oldProseLength, to: raw.length, insert: serialized.slice(doc.prose.length) },
    ],
    cursor: from + opts.text.length,
  };
}

/**
 * A file name from the quote: the first 48 characters, without the characters
 * that file systems or Obsidian links reject.
 */
export function graduateNoteName(quote: string): string {
  const flat = quote.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
  const cut = flat.length <= 48 ? flat : flat.slice(0, 47).trimEnd() + "…";
  return cut.replace(/^\.+/, "").trim() || "Comment";
}

export function buildGraduateNote(opts: {
  sourceLink: string;
  quote: string;
  thread: ThreadEntry[];
  formatTs: (ts: string) => string;
}): string {
  const lines = [`Source: ${opts.sourceLink}`, "", "> " + opts.quote.replace(/\n/g, "\n> "), ""];
  if (opts.thread.length) {
    lines.push("## Thread", "");
    for (const entry of opts.thread) {
      lines.push(`**${entry.author}** · ${opts.formatTs(entry.ts)}`, "", entry.text, "");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}

export function graduateFailureMessage(reason: GraduateFailureReason): string {
  switch (reason) {
    case "no-editor":
      return "Open this file in a Markdown editor before graduating into its text.";
    case "invalid-document":
      return "The tandem-comments block is invalid. Fix its JSON first.";
    case "empty-text":
      return "Select at least one message, or write the text to place.";
    case "orphaned":
      return "The original passage no longer exists. Re-anchor before replacing, or insert at the cursor.";
    case "ambiguous":
      return "The original passage appears more than once. Re-anchor before replacing, or insert at the cursor.";
    case "cursor-outside-prose":
      return "Place the cursor in the note's text, not in the comments block, before inserting.";
    case "already-resolved":
      return "This thread is already resolved.";
    case "not-discussion":
      return "Edit suggestions are accepted or declined, not graduated.";
    case "missing":
      return "This thread is no longer available.";
  }
}
