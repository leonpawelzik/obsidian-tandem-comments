import { describe, expect, it } from "vitest";
import { countHiddenComments, parseDocument, serializeDocument } from "../src/store";
import type { CommentMap } from "../src/types";

const F = "```";
const entries = (...ids: string[]): CommentMap =>
  Object.fromEntries(ids.map((id) => [id, {
    anchor: { exact: "text" }, status: "open" as const,
    thread: [{ author: "Leon", ts: "2026-11-25T10:00:00Z", text: "Note " + id }],
  }]));
const block = (map: unknown): string => `${F}tandem-comments\n${JSON.stringify(map, null, 2)}\n${F}\n`;
const hidden = (raw: string): number => countHiddenComments(parseDocument(raw).prose);

describe("comments in blocks other than the last one", () => {
  it.each([true, false])("are counted when a tool appends a second block (schema hint %s)", (hint) => {
    const raw = serializeDocument({ prose: "Some text.\n", comments: entries("a", "b") }, hint) + "\n" + block(entries("c"));
    expect(Object.keys(parseDocument(raw).comments)).toEqual(["c"]);
    expect(hidden(raw)).toBe(2);
  });

  it("are counted across several blocks, also when the first one starts the file", () => {
    expect(hidden(block(entries("a")) + "Text\n" + block(entries("b", "c")) + block(entries("d")))).toBe(3);
  });

  it("are none in a note with one block, no block or an empty extra block", () => {
    expect(hidden("Some text.\n" + block(entries("a")))).toBe(0);
    expect(hidden("Some text.\n")).toBe(0);
    expect(hidden("Some text.\n" + block({}) + block(entries("a")))).toBe(0);
  });

  it.each([
    ["a longer fence", `${F}${F}markdown\n${block(entries("a"))}${F}${F}\n`],
    ["a longer fence with several examples", `${F}${F}markdown\n${block(entries("a"))}${block(entries("b"))}${F}${F}\n`],
    ["a longer fence that a labelled line does not close", `${F}${F}\n${F}${F}text\n${block(entries("a"))}${F}${F}\n`],
    ["a tilde fence", `~~~\n${block(entries("a"))}~~~\n`],
    ["an unclosed fence of another kind", `~~~\nno end\n${block(entries("a"))}`],
  ])("ignore examples inside %s", (_, example) => {
    expect(hidden("Docs:\n\n" + example + "\n" + block(entries("z")))).toBe(0);
  });

  it("are found after an ordinary code block", () => {
    expect(hidden(`${F}js\nlet a;\n${F}\n${block(entries("a"))}${block(entries("z"))}`)).toBe(1);
  });

  it.each([
    ["broken JSON", `${F}tandem-comments\n{ "a": \n${F}\n`],
    ["a shape that is no comment", block({ "<id>": "anchor", other: null, list: [], half: { anchor: {} } })],
    ["another language with the same prefix", block(entries("a")).replace("comments", "comments-import")],
  ])("leave out %s", (_, other) => {
    expect(hidden(other + block(entries("y")) + block(entries("z")))).toBe(1);
  });
});
