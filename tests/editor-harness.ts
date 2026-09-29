import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { createEditorAnchorTracker } from "../src/editor-extension";
import { makeAnchor, serializeDocument } from "../src/store";
import type { CommentMap } from "../src/types";

export function fixture(size: number, count: number, tables = false, repeated = false) {
  const rows: string[] = ["Introductory text outside all anchors.\n"];
  let length = rows[0].length;
  let row = 0;
  while (length < size) {
    const text = tables
      ? `\n| Item ${row} | Notes |\n| --- | --- |\n| target-${row} | status status status |\n`
      : `Paragraph ${row}: target-${row} status status status. A note with enough context for a stable anchor.\n`;
    rows.push(text);
    length += text.length;
    row++;
  }
  const prose = rows.join("");
  const comments: CommentMap = {};
  for (let i = 0; i < count; i++) {
    const target = repeated ? "status" : `target-${Math.floor(i * row / count)} `;
    const from = repeated ? prose.indexOf(target, Math.floor(i * prose.length / count)) : prose.indexOf(target);
    if (from < 0) throw new Error(`Fixture target missing: ${target}`);
    comments[`c${i}`] = {
      anchor: makeAnchor(prose, from, from + target.trimEnd().length),
      status: "open",
      thread: [{ author: "Reviewer", ts: "2026-08-11T10:30:00Z", text: `Review comment ${i}: **check** this passage.` }],
    };
  }
  return { prose, comments, raw: serializeDocument({ prose, comments }, true) };
}

// Real CodeMirror state/transactions and plugin tracker; no browser layout.
export class Harness {
  applyingSuggestion = false;
  closedText: string | undefined;
  dispatches: TransactionSpec[] = [];
  pendingMeasure: { read: () => unknown; write: (value: unknown) => void } | undefined;
  queryCount = 0;
  view: {
    state: EditorState;
    requestMeasure: (request: Harness["pendingMeasure"]) => void;
    dispatch: (spec: TransactionSpec) => void;
    contentDOM: { querySelectorAll: () => never[] };
  };
  tracker: Pick<ReturnType<typeof createEditorAnchorTracker>,
    "anchors" | "dirty" | "update" | "destroy" | "performReanchor" | "performNormalize">;

  constructor(raw: string) {
    this.view = {
      state: EditorState.create({ doc: raw }),
      requestMeasure: (request) => { this.pendingMeasure = request; },
      dispatch: (spec) => { this.dispatches.push(spec); this.apply(spec); },
      contentDOM: { querySelectorAll: () => { this.queryCount++; return []; } },
    };
    this.tracker = createEditorAnchorTracker(this.view as unknown as EditorView, {
      captureAnchorSave: (_view, previous) => previous ?? ({ key: this, save: (_before, after) => { this.closedText = after; } }),
      settings: { schemaHint: true }, isApplyingSuggestion: () => this.applyingSuggestion, openSidebar: () => {},
    });
  }

  apply(spec: TransactionSpec) {
    const startState = this.view.state;
    const transaction = startState.update(spec);
    this.view.state = transaction.state;
    this.tracker.update({
      startState, state: transaction.state, transactions: [transaction], changes: transaction.changes,
      docChanged: transaction.docChanged, selectionSet: transaction.selection !== undefined,
      viewportChanged: false,
    } as unknown as ViewUpdate);
    return transaction;
  }

  measure() {
    const request = this.pendingMeasure;
    this.pendingMeasure = undefined;
    if (request) request.write(request.read());
  }

  type(measure = false) {
    const next = this.view.state.doc.sliceString(1, 2) === "x" ? "y" : "x";
    this.apply({ changes: { from: 1, to: 2, insert: next }, userEvent: "input" });
    if (measure) this.measure();
  }

  select() {
    const anchor = this.view.state.selection.main.anchor === 1 ? 2 : 1;
    this.apply({ selection: { anchor } });
    this.measure();
  }
}
