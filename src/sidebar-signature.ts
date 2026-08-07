import { resolveAll } from "./store";
import type { Anchor, ParsedDoc } from "./types";

export interface SidebarDraft {
  filePath: string;
  anchor: Anchor;
  kind: "comment" | "suggestion";
}

/**
 * Display-relevant signature for the sidebar. Includes resolution kind and quote
 * text so orphan/quote changes still refresh. Pure — no Obsidian imports.
 */
export function sidebarContentSignature(
  filePath: string,
  doc: ParsedDoc,
  showResolved: boolean,
  draft: SidebarDraft | null
): string {
  const parts: string[] = [filePath, showResolved ? "1" : "0"];
  if (draft && draft.filePath === filePath) {
    parts.push("draft", draft.kind, draft.anchor.exact, String(draft.anchor.pos ?? ""));
  }
  if (doc.error) {
    parts.push("err", doc.error);
    return parts.join("\0");
  }
  for (const r of resolveAll(doc.prose, doc.comments)) {
    const c = r.comment;
    parts.push(r.id, c.status, r.resolution.kind);
    if (r.resolution.kind === "resolved") {
      parts.push(String(r.resolution.start), String(r.resolution.end), r.resolution.ambiguous ? "a" : "");
    }
    parts.push(c.anchor.exact);
    for (const t of c.thread) {
      parts.push(t.author, t.ts, t.text);
    }
    if (c.suggestion) {
      parts.push(
        c.suggestion.replacement,
        c.suggestion.author,
        c.suggestion.ts,
        c.suggestion.result ?? ""
      );
    }
  }
  return parts.join("\0");
}
