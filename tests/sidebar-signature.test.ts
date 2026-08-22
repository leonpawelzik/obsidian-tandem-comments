import { describe, expect, it } from "vitest";
import { commentCardSignature, sidebarContentSignature } from "../src/sidebar-signature";
import { resolveAll } from "../src/store";
import type { ParsedDoc } from "../src/types";

function doc(over: Partial<ParsedDoc> & Pick<ParsedDoc, "prose" | "comments">): ParsedDoc {
  return { ...over };
}

function sig(
  path: string,
  parsed: ParsedDoc,
  showResolved: boolean,
  draft: Parameters<typeof sidebarContentSignature>[3]
): string {
  return sidebarContentSignature(
    path,
    parsed,
    showResolved,
    draft,
    parsed.error ? [] : resolveAll(parsed.prose, parsed.comments)
  );
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
    const a = sig("n.md", base, false, null);
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
    expect(sig("n.md", moved, false, null)).toBe(a);
  });

  it("changes when thread text changes", () => {
    const a = sig("n.md", base, false, null);
    const edited: ParsedDoc = doc({
      prose: base.prose,
      comments: {
        a1: {
          ...base.comments.a1,
          thread: [{ author: "Me", ts: "2026-01-01T00:00:00Z", text: "Edited" }],
        },
      },
    });
    expect(sig("n.md", edited, false, null)).not.toBe(a);
  });

  it("changes when prose orphans the quote", () => {
    const a = sig("n.md", base, false, null);
    const orphaned: ParsedDoc = doc({
      prose: "Totally different document.",
      comments: base.comments,
    });
    expect(sig("n.md", orphaned, false, null)).not.toBe(a);
  });

  it("includes draft in the signature", () => {
    const without = sig("n.md", base, false, null);
    const withDraft = sig("n.md", base, false, {
      filePath: "n.md",
      kind: "comment",
      anchor: { exact: "more text", pos: 16 },
    });
    expect(withDraft).not.toBe(without);
  });

  it("changes one card signature without changing another", () => {
    const two: ParsedDoc = doc({
      prose: "Hello world and more text here.",
      comments: {
        a1: base.comments.a1,
        b2: {
          anchor: { exact: "more text", pos: 16 },
          status: "open",
          thread: [{ author: "Me", ts: "2026-01-01T00:00:00Z", text: "Other" }],
        },
      },
    });
    const [first, second] = resolveAll(two.prose, two.comments);
    const edited: ParsedDoc = doc({
      prose: two.prose,
      comments: {
        ...two.comments,
        b2: {
          ...two.comments.b2,
          thread: [
            two.comments.b2.thread[0],
            { author: "Me", ts: "2026-01-01T00:01:00Z", text: "Reply" },
          ],
        },
      },
    });
    const [firstAfter, secondAfter] = resolveAll(edited.prose, edited.comments);
    expect(commentCardSignature(firstAfter)).toBe(commentCardSignature(first));
    expect(commentCardSignature(secondAfter)).not.toBe(commentCardSignature(second));
  });

  it("rebuilds when an unknown comment field changes, without listing that field", () => {
    const [plain] = resolveAll(base.prose, base.comments);
    const withExtra = {
      ...plain,
      comment: {
        ...plain.comment,
        lifecycle: { outcome: "promoted-note", at: "2026-01-01T00:00:00Z" },
      },
    };
    expect(commentCardSignature(withExtra)).not.toBe(commentCardSignature(plain));
  });
});
