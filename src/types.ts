export interface Anchor {
  /** Exaktes Zitat des kommentierten Bereichs. */
  exact: string;
  /** Wenige Zeichen vor dem Zitat zur Disambiguierung. */
  prefix?: string;
  /** Wenige Zeichen nach dem Zitat zur Disambiguierung. */
  suffix?: string;
  /** Zeichen-Offset in der Prosa als Fallback bei Mehrdeutigkeit. */
  pos?: number;
}

export interface ThreadEntry {
  author: string;
  ts: string;
  text: string;
}

export type CommentStatus = "open" | "resolved";

export type SuggestionResult = "accepted" | "declined";

export interface EditSuggestion {
  /** Replacement text proposed for the anchored passage. */
  replacement: string;
  /** Author and timestamp belong to the proposal itself, independently of its discussion thread. */
  author: string;
  ts: string;
  /** Present only when resolved suggestions are retained as history. */
  result?: SuggestionResult;
}

export interface CommentEntry {
  anchor: Anchor;
  status: CommentStatus;
  thread: ThreadEntry[];
  /** Presence turns this comment into a replacement-only edit suggestion. */
  suggestion?: EditSuggestion;
}

export type CommentMap = Record<string, CommentEntry>;

export interface ParsedDoc {
  prose: string;
  comments: CommentMap;
  /**
   * Inhalt nach der schließenden Fence-Zeile, byte-genau (z.B. Fußnoten-
   * Definitionen, die Obsidian ans Dateiende hängt — Issue #2).
   */
  trailing?: string;
  /** Gesetzt, wenn ein tandem-comments-Block existiert, dessen JSON aber kaputt ist. */
  error?: string;
}

export type AnchorResolution =
  | { kind: "resolved"; start: number; end: number; ambiguous?: boolean }
  | { kind: "orphaned" };

export interface ResolvedComment {
  id: string;
  comment: CommentEntry;
  resolution: AnchorResolution;
}
