import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocumentReader, makeAnchor, parseDocument, resolveAnchor } from "../src/store";
import type { Anchor, AnchorResolution } from "../src/types";
import { Harness, fixture } from "./editor-harness";

// The pre-optimization exhaustive semantics, retained as a differential oracle.
function reference(prose: string, anchor: Anchor): AnchorResolution {
  if (!anchor.exact) return { kind: "orphaned" };
  let hits: number[] = [];
  for (let at = prose.indexOf(anchor.exact); at !== -1; at = prose.indexOf(anchor.exact, at + 1)) hits.push(at);
  if (!hits.length) return { kind: "orphaned" };
  if (hits.length > 1) {
    const contextual = hits.filter((at) =>
      (!anchor.prefix || prose.slice(Math.max(0, at - anchor.prefix.length), at) === anchor.prefix) &&
      (!anchor.suffix || prose.slice(at + anchor.exact.length, at + anchor.exact.length + anchor.suffix.length) === anchor.suffix));
    if (contextual.length) hits = contextual;
  }
  const start = hits.reduce((a, b) => anchor.pos != null && Math.abs(b - anchor.pos) < Math.abs(a - anchor.pos) ? b : a);
  return { kind: "resolved", start, end: start + anchor.exact.length, ...(hits.length > 1 ? { ambiguous: true } : {}) };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("performance cache and resolution contracts", () => {
  it("preserves exhaustive resolution for overlaps, stale context, boundaries and UTF-16", () => {
    let seed = 41;
    const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    for (let i = 0; i < 4000; i++) {
      const prose = Array.from({ length: 40 }, () => ["a", "b", "😀", "é"][random(4)]).join("");
      const start = random(prose.length), end = Math.min(start + random(8), prose.length);
      const anchor = makeAnchor(prose, start, end);
      if (i % 2) anchor.prefix = [undefined, "", "missing", "a"][random(4)];
      if (i % 3) anchor.suffix = [undefined, "", "missing", "b"][random(4)];
      anchor.pos = i % 5 ? random(prose.length * 2) - prose.length : undefined;
      expect(resolveAnchor(prose, anchor)).toEqual(reference(prose, anchor));
    }
    for (const anchor of [{ exact: "aa", prefix: "a", suffix: "a", pos: 3 }, { exact: "aa", pos: 1.5 }]) {
      expect(resolveAnchor("aaaaaaa", anchor)).toEqual(reference("aaaaaaa", anchor));
    }
  });

  it("invalidates cached JSON on edits, errors and restores; mutating fresh reads stays isolated", () => {
    const read = createDocumentReader(), raw = fixture(4000, 8).raw;
    for (const next of [raw, "prefix\n" + raw, raw + "\nFootnote", raw.replace('"open"', '"resolved"'),
      raw.replace('"open"', 'invalid'), "just prose", "```tandem-comments\n[]\n```\n", raw]) {
      expect(read(next)).toEqual(parseDocument(next));
    }
    parseDocument(raw).comments.c0.thread[0].text = "changed";
    expect(read(raw)).toEqual(parseDocument(raw));
  });

  it("does no JSON decoding during prose typing and cursor movement after warmup", () => {
    vi.stubGlobal("window", { setTimeout: () => 1, clearTimeout: () => {} });
    const h = new Harness(fixture(4000, 8).raw); h.measure();
    const spy = vi.spyOn(JSON, "parse");
    for (let i = 0; i < 30; i++) { h.type(true); h.select(); }
    expect(spy).not.toHaveBeenCalled();
    h.tracker.destroy();
  });
});
