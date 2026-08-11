import { describe, expect, it } from "vitest";
import {
  addComment,
  addReply,
  addSuggestion,
  editThreadEntry,
  generateId,
  removeComment,
  removeThreadEntry,
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

  it("edits one thread entry without changing its metadata", () => {
    const c = sample();
    const original = { ...c.a1f3.thread[0] };

    expect(editThreadEntry(c, "a1f3", 0, original, "Corrected text")).toEqual({ ok: true });
    expect(c.a1f3.thread[0]).toEqual({
      author: "Leon",
      ts: "2026-06-10T00:00:00Z",
      text: "Corrected text",
    });
  });

  it("does not overwrite a thread entry that changed after editing began", () => {
    const c = sample();
    const original = { ...c.a1f3.thread[0] };
    c.a1f3.thread[0].text = "Changed elsewhere";

    expect(editThreadEntry(c, "a1f3", 0, original, "My edit")).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(c.a1f3.thread[0].text).toBe("Changed elsewhere");
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

  it("removeThreadEntry on a reply splices just that entry", () => {
    const c = threaded();
    removeThreadEntry(c, "a1f3", 1);
    expect(c.a1f3.thread).toHaveLength(1);
    expect(c.a1f3.thread[0].author).toBe("Leon");
  });

  it("removeThreadEntry on the root entry deletes the whole comment", () => {
    const c = threaded();
    removeThreadEntry(c, "a1f3", 0);
    expect(c).toEqual({});
  });

  it("removeThreadEntry throws for unknown id", () => {
    expect(() => removeThreadEntry(sample(), "nope", 0)).toThrow();
  });

  it("removeThreadEntry throws for out-of-range index", () => {
    expect(() => removeThreadEntry(sample(), "a1f3", 5)).toThrow();
  });

  it("removeThreadEntry on a suggestion's explanation keeps the suggestion", () => {
    const c: CommentMap = {};
    addSuggestion(
      c,
      "s1",
      { exact: "abc" },
      "Claude",
      "2026-06-10T00:00:00Z",
      "replacement",
      "why this change"
    );
    addReply(c, "s1", "Leon", "2026-06-10T01:00:00Z", "Follow-up");
    removeThreadEntry(c, "s1", 0);
    expect(c.s1).toBeDefined();
    expect(c.s1.suggestion?.replacement).toBe("replacement");
    expect(c.s1.thread).toEqual([
      { author: "Leon", ts: "2026-06-10T01:00:00Z", text: "Follow-up" },
    ]);
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
