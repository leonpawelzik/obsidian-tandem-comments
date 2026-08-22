import type { Anchor, ParsedDoc, ResolvedComment } from "./types";

export interface SidebarDraft {
  filePath: string;
  anchor: Anchor;
  kind: "comment" | "suggestion";
}

/**
 * Display-relevant signature of one sidebar card.
 * Serializes the whole comment (unknown fields included) plus resolution.
 * Anchor `pos` is omitted so a persist-only pos rewrite does not rebuild the card.
 */
export function commentCardSignature(r: ResolvedComment): string {
  const { pos: _pos, ...anchor } = r.comment.anchor;
  return JSON.stringify({
    id: r.id,
    resolution: r.resolution,
    comment: { ...r.comment, anchor },
  });
}

function draftSignature(filePath: string, draft: SidebarDraft | null): string {
  if (!draft || draft.filePath !== filePath) return "";
  return JSON.stringify(draft);
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
