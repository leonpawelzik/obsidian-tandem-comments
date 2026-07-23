import { ChangeSet } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  canPreservePendingAnchors,
  changesTouchCommentBlock,
  isFullReplace,
  mapAnchors,
  mergePendingAnchors,
  shouldPreservePendingAnchors,
} from "../src/reanchor";

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

describe("changesTouchCommentBlock", () => {
  it("is false for a prose-only edit", () => {
    const changes = ChangeSet.of({ from: 4, to: 7, insert: "new" }, 40);
    expect(changesTouchCommentBlock(changes, 20, 20)).toBe(false);
  });

  it("detects a block-only edit", () => {
    const changes = ChangeSet.of({ from: 25, to: 30, insert: "JSON" }, 40);
    expect(changesTouchCommentBlock(changes, 20, 20)).toBe(true);
  });

  it("detects an atomic mixed prose and block edit", () => {
    const changes = ChangeSet.of(
      [
        { from: 4, to: 7, insert: "replacement" },
        { from: 20, to: 40, insert: "\n```tandem-comments\n{}\n```\n" },
      ],
      40
    );
    expect(changesTouchCommentBlock(changes, 20, 28)).toBe(true);
  });

  it("treats an insertion exactly at the prose boundary as touching the block", () => {
    const changes = ChangeSet.of({ from: 20, insert: "x" }, 40);
    expect(changesTouchCommentBlock(changes, 20, 21)).toBe(true);
  });
});

describe("pending anchors across comment-block transactions", () => {
  it("keeps explicit mixed prose + block transactions mappable even when they cover most of the document", () => {
    const changes = ChangeSet.of(
      [
        { from: 2, to: 5, insert: "edited passage" },
        { from: 20, to: 100, insert: "\n```tandem-comments\n{}\n```\n" },
      ],
      100
    );
    expect(isFullReplace(changes)).toBe(true);
    expect(canPreservePendingAnchors(changes, 20)).toBe(true);
  });

  it("does not map pending anchors through an unstructured whole-document replacement", () => {
    const changes = ChangeSet.of({ from: 0, to: 100, insert: "entirely new document" }, 100);
    expect(canPreservePendingAnchors(changes, 20)).toBe(false);
  });

  it("preserves pending anchors for a marked acceptance even when adjacent edits coalesce", () => {
    const changes = ChangeSet.of(
      [
        { from: 10, to: 20, insert: "replacement" },
        { from: 20, to: 100, insert: "" },
      ],
      100
    );
    expect(isFullReplace(changes)).toBe(true);
    expect(canPreservePendingAnchors(changes, 20)).toBe(false);
    expect(shouldPreservePendingAnchors(changes, 20, true)).toBe(true);
  });

  it("restores a pending edited anchor dropped by stale serialized JSON", () => {
    const changes = ChangeSet.of(
      [
        { from: 0, to: 1, insert: "long replacement" },
        { from: 30, to: 100, insert: "\n```tandem-comments\n{}\n```\n" },
      ],
      100
    );
    const pending = mapAnchors([{ id: "edited", from: 10, to: 18 }], changes);
    const merged = mergePendingAnchors([], pending, new Set(["edited"]));
    expect(merged).toEqual([{ id: "edited", from: 25, to: 33 }]);
  });

  it("does not resurrect an entry that was intentionally removed from the block", () => {
    expect(
      mergePendingAnchors([], [{ id: "removed", from: 10, to: 18 }], new Set())
    ).toEqual([]);
  });
});
