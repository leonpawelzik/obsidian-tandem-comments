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
