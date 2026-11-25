import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeAnchor, parseDocument, resolveAnchor, serializeDocument } from "../src/store";
import type { CommentMap } from "../src/types";
import { Harness } from "./editor-harness";

beforeEach(() => {
  vi.stubGlobal("window", { setTimeout: () => 1, clearTimeout: () => {} });
});

// Genug Text drumherum, damit eine Block-Ersetzung nicht als Full-Replace (>50 %) gilt.
const FILLER = "\n" + "Unrelated closing paragraph with enough words to stay large. ".repeat(40) + "\n";

function nthIndexOf(text: string, needle: string, nth = 0): number {
  let at = text.indexOf(needle);
  for (let i = 0; i < nth; i++) at = text.indexOf(needle, at + 1);
  if (at < 0) throw new Error(`missing: ${needle}`);
  return at;
}

/** Öffnet die Prosa mit Kommentaren auf [Zitat, n-tes Vorkommen]. */
function open(text: string, quotes: Record<string, [string, number?]>) {
  const prose = text + FILLER;
  const comments: CommentMap = {};
  for (const [id, [quote, nth]] of Object.entries(quotes)) {
    const from = nthIndexOf(prose, quote, nth);
    comments[id] = { anchor: makeAnchor(prose, from, from + quote.length), status: "open", thread: [{ author: "R", ts: "2026-08-11T10:30:00Z", text: "x" }] };
  }
  return new Harness(serializeDocument({ prose, comments }, true));
}

/** Ersetzt `before` durch `after`, so wie Obsidian ganze Zellen, Tabellen und Callouts ersetzt. */
function replace(h: Harness, before: string, after: string) {
  const from = nthIndexOf(h.view.state.doc.toString(), before);
  h.apply({ changes: { from, to: from + before.length, insert: after }, userEvent: "input" });
}

/** Ein Nutzer-Edit mit CodeMirror-Kennzeichnung; externe Änderungen meldet Obsidian als "set". */
function edit(h: Harness, userEvent: string, ...changes: { from: number; to?: number; insert?: string }[]) {
  h.apply({ changes, userEvent });
}

/** Schreibt den Block neu, wie beim Hinzufügen eines Kommentars in der Sidebar. */
function rewriteBlock(h: Harness, mutate: (comments: CommentMap) => void) {
  const raw = h.view.state.doc.toString();
  const doc = parseDocument(raw);
  mutate(doc.comments);
  h.apply({ changes: { from: doc.prose.length, to: raw.length, insert: serializeDocument(doc, true).slice(doc.prose.length) }, userEvent: "set" });
}

function stored(h: Harness, id: string) {
  return parseDocument(h.view.state.doc.toString()).comments[id].anchor;
}

/** Wo der Kommentar gerade sitzt, mit etwas Text davor. */
function live(h: Harness, id: string, context = 0): string | null {
  const anchor = h.tracker.anchors.find((a) => a.id === id);
  return anchor ? h.view.state.doc.sliceString(anchor.from - context, anchor.to) : null;
}

/** Wo der Kommentar nach Speichern und erneutem Öffnen sitzt. */
function reopened(h: Harness, id: string, context = 0): string | null {
  h.tracker.performReanchor();
  const { prose, comments } = parseDocument(h.view.state.doc.toString());
  const resolution = resolveAnchor(prose, comments[id].anchor);
  return resolution.kind === "resolved" ? prose.slice(resolution.start - context, resolution.end) : null;
}

describe("editing a quote that also occurs elsewhere", () => {
  it("keeps the comment on the edited passage in prose", () => {
    const h = open("Some plain cell.\n\nAnother plain word.\n", { c: ["plain"] });
    replace(h, "Some plain", "Some plaQQin");
    expect(reopened(h, "c", 5)).toBe("Some plaQQin");
  });

  it("keeps the comment on the edited cell when the word occurs outside of the table", () => {
    const h = open("| a | b |\n| - | - |\n| x | some plain cell |\n\nAnother plain word.\n", { c: ["plain"] });
    replace(h, " some plain cell ", " some plaQQin cell ");
    expect(reopened(h, "c", 5)).toBe("some plaQQin");
  });

  it("keeps the comment on the edited cell when another row holds the same text", () => {
    const h = open("| Item | Notes      |\n| ---- | ---------- |\n| one  | plain text |\n| two  | plain text |\n", { c: ["plain text"] });
    replace(h, "| one  | plain text |", "| one  | plain Qtext |");
    expect(reopened(h, "c", 9)).toBe("| one  | plain Qtext");
  });

  it("keeps the comment in place when a line is inserted between identical lines", () => {
    const h = open("- status open\n".repeat(30), { c: ["status open", 20] });
    const from = h.tracker.anchors[0].from;
    h.apply({ changes: { from: 0, insert: "- status open\n".repeat(8) }, userEvent: "input.paste" });
    h.tracker.performReanchor();
    const { prose, comments } = parseDocument(h.view.state.doc.toString());
    expect(resolveAnchor(prose, comments.c.anchor)).toMatchObject({ start: from + 8 * 14 });
  });
});

describe("replacements of a whole table", () => {
  const NARROW = "| Item | Notes |\n| --- | --- |\n| one | plain text |\n| two | plain word |";
  const PADDED = "| Item | Notes      |\n| ---- | ---------- |\n| one  | plain text |\n| two  | plain word |";

  it("follows every quote through a padding-only reformat", () => {
    const h = open(NARROW + "\n", { head: ["Notes"], first: ["plain"], second: ["plain", 1], whole: ["two | plain word"] });
    replace(h, NARROW, PADDED);
    expect([live(h, "head"), live(h, "first", 9), live(h, "second", 9), live(h, "whole")])
      .toEqual(["Notes", "| one  | plain", "| two  | plain", "two  | plain word"]);
    expect([reopened(h, "first", 9), reopened(h, "second", 9)]).toEqual(["| one  | plain", "| two  | plain"]);
  });

  it("follows a quote when a row is added in the same replacement", () => {
    const h = open(PADDED + "\n", { c: ["plain", 1] });
    replace(h, PADDED, PADDED + "\n|      |            |");
    expect(live(h, "c", 9)).toBe("| two  | plain");
  });

  it("finds the quote again when rows are sorted", () => {
    const table = "| Fruit   |\n| ------- |\n| apple   |\n| apricot |";
    const h = open(table + "\n", { c: ["apple"] });
    replace(h, table, "| Fruit   |\n| ------- |\n| apricot |\n| apple   |");
    expect([live(h, "c"), reopened(h, "c")]).toEqual(["apple", "apple"]);
  });
});

describe("replacements of a whole callout", () => {
  it("keeps the comment when a checkbox in the callout is clicked (#46)", () => {
    const callout = "> [!todo] T\n> - [ ] open task\n> - [x] done task";
    const h = open("Top.\n\n" + callout + "\n", { open: ["open task"], done: ["done task"] });
    replace(h, callout, "> [!todo] T\n> - [ ] open task\n> - [ ] done task");
    expect([live(h, "open"), live(h, "done")]).toEqual(["open task", "done task"]);
  });
});

describe("edits that must not move or rewrite a comment", () => {
  it("does not rewrite the block when text elsewhere changes", () => {
    const h = open("Some plain cell.\n\nAnother plain word.\n", { c: ["plain"] });
    replace(h, "Unrelated closing", "Unrelated QQ closing");
    h.tracker.performReanchor();
    expect(h.dispatches).toHaveLength(0);
  });

  it("drops a deleted quote instead of moving it to the same word elsewhere", () => {
    const h = open("Some plain cell.\n\nAnother plain word.\n", { c: ["plain"] });
    replace(h, "Some plain cell.", "");
    expect(live(h, "c")).toBeNull();
  });

  it("drops a quote deleted from a table cell instead of moving it to the same word elsewhere", () => {
    const h = open("| a | b |\n| - | - |\n| x | plain |\n\nAnother plain word.\n", { c: ["plain"] });
    replace(h, " plain |", "       |");
    expect(live(h, "c")).toBeNull();
  });

  it("drops a quote whose passage is replaced by different text", () => {
    const h = open("Some plain cell.\n\nAnother plain word.\n", { c: ["plain"] });
    replace(h, "Some plain cell.", "Totally different.");
    expect(live(h, "c")).toBeNull();
  });
});

describe("deleting a quote that also occurs elsewhere", () => {
  const TEXT = "Some plain cell.\n\nAnother plain word.\n";
  const deleted = () => {
    const h = open(TEXT, { c: ["plain"] });
    edit(h, "delete.selection", { from: 0, to: 16 });
    return h;
  };

  it("orphans the comment instead of moving it", () => {
    const h = deleted();
    expect(reopened(h, "c")).toBeNull();
    expect(stored(h, "c")).toMatchObject({ exact: "plain", orphaned: true });
  });

  it("orphans the comment when the quote is erased character by character", () => {
    const h = open(TEXT, { c: ["plain"] });
    for (let end = 10; end > 5; end--) edit(h, "delete.backward", { from: end - 1, to: end });
    expect(reopened(h, "c")).toBeNull();
    expect(stored(h, "c").exact).toBe("plain");
  });

  it("orphans a comment erased from a table cell", () => {
    const h = open("| a | b |\n| - | - |\n| x | plain |\n\nAnother plain word.\n", { c: ["plain"] });
    const from = nthIndexOf(h.view.state.doc.toString(), " plain |");
    edit(h, "delete.backward", { from, to: from + 8, insert: "       |" });
    expect(reopened(h, "c")).toBeNull();
  });

  it("brings the comment back on undo, also after it was saved as orphaned", () => {
    const h = deleted();
    h.tracker.performReanchor();
    edit(h, "undo", { from: 0, insert: "Some plain cell." });
    expect(live(h, "c", 5)).toBe("Some plain");
    expect(reopened(h, "c", 5)).toBe("Some plain");
    expect(stored(h, "c").orphaned).toBeUndefined();
  });

  it("brings the comment back on undo in a later session", () => {
    const h = deleted();
    h.tracker.performReanchor();
    const later = new Harness(h.view.state.doc.toString());
    edit(later, "input.paste", { from: 0, insert: "Some plain cell." });
    expect(live(later, "c", 5)).toBe("Some plain");
  });

  it("follows cut and paste", () => {
    const h = deleted();
    h.tracker.performReanchor();
    const end = nthIndexOf(h.view.state.doc.toString(), "Unrelated closing");
    edit(h, "input.paste", { from: end, insert: "Some plain cell.\n" });
    expect(reopened(h, "c", 5)).toBe("Some plain");
  });

  it("follows a moved line", () => {
    const h = open("- one plain\n- two plain\n", { c: ["plain"] });
    edit(h, "move.line", { from: 0, to: 12 }, { from: 24, insert: "- one plain\n" });
    expect([live(h, "c", 6), reopened(h, "c", 6)]).toEqual(["- one plain", "- one plain"]);
  });

  it("follows the quote into a rewritten passage", () => {
    const h = open(TEXT, { c: ["plain"] });
    edit(h, "input", { from: 0, to: 16, insert: "It is a plain thing!" });
    expect(reopened(h, "c", 5)).toBe("is a plain");
  });

  it("does not come back for other text", () => {
    const h = deleted();
    edit(h, "input.type", { from: 0, insert: "p" });
    edit(h, "input.paste", { from: 0, insert: "A quite plain intro. " });
    expect([live(h, "c"), reopened(h, "c")]).toEqual([null, null]);
  });

  it("does not mark comments when another app changes the file", () => {
    const h = open(TEXT, { c: ["plain"] });
    edit(h, "set", { from: 0, to: 16 });
    h.tracker.performReanchor();
    expect(h.dispatches).toHaveLength(0);
  });
});

describe("a block rewrite before pending edits are saved", () => {
  const TEXT = "Some plain cell.\n\nAnother plain word.\n";
  const addComment = (h: Harness) => rewriteBlock(h, (comments) => {
    comments.other = { anchor: { exact: "Unrelated" }, status: "open", thread: [] };
  });

  it("keeps the comment on the edited quote", () => {
    const h = open(TEXT, { c: ["plain"] });
    edit(h, "input.type", { from: 8, insert: "QQ" });
    addComment(h);
    expect(live(h, "c", 5)).toBe("Some plaQQin");
    expect(reopened(h, "c", 5)).toBe("Some plaQQin");
  });

  it("keeps the comment orphaned when its quote was deleted", () => {
    const h = open(TEXT, { c: ["plain"] });
    edit(h, "delete.selection", { from: 0, to: 16 });
    addComment(h);
    expect(live(h, "c")).toBeNull();
    expect(reopened(h, "c")).toBeNull();
  });

  it("lets an explicit re-anchoring win", () => {
    const h = open(TEXT, { c: ["plain"] });
    edit(h, "input.type", { from: 8, insert: "QQ" });
    rewriteBlock(h, (comments) => {
      const { prose } = parseDocument(h.view.state.doc.toString());
      const from = prose.indexOf("word");
      comments.c.anchor = makeAnchor(prose, from, from + 4);
    });
    expect([live(h, "c"), reopened(h, "c")]).toEqual(["word", "word"]);
  });

  it("lets an explicit re-anchoring win over a deletion", () => {
    const h = open(TEXT, { c: ["plain"] });
    edit(h, "delete.selection", { from: 0, to: 16 });
    rewriteBlock(h, (comments) => {
      const { prose } = parseDocument(h.view.state.doc.toString());
      const from = prose.indexOf("word");
      comments.c.anchor = makeAnchor(prose, from, from + 4);
    });
    expect([live(h, "c"), reopened(h, "c")]).toEqual(["word", "word"]);
  });
});
