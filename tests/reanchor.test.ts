import { ChangeSet, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  canPreservePendingAnchors,
  changesTouchCommentBlock,
  isFullReplace,
  mapAnchors,
  mapAnchorsPrecisely,
  mergePendingAnchors,
  refineChanges,
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

describe("refineChanges", () => {
  const random = (seed: number) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

  it("produces the same document as the original change", () => {
    const next = random(7);
    const chars = "ab -|\nx[]";
    const text = (length: number) => Array.from({ length }, () => chars[Math.floor(next() * chars.length)]).join("");
    for (let run = 0; run < 3000; run++) {
      const doc = Text.of(text(40).split("\n"));
      const from = Math.floor(next() * 20);
      const changes = ChangeSet.of({ from, to: from + 1 + Math.floor(next() * 19), insert: text(Math.floor(next() * 20)) }, doc.length);
      expect((refineChanges(changes, doc) ?? changes).apply(doc).toString()).toBe(changes.apply(doc).toString());
    }
  });

  it("leaves pure insertions and deletions alone", () => {
    const doc = Text.of(["some text"]);
    expect(refineChanges(ChangeSet.of({ from: 2, insert: "x" }, doc.length), doc)).toBeNull();
    expect(refineChanges(ChangeSet.of({ from: 2, to: 4 }, doc.length), doc)).toBeNull();
  });

  it("follows every cell through random column padding", () => {
    const next = random(11);
    const words = Array.from({ length: 12 }, (_, i) => `word${i}`);
    const table = () => {
      const pad = () => " ".repeat(1 + Math.floor(next() * 8));
      const rows = [0, 3, 6, 9].map((i) => `|${words.slice(i, i + 3).map((w) => ` ${w}${pad()}`).join("|")}|`);
      rows.splice(1, 0, `|${[0, 1, 2].map(() => ` ${"-".repeat(3 + Math.floor(next() * 8))} `).join("|")}|`);
      return rows.join("\n");
    };
    for (let run = 0; run < 300; run++) {
      const before = table();
      const after = table();
      const doc = Text.of(before.split("\n"));
      const changes = ChangeSet.of({ from: 0, to: before.length, insert: after }, doc.length);
      const anchors = words.map((word) => ({ id: word, from: before.indexOf(word + " "), to: before.indexOf(word + " ") + word.length }));
      const { mapped, torn } = mapAnchorsPrecisely(anchors, changes, doc);
      expect(torn.size).toBe(0);
      expect(mapped.map((a) => after.slice(a.from, a.to))).toEqual(words);
    }
  });
});
