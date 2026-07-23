import { ChangeSet, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { mapAnchors, mergePendingAnchors } from "../src/reanchor";
import {
  acceptSuggestion,
  addSuggestion,
  declineSuggestion,
  makeAnchor,
  parseDocument,
  planSuggestionAcceptance,
  resolveAll,
  resolveAnchor,
  serializeDocument,
  type SuggestionTextChange,
} from "../src/store";
import type { CommentMap, ParsedDoc } from "../src/types";

const TS = "2026-07-23T12:00:00Z";

function suggestionDoc(prose = "We should cut prices hard in Q3."): ParsedDoc {
  const exact = "cut prices hard";
  const start = prose.indexOf(exact);
  return {
    prose,
    comments: {
      a1f3: {
        anchor: makeAnchor(prose, start, start + exact.length),
        status: "open",
        suggestion: {
          replacement: "reduce prices significantly",
          author: "Claude",
          ts: TS,
        },
        thread: [{ author: "Claude", ts: TS, text: "Less abrupt." }],
      },
    },
  };
}

/** Applies simultaneous CodeMirror-style changes whose offsets refer to raw. */
function applyChanges(raw: string, changes: SuggestionTextChange[]): string {
  let result = raw;
  for (const change of [...changes].sort((a, b) => b.from - a.from)) {
    result = result.slice(0, change.from) + change.insert + result.slice(change.to);
  }
  return result;
}

describe("edit suggestion mutations", () => {
  it("creates a suggestion with proposal metadata and an optional discussion note", () => {
    const comments: CommentMap = {};
    addSuggestion(
      comments,
      "7c2e",
      { exact: "cut prices hard", pos: 10 },
      "Leon",
      TS,
      "reduce prices significantly",
      "Clearer wording."
    );
    expect(comments["7c2e"]).toEqual({
      anchor: { exact: "cut prices hard", pos: 10 },
      status: "open",
      suggestion: {
        replacement: "reduce prices significantly",
        author: "Leon",
        ts: TS,
      },
      thread: [{ author: "Leon", ts: TS, text: "Clearer wording." }],
    });
  });

  it("allows a suggestion without a discussion note", () => {
    const comments: CommentMap = {};
    addSuggestion(comments, "7c2e", { exact: "old" }, "Leon", TS, "new");
    expect(comments["7c2e"].thread).toEqual([]);
  });

  it("accepts a uniquely resolved suggestion and removes it by default", () => {
    const doc = suggestionDoc();
    const result = acceptSuggestion(doc, "a1f3", "remove");
    expect(result).toEqual({
      ok: true,
      start: 10,
      end: 25,
      replacement: "reduce prices significantly",
    });
    expect(doc.prose).toBe("We should reduce prices significantly in Q3.");
    expect(doc.comments).toEqual({});
  });

  it("retains accepted suggestions with a machine-readable result in history mode", () => {
    const doc = suggestionDoc();
    expect(acceptSuggestion(doc, "a1f3", "keep").ok).toBe(true);
    expect(doc.comments.a1f3.status).toBe("resolved");
    expect(doc.comments.a1f3.suggestion?.result).toBe("accepted");
  });

  it("does not resolve accepted history through its obsolete quote anchor", () => {
    const doc = suggestionDoc();
    doc.comments.a1f3.suggestion!.replacement = "cut prices hard, but carefully";
    expect(acceptSuggestion(doc, "a1f3", "keep").ok).toBe(true);
    expect(resolveAnchor(doc.prose, doc.comments.a1f3.anchor).kind).toBe("resolved");
    expect(resolveAll(doc.prose, doc.comments)[0].resolution).toEqual({ kind: "orphaned" });
  });

  it("declines without changing prose and removes the suggestion by default", () => {
    const doc = suggestionDoc();
    const proseBefore = doc.prose;
    expect(declineSuggestion(doc.comments, "a1f3", "remove")).toEqual({ ok: true });
    expect(doc.prose).toBe(proseBefore);
    expect(doc.comments).toEqual({});
  });

  it("retains declined suggestions with a machine-readable result in history mode", () => {
    const doc = suggestionDoc();
    expect(declineSuggestion(doc.comments, "a1f3", "keep")).toEqual({ ok: true });
    expect(doc.comments.a1f3.status).toBe("resolved");
    expect(doc.comments.a1f3.suggestion?.result).toBe("declined");
    expect(doc.prose).toBe("We should cut prices hard in Q3.");
  });

  it.each(["invalid", null])(
    "rejects malformed %s suggestion data instead of crashing while retaining declined history",
    (payload) => {
      const doc = suggestionDoc();
      (doc.comments.a1f3 as unknown as { suggestion: unknown }).suggestion = payload;
      const before = structuredClone(doc.comments);
      expect(declineSuggestion(doc.comments, "a1f3", "keep")).toEqual({
        ok: false,
        reason: "invalid-suggestion",
      });
      expect(doc.comments).toEqual(before);
    }
  );

  it.each([
    ["missing", (doc: ParsedDoc): void => { delete doc.comments.a1f3; }, "missing"],
    ["ordinary comment", (doc: ParsedDoc): void => { delete doc.comments.a1f3.suggestion; }, "not-suggestion"],
    ["resolved", (doc: ParsedDoc): void => { doc.comments.a1f3.status = "resolved"; }, "already-resolved"],
    ["already-resulted", (doc: ParsedDoc): void => { doc.comments.a1f3.suggestion!.result = "declined"; }, "already-resolved"],
    ["empty replacement", (doc: ParsedDoc): void => { doc.comments.a1f3.suggestion!.replacement = ""; }, "empty-replacement"],
    [
      "non-text replacement",
      (doc: ParsedDoc): void => {
        (doc.comments.a1f3.suggestion as unknown as { replacement: number }).replacement = 42;
      },
      "invalid-suggestion",
    ],
    ["orphaned", (doc: ParsedDoc): void => { doc.prose = "The passage disappeared."; }, "orphaned"],
  ] as const)("refuses a %s suggestion without mutating the document", (_name, arrange, reason) => {
    const doc = suggestionDoc();
    arrange(doc);
    const before = structuredClone(doc);
    expect(acceptSuggestion(doc, "a1f3", "remove")).toEqual({ ok: false, reason });
    expect(doc).toEqual(before);
  });

  it("refuses an ambiguous anchor even when its pos would choose a nearby occurrence", () => {
    const prose = "Change this. Change this.";
    const doc: ParsedDoc = {
      prose,
      comments: {
        a1f3: {
          anchor: { exact: "Change this", pos: 13 },
          status: "open",
          suggestion: { replacement: "Keep that", author: "Claude", ts: TS },
          thread: [],
        },
      },
    };
    const before = structuredClone(doc);
    expect(acceptSuggestion(doc, "a1f3", "remove")).toEqual({ ok: false, reason: "ambiguous" });
    expect(doc).toEqual(before);
  });

  it("accepts a repeated quote when prefix/suffix context identifies exactly one occurrence", () => {
    const prose = "First change this. Later change this now.";
    const start = prose.lastIndexOf("change this");
    const doc: ParsedDoc = {
      prose,
      comments: {
        a1f3: {
          anchor: makeAnchor(prose, start, start + "change this".length),
          status: "open",
          suggestion: { replacement: "keep that", author: "Claude", ts: TS },
          thread: [],
        },
      },
    };
    expect(acceptSuggestion(doc, "a1f3", "remove").ok).toBe(true);
    expect(doc.prose).toBe("First change this. Later keep that now.");
  });
});

describe("atomic suggestion acceptance plan", () => {
  it("parses a hand-authored AI suggestion without modifying its prose", () => {
    const raw = [
      "We should cut prices hard in Q3.",
      "```tandem-comments",
      "{",
      '  "7c2e": {',
      '    "anchor": { "exact": "cut prices hard", "prefix": "We should ", "suffix": " in Q3.", "pos": 10 },',
      '    "status": "open",',
      '    "suggestion": { "replacement": "reduce prices significantly", "author": "Claude", "ts": "2026-07-23T12:00:00Z" },',
      '    "thread": [{ "author": "Claude", "ts": "2026-07-23T12:00:00Z", "text": "Less abrupt." }]',
      "  }",
      "}",
      "```",
      "",
    ].join("\n");
    const parsed = parseDocument(raw);
    expect(parsed.prose).toBe("We should cut prices hard in Q3.");
    expect(parsed.comments["7c2e"].suggestion?.replacement).toBe("reduce prices significantly");
    expect(serializeDocument(parsed, false)).toContain('"suggestion"');
  });

  it("plans prose and block updates in one pair of non-overlapping original-coordinate changes", () => {
    const raw = serializeDocument(suggestionDoc(), true);
    const plan = planSuggestionAcceptance(raw, "a1f3", "remove", true);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    expect(plan.changes).toHaveLength(2);
    expect(plan.changes[0].to).toBeLessThanOrEqual(plan.changes[1].from);
    const output = applyChanges(raw, plan.changes);
    expect(output).toBe("We should reduce prices significantly in Q3.");
    expect(plan.cursor).toBe("We should reduce prices significantly".length);
  });

  it("applies and inverts the acceptance through CodeMirror as one change set", () => {
    const raw = serializeDocument(suggestionDoc(), true);
    const plan = planSuggestionAcceptance(raw, "a1f3", "remove", true);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const original = Text.of(raw.split("\n"));
    const changeSet = ChangeSet.of(
      plan.changes.map((change) => ({
        from: change.from,
        to: change.to,
        insert: change.insert,
      })),
      raw.length
    );
    const accepted = changeSet.apply(original);
    expect(accepted.toString()).toBe("We should reduce prices significantly in Q3.");
    expect(changeSet.invert(original).apply(accepted).toString()).toBe(raw);
  });

  it("keeps resolved history in the rewritten comment block", () => {
    const raw = serializeDocument(suggestionDoc(), true);
    const plan = planSuggestionAcceptance(raw, "a1f3", "keep", true);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const output = applyChanges(raw, plan.changes);
    const parsed = parseDocument(output);
    expect(parsed.prose).toBe("We should reduce prices significantly in Q3.");
    expect(parsed.comments.a1f3.status).toBe("resolved");
    expect(parsed.comments.a1f3.suggestion?.result).toBe("accepted");
  });

  it.each([
    ["document start", "cut prices hard at the start", 0, "Start strongly"],
    ["document end", "Finish with cut prices hard", 12, "a softer close"],
    ["quotes and emoji", "Use cut prices hard here", 4, 'say "hello" 👋'],
    ["multiple lines", "Use cut prices hard here", 4, "reduce prices\nwith care"],
  ])("handles replacement at %s and preserves arbitrary replacement text", (_name, prose, start, replacement) => {
    const exact = "cut prices hard";
    const doc: ParsedDoc = {
      prose,
      comments: {
        a1f3: {
          anchor: makeAnchor(prose, start, start + exact.length),
          status: "open",
          suggestion: { replacement, author: "Claude", ts: TS },
          thread: [],
        },
      },
    };
    const raw = serializeDocument(doc, false);
    const plan = planSuggestionAcceptance(raw, "a1f3", "remove", false);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(applyChanges(raw, plan.changes)).toBe(
      prose.slice(0, start) + replacement + prose.slice(start + exact.length)
    );
  });

  it("respects the disabled schema-hint setting when retained history rewrites the block", () => {
    const raw = serializeDocument(suggestionDoc(), false);
    const plan = planSuggestionAcceptance(raw, "a1f3", "keep", false);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const output = applyChanges(raw, plan.changes);
    expect(output).not.toContain("// Schema:");
    expect(parseDocument(output).comments.a1f3.suggestion?.result).toBe("accepted");
  });

  it("preserves trailing footnotes byte-exact while replacing multiline Unicode text", () => {
    const prose = "Intro.\nCafé costs too much.\nEnd.[^1]";
    const exact = "Café costs too much.";
    const start = prose.indexOf(exact);
    const doc: ParsedDoc = {
      prose,
      comments: {
        a1f3: {
          anchor: makeAnchor(prose, start, start + exact.length),
          status: "open",
          suggestion: {
            replacement: "Café costs €4.\nThat is acceptable.",
            author: "Claude",
            ts: TS,
          },
          thread: [],
        },
      },
      trailing: "\n[^1]: Source\n",
    };
    const raw = serializeDocument(doc, true);
    const plan = planSuggestionAcceptance(raw, "a1f3", "remove", true);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    expect(applyChanges(raw, plan.changes)).toBe(
      "Intro.\nCafé costs €4.\nThat is acceptable.\nEnd.[^1]\n[^1]: Source\n"
    );
  });

  it("keeps prose separated from immediate trailing content when acceptance removes the block", () => {
    const doc = suggestionDoc("We should cut prices hard in Q3.[^1]");
    doc.trailing = "[^1]: Source\n";
    const raw = serializeDocument(doc, true);
    const plan = planSuggestionAcceptance(raw, "a1f3", "remove", true);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    expect(applyChanges(raw, plan.changes)).toBe(
      "We should reduce prices significantly in Q3.[^1]\n[^1]: Source\n"
    );
  });

  it("keeps prose separated from immediate trailing content when decline removes the block", () => {
    const doc = suggestionDoc("We should cut prices hard in Q3.[^1]");
    doc.trailing = "[^1]: Source\n";
    const parsed = parseDocument(serializeDocument(doc, true));
    expect(declineSuggestion(parsed.comments, "a1f3", "remove")).toEqual({ ok: true });
    expect(serializeDocument(parsed, true)).toBe(
      "We should cut prices hard in Q3.[^1]\n[^1]: Source\n"
    );
  });

  it("preserves unrelated comments and leaves their quote anchors resolvable", () => {
    const doc = suggestionDoc("First note. We should cut prices hard in Q3. Final note.");
    doc.comments.b2c4 = {
      anchor: makeAnchor(doc.prose, 47, 57),
      status: "open",
      thread: [{ author: "Leon", ts: TS, text: "Keep this." }],
    };
    const raw = serializeDocument(doc, true);
    const plan = planSuggestionAcceptance(raw, "a1f3", "remove", true);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const parsed = parseDocument(applyChanges(raw, plan.changes));
    expect(parsed.comments.b2c4).toBeDefined();
    expect(resolveAnchor(parsed.prose, parsed.comments.b2c4.anchor).kind).toBe("resolved");
  });

  it("rebases a later repeated anchor so its stale pos cannot move it to an earlier occurrence", () => {
    const prose = "X same middle same";
    const secondSame = prose.lastIndexOf("same");
    const doc: ParsedDoc = {
      prose,
      comments: {
        a1f3: {
          anchor: makeAnchor(prose, 0, 1),
          status: "open",
          suggestion: {
            replacement: "A much longer opening",
            author: "Claude",
            ts: TS,
          },
          thread: [],
        },
        b2c4: {
          anchor: makeAnchor(prose, secondSame, secondSame + "same".length),
          status: "open",
          thread: [{ author: "Leon", ts: TS, text: "Keep the second occurrence." }],
        },
      },
    };

    expect(acceptSuggestion(doc, "a1f3", "remove").ok).toBe(true);
    const expectedStart = doc.prose.lastIndexOf("same");
    expect(doc.comments.b2c4.anchor.pos).toBe(expectedStart);
    expect(resolveAnchor(doc.prose, doc.comments.b2c4.anchor)).toEqual({
      kind: "resolved",
      start: expectedStart,
      end: expectedStart + 4,
    });
  });

  it("preserves ambiguity instead of rebasing an arbitrarily chosen surviving occurrence", () => {
    const prose = "X same middle same";
    const doc: ParsedDoc = {
      prose,
      comments: {
        a1f3: {
          anchor: makeAnchor(prose, 0, 1),
          status: "open",
          suggestion: { replacement: "A much longer opening", author: "Claude", ts: TS },
          thread: [],
        },
        b2c4: {
          anchor: { exact: "same", pos: prose.lastIndexOf("same") },
          status: "open",
          suggestion: { replacement: "different", author: "Claude", ts: TS },
          thread: [],
        },
      },
    };
    const ambiguousBefore = structuredClone(doc.comments.b2c4.anchor);

    expect(acceptSuggestion(doc, "a1f3", "remove").ok).toBe(true);
    expect(doc.comments.b2c4.anchor).toEqual(ambiguousBefore);
    expect(resolveAnchor(doc.prose, doc.comments.b2c4.anchor)).toMatchObject({
      kind: "resolved",
      ambiguous: true,
    });
    expect(acceptSuggestion(doc, "b2c4", "remove")).toEqual({
      ok: false,
      reason: "ambiguous",
    });
  });

  it("recovers an unrelated in-memory reanchor when acceptance serializes its stale quote", () => {
    const prose = "X target and very old quote.";
    const targetStart = prose.indexOf("target");
    const otherStart = prose.indexOf("very old quote");
    const doc: ParsedDoc = {
      prose,
      comments: {
        a1f3: {
          anchor: makeAnchor(prose, targetStart, targetStart + "target".length),
          status: "open",
          suggestion: {
            replacement: "a substantially longer target",
            author: "Claude",
            ts: TS,
          },
          thread: [],
        },
        b2c4: {
          anchor: makeAnchor(prose, otherStart, otherStart + "very old quote".length),
          status: "open",
          thread: [{ author: "Leon", ts: TS, text: "Pending edit." }],
        },
      },
    };
    const originalRaw = serializeDocument(doc, true);

    const oldWordStart = prose.indexOf("old");
    const userChange = ChangeSet.of(
      { from: oldWordStart, to: oldWordStart + 3, insert: "new wording" },
      originalRaw.length
    );
    const editedRaw = userChange.apply(Text.of(originalRaw.split("\n"))).toString();
    const pendingAfterEdit = mapAnchors(
      [{ id: "b2c4", from: otherStart, to: otherStart + "very old quote".length }],
      userChange
    );

    const plan = planSuggestionAcceptance(editedRaw, "a1f3", "remove", true);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const acceptanceChange = ChangeSet.of(
      plan.changes.map((change) => ({
        from: change.from,
        to: change.to,
        insert: change.insert,
      })),
      editedRaw.length
    );
    const acceptedRaw = acceptanceChange.apply(Text.of(editedRaw.split("\n"))).toString();
    const acceptedDoc = parseDocument(acceptedRaw);
    expect(resolveAnchor(acceptedDoc.prose, acceptedDoc.comments.b2c4.anchor).kind).toBe("orphaned");

    const pendingAfterAccept = mapAnchors(pendingAfterEdit, acceptanceChange);
    const restored = mergePendingAnchors([], pendingAfterAccept, new Set(["b2c4"]));
    expect(restored).toHaveLength(1);
    acceptedDoc.comments.b2c4.anchor = makeAnchor(
      acceptedDoc.prose,
      restored[0].from,
      restored[0].to
    );
    expect(acceptedDoc.comments.b2c4.anchor.exact).toBe("very new wording quote");
    expect(resolveAnchor(acceptedDoc.prose, acceptedDoc.comments.b2c4.anchor).kind).toBe("resolved");
  });

  it("returns no changes for invalid JSON, ambiguous anchors, and missing IDs", () => {
    expect(planSuggestionAcceptance("Text\n```tandem-comments\n{bad\n```\n", "a", "remove", true)).toMatchObject({
      ok: false,
      reason: "invalid-document",
    });

    const ambiguous = suggestionDoc("cut prices hard / cut prices hard");
    ambiguous.comments.a1f3.anchor = { exact: "cut prices hard" };
    const ambiguousRaw = serializeDocument(ambiguous, true);
    expect(planSuggestionAcceptance(ambiguousRaw, "a1f3", "remove", true)).toEqual({
      ok: false,
      reason: "ambiguous",
    });

    const raw = serializeDocument(suggestionDoc(), true);
    expect(planSuggestionAcceptance(raw, "nope", "remove", true)).toEqual({
      ok: false,
      reason: "missing",
    });
  });
});
