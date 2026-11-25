import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildExportNote, formatComment } from "../src/export";
import { sortSidebarComments } from "../src/sidebar-preferences";
import { SKILL_MARKDOWN } from "../src/skill-export";
import {
  addComment,
  makeAnchor,
  noteAnchor,
  parseDocument,
  planSuggestionAcceptance,
  resolveAll,
  resolveAnchor,
  SCHEMA_HINT_LINES,
  serializeDocument,
} from "../src/store";
import type { CommentMap } from "../src/types";
import { Harness } from "./editor-harness";

const TS = "2026-11-25T10:00:00Z";
const PROSE = "Intro line.\n\nSecond passage here.\n";

function comments(): CommentMap {
  const map: CommentMap = {};
  addComment(map, "late", makeAnchor(PROSE, PROSE.indexOf("passage"), PROSE.indexOf("passage") + 7), "Leon", TS, "About this");
  addComment(map, "early", makeAnchor(PROSE, 0, 5), "Leon", TS, "About intro");
  addComment(map, "note", noteAnchor(), "Leon", "2026-11-25T09:00:00Z", "About everything");
  return map;
}

describe("comments on the whole note", () => {
  it("resolve to the note, not to a passage", () => {
    expect(resolveAnchor(PROSE, noteAnchor())).toEqual({ kind: "note" });
    expect(resolveAnchor("", noteAnchor())).toEqual({ kind: "note" });
  });

  it("stay readable for older versions, which treat an empty quote as orphaned", () => {
    expect(noteAnchor()).toEqual({ exact: "", scope: "note" });
  });

  it("still treat an empty quote without scope as orphaned", () => {
    expect(resolveAnchor(PROSE, { exact: "" })).toEqual({ kind: "orphaned" });
  });

  it.each(["", PROSE])("survive saving and parsing in a note with prose %j", (prose) => {
    const map: CommentMap = {};
    addComment(map, "n", noteAnchor(), "Leon", TS, "Whole note");
    const doc = parseDocument(serializeDocument({ prose, comments: map }, true));
    expect(doc.prose).toBe(prose);
    expect(doc.comments.n.anchor).toEqual(noteAnchor());
  });

  it("come first in document order", () => {
    const order = sortSidebarComments(resolveAll(PROSE, comments()), "document").map((r) => r.id);
    expect(order).toEqual(["note", "early", "late"]);
  });

  it("are sorted by activity like any other comment", () => {
    const order = sortSidebarComments(resolveAll(PROSE, comments()), "newest").map((r) => r.id);
    expect(order[2]).toBe("note");
  });

  it("are copied with a label instead of an empty quote", () => {
    const [note] = resolveAll(PROSE, comments()).filter((r) => r.id === "note");
    const entry = "**Leon** (2026-11-25T09:00:00Z): About everything";
    expect(formatComment(note, { includeQuote: true })).toBe("*Whole note*\n\n" + entry);
    expect(formatComment(note, { includeQuote: false })).toBe(entry);
  });

  it("are exported first among the open threads", () => {
    const out = buildExportNote("Note", resolveAll(PROSE, comments()), { scope: "all", date: "2026-11-25" })!;
    expect(out).not.toContain("## Orphaned");
    expect(out.indexOf("About everything")).toBeGreaterThan(out.indexOf("## Open"));
    expect(out.indexOf("About everything")).toBeLessThan(out.indexOf("About intro"));
  });

  it("cannot be accepted as an edit suggestion", () => {
    const map: CommentMap = { s: { anchor: noteAnchor(), status: "open", thread: [], suggestion: { replacement: "x", author: "R", ts: TS } } };
    expect(planSuggestionAcceptance(serializeDocument({ prose: PROSE, comments: map }, true), "s", "keep", true)).toMatchObject({ ok: false, reason: "orphaned" });
  });

  describe("in the editor", () => {
    beforeEach(() => {
      vi.stubGlobal("window", { setTimeout: () => 1, clearTimeout: () => {} });
    });

    it("are neither highlighted nor rewritten while typing, deleting or undoing", () => {
      const prose = PROSE + "More words to keep the note large. ".repeat(30);
      const map: CommentMap = {};
      addComment(map, "n", noteAnchor(), "Leon", TS, "Whole note");
      const h = new Harness(serializeDocument({ prose, comments: map }, true));
      h.apply({ changes: { from: 0, insert: "x" }, userEvent: "input.type" });
      h.apply({ changes: { from: 0, to: 14 }, userEvent: "delete.selection" });
      h.apply({ changes: { from: 0, insert: "Intro line.\n" }, userEvent: "undo" });
      h.tracker.performReanchor();
      expect(h.tracker.anchors).toEqual([]);
      expect(h.dispatches).toHaveLength(0);
      expect(parseDocument(h.view.state.doc.toString()).comments.n.anchor).toEqual(noteAnchor());
    });
  });

  it("are explained to agents in the block and in the skill", () => {
    expect(SCHEMA_HINT_LINES[1]).toContain('scope "note"');
    for (const line of SCHEMA_HINT_LINES) expect(SKILL_MARKDOWN).toContain(line);
    const skill = SKILL_MARKDOWN.replace(/\s+/g, " ");
    expect(skill).toContain('`"anchor": { "exact": "", "scope": "note" }` is a comment on the whole note');
    expect(skill).toContain("not an anchor you cannot locate");
  });
});
