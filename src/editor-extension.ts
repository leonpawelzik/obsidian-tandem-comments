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
import { createDocumentReader, makeAnchor, normalizeTrailingChanges, parseDocument, resolveAnchor, serializeDocument } from "./store";
import { applyTableHighlights, clearTableHighlights, findTables, rangesTouchTable, type ParsedTable } from "./table-highlight";

/** Markiert Transaktionen, die das Plugin selbst dispatcht (Block-Rewrite). */
export const selfEdit = Annotation.define<boolean>();

const REANCHOR_DEBOUNCE_MS = 800;
const NORMALIZE_DEBOUNCE_MS = 500;

export interface AnchorSaveTarget {
  key: object;
  save(before: string, after: string): void;
}

export interface EditorExtensionHost {
  settings: { schemaHint: boolean };
  isApplyingSuggestion(): boolean;
  openSidebar(id?: string): unknown;
  captureAnchorSave?(view: EditorView, previous?: AnchorSaveTarget): AnchorSaveTarget | undefined;
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
      readDocument = createDocumentReader();
      dirty = false;
      saveOnClose: AnchorSaveTarget | undefined;
      destroyed = false;
      timer: number | null = null;
      normalizeTimer: number | null = null;
      tableDoc: EditorView["state"]["doc"] | null = null;
      tableSnapshot: { text: string; proseLen: number; tables: ParsedTable[] } | null = null;

      tablesFor(text?: string, proseLen?: number) {
        if (this.tableDoc !== this.view.state.doc || !this.tableSnapshot) {
          const raw = text ?? this.view.state.doc.toString();
          const length = proseLen ?? this.readDocument(raw).prose.length;
          this.tableDoc = this.view.state.doc;
          this.tableSnapshot = { text: raw, proseLen: length, tables: findTables(raw, length) };
        }
        return this.tableSnapshot;
      }

      constructor(readonly view: EditorView) {
        this.saveOnClose = plugin.captureAnchorSave?.(view);
        this.syncFromDoc(view.state.doc.toString());
        this.decorations = this.buildDecorations();
        this.scheduleTableHighlight();
        this.scheduleNormalize();
      }

      destroy(): void {
        this.destroyed = true;
        if (this.dirty && this.saveOnClose) {
          const before = this.view.state.doc.toString();
          const after = this.reanchoredText(before);
          if (after) this.saveOnClose.save(before, after);
        }
        if (this.timer !== null) window.clearTimeout(this.timer);
        if (this.normalizeTimer !== null) window.clearTimeout(this.normalizeTimer);
      }

      syncFromDoc(text: string): void {
        const doc = this.readDocument(text);
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
        const target = plugin.captureAnchorSave?.(this.view, this.saveOnClose);
        if (target && target.key !== this.saveOnClose?.key) {
          // Obsidian can reuse the same editor for a different file. Flush the
          // outgoing snapshot using its original file before replacing anchors.
          if (this.dirty && this.saveOnClose) {
            const before = u.startState.doc.toString();
            const after = this.reanchoredText(before);
            if (after) this.saveOnClose.save(before, after);
          }
          this.saveOnClose = target;
        }
        // Tabellen-Widgets entstehen/verschwinden auch bei Selektions- und
        // Viewport-Wechseln (Cursor rein/raus), nicht nur bei Doc-Änderungen.
        if (u.docChanged || u.selectionSet || u.viewportChanged) this.scheduleTableHighlight();
        if (!u.docChanged) return;
        this.scheduleNormalize();
        const text = u.state.doc.toString();
        const isSelf = u.transactions.some((tr) => tr.annotation(selfEdit));
        const oldText = u.startState.doc.toString();
        const oldDoc = this.readDocument(oldText);
        const oldProseLen = oldDoc.prose.length;
        const newDoc = this.readDocument(text);
        const newProseLen = newDoc.prose.length;
        const fullReplace = isFullReplace(u.changes);
        const touchesBlock = changesTouchCommentBlock(u.changes, oldProseLen, newProseLen);
        const acceptanceHistory = isSuggestionAcceptanceHistoryUpdate(u, oldText, text);
        const preservePending = shouldPreservePendingAnchors(
          u.changes,
          oldProseLen,
          plugin.isApplyingSuggestion() || acceptanceHistory
        );
        // Preserve quote edits made in this same transaction, including multi-range
        // sync/AI edits; the stored-anchor check below protects explicit re-anchoring.
        const pending =
          !isSelf && touchesBlock && preservePending
            ? mapAnchors(this.anchors, u.changes).filter((anchor) => anchor.to <= newProseLen)
            : [];
        if (isSelf || fullReplace || touchesBlock) {
          this.syncFromDoc(text);
          if (pending.length > 0) {
            const doc = this.readDocument(text);
            if (!doc.error) {
              const recoverable = new Set(
                Object.entries(doc.comments)
                  .filter(
                    ([id, comment]) =>
                      comment.status === "open" &&
                      (acceptanceHistory || JSON.stringify(comment.anchor) === JSON.stringify(oldDoc.comments[id]?.anchor)) &&
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
          const hasOpenComments = this.anchors.length > 0 || Object.values(newDoc.comments).some((comment) => comment.status === "open");
          if (hasOpenComments && rangesTouchTable(text, newProseLen, ranges, this.tablesFor(text, newProseLen).tables)) {
            // Tabellen-Edit: Positionen durch die Änderung mappen (Anker folgen
            // echten Text-Edits wie in Prosa). Anker, die bei Obsidians Tabellen-
            // Neuformatierung (Ganz-Block-Replace) kollabieren, per exaktem Text
            // wiederherstellen statt sie zu verlieren. performReanchor schreibt nur
            // um, wenn der exact-Text wirklich weg ist — schützt vor Korruption.
            const mapped = mapAnchors(this.anchors, u.changes);
            const survived = new Set(mapped.map((a) => a.id));
            this.anchors = mapped;
            const doc = this.readDocument(text);
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
            this.dirty = this.anchors.length > 0;
            if (this.dirty) this.scheduleReanchor();
          }
        }
        this.decorations = this.anchors.length ? this.buildDecorations() : Decoration.none;
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
            if (this.destroyed) return;
            if (this.anchors.length === 0) {
              clearTableHighlights(this.view);
              return;
            }
            const { text, proseLen, tables } = this.tablesFor();
            applyTableHighlights(this.view, this.anchors, text, proseLen, (id) => void plugin.openSidebar(id), tables);
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
        const changes = normalizeTrailingChanges(text, this.readDocument(text));
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
        if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
        if (!this.dirty || this.destroyed) return;
        this.dirty = false;
        const text = this.view.state.doc.toString();
        const serialized = this.reanchoredText(text);
        if (!serialized) return;
        const proseLen = this.readDocument(text).prose.length;
        this.view.dispatch({
          changes: { from: proseLen, to: text.length, insert: serialized.slice(proseLen) },
          annotations: [selfEdit.of(true), Transaction.addToHistory.of(false)],
        });
      }

      private reanchoredText(text: string): string | undefined {
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
          if (cur.exact && doc.prose.includes(cur.exact)) continue;
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
        return serializeDocument(doc, plugin.settings.schemaHint);
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
