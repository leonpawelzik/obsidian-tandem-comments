import { Annotation, RangeSetBuilder, Transaction } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import type CommentsPlugin from "./main";
import {
  recordDecorationMap,
  recordDecorationRebuild,
  recordParse,
  recordPersist,
  recordTable,
  recordUpdate,
} from "./perf";
import {
  changesTouchCommentBlock,
  isFullReplace,
  mapAnchors,
  mergePendingAnchors,
  shouldPreservePendingAnchors,
  type TrackedAnchor,
} from "./reanchor";
import {
  makeAnchor,
  normalizeTrailingChanges,
  parseDocument,
  proseEndOf,
  resolveAnchor,
  serializeDocument,
} from "./store";
import { applyTableHighlights, clearTableHighlights, findTables, rangesTouchTable } from "./table-highlight";

/** Markiert Transaktionen, die das Plugin selbst dispatcht (Block-Rewrite). */
export const selfEdit = Annotation.define<boolean>();

/** L2 persist: reanchor + trailing normalize in one debounced dispatch. */
const PERSIST_DEBOUNCE_MS = 800;

export interface EditorExtensionHost {
  settings: { schemaHint: boolean; debugPerf?: boolean };
  isApplyingSuggestion(): boolean;
  openSidebar(id?: string): unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOpenSuggestion(value: unknown): boolean {
  if (!isObject(value) || value.status !== "open") return false;
  const suggestion = value.suggestion;
  return isObject(suggestion) && suggestion.result == null;
}

function isAcceptedSuggestion(value: unknown): boolean {
  if (!isObject(value) || value.status !== "resolved") return false;
  const suggestion = value.suggestion;
  return isObject(suggestion) && suggestion.result === "accepted";
}

/**
 * Detects Undo/Redo transitions across an accepted suggestion from document
 * semantics rather than change-range shape. End-of-prose acceptance may be
 * coalesced into a single large range, indistinguishable from a full replace.
 */
export function isSuggestionAcceptanceHistoryUpdate(u: ViewUpdate, oldText: string, text: string): boolean {
  if (!u.transactions.some((tr) => tr.isUserEvent("undo") || tr.isUserEvent("redo"))) return false;
  recordParse();
  recordParse();
  const oldDoc = parseDocument(oldText);
  const newDoc = parseDocument(text);
  if (oldDoc.error || newDoc.error || oldDoc.prose === newDoc.prose) return false;
  const ids = new Set([...Object.keys(oldDoc.comments), ...Object.keys(newDoc.comments)]);
  for (const id of ids) {
    const before = oldDoc.comments[id];
    const after = newDoc.comments[id];
    if (
      (isOpenSuggestion(before) && (after === undefined || isAcceptedSuggestion(after))) ||
      (isOpenSuggestion(after) && (before === undefined || isAcceptedSuggestion(before)))
    ) {
      return true;
    }
  }
  return false;
}

function editorAnchorTrackerClass(plugin: EditorExtensionHost) {
  return (
    class {
      decorations: DecorationSet;
      anchors: TrackedAnchor[] = [];
      dirty = false;
      persistTimer: number | null = null;
      /**
       * Sticky table presence for the current doc generation.
       * null = unknown (rescan on next table work); false = skip DOM path;
       * true = selection/viewport may refresh table highlights.
       */
      hasTables: boolean | null = null;

      constructor(readonly view: EditorView) {
        this.syncFromDoc(view.state.doc.toString());
        this.decorations = this.buildDecorations();
        this.scheduleTableHighlight();
        this.schedulePersist();
      }

      destroy(): void {
        if (this.persistTimer !== null) window.clearTimeout(this.persistTimer);
      }

      syncFromDoc(text: string): void {
        recordParse();
        const doc = parseDocument(text);
        this.anchors = [];
        this.dirty = false;
        this.hasTables = null;
        if (doc.error) return;
        for (const [id, c] of Object.entries(doc.comments)) {
          if (c.status === "resolved") continue;
          const r = resolveAnchor(doc.prose, c.anchor);
          if (r.kind === "resolved") this.anchors.push({ id, from: r.start, to: r.end });
        }
        this.anchors.sort((a, b) => a.from - b.from);
      }

      /** Table DOM work only when anchors exist and we have not proven absence of tables. */
      private shouldRefreshTableHighlights(reason: "doc" | "selection"): boolean {
        if (this.anchors.length === 0) return false;
        if (this.hasTables === false) return false;
        if (reason === "selection" && this.hasTables !== true) return false;
        return true;
      }

      private rebuildDecorations(): void {
        this.decorations = this.buildDecorations();
        recordDecorationRebuild();
      }

      /** Map existing marks through the transaction when only positions moved (same id set). */
      private mapDecorations(u: ViewUpdate): void {
        this.decorations = this.decorations.map(u.changes);
        recordDecorationMap();
      }

      update(u: ViewUpdate): void {
        if (!u.docChanged) {
          if (
            (u.selectionSet || u.viewportChanged) &&
            this.shouldRefreshTableHighlights("selection")
          ) {
            this.scheduleTableHighlight();
          }
          return;
        }

        const t0 = performance.now();
        this.hasTables = null;
        this.schedulePersist();

        // L0: materialize doc strings once per transaction; prose lengths without JSON.
        const text = u.state.doc.toString();
        const oldText = u.startState.doc.toString();
        const oldProseLen = proseEndOf(oldText);
        const newProseLen = proseEndOf(text);

        const isSelf = u.transactions.some((tr) => tr.annotation(selfEdit));
        const fullReplace = isFullReplace(u.changes);
        const touchesBlock = changesTouchCommentBlock(u.changes, oldProseLen, newProseLen);
        const acceptanceHistory = isSuggestionAcceptanceHistoryUpdate(u, oldText, text);
        const preservePending = shouldPreservePendingAnchors(
          u.changes,
          oldProseLen,
          plugin.isApplyingSuggestion() || acceptanceHistory
        );
        const pending =
          (this.dirty || acceptanceHistory) && touchesBlock && preservePending
            ? mapAnchors(this.anchors, u.changes).filter((anchor) => anchor.to <= newProseLen)
            : [];

        /** true → decorations rebuilt from anchors; false → mapped through changes. */
        let rebuildDeco = true;

        if (isSelf || fullReplace || touchesBlock) {
          this.syncFromDoc(text);
          if (pending.length > 0) {
            recordParse();
            const doc = parseDocument(text);
            if (!doc.error) {
              const recoverable = new Set(
                Object.entries(doc.comments)
                  .filter(
                    ([, comment]) =>
                      comment.status === "open" &&
                      resolveAnchor(doc.prose, comment.anchor).kind === "orphaned"
                  )
                  .map(([id]) => id)
              );
              const merged = mergePendingAnchors(this.anchors, pending, recoverable);
              if (merged.length > this.anchors.length) {
                this.anchors = merged;
                this.dirty = true;
                this.schedulePersist();
              }
            }
          }
        } else {
          const ranges: { from: number; to: number }[] = [];
          u.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
            ranges.push({ from: fromB, to: toB });
          });
          const touchTable =
            this.hasTables !== false && rangesTouchTable(text, newProseLen, ranges);
          if (touchTable) {
            this.hasTables = true;
            const mapped = mapAnchors(this.anchors, u.changes);
            const survived = new Set(mapped.map((a) => a.id));
            this.anchors = mapped;
            recordParse();
            const doc = parseDocument(text);
            for (const [id, c] of Object.entries(doc.comments)) {
              if (c.status === "resolved" || survived.has(id)) continue;
              const r = resolveAnchor(doc.prose, c.anchor);
              if (r.kind === "resolved") this.anchors.push({ id, from: r.start, to: r.end });
            }
            this.anchors.sort((a, b) => a.from - b.from);
            this.dirty = true;
            this.schedulePersist();
          } else {
            // Pure prose map: same id set, positions follow ChangeSet — map marks in place.
            this.anchors = mapAnchors(this.anchors, u.changes);
            this.dirty = true;
            this.schedulePersist();
            this.mapDecorations(u);
            rebuildDeco = false;
          }
        }

        if (rebuildDeco) this.rebuildDecorations();

        if (this.shouldRefreshTableHighlights("doc")) this.scheduleTableHighlight();
        else if (this.anchors.length === 0) {
          this.view.requestMeasure({
            key: "tc-table-highlight",
            read: () => null,
            write: () => clearTableHighlights(this.view),
          });
        }

        recordUpdate(performance.now() - t0);
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

      /**
       * Highlights innerhalb gerenderter Tabellen-Widgets müssen direkt ins DOM
       * geschrieben werden (CM-mark-Dekorationen werden dort verschluckt).
       */
      scheduleTableHighlight(): void {
        this.view.requestMeasure({
          key: "tc-table-highlight",
          read: () => null,
          write: () => {
            const t0 = performance.now();
            if (this.anchors.length === 0) {
              clearTableHighlights(this.view);
              recordTable(performance.now() - t0);
              return;
            }
            const text = this.view.state.doc.toString();
            const proseLen = proseEndOf(text);
            if (this.hasTables !== true) {
              const tables = findTables(text, proseLen);
              this.hasTables = tables.length > 0;
              if (!this.hasTables) {
                clearTableHighlights(this.view);
                recordTable(performance.now() - t0);
                return;
              }
            }
            applyTableHighlights(this.view, this.anchors, text, proseLen, (id) => void plugin.openSidebar(id));
            recordTable(performance.now() - t0);
          },
        });
      }

      schedulePersist(): void {
        if (this.persistTimer !== null) window.clearTimeout(this.persistTimer);
        this.persistTimer = window.setTimeout(() => {
          this.persistTimer = null;
          this.performPersist();
        }, PERSIST_DEBOUNCE_MS);
      }

      /**
       * L2: rewrite stale quote anchors and fold trailing content back before the
       * fence in a single selfEdit transaction (reanchor + normalize coalesced).
       */
      performPersist(): void {
        const t0 = performance.now();
        const original = this.view.state.doc.toString();
        let text = original;
        recordParse();
        let doc = parseDocument(text);
        if (doc.error) {
          this.dirty = false;
          recordPersist(performance.now() - t0);
          return;
        }

        let blockChanged = false;
        if (this.dirty) {
          this.dirty = false;
          if (Object.keys(doc.comments).length > 0) {
            for (const t of this.anchors) {
              const c = doc.comments[t.id];
              if (!c || c.status === "resolved") continue;
              if (t.to > doc.prose.length) continue;
              const cur = c.anchor;
              if (resolveAnchor(doc.prose, cur).kind === "resolved") continue;
              const next = makeAnchor(doc.prose, t.from, t.to);
              if (
                next.exact &&
                (next.exact !== cur.exact ||
                  next.prefix !== cur.prefix ||
                  next.suffix !== cur.suffix ||
                  next.pos !== cur.pos)
              ) {
                c.anchor = next;
                blockChanged = true;
              }
            }
          }
        }

        if (blockChanged) {
          text = serializeDocument(doc, plugin.settings.schemaHint);
          recordParse();
          doc = parseDocument(text);
        }

        const norm = normalizeTrailingChanges(text, doc);
        if (!blockChanged && !norm) {
          recordPersist(performance.now() - t0);
          return;
        }

        const changes: { from: number; to: number; insert: string }[] = [];
        if (blockChanged) {
          const proseLen = proseEndOf(original);
          changes.push({
            from: proseLen,
            to: original.length,
            insert: text.slice(proseEndOf(text)),
          });
        }
        if (norm) changes.push(...norm);

        this.view.dispatch({
          changes,
          annotations: [selfEdit.of(true), Transaction.addToHistory.of(false)],
        });
        recordPersist(performance.now() - t0);
      }
    }
  );
}

export function createEditorAnchorTracker(view: EditorView, plugin: EditorExtensionHost) {
  const Tracker = editorAnchorTrackerClass(plugin);
  return new Tracker(view);
}

export function buildEditorExtension(plugin: CommentsPlugin) {
  return ViewPlugin.fromClass(editorAnchorTrackerClass(plugin), {
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
  });
}
