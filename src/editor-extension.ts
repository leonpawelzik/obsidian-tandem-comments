import { Annotation, RangeSetBuilder, Transaction } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import type CommentsPlugin from "./main";
import {
  changesTouchCommentBlock,
  isFullReplace,
  mapAnchors,
  mapAnchorsPrecisely,
  mergePendingAnchors,
  shouldPreservePendingAnchors,
  type TrackedAnchor,
} from "./reanchor";
import { findInReplacement, findReturned, loseAnchor, textChanges, type LostAnchor } from "./lost-anchors";
import { createDocumentReader, makeAnchor, normalizeTrailingChanges, parseDocument, resolveAnchor, serializeDocument } from "./store";
import { findCallouts, type ParsedCallout } from "./callout-highlight";
import { findTables, rangesTouchTable, type ParsedTable } from "./table-highlight";
import type { ParsedDoc } from "./types";
import { applyWidgetHighlights, clearWidgetHighlights } from "./widget-highlight";

/** Markiert Transaktionen, die das Plugin selbst dispatcht (Block-Rewrite). */
export const selfEdit = Annotation.define<boolean>();

const REANCHOR_DEBOUNCE_MS = 800;
const NORMALIZE_DEBOUNCE_MS = 500;
/** Kennzeichnung von Nutzer-Edits; externe Dateiänderungen meldet Obsidian als "set". */
const USER_EVENTS = ["input", "delete", "move", "undo", "redo"];

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
      lost = new Map<string, LostAnchor>();
      timer: number | null = null;
      normalizeTimer: number | null = null;
      widgetDoc: EditorView["state"]["doc"] | null = null;
      widgetSnapshot: { text: string; proseLen: number; tables: ParsedTable[]; callouts: ParsedCallout[] } | null = null;

      widgetsFor(text?: string, proseLen?: number) {
        if (this.widgetDoc !== this.view.state.doc || !this.widgetSnapshot) {
          const raw = text ?? this.view.state.doc.toString();
          const length = proseLen ?? this.readDocument(raw).prose.length;
          this.widgetDoc = this.view.state.doc;
          this.widgetSnapshot = { text: raw, proseLen: length, tables: findTables(raw, length), callouts: findCallouts(raw, length) };
        }
        return this.widgetSnapshot;
      }

      constructor(readonly view: EditorView) {
        this.saveOnClose = plugin.captureAnchorSave?.(view);
        this.syncFromDoc(view.state.doc.toString());
        this.decorations = this.buildDecorations();
        this.scheduleWidgetHighlight();
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
          this.lost.clear();
        }
        // Tabellen-Widgets entstehen/verschwinden auch bei Selektions- und
        // Viewport-Wechseln (Cursor rein/raus), nicht nur bei Doc-Änderungen.
        if (u.docChanged || u.selectionSet || u.viewportChanged) this.scheduleWidgetHighlight();
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
        const before = this.anchors;
        if (isSelf || fullReplace || touchesBlock) {
          this.syncFromDoc(text);
          if (!isSelf) this.keepPending(before, pending, u, oldDoc, newDoc, preservePending);
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
          const { mapped, torn } = mapAnchorsPrecisely(this.anchors, u.changes, u.startState.doc);
          if (hasOpenComments && rangesTouchTable(text, newProseLen, ranges, this.widgetsFor(text, newProseLen).tables)) {
            // Tabellen-Edit: Anker, die Obsidians Umbau (Zeilen sortieren, Spalten
            // verschieben …) zerreißt oder löscht, per exaktem Text innerhalb des
            // Geänderten wiederfinden statt sie zu verlieren.
            const safe = mapped.filter((a) => !torn.has(a.id));
            const guessed = new Map(mapped.filter((a) => torn.has(a.id)).map((a) => [a.id, a]));
            const survived = new Set(safe.map((a) => a.id));
            this.anchors = safe;
            for (const [id, c] of Object.entries(newDoc.comments)) {
              if (c.status === "resolved" || survived.has(id)) continue;
              const r = resolveAnchor(newDoc.prose, c.anchor);
              const found = r.kind === "resolved" && ranges.some((range) => r.start >= range.from && r.end <= range.to);
              const fallback = guessed.get(id);
              if (found) this.anchors.push({ id, from: r.start, to: r.end });
              else if (fallback) this.anchors.push(fallback);
            }
            this.anchors.sort((a, b) => a.from - b.from);
            this.dirty = true;
            this.scheduleReanchor();
          } else {
            this.anchors = mapped;
            this.dirty = this.anchors.length > 0;
            if (this.dirty) this.scheduleReanchor();
          }
          this.followLost(before, u, oldDoc, newDoc);
        }
        this.decorations = this.anchors.length ? this.buildDecorations() : Decoration.none;
      }

      /** Merkt sich vom Nutzer gelöschte Zitate und holt zurückgekehrte wieder herein. */
      followLost(before: TrackedAnchor[], u: ViewUpdate, oldDoc: ParsedDoc, newDoc: ParsedDoc): void {
        const tracked = new Set(this.anchors.map((a) => a.id));
        const gone = before.filter((a) => !tracked.has(a.id));
        const away = Object.entries(newDoc.comments).filter(
          ([id, c]) => c.status === "open" && !tracked.has(id) && (c.anchor.orphaned || this.lost.has(id))
        );
        if (gone.length === 0 && away.length === 0) return;
        const changes = textChanges(u.changes);
        const back: TrackedAnchor[] = [];
        const byUser = u.transactions.some((tr) => USER_EVENTS.some((event) => tr.isUserEvent(event)));
        for (const anchor of gone) {
          const stored = newDoc.comments[anchor.id]?.anchor;
          if (!stored) continue;
          const oldText = u.startState.doc;
          const found = findInReplacement(anchor, changes, oldText);
          if (found) back.push({ id: anchor.id, ...found });
          // Externe Änderungen ("set") können den Anker noch nachziehen, z.B. ein Agent.
          else if (byUser) {
            const lost = loseAnchor(anchor, stored, changes, oldText, oldDoc.prose);
            const returned = findReturned(lost.anchor, lost, changes, newDoc.prose);
            if (returned) back.push({ id: anchor.id, ...returned });
            else this.lost.set(anchor.id, lost);
          }
        }
        for (const [id, c] of away) {
          const lost = this.lost.get(id);
          const returned = findReturned(lost?.anchor ?? c.anchor, lost, changes, newDoc.prose);
          if (returned) back.push({ id, ...returned });
        }
        for (const anchor of back) this.lost.delete(anchor.id);
        this.anchors = [...this.anchors, ...back].sort((a, b) => a.from - b.from);
        this.dirty = this.anchors.length > 0 || this.lost.size > 0;
        if (this.dirty) this.scheduleReanchor();
      }

      /**
       * Nach einem Block-Rewrite, bevor offene Änderungen gespeichert sind: Wer
       * seinen gespeicherten Anker behalten hat, bleibt an der verfolgten Stelle
       * bzw. gelöscht, auch wenn das alte Zitat anderswo vorkommt.
       */
      keepPending(
        before: TrackedAnchor[],
        pending: TrackedAnchor[],
        u: ViewUpdate,
        oldDoc: ParsedDoc,
        newDoc: ParsedDoc,
        preserve: boolean
      ): void {
        if (!preserve) this.lost.clear();
        const unchanged = (id: string): boolean =>
          newDoc.comments[id]?.status === "open" &&
          JSON.stringify(newDoc.comments[id].anchor) === JSON.stringify(oldDoc.comments[id]?.anchor);
        for (const id of [...this.lost.keys()]) if (!unchanged(id)) this.lost.delete(id);
        const quotes = new Map(before.map((a) => [a.id, u.startState.doc.sliceString(a.from, a.to)]));
        const keep = pending.filter((a) => unchanged(a.id) && quotes.get(a.id) === u.state.doc.sliceString(a.from, a.to));
        const replaced = new Set([...keep.map((a) => a.id), ...this.lost.keys()]);
        const synced = new Map(this.anchors.map((a) => [a.id, a]));
        this.anchors = [...this.anchors.filter((a) => !replaced.has(a.id)), ...keep].sort((a, b) => a.from - b.from);
        const moved = keep.some((a) => synced.get(a.id)?.from !== a.from || synced.get(a.id)?.to !== a.to);
        if (moved || this.lost.size > 0) {
          this.dirty = true;
          this.scheduleReanchor();
        }
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
       * Highlights innerhalb gerenderter Tabellen- und Callout-Widgets müssen direkt ins DOM
       * geschrieben werden (CM-mark-Dekorationen werden dort verschluckt). Das
       * läuft in der Measure-/Write-Phase, nachdem Obsidian die Widgets gebaut hat.
       */
      scheduleWidgetHighlight(): void {
        this.view.requestMeasure({
          key: "tc-widget-highlight",
          read: () => null,
          write: () => {
            if (this.destroyed) return;
            if (this.anchors.length === 0) {
              clearWidgetHighlights(this.view);
              return;
            }
            const { text, proseLen, tables, callouts } = this.widgetsFor();
            applyWidgetHighlights(this.view, this.anchors, text, proseLen, (id) => void plugin.openSidebar(id), tables, callouts);
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
          // Nur umschreiben, wenn der gespeicherte Anker nicht mehr genau hierher
          // führt — auch wenn sein Zitat anderswo noch vorkommt: sonst säße der
          // Kommentar nach dem Neuöffnen an der anderen Stelle.
          const stored = resolveAnchor(doc.prose, cur);
          if (stored.kind === "resolved" && stored.start === t.from && stored.end === t.to) continue;
          const next = makeAnchor(doc.prose, t.from, t.to);
          if (
            next.exact &&
            (cur.orphaned ||
              next.exact !== cur.exact ||
              next.prefix !== cur.prefix ||
              next.suffix !== cur.suffix ||
              next.pos !== cur.pos)
          ) {
            c.anchor = next;
            changed = true;
          }
        }
        for (const [id, lost] of this.lost) {
          const c = doc.comments[id];
          if (!c || c.status === "resolved" || JSON.stringify(c.anchor) !== lost.stored) continue;
          c.anchor = { ...lost.anchor, orphaned: true };
          changed = true;
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
