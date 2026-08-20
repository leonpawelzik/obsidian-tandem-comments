import type { Anchor, ParsedDoc, ResolvedComment } from "./types";

export interface SidebarDraft {
  filePath: string;
  anchor: Anchor;
  kind: "comment" | "suggestion";
}

/** Display-relevant signature of one sidebar card. Pure — no Obsidian imports. */
export function commentCardSignature(r: ResolvedComment): string {
  const c = r.comment;
  const parts: string[] = [r.id, c.status, r.resolution.kind];
  if (r.resolution.kind === "resolved") {
    parts.push(String(r.resolution.start), String(r.resolution.end), r.resolution.ambiguous ? "a" : "");
  }
  parts.push(c.anchor.exact);
  for (const t of c.thread) {
    parts.push(t.author, t.ts, t.text);
  }
  if (c.suggestion) {
    parts.push(c.suggestion.replacement, c.suggestion.author, c.suggestion.ts, c.suggestion.result ?? "");
  }
  return parts.join("\0");
}

function draftSignature(filePath: string, draft: SidebarDraft | null): string {
  if (!draft || draft.filePath !== filePath) return "";
  return ["draft", draft.kind, draft.anchor.exact, String(draft.anchor.pos ?? "")].join("\0");
}

/**
 * Display-relevant signature for the sidebar. Includes resolution kind and quote
 * text so orphan/quote changes still refresh. Pass precomputed `resolved` to
 * avoid a second scan of the prose.
 */
export function sidebarContentSignature(
  filePath: string,
  doc: ParsedDoc,
  showResolved: boolean,
  draft: SidebarDraft | null,
  resolved: readonly ResolvedComment[]
): string {
  const parts: string[] = [filePath, showResolved ? "1" : "0", draftSignature(filePath, draft)];
  if (doc.error) {
    parts.push("err", doc.error);
    return parts.join("\0");
  }
  for (const r of resolved) parts.push(commentCardSignature(r));
  return parts.join("\0");
}
