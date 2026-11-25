import { describe, expect, it } from "vitest";
import { findCallouts } from "../src/callout-highlight";
import { findTables } from "../src/table-highlight";
import { highlightSignature } from "../src/widget-highlight";

const DOC = "Intro.\n\n> [!note] T\n> first price, second price\n\n| a |\n| - |\n| cell |\n\nProse end.";

function signatureOf(text: string, needles: [string, number?][]) {
  const anchors = needles.map(([needle, nth = 0], i) => {
    let from = text.indexOf(needle);
    for (let k = 0; k < nth; k++) from = text.indexOf(needle, from + 1);
    return { id: `c${i}`, from, to: from + needle.length };
  });
  return highlightSignature(anchors, text, findTables(text), findCallouts(text));
}

describe("highlightSignature", () => {
  it("stays the same when text is typed before the widgets", () => {
    const needles: [string][] = [["first"], ["cell"]];
    expect(signatureOf("xyz " + DOC, needles)).toBe(signatureOf(DOC, needles));
  });

  it("ignores anchors outside of tables and callouts", () => {
    expect(signatureOf(DOC, [["first"], ["Prose"]])).toBe(signatureOf(DOC, [["first"]]));
  });

  it("changes when an anchor moves within its callout, changes text or is removed", () => {
    const base = signatureOf(DOC, [["price"]]);
    expect(signatureOf(DOC, [["price", 1]])).not.toBe(base);
    expect(signatureOf(DOC, [["price,"]])).not.toBe(base);
    expect(signatureOf(DOC, [])).not.toBe(base);
  });
});
