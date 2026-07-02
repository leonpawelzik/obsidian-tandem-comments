import { describe, expect, it } from "vitest";
import {
  addComment,
  addReply,
  editEntry,
  generateId,
  removeComment,
  removeEntry,
  resolveAll,
  setStatus,
} from "../src/store";
import type { CommentMap } from "../src/types";

function sample(): CommentMap {
  return {
    a1f3: {
      anchor: { exact: "abc" },
      status: "open",
      thread: [{ author: "Leon", ts: "2026-06-10T00:00:00Z", text: "Hi" }],
    },
  };
}

function threaded(): CommentMap {
  return {
    a1f3: {
      anchor: { exact: "abc" },
      status: "open",
      thread: [
        { author: "Leon", ts: "2026-06-10T00:00:00Z", text: "Hi" },
        { author: "Claude", ts: "2026-06-10T01:00:00Z", text: "Antwort" },
      ],
    },
  };
}

describe("mutations", () => {
  it("addComment creates an open comment with one thread entry", () => {
    const c: CommentMap = {};
    addComment(c, "x1", { exact: "foo" }, "Leon", "2026-06-10T00:00:00Z", "Text");
    expect(c.x1).toEqual({
      anchor: { exact: "foo" },
      status: "open",
      thread: [{ author: "Leon", ts: "2026-06-10T00:00:00Z", text: "Text" }],
    });
  });

  it("addReply appends to the thread", () => {
    const c = sample();
    addReply(c, "a1f3", "Claude", "2026-06-10T01:00:00Z", "Antwort");
    expect(c.a1f3.thread).toHaveLength(2);
    expect(c.a1f3.thread[1].author).toBe("Claude");
  });

  it("addReply throws for unknown id", () => {
    expect(() => addReply(sample(), "nope", "X", "ts", "t")).toThrow();
  });

  it("setStatus flips status", () => {
    const c = sample();
    setStatus(c, "a1f3", "resolved");
    expect(c.a1f3.status).toBe("resolved");
  });

  it("removeComment deletes the entry", () => {
    const c = sample();
    removeComment(c, "a1f3");
    expect(c).toEqual({});
  });

  it("editEntry changes only the text and preserves author and ts", () => {
    const c = threaded();
    editEntry(c, "a1f3", 1, "Neuer Text");
    expect(c.a1f3.thread[1]).toEqual({
      author: "Claude",
      ts: "2026-06-10T01:00:00Z",
      text: "Neuer Text",
    });
    expect(c.a1f3.thread[0].text).toBe("Hi");
  });

  it("editEntry throws for unknown id", () => {
    expect(() => editEntry(sample(), "nope", 0, "x")).toThrow();
  });

  it("editEntry throws for out-of-range index", () => {
    expect(() => editEntry(sample(), "a1f3", 5, "x")).toThrow();
  });

  it("removeEntry on a reply splices just that entry", () => {
    const c = threaded();
    removeEntry(c, "a1f3", 1);
    expect(c.a1f3.thread).toHaveLength(1);
    expect(c.a1f3.thread[0].author).toBe("Leon");
  });

  it("removeEntry on the root entry deletes the whole comment", () => {
    const c = threaded();
    removeEntry(c, "a1f3", 0);
    expect(c).toEqual({});
  });

  it("removeEntry throws for unknown id", () => {
    expect(() => removeEntry(sample(), "nope", 0)).toThrow();
  });

  it("removeEntry throws for out-of-range index", () => {
    expect(() => removeEntry(sample(), "a1f3", 5)).toThrow();
  });

  it("generateId returns 4-char hex ids not colliding with existing", () => {
    const c = sample();
    for (let i = 0; i < 100; i++) {
      const id = generateId(c);
      expect(id).toMatch(/^[0-9a-f]{4}$/);
      expect(id in c).toBe(false);
    }
  });

  it("resolveAll resolves every comment against the prose", () => {
    const c = sample();
    const rs = resolveAll("xx abc yy", c);
    expect(rs).toHaveLength(1);
    expect(rs[0].id).toBe("a1f3");
    expect(rs[0].resolution).toEqual({ kind: "resolved", start: 3, end: 6 });
  });
});
