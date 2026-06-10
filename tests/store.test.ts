import { describe, expect, it } from "vitest";
import { parseDocument, resolveAnchor, serializeDocument, SCHEMA_HINT_LINES } from "../src/store";
import type { CommentMap } from "../src/types";

const COMMENTS: CommentMap = {
  a1f3: {
    anchor: { exact: "aggressiv senken", prefix: "den Preis ", suffix: " im Q3", pos: 22 },
    status: "open",
    thread: [{ author: "Leon", ts: "2026-06-10T10:24:00Z", text: "Zu hart?" }],
  },
};

function block(json: string, hint = true): string {
  const hintStr = hint ? SCHEMA_HINT_LINES.join("\n") + "\n" : "";
  return "```tandem-comments\n" + hintStr + json + "\n```\n";
}

describe("parseDocument", () => {
  it("returns whole file as prose when no block exists", () => {
    const raw = "# Titel\n\nWir senken den Preis.\n";
    expect(parseDocument(raw)).toEqual({ prose: raw, comments: {} });
  });

  it("splits prose and comments when block exists", () => {
    const prose = "Wir sollten den Preis aggressiv senken im Q3.";
    const raw = prose + "\n" + block(JSON.stringify(COMMENTS, null, 2));
    const doc = parseDocument(raw);
    expect(doc.prose).toBe(prose);
    expect(doc.comments).toEqual(COMMENTS);
    expect(doc.error).toBeUndefined();
  });

  it("ignores // hint lines before the JSON", () => {
    const raw = "Text.\n" + block(JSON.stringify(COMMENTS, null, 2), true);
    expect(parseDocument(raw).comments).toEqual(COMMENTS);
  });

  it("parses a block without hint lines", () => {
    const raw = "Text.\n" + block(JSON.stringify(COMMENTS, null, 2), false);
    expect(parseDocument(raw).comments).toEqual(COMMENTS);
  });

  it("sets error and keeps raw as prose when JSON is broken", () => {
    const raw = "Text.\n```tandem-comments\n{ kaputt\n```\n";
    const doc = parseDocument(raw);
    expect(doc.error).toBeTruthy();
    expect(doc.prose).toBe(raw);
    expect(doc.comments).toEqual({});
  });

  it("handles a file that is only a block (empty prose)", () => {
    const raw = block(JSON.stringify(COMMENTS, null, 2));
    const doc = parseDocument(raw);
    expect(doc.prose).toBe("");
    expect(doc.comments).toEqual(COMMENTS);
  });

  it("parses a hand-written block as Claude would author it", () => {
    const raw = [
      "Wir sollten den Preis aggressiv senken im Q3.",
      "```tandem-comments",
      '// Schema: { "<id>": { anchor:{exact,prefix,suffix,pos?}, status:open|resolved, thread:[{author,ts,text}] } }',
      '// Anchor = quote from the prose. To locate: search for "exact", disambiguate via prefix/suffix.',
      "{",
      '  "7c2e": {',
      '    "anchor": { "exact": "aggressiv senken", "prefix": "den Preis ", "suffix": " im Q3", "pos": 22 },',
      '    "status": "open",',
      '    "thread": [{ "author": "Claude", "ts": "2026-06-10T12:00:00Z", "text": "Vorschlag: gezielt nachschärfen." }]',
      "  }",
      "}",
      "```",
      "",
    ].join("\n");
    const doc = parseDocument(raw);
    expect(doc.error).toBeUndefined();
    expect(doc.prose).toBe("Wir sollten den Preis aggressiv senken im Q3.");
    expect(resolveAnchor(doc.prose, doc.comments["7c2e"].anchor)).toEqual({ kind: "resolved", start: 22, end: 38 });
  });
});

describe("serializeDocument", () => {
  it("returns prose byte-exact when no comments exist", () => {
    const prose = "Kein Newline am Ende";
    expect(serializeDocument({ prose, comments: {} }, true)).toBe(prose);
  });

  it("round-trips byte-exact (parse → serialize → parse)", () => {
    for (const prose of ["Ohne Newline", "Mit Newline\n", "Mehrere\n\n\n", ""]) {
      const out = serializeDocument({ prose, comments: COMMENTS }, true);
      const doc = parseDocument(out);
      expect(doc.prose).toBe(prose);
      expect(doc.comments).toEqual(COMMENTS);
      expect(serializeDocument(doc, true)).toBe(out);
    }
  });

  it("add + remove all comments restores the original file byte-exact", () => {
    const original = "Prosa ohne trailing newline";
    const withComments = serializeDocument({ prose: original, comments: COMMENTS }, true);
    const doc = parseDocument(withComments);
    expect(serializeDocument({ prose: doc.prose, comments: {} }, true)).toBe(original);
  });

  it("omits hint lines when schemaHint is false", () => {
    const out = serializeDocument({ prose: "X", comments: COMMENTS }, false);
    expect(out).not.toContain("// Schema");
    expect(parseDocument(out).comments).toEqual(COMMENTS);
  });

  it("never emits a bare ``` line from comment text (JSON escapes newlines)", () => {
    const comments: CommentMap = {
      x1: {
        anchor: { exact: "A" },
        status: "open",
        thread: [{ author: "Leon", ts: "2026-06-10T00:00:00Z", text: "Code:\n```\nfoo\n```\nEnde" }],
      },
    };
    const out = serializeDocument({ prose: "A B C", comments }, true);
    const doc = parseDocument(out);
    expect(doc.comments).toEqual(comments);
    expect(doc.prose).toBe("A B C");
  });

  it("throws when asked to serialize a doc with parse error", () => {
    expect(() => serializeDocument({ prose: "x", comments: {}, error: "kaputt" }, true)).toThrow();
  });
});
