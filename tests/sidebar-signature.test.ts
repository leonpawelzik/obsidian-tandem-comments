import { describe, expect, it } from "vitest";
import { sidebarContentSignature } from "../src/sidebar-signature";
import type { ParsedDoc } from "../src/types";

function doc(over: Partial<ParsedDoc> & Pick<ParsedDoc, "prose" | "comments">): ParsedDoc {
  return { ...over };
}

describe("sidebarContentSignature", () => {
  const base: ParsedDoc = doc({
    prose: "Hello world and more text here.",
    comments: {
      a1: {
        anchor: { exact: "Hello world", prefix: "", suffix: " and", pos: 0 },
        status: "open",
        thread: [{ author: "Me", ts: "2026-01-01T00:00:00Z", text: "Hi" }],
      },
    },
  });

  it("is stable when only anchor pos changes but quote and resolution match", () => {
    const a = sidebarContentSignature("n.md", base, false, null);
    const moved: ParsedDoc = doc({
      prose: base.prose,
      comments: {
        a1: {
          ...base.comments.a1,
          anchor: { ...base.comments.a1.anchor, pos: 99 },
        },
      },
    });
    // resolve still finds "Hello world" at 0; signature includes start/end from resolve, not pos
    expect(sidebarContentSignature("n.md", moved, false, null)).toBe(a);
  });

  it("changes when thread text changes", () => {
    const a = sidebarContentSignature("n.md", base, false, null);
    const edited: ParsedDoc = doc({
      prose: base.prose,
      comments: {
        a1: {
          ...base.comments.a1,
          thread: [{ author: "Me", ts: "2026-01-01T00:00:00Z", text: "Edited" }],
        },
      },
    });
    expect(sidebarContentSignature("n.md", edited, false, null)).not.toBe(a);
  });

  it("changes when prose orphans the quote", () => {
    const a = sidebarContentSignature("n.md", base, false, null);
    const orphaned: ParsedDoc = doc({
      prose: "Totally different document.",
      comments: base.comments,
    });
    expect(sidebarContentSignature("n.md", orphaned, false, null)).not.toBe(a);
  });

  it("includes draft in the signature", () => {
    const without = sidebarContentSignature("n.md", base, false, null);
    const withDraft = sidebarContentSignature("n.md", base, false, {
      filePath: "n.md",
      kind: "comment",
      anchor: { exact: "more text", pos: 16 },
    });
    expect(withDraft).not.toBe(without);
  });
});
