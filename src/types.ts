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

export interface CommentEntry {
  anchor: Anchor;
  status: CommentStatus;
  thread: ThreadEntry[];
}

export type CommentMap = Record<string, CommentEntry>;

export interface ParsedDoc {
  prose: string;
  comments: CommentMap;
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
