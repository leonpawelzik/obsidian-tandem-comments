import type { ResolvedComment } from "./types";
import type { SidebarSortOrder, SubmitShortcut } from "./settings-model";

interface SubmitKeyEvent {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

export function shouldSubmitComment(event: SubmitKeyEvent, shortcut: SubmitShortcut): boolean {
  if (event.key !== "Enter") return false;
  return shortcut === "enter"
    ? !event.shiftKey && !event.metaKey && !event.ctrlKey
    : event.metaKey || event.ctrlKey;
}

function activityTimestamp(item: ResolvedComment): number {
  const threadTs = item.comment.thread[item.comment.thread.length - 1]?.ts;
  const suggestionTs = item.comment.suggestion?.ts;
  const parsedThreadTs = threadTs ? Date.parse(threadTs) : 0;
  const parsedSuggestionTs = suggestionTs ? Date.parse(suggestionTs) : 0;
  return Math.max(
    Number.isFinite(parsedThreadTs) ? parsedThreadTs : 0,
    Number.isFinite(parsedSuggestionTs) ? parsedSuggestionTs : 0
  );
}

/** Kommentare zur ganzen Notiz stehen vor, verwaiste nach allen Textstellen. */
export function documentPosition(item: ResolvedComment): number {
  switch (item.resolution.kind) {
    case "note":
      return -1;
    case "resolved":
      return item.resolution.start;
    case "orphaned":
      return Number.MAX_SAFE_INTEGER;
  }
}

export function sortSidebarComments(
  items: ResolvedComment[],
  order: SidebarSortOrder
): ResolvedComment[] {
  if (order === "document") {
    return [...items].sort((a, b) => documentPosition(a) - documentPosition(b));
  }
  const direction = order === "newest" ? -1 : 1;
  return [...items].sort((a, b) => direction * (activityTimestamp(a) - activityTimestamp(b)));
}
