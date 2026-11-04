import { describe, expect, it } from "vitest";
import { findCallouts, locateInCallout, type CalloutScope } from "../src/callout-highlight";

const CALLOUT = [
  "> [!summary] Answered in part",
  "> **Expected:** the gaps are known.",
  ">",
  "> The gaps are known, and the gaps are old.",
].join("\n");

describe("findCallouts", () => {
  it("spans the header line and all following quote lines", () => {
    const doc = "Intro.\n\n" + CALLOUT + "\n\nAfter.";
    const callouts = findCallouts(doc);
    expect(callouts).toHaveLength(1);
    expect(doc.slice(callouts[0].from, callouts[0].to)).toBe(CALLOUT);
    expect(doc.slice(callouts[0].bodyFrom, callouts[0].to)).toBe(CALLOUT.slice(CALLOUT.indexOf("\n") + 1));
  });

  it("accepts foldable callouts and callouts without a title", () => {
    expect(findCallouts("> [!tip]- Folded\n> body")).toHaveLength(1);
    expect(findCallouts(">[!note]\n> body")).toHaveLength(1);
  });

  it("has an empty body for a header-only callout", () => {
    const [callout] = findCallouts("> [!note] Only a title");
    expect(callout.bodyFrom).toBe(callout.to);
  });

  it("ignores plain blockquotes", () => {
    expect(findCallouts("> just a quote\n> [!note] not a header here")).toHaveLength(0);
  });

  it("ignores text after the prose limit", () => {
    const doc = "Prose.\n```tandem-comments\n> [!note] x\n```";
    expect(findCallouts(doc, "Prose.".length)).toHaveLength(0);
  });

  it("finds consecutive callouts separated by a blank line", () => {
    expect(findCallouts("> [!note] a\n> b\n\n> [!tip] c")).toHaveLength(2);
  });
});

/**
 * Gerendertes Callout als textContent von Titel und Inhalt. Ob zwischen den
 * Block-Elementen ein "\n"-Textknoten steht, hängt vom Renderer ab — beides testen.
 */
interface Rendered {
  title: string;
  content: string;
}

/** Simuliert `querySelector(scope).textContent` im Callout-Widget (`.callout` = Titel + Inhalt). */
function textContentOf(rendered: Rendered, scope: CalloutScope): string {
  return { ".callout": rendered.title + rendered.content, ".callout-content": rendered.content }[scope];
}

/** Markiert `needle` (n-tes Vorkommen) im Callout-Quelltext; liefert den durchsuchten Text und die Spanne darin. */
function spanOf(source: string, needle: string, rendered: Rendered, nth = 0) {
  let from = source.indexOf(needle);
  for (let i = 0; i < nth; i++) from = source.indexOf(needle, from + 1);
  const span = locateInCallout(source, findCallouts(source), from, from + needle.length,
    (_callout, scope) => ({ textContent: textContentOf(rendered, scope) }));
  return span && { searched: span.root.textContent, start: span.start, end: span.end };
}

/** Text, den die Markierung im gerenderten textContent umschließt. */
function highlighted(source: string, needle: string, rendered: Rendered, nth = 0): string | null {
  const span = spanOf(source, needle, rendered, nth);
  return span ? span.searched.slice(span.start, span.end) : null;
}

const RENDERED_JOINED: Rendered = {
  title: "Answered in part",
  content: "Expected: the gaps are known.The gaps are known, and the gaps are old.",
};
const RENDERED_NEWLINES: Rendered = {
  title: "Answered in part\n",
  content: "Expected: the gaps are known.\nThe gaps are known, and the gaps are old.",
};

describe("locateInCallout", () => {
  it("finds an anchor in the body", () => {
    expect(highlighted(CALLOUT, "the gaps are known", RENDERED_JOINED)).toBe("the gaps are known");
  });

  it("picks the right occurrence of a repeated phrase, ignoring quote and callout markers", () => {
    // Zweites "the gaps" steht in der letzten Zeile, das erste in der "Expected"-Zeile.
    const span = spanOf(CALLOUT, "the gaps", RENDERED_JOINED, 1)!;
    expect(span.searched.slice(span.start - 4, span.end)).toBe("and the gaps");
  });

  it("strips inline Markdown from the anchor", () => {
    expect(highlighted(CALLOUT, "**Expected:** the", RENDERED_JOINED)).toBe("Expected: the");
  });

  it("finds anchors in the title", () => {
    expect(highlighted(CALLOUT, "Answered", RENDERED_JOINED)).toBe("Answered");
  });

  it("highlights an anchor from the title into the body", () => {
    expect(highlighted(CALLOUT, "part\n> **Expected:**", RENDERED_JOINED)).toBe("partExpected:");
  });

  it("ignores the type name an untitled callout renders as its title", () => {
    // Ohne Titel zeigt Obsidian "Note" als Titel — der steht nicht im Quelltext.
    const source = "> [!note]\n> Note that the note is short.";
    const rendered = { title: "Note", content: "Note that the note is short." };
    const first = spanOf(source, "Note", rendered)!;
    expect(first.searched).toBe(rendered.content);
    expect(first.start).toBe(0);
    // Erstes "note" im Quelltext ist der `[!note]`-Marker, das zweite "the note".
    expect(spanOf(source, "note", rendered, 1)!.start).toBe(rendered.content.indexOf("note"));
  });

  it("returns nothing for an anchor on the `[!type]` marker", () => {
    expect(spanOf("> [!note]\n> Note that the note is short.", "note", { title: "Note", content: "Note that the note is short." })).toBeNull();
  });

  it("highlights an anchor across paragraphs", () => {
    const needle = "known.\n>\n> The gaps";
    expect(highlighted(CALLOUT, needle, RENDERED_JOINED)).toBe("known.The gaps");
    expect(highlighted(CALLOUT, needle, RENDERED_NEWLINES)).toBe("known.\nThe gaps");
  });

  it("highlights an anchor across a soft line break, rendered as \\n or as <br>", () => {
    const source = "> [!note]\n> first line\n> second line";
    expect(highlighted(source, "line\n> second", { title: "Note", content: "first line\nsecond line" })).toBe("line\nsecond");
    expect(highlighted(source, "line\n> second", { title: "Note", content: "first linesecond line" })).toBe("linesecond");
  });

  it("highlights an anchor spanning list items", () => {
    const source = "> [!note]\n> - alpha item\n> - [ ] beta item\n> 2. gamma item";
    const rendered = { title: "Note", content: "alpha itembeta itemgamma item" };
    expect(highlighted(source, "item\n> - [ ] beta", rendered)).toBe("itembeta");
    expect(highlighted(source, "item\n> 2. gamma", rendered)).toBe("itemgamma");
  });

  it("treats a dash inside a line as text, not as a list marker", () => {
    expect(highlighted("> [!note]\n> a - b", "- b", { title: "Note", content: "a - b" })).toBe("- b");
  });

  it("treats an anchor right after a list marker as starting the line", () => {
    expect(highlighted("> [!note]\n> - alpha", "alpha", { title: "Note", content: "alpha" })).toBe("alpha");
  });

  it("returns null when the rendered text does not contain the anchor", () => {
    expect(highlighted(CALLOUT, "the gaps are known", { title: "Answered in part", content: "" })).toBeNull();
  });
});
