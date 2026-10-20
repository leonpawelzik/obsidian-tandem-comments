import { describe, expect, it } from "vitest";
import {
  asTaskLines,
  buildGraduateNote,
  finishGraduate,
  graduateEntries,
  graduateNoteName,
  graduateText,
  planGraduate,
  type GraduateOptions,
} from "../src/graduate";
import { parseDocument, resolveAnchor, serializeDocument } from "../src/store";
import type { ParsedDoc } from "../src/types";

const TS = "2026-08-07T12:00:00Z";
const RECORD = { author: "Me", ts: TS, text: "Graduated to the text." };

function discussionDoc(): ParsedDoc {
  const prose = "We should cut prices hard in Q3. Margins matter.";
  const start = prose.indexOf("cut prices hard");
  const margins = prose.indexOf("Margins");
  return {
    prose,
    comments: {
      a1: {
        anchor: { exact: "cut prices hard", prefix: "We should ", suffix: " in Q3.", pos: start },
        status: "open",
        thread: [
          { author: "Leon", ts: TS, text: "Too aggressive?" },
          { author: "Me", ts: TS, text: "" },
          { author: "Me", ts: TS, text: "reduce prices significantly" },
        ],
      },
      b2: {
        anchor: { exact: "Margins", prefix: "Q3. ", suffix: " matter.", pos: margins },
        status: "open",
        thread: [{ author: "Leon", ts: TS, text: "Which ones?" }],
      },
    },
  };
}

function raw(doc = discussionDoc()): string {
  return serializeDocument(doc, true);
}

function apply(source: string, plan: ReturnType<typeof planGraduate>): ParsedDoc {
  if (!plan.ok) throw new Error(plan.reason);
  // Both changes are in the original coordinates; the block change comes second.
  let out = source;
  for (const change of [...plan.changes].reverse()) {
    out = out.slice(0, change.from) + change.insert + out.slice(change.to);
  }
  return parseDocument(out);
}

function options(over: Partial<GraduateOptions> = {}): GraduateOptions {
  return {
    text: "reduce prices significantly",
    placement: { kind: "quote" },
    record: RECORD,
    resolve: false,
    behavior: "keep",
    schemaHint: true,
    ...over,
  };
}

describe("graduate text from the thread", () => {
  it("offers only messages with text, keeping their thread index", () => {
    expect(graduateEntries(discussionDoc().comments.a1).map(([index]) => index)).toEqual([0, 2]);
  });

  it("joins the selected messages in thread order, without authors", () => {
    const comment = discussionDoc().comments.a1;
    expect(graduateText(comment, new Set([2, 0]))).toBe("Too aggressive?\n\nreduce prices significantly");
    expect(graduateText(comment, new Set([2]))).toBe("reduce prices significantly");
    expect(graduateText(comment, new Set([1]))).toBe("");
  });

  it("turns each line into a task and leaves existing tasks alone", () => {
    expect(asTaskLines("call Leon\n\n- [x] done already")).toBe("- [ ] call Leon\n- [x] done already");
  });
});

describe("planGraduate", () => {
  it("replaces the quote, keeps the thread open on the new text, and records it", () => {
    const source = raw();
    const doc = apply(source, planGraduate(source, "a1", options()));
    expect(doc.prose).toBe("We should reduce prices significantly in Q3. Margins matter.");
    const a1 = doc.comments.a1;
    expect(a1.status).toBe("open");
    expect(a1.anchor.exact).toBe("reduce prices significantly");
    expect(a1.thread.slice(-1)[0]).toEqual(RECORD);
  });

  it("moves the other open anchors through the change", () => {
    const source = raw();
    const doc = apply(source, planGraduate(source, "a1", options()));
    const b2 = resolveAnchor(doc.prose, doc.comments.b2.anchor);
    expect(b2.kind).toBe("resolved");
    expect(doc.comments.b2.anchor.pos).toBe(doc.prose.indexOf("Margins"));
  });

  it("inserts at the cursor without touching the quote", () => {
    const source = raw();
    const end = discussionDoc().prose.length;
    const doc = apply(
      source,
      planGraduate(source, "a1", options({ text: "\n\n- [ ] check Q3", placement: { kind: "cursor", offset: end } }))
    );
    expect(doc.prose).toBe("We should cut prices hard in Q3. Margins matter.\n\n- [ ] check Q3");
    expect(doc.comments.a1.anchor.exact).toBe("cut prices hard");
  });

  it("moves the thread's own anchor when inserting before it", () => {
    const source = raw();
    const doc = apply(source, planGraduate(source, "a1", options({ text: "Note: ", placement: { kind: "cursor", offset: 0 } })));
    expect(doc.comments.a1.anchor.pos).toBe(doc.prose.indexOf("cut prices hard"));
  });

  it("resolves the thread, or removes it, when asked to", () => {
    const source = raw();
    const kept = apply(source, planGraduate(source, "a1", options({ resolve: true })));
    expect(kept.comments.a1.status).toBe("resolved");
    expect(kept.comments.a1.thread.slice(-1)[0]).toEqual(RECORD);
    const removed = apply(source, planGraduate(source, "a1", options({ resolve: true, behavior: "remove" })));
    expect(removed.comments.a1).toBeUndefined();
    expect(removed.comments.b2).toBeDefined();
  });

  it("refuses empty text, suggestions, resolved threads and a cursor in the block", () => {
    const source = raw();
    expect(planGraduate(source, "a1", options({ text: "  " }))).toMatchObject({ reason: "empty-text" });
    expect(planGraduate(source, "zz", options())).toMatchObject({ reason: "missing" });
    expect(
      planGraduate(source, "a1", options({ placement: { kind: "cursor", offset: source.length } }))
    ).toMatchObject({ reason: "cursor-outside-prose" });

    const suggestion = discussionDoc();
    suggestion.comments.a1.suggestion = { replacement: "x", author: "Leon", ts: TS };
    expect(planGraduate(raw(suggestion), "a1", options())).toMatchObject({ reason: "not-discussion" });
    const resolved = discussionDoc();
    resolved.comments.a1.status = "resolved";
    expect(planGraduate(raw(resolved), "a1", options())).toMatchObject({ reason: "already-resolved" });
  });

  it("refuses to replace a passage that is gone or appears twice", () => {
    const gone = discussionDoc();
    gone.prose = gone.prose.replace("cut prices hard", "raise prices");
    expect(planGraduate(raw(gone), "a1", options())).toMatchObject({ reason: "orphaned" });

    const twice = discussionDoc();
    twice.prose = "Margins matter. Margins matter.";
    twice.comments.b2.anchor = { exact: "Margins", prefix: "", suffix: "" };
    expect(planGraduate(raw(twice), "b2", options())).toMatchObject({ reason: "ambiguous" });
  });
});

describe("finishGraduate", () => {
  it("adds the record even when the thread stays open", () => {
    const { comments } = discussionDoc();
    finishGraduate(comments, "a1", RECORD, false, "remove");
    expect(comments.a1.status).toBe("open");
    expect(comments.a1.thread).toHaveLength(4);
  });
});

describe("graduate notes", () => {
  it("names the note after the quote, without characters files or links reject", () => {
    expect(graduateNoteName("inputs/outputs: see [[here]] #tag")).toBe("inputs outputs see here tag");
    expect(graduateNoteName("a".repeat(60))).toBe("a".repeat(47) + "…");
    expect(graduateNoteName("..//")).toBe("Comment");
  });

  it("links the source and quotes the passage before the thread", () => {
    const note = buildGraduateNote({
      sourceLink: "[[Plan]]",
      quote: "line one\nline two",
      thread: [{ author: "Leon", ts: TS, text: "Too aggressive?" }],
      formatTs: () => "Aug 7",
    });
    expect(note).toBe(
      "Source: [[Plan]]\n\n> line one\n> line two\n\n## Thread\n\n**Leon** · Aug 7\n\nToo aggressive?\n"
    );
  });
});
