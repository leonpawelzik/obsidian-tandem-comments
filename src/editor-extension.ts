import { Annotation, RangeSetBuilder, Transaction } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import type CommentsPlugin from "./main";
import {
  changesTouchCommentBlock,
  isFullReplace,
  mapAnchors,
  mergePendingAnchors,
  shouldPreservePendingAnchors,
  type TrackedAnchor,
} from "./reanchor";
import { makeAnchor, normalizeTrailingChanges, parseDocument, resolveAnchor, serializeDocument } from "./store";
import { applyTableHighlights, rangesTouchTable } from "./table-highlight";

/** Markiert Transaktionen, die das Plugin selbst dispatcht (Block-Rewrite). */
export const selfEdit = Annotation.define<boolean>();

const REANCHOR_DEBOUNCE_MS = 800;
const NORMALIZE_DEBOUNCE_MS = 500;

export interface EditorExtensionHost {
  settings: { schemaHint: boolean };
  isApplyingSuggestion(): boolean;
  openSidebar(id?: string): unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      timer: number | null = null;
      normalizeTimer: number | null = null;

      constructor(readonly view: EditorView) {
        this.syncFromDoc(view.state.doc.toString());
        this.decorations = this.buildDecorations();
        this.scheduleTableHighlight();
        this.scheduleNormalize();
      }

      destroy(): void {
        if (this.timer !== null) window.clearTimeout(this.timer);
        if (this.normalizeTimer !== null) window.clearTimeout(this.normalizeTimer);
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
        // Tabellen-Widgets entstehen/verschwinden auch bei Selektions- und
        // Viewport-Wechseln (Cursor rein/raus), nicht nur bei Doc-Änderungen.
        if (u.docChanged || u.selectionSet || u.viewportChanged) this.scheduleTableHighlight();
        if (!u.docChanged) return;
        this.scheduleNormalize();
        const text = u.state.doc.toString();
        const isSelf = u.transactions.some((tr) => tr.annotation(selfEdit));
        const oldText = u.startState.doc.toString();
        const oldProseLen = parseDocument(oldText).prose.length;
        const newProseLen = parseDocument(text).prose.length;
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
        if (isSelf || fullReplace || touchesBlock) {
          this.syncFromDoc(text);
          if (pending.length > 0) {
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
                this.scheduleReanchor();
              }
            }
          }
        } else {
          const ranges: { from: number; to: number }[] = [];
          u.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
            ranges.push({ from: fromB, to: toB });
          });
          if (rangesTouchTable(text, newProseLen, ranges)) {
            // Tabellen-Edit: Positionen durch die Änderung mappen (Anker folgen
            // echten Text-Edits wie in Prosa). Anker, die bei Obsidians Tabellen-
            // Neuformatierung (Ganz-Block-Replace) kollabieren, per exaktem Text
            // wiederherstellen statt sie zu verlieren. performReanchor schreibt nur
            // um, wenn der exact-Text wirklich weg ist — schützt vor Korruption.
            const mapped = mapAnchors(this.anchors, u.changes);
            const survived = new Set(mapped.map((a) => a.id));
            this.anchors = mapped;
            const doc = parseDocument(text);
            for (const [id, c] of Object.entries(doc.comments)) {
              if (c.status === "resolved" || survived.has(id)) continue;
              const r = resolveAnchor(doc.prose, c.anchor);
              if (r.kind === "resolved") this.anchors.push({ id, from: r.start, to: r.end });
            }
            this.anchors.sort((a, b) => a.from - b.from);
            this.dirty = true;
            this.scheduleReanchor();
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

      /**
       * Highlights innerhalb gerenderter Tabellen-Widgets müssen direkt ins DOM
       * geschrieben werden (CM-mark-Dekorationen werden dort verschluckt). Das
       * läuft in der Measure-/Write-Phase, nachdem Obsidian die Widgets gebaut hat.
       */
      scheduleTableHighlight(): void {
        this.view.requestMeasure({
          key: "tc-table-highlight",
          read: () => null,
          write: () => {
            const text = this.view.state.doc.toString();
            const proseLen = parseDocument(text).prose.length;
            applyTableHighlights(this.view, this.anchors, text, proseLen, (id) => void plugin.openSidebar(id));
          },
        });
      }

      scheduleNormalize(): void {
        if (this.normalizeTimer !== null) window.clearTimeout(this.normalizeTimer);
        this.normalizeTimer = window.setTimeout(() => {
          this.normalizeTimer = null;
          this.performNormalize();
        }, NORMALIZE_DEBOUNCE_MS);
      }

      /**
       * Faltet Inhalt hinter dem Block (getippte Prosa, Fußnoten-Definitionen)
       * zurück vor den Block, damit der Block das letzte Element der Datei bleibt —
       * sonst landet der Text im nicht kommentierbaren trailing-Bereich.
       */
      performNormalize(): void {
        // Ausstehendes Reanchor zuerst verarbeiten: syncFromDoc (via update()) baut
        // die Anker sonst aus dem noch nicht umgeschriebenen Block neu auf und der
        // gerade bearbeitete Anker geht verloren, das spätere Reanchor no-opt dann.
        if (this.dirty) this.performReanchor();
        const text = this.view.state.doc.toString();
        const changes = normalizeTrailingChanges(text, parseDocument(text));
        if (!changes) return;
        this.view.dispatch({
          changes,
          annotations: [selfEdit.of(true), Transaction.addToHistory.of(false)],
        });
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
          const cur = c.anchor;
          // Nur umschreiben, wenn der bisherige exact-Text nicht mehr auffindbar
          // ist (= echte Bearbeitung des Zitats). Ist er noch da, war die Änderung
          // nur drumherum (z.B. Obsidians Tabellen-Neuformatierung) — ein Rewrite
          // aus evtl. verschobenen Positionen würde den Anker korrumpieren.
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
            changed = true;
          }
        }
        if (!changed) return;
        const serialized = serializeDocument(doc, plugin.settings.schemaHint);
        this.view.dispatch({
          changes: { from: doc.prose.length, to: text.length, insert: serialized.slice(doc.prose.length) },
          annotations: [selfEdit.of(true), Transaction.addToHistory.of(false)],
        });
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
