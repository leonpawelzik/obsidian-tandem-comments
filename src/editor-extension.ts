import { Annotation, RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import type CommentsPlugin from "./main";
import { isFullReplace, mapAnchors, type TrackedAnchor } from "./reanchor";
import { makeAnchor, parseDocument, resolveAnchor, serializeDocument } from "./store";

/** Markiert Transaktionen, die das Plugin selbst dispatcht (Block-Rewrite). */
export const selfEdit = Annotation.define<boolean>();

const REANCHOR_DEBOUNCE_MS = 800;

export function buildEditorExtension(plugin: CommentsPlugin) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      anchors: TrackedAnchor[] = [];
      dirty = false;
      timer: number | null = null;

      constructor(readonly view: EditorView) {
        this.syncFromDoc(view.state.doc.toString());
        this.decorations = this.buildDecorations();
      }

      destroy(): void {
        if (this.timer !== null) window.clearTimeout(this.timer);
      }

      syncFromDoc(text: string): void {
        const doc = parseDocument(text);
        this.anchors = [];
        this.dirty = false;
        if (doc.error) return;
        for (const [id, c] of Object.entries(doc.comments)) {
          if (c.status === "resolved") continue;
          const r = resolveAnchor(doc.prose, c.anchor);
          if (r.kind === "resolved") this.anchors.push({ id, from: r.start, to: r.end });
        }
        this.anchors.sort((a, b) => a.from - b.from);
      }

      update(u: ViewUpdate): void {
        if (!u.docChanged) return;
        const text = u.state.doc.toString();
        const isSelf = u.transactions.some((tr) => tr.annotation(selfEdit));
        if (isSelf || isFullReplace(u.changes)) {
          this.syncFromDoc(text);
        } else {
          // Block-only-Edit (z.B. Sidebar-Write, Hand-Edit des JSON)?
          let minFrom = Infinity;
          u.changes.iterChangedRanges((_fromA, _toA, fromB) => {
            minFrom = Math.min(minFrom, fromB);
          });
          const proseLen = parseDocument(text).prose.length;
          if (minFrom >= proseLen) {
            this.syncFromDoc(text);
          } else {
            this.anchors = mapAnchors(this.anchors, u.changes);
            this.dirty = true;
            this.scheduleReanchor();
          }
        }
        this.decorations = this.buildDecorations();
      }

      buildDecorations(): DecorationSet {
        const b = new RangeSetBuilder<Decoration>();
        const len = this.view.state.doc.length;
        for (const a of this.anchors) {
          if (a.from >= a.to || a.to > len) continue;
          b.add(a.from, a.to, Decoration.mark({ class: "tc-highlight", attributes: { "data-tc-id": a.id } }));
        }
        return b.finish();
      }

      scheduleReanchor(): void {
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => {
          this.timer = null;
          this.performReanchor();
        }, REANCHOR_DEBOUNCE_MS);
      }

      /**
       * Schreibt nach editierter Prosa die aktuellen Zitate/Kontexte der noch
       * lebenden Anker zurück in den Block (nur die Block-Region wird ersetzt).
       */
      performReanchor(): void {
        if (!this.dirty) return;
        this.dirty = false;
        const text = this.view.state.doc.toString();
        const doc = parseDocument(text);
        if (doc.error || Object.keys(doc.comments).length === 0) return;
        let changed = false;
        for (const t of this.anchors) {
          const c = doc.comments[t.id];
          if (!c || c.status === "resolved") continue;
          if (t.to > doc.prose.length) continue;
          const next = makeAnchor(doc.prose, t.from, t.to);
          const cur = c.anchor;
          if (
            next.exact !== cur.exact ||
            next.prefix !== cur.prefix ||
            next.suffix !== cur.suffix ||
            next.pos !== cur.pos
          ) {
            c.anchor = next;
            changed = true;
          }
        }
        if (!changed) return;
        const serialized = serializeDocument(doc, plugin.settings.schemaHint);
        this.view.dispatch({
          changes: { from: doc.prose.length, to: text.length, insert: serialized.slice(doc.prose.length) },
          annotations: selfEdit.of(true),
        });
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(e: MouseEvent) {
          const target = e.target as HTMLElement;
          const el = target.closest?.(".tc-highlight");
          if (!el) return false;
          const id = el.getAttribute("data-tc-id");
          if (id) void plugin.openSidebar(id);
          return false;
        },
      },
    }
  );
}
