import { describe, expect, it, vi } from "vitest";
import { fixture } from "./editor-harness";
import type { ResolvedComment } from "../src/types";

vi.mock("obsidian", () => ({
  ItemView: class {
    children = new Set();
    addChild(child: unknown) { this.children.add(child); return child; }
    removeChild(child: unknown) { this.children.delete(child); }
  }, Component: class {}, Modal: class {}, TFile: class {}, WorkspaceLeaf: class {},
  MarkdownRenderer: { render: vi.fn() }, Keymap: {}, Menu: class {}, Notice: class {},
  setIcon: vi.fn(), setTooltip: vi.fn(),
}));
import { CommentSidebar } from "../src/sidebar";

// A small structural DOM, with the actual scheduler, diff, sorting and lifecycle.
class Container {
  scrollTop = 0;
  label = "";
  editing = false;
  parent: Container | null = null;
  children: Container[] = [];
  ownerDocument = { createElement: () => new Container() };
  get firstChild(): Container | null { return this.children[0] ?? null; }
  get nextSibling(): Container | null {
    return this.parent?.children[this.parent.children.indexOf(this) + 1] ?? null;
  }
  get isConnected(): boolean { return this.parent !== null; }
  classes = new Set<string>();
  addClass(cls: string) { this.classes.add(cls); }
  removeClass(cls: string) { this.classes.delete(cls); }
  scrollIntoView() {}
  querySelector() { return this.editing ? {} : null; }
  createDiv() { const node = new Container(); this.insertBefore(node, null); return node; }
  createSpan() { return {}; } createEl() { return {}; }
  insertBefore(node: Container, cursor: Container | null) {
    node.parent?.removeChild(node);
    this.children.splice(cursor ? this.children.indexOf(cursor) : this.children.length, 0, node);
    node.parent = this;
  }
  removeChild(node: Container) { this.children.splice(this.children.indexOf(node), 1); node.parent = null; }
  get cards() { return this.children.filter((node) => node.label); }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function sidebarHarness() {
  const container = new Container();
  let file = { path: "A.md", extension: "md" };
  const plugin = { settings: { sidebarSortOrder: "document" }, readDoc: vi.fn() };
  const sidebar = new CommentSidebar({} as never, plugin as never);
  const renderCard = vi.fn((target: Container, source: { path: string }, comment: ResolvedComment) => {
    const card = target.createDiv(); card.label = `${source.path}:${comment.id}`; return card;
  });
  Object.assign(sidebar, { contentEl: container,
    app: { workspace: { getActiveFile: () => file } }, renderComment: renderCard });
  return { sidebar, container, plugin, renderCard, switchFile: () => { file = { path: "B.md", extension: "md" }; } };
}

describe("sidebar refresh contracts", () => {
  it("coalesces synchronous refresh bursts into one read and one card per comment", async () => {
    const h = sidebarHarness(); h.plugin.readDoc.mockResolvedValue(fixture(4_000, 8));
    await Promise.all(Array.from({ length: 5 }, () => h.sidebar.render()));
    expect(h.plugin.readDoc).toHaveBeenCalledTimes(1);
    expect(h.container.cards).toHaveLength(8);
  });

  it("discards stale overlapping reads without duplicate cards", async () => {
    const h = sidebarHarness(), doc = fixture(4_000, 8), slow = deferred<typeof doc>();
    h.plugin.readDoc.mockReturnValueOnce(slow.promise).mockResolvedValue(doc);
    const first = h.sidebar.render(); await Promise.resolve();
    await h.sidebar.render(); slow.resolve(doc); await first;
    expect(h.container.cards).toHaveLength(8);
    expect(h.renderCard).toHaveBeenCalledTimes(8);
  });

  it("discards late file-A reads after switching to B", async () => {
    const h = sidebarHarness(), doc = fixture(4_000, 8), slow = deferred<typeof doc>();
    h.plugin.readDoc.mockReturnValueOnce(slow.promise).mockResolvedValue(doc);
    const first = h.sidebar.render(); await Promise.resolve(); h.switchFile();
    await h.sidebar.render(); slow.resolve(doc); await first;
    expect(h.container.cards.every((node) => node.label.startsWith("B.md:"))).toBe(true);
  });

  it("does not commit a pending read after close", async () => {
    const h = sidebarHarness(), doc = fixture(4_000, 8), slow = deferred<typeof doc>();
    h.plugin.readDoc.mockReturnValue(slow.promise);
    const first = h.sidebar.render(); await Promise.resolve(); await h.sidebar.onClose();
    slow.resolve(doc); await first;
    expect(h.renderCard).not.toHaveBeenCalled();
  });

  it("reuses unchanged cards and focusing does no read or render", async () => {
    const h = sidebarHarness(), doc = fixture(4_000, 8);
    h.plugin.readDoc.mockResolvedValue(doc); await h.sidebar.render();
    const cards = h.container.cards;
    await h.sidebar.render(); h.sidebar.focusComment("c0");
    expect(h.container.cards).toEqual(cards);
    expect(h.renderCard).toHaveBeenCalledTimes(8);
    expect(h.plugin.readDoc).toHaveBeenCalledTimes(2);
  });

  it("rebuilds only changed cards and releases removed card components", async () => {
    const h = sidebarHarness(), doc = fixture(4_000, 8);
    h.plugin.readDoc.mockResolvedValue(doc); await h.sidebar.render();
    const changed = structuredClone(doc); changed.comments.c0.thread[0].text = "Edited";
    delete changed.comments.c1;
    h.plugin.readDoc.mockResolvedValue(changed); await h.sidebar.render();
    expect(h.renderCard).toHaveBeenCalledTimes(9);
    expect(h.container.cards).toHaveLength(7);
    expect((h.sidebar as unknown as { children: Set<unknown> }).children.size).toBe(7);
    await h.sidebar.onClose();
    expect((h.sidebar as unknown as { children: Set<unknown> }).children.size).toBe(0);
  });
  it("clears a focus highlight on the next refresh without rebuilding cards", async () => {
    const h = sidebarHarness(); h.plugin.readDoc.mockResolvedValue(fixture(4000, 8));
    await h.sidebar.render(); h.sidebar.focusComment("c0");
    expect(h.container.cards[0].classes.has("tc-focused")).toBe(true);
    await h.sidebar.render();
    expect(h.container.cards.some(card => card.classes.has("tc-focused"))).toBe(false);
    expect(h.renderCard).toHaveBeenCalledTimes(8);
  });

  it("focuses a newly rendered card without leaving the old cached card focused", async () => {
    const h = sidebarHarness(), doc = fixture(4000, 8);
    delete doc.comments.c7;
    h.plugin.readDoc.mockResolvedValue(doc); await h.sidebar.render();
    h.sidebar.focusComment("c0");
    h.plugin.readDoc.mockResolvedValue(fixture(4000, 8));
    h.sidebar.focusComment("c7"); await h.sidebar.render();
    expect(h.container.cards.filter(card => card.classes.has("tc-focused")).map(card => card.label)).toEqual(["A.md:c7"]);
  });

});
