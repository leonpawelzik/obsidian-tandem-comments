import { ChangeSet } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { isFullReplace, mapAnchors } from "../src/reanchor";

// Doc: "Wir senken den Preis." (21 Zeichen), Anker auf "senken" = [4, 10)
const ANCHORS = [{ id: "a", from: 4, to: 10 }];

describe("mapAnchors", () => {
  it("shifts anchors right when text is inserted before them", () => {
    const changes = ChangeSet.of({ from: 0, insert: "XX " }, 21);
    expect(mapAnchors(ANCHORS, changes)).toEqual([{ id: "a", from: 7, to: 13 }]);
  });

  it("keeps anchors in place for edits after them", () => {
    const changes = ChangeSet.of({ from: 15, insert: "!" }, 21);
    expect(mapAnchors(ANCHORS, changes)).toEqual([{ id: "a", from: 4, to: 10 }]);
  });

  it("grows the range when typing inside the quote", () => {
    const changes = ChangeSet.of({ from: 7, insert: "X" }, 21);
    expect(mapAnchors(ANCHORS, changes)).toEqual([{ id: "a", from: 4, to: 11 }]);
  });

  it("does not absorb insertions at the range edges", () => {
    const atStart = ChangeSet.of({ from: 4, insert: "X" }, 21);
    expect(mapAnchors(ANCHORS, atStart)).toEqual([{ id: "a", from: 5, to: 11 }]);
    const atEnd = ChangeSet.of({ from: 10, insert: "X" }, 21);
    expect(mapAnchors(ANCHORS, atEnd)).toEqual([{ id: "a", from: 4, to: 10 }]);
  });

  it("drops anchors whose range was deleted entirely", () => {
    const changes = ChangeSet.of({ from: 3, to: 11 }, 21);
    expect(mapAnchors(ANCHORS, changes)).toEqual([]);
  });
});

describe("isFullReplace", () => {
  it("is true when most of the doc is replaced", () => {
    const changes = ChangeSet.of({ from: 0, to: 21, insert: "neu" }, 21);
    expect(isFullReplace(changes)).toBe(true);
  });

  it("is false for a small edit", () => {
    const changes = ChangeSet.of({ from: 5, insert: "x" }, 21);
    expect(isFullReplace(changes)).toBe(false);
  });
});
