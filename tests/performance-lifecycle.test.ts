import { Transaction } from "@codemirror/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Harness, fixture } from "./editor-harness";
import { makeAnchor, parseDocument, planSuggestionAcceptance, resolveAnchor, serializeDocument } from "../src/store";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("performance overhaul: editor lifecycle contracts", () => {
  it("coalesces a 100-keystroke quote edit into one persisted block rewrite", () => {
    const h = new Harness(fixture(10_000, 20).raw);
    const pos = h.tracker.anchors[0].from + 2;
    for (let i = 0; i < 100; i++) {
      h.apply({ changes: { from: pos, to: pos + 1, insert: i % 2 ? "Y" : "X" }, userEvent: "input" });
      h.measure();
      vi.advanceTimersByTime(50);
      expect(h.dispatches).toHaveLength(0);
    }
    vi.advanceTimersByTime(2_000);
    expect(h.dispatches).toHaveLength(1);
    const doc = parseDocument(h.view.state.doc.toString());
    expect(doc.comments.c0.anchor.exact).toContain("Y");
    expect(resolveAnchor(doc.prose, doc.comments.c0.anchor).kind).toBe("resolved");
    expect(vi.getTimerCount()).toBe(0);
    h.tracker.destroy();
  });

  it("does not write unchanged comment data after typing outside quotes", () => {
    const h = new Harness(fixture(10_000, 20).raw);
    for (let i = 0; i < 30; i++) { h.type(true); vi.advanceTimersByTime(40); }
    vi.advanceTimersByTime(2_000);
    expect(h.dispatches).toHaveLength(0);
    expect(h.tracker.dirty).toBe(false);
    h.tracker.destroy();
  });

  it("cancels pending callbacks when an editor is destroyed", () => {
    const h = new Harness(fixture(10_000, 20).raw);
    h.type();
    h.tracker.destroy();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(h.dispatches).toHaveLength(0);
  });

  it("does not accumulate timers over 100 editor open/edit/close cycles", () => {
    const raw = fixture(4_000, 8).raw;
    for (let i = 0; i < 100; i++) {
      const h = new Harness(raw);
      h.type(); h.tracker.destroy();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("preserves the edited quote on reopen when closing before debounce", () => {
    const h = new Harness(fixture(10_000, 20).raw);
    const pos = h.tracker.anchors[0].from + 2;
    h.apply({ changes: { from: pos, to: pos + 1, insert: "Z" } });
    // The host persists the edited document; tracker destruction must not leave
    // its anchor metadata stale when that same document is opened again.
    h.tracker.destroy();
    const reopened = new Harness(h.closedText ?? h.view.state.doc.toString());
    try { expect(reopened.tracker.anchors.some(({ id }) => id === "c0")).toBe(true); }
    finally { reopened.tracker.destroy(); }
  });

  it("does not replace an explicitly changed anchor with the previous quote", () => {
    const h = new Harness(fixture(10_000, 20).raw);
    const doc = parseDocument(h.view.state.doc.toString());
    doc.comments.c0.anchor.exact = "deliberately missing";
    const next = serializeDocument(doc, true);
    h.apply({ changes: { from: doc.prose.length, to: h.view.state.doc.length, insert: next.slice(doc.prose.length) } });
    vi.advanceTimersByTime(2000);
    expect(parseDocument(h.view.state.doc.toString()).comments.c0.anchor.exact).toBe("deliberately missing");
    expect(h.tracker.anchors.some(({ id }) => id === "c0")).toBe(false);
    h.tracker.destroy();
  });

  it("keeps two editor instances isolated across comment-block changes", () => {
    const raw = fixture(10_000, 20).raw;
    const a = new Harness(raw), b = new Harness(raw);
    const doc = parseDocument(raw);
    doc.comments.c0.status = "resolved";
    a.apply({ changes: { from: 0, to: a.view.state.doc.length, insert: serializeDocument(doc, true) } });
    a.measure(); b.select();
    expect(a.tracker.anchors.some(({ id }) => id === "c0")).toBe(false);
    expect(b.tracker.anchors.some(({ id }) => id === "c0")).toBe(true);
    expect(b.view.state.doc.toString()).toBe(raw);
    a.tracker.destroy(); b.tracker.destroy();
  });

  it.each(["keep", "remove"] as const)("preserves another edited quote through suggestion acceptance and history (%s)", (behavior) => {
    const doc = fixture(10_000, 20);
    doc.comments.c10.suggestion = { replacement: "new replacement", author: "Reviewer", ts: "2026-09-29T00:00:00Z" };
    const h = new Harness(serializeDocument(doc, true));
    const position = h.tracker.anchors.find(({ id }) => id === "c0")!.from + 2;
    h.apply({ changes: { from: position, to: position + 1, insert: "ZZZ" } });
    const before = h.view.state.doc;
    const plan = planSuggestionAcceptance(before.toString(), "c10", behavior, true);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(plan.reason);
    h.applyingSuggestion = true;
    const accepted = h.apply({ changes: plan.changes });
    h.applyingSuggestion = false;
    // Replay actual inverse coordinates, not a synthetic full-document undo.
    h.apply({ changes: accepted.changes.invert(before), annotations: Transaction.userEvent.of("undo") });
    h.apply({ changes: accepted.changes, annotations: Transaction.userEvent.of("redo") });
    vi.advanceTimersByTime(2_000);
    const after = parseDocument(h.view.state.doc.toString());
    expect(after.comments.c0.anchor.exact).toContain("ZZZ");
    expect(resolveAnchor(after.prose, after.comments.c0.anchor).kind).toBe("resolved");
    expect(after.prose).toContain("new replacement");
    h.tracker.destroy();
  });

  it("preserves UTF-16 anchor positions through emoji and combining-character edits", () => {
    const prose = "Start 😀 café — quoted 中文 passage — ending";
    const from = prose.indexOf("quoted"), to = prose.indexOf(" — ending");
    const h = new Harness(serializeDocument({ prose, comments: { a: {
      anchor: makeAnchor(prose, from, to), status: "open", thread: [],
    } } }, true));
    h.apply({ changes: { from: 6, to: 8, insert: "🌍🌱" } });
    const anchor = h.tracker.anchors[0];
    expect(h.view.state.doc.sliceString(anchor.from, anchor.to)).toBe("quoted 中文 passage");
    h.apply({ changes: { from: anchor.from + 7, to: anchor.from + 9, insert: "日本語" } });
    vi.advanceTimersByTime(2_000);
    const doc = parseDocument(h.view.state.doc.toString());
    expect(doc.comments.a.anchor.exact).toBe("quoted 日本語 passage");
    h.tracker.destroy();
  });

  it("preserves the edited anchor through a single mixed quote+trailing edit", () => {
    const h = new Harness(fixture(10_000, 20).raw);
    const pos = h.tracker.anchors[0].from + 2;
    h.apply({ changes: [{ from: pos, to: pos + 1, insert: "Z" },
      { from: h.view.state.doc.length, insert: "\n[^audit]: Added footnote.\n" }] });
    vi.advanceTimersByTime(2_000);
    const doc = parseDocument(h.view.state.doc.toString());
    expect(doc.error).toBeUndefined();
    expect(doc.trailing).toBeUndefined();
    expect(doc.prose).toContain("[^audit]: Added footnote.");
    expect(doc.comments.c0.anchor.exact).toContain("Z");
    expect(h.dispatches.length).toBeLessThanOrEqual(2);
    h.tracker.destroy();
  });
  it("recovers an orphaned table quote when no other anchors are tracked", () => {
    const doc = fixture(4000, 1, true);
    const exact = doc.comments.c0.anchor.exact;
    const changed = doc.prose.replace(exact, "missing");
    const h = new Harness(serializeDocument({ ...doc, prose: changed }, true));
    expect(h.tracker.anchors).toHaveLength(0);
    const from = changed.indexOf("missing");
    h.apply({ changes: { from, to: from + "missing".length, insert: exact } });
    expect(h.tracker.anchors.map(({ id }) => id)).toEqual(["c0"]);
    h.tracker.destroy();
  });

});
