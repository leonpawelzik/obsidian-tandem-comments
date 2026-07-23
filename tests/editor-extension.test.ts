import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEditorAnchorTracker,
  type EditorExtensionHost,
} from "../src/editor-extension";
import { isFullReplace } from "../src/reanchor";
import {
  makeAnchor,
  parseDocument,
  planSuggestionAcceptance,
  resolveAnchor,
  serializeDocument,
} from "../src/store";
import type { ParsedDoc } from "../src/types";

const TS = "2026-07-23T12:00:00Z";

function acceptanceDoc(): ParsedDoc {
  const prose = "Very old quote and target";
  const targetStart = prose.indexOf("target");
  return {
    prose,
    comments: {
      pending: {
        anchor: makeAnchor(prose, 0, "Very old quote".length),
        status: "open",
        thread: [{ author: "Leon", ts: TS, text: "Keep this thread attached." }],
      },
      suggestion: {
        anchor: makeAnchor(prose, targetStart, prose.length),
        status: "open",
        suggestion: {
          replacement: "a substantially longer ending",
          author: "Claude",
          ts: TS,
        },
        thread: [],
      },
    },
  };
}

function singleReplacement(fromText: string, toText: string): { from: number; to: number; insert: string } {
  let from = 0;
  while (from < fromText.length && from < toText.length && fromText[from] === toText[from]) from++;
  let suffix = 0;
  while (
    suffix < fromText.length - from &&
    suffix < toText.length - from &&
    fromText[fromText.length - 1 - suffix] === toText[toText.length - 1 - suffix]
  ) {
    suffix++;
  }
  return {
    from,
    to: fromText.length - suffix,
    insert: toText.slice(from, toText.length - suffix),
  };
}

class ExtensionHarness {
  state: EditorState;
  applyingSuggestion = false;
  readonly host: EditorExtensionHost;
  readonly view: {
    state: EditorState;
    requestMeasure: ReturnType<typeof vi.fn>;
    dispatch: (spec: TransactionSpec) => void;
  };
  readonly tracker: ReturnType<typeof createEditorAnchorTracker>;

  constructor(raw: string) {
    this.state = EditorState.create({ doc: raw });
    this.host = {
      settings: { schemaHint: true },
      isApplyingSuggestion: () => this.applyingSuggestion,
      openSidebar: vi.fn(),
    };
    this.view = {
      state: this.state,
      requestMeasure: vi.fn(),
      dispatch: (spec) => {
        this.apply(spec);
      },
    };
    this.tracker = createEditorAnchorTracker(this.view as unknown as EditorView, this.host);
  }

  text(): string {
    return this.state.doc.toString();
  }

  apply(spec: TransactionSpec) {
    const startState = this.state;
    const transaction = startState.update(spec);
    this.state = transaction.state;
    this.view.state = this.state;
    this.tracker.update({
      startState,
      state: this.state,
      transactions: [transaction],
      changes: transaction.changes,
      docChanged: transaction.docChanged,
      selectionSet: false,
      viewportChanged: false,
    } as unknown as ViewUpdate);
    return transaction;
  }

  applyHistoryText(text: string, event: "undo" | "redo") {
    return this.apply({
      changes: singleReplacement(this.text(), text),
      annotations: Transaction.userEvent.of(event),
    });
  }

  expectPendingAnchor(): void {
    const doc = parseDocument(this.text());
    const anchor = this.tracker.anchors.find(({ id }) => id === "pending");
    expect(anchor).toBeDefined();
    expect(doc.prose.slice(anchor!.from, anchor!.to)).toBe("Very new wording quote");
  }
}

describe("editor-extension pending anchors across acceptance history", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    ["before the debounce with removal", false, "remove"],
    ["after the debounce with removal", true, "remove"],
    ["before the debounce with retained history", false, "keep"],
    ["after the debounce with retained history", true, "keep"],
  ] as const)("preserves an unrelated pending reanchor through Undo and Redo %s", (_name, wait, behavior) => {
    const harness = new ExtensionHarness(serializeDocument(acceptanceDoc(), true));
    const oldStart = harness.text().indexOf("old");
    harness.apply({
      changes: { from: oldStart, to: oldStart + 3, insert: "new wording" },
      userEvent: "input",
    });
    const editedText = harness.text();
    harness.expectPendingAnchor();

    const plan = planSuggestionAcceptance(editedText, "suggestion", behavior, true);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    harness.applyingSuggestion = true;
    const acceptance = harness.apply({ changes: plan.changes });
    harness.applyingSuggestion = false;
    let changedRanges = 0;
    acceptance.changes.iterChangedRanges(() => changedRanges++);
    expect(changedRanges).toBe(1);
    expect(isFullReplace(acceptance.changes)).toBe(true);
    harness.expectPendingAnchor();

    if (wait) vi.advanceTimersByTime(800);
    if (wait) expect(harness.tracker.dirty).toBe(false);
    const acceptedText = harness.text();
    const undo = harness.applyHistoryText(editedText, "undo");
    expect(isFullReplace(undo.changes)).toBe(true);
    harness.expectPendingAnchor();

    if (wait) vi.advanceTimersByTime(800);
    if (wait) expect(harness.tracker.dirty).toBe(false);
    harness.applyHistoryText(acceptedText, "redo");
    harness.expectPendingAnchor();

    vi.advanceTimersByTime(800);
    const persisted = parseDocument(harness.text()).comments.pending.anchor;
    expect(persisted.exact).toBe("Very new wording quote");
    expect(resolveAnchor(parseDocument(harness.text()).prose, persisted).kind).toBe("resolved");
    harness.tracker.destroy();
  });

  it("does not preserve pending coordinates through an unrelated external full replace", () => {
    const harness = new ExtensionHarness(serializeDocument(acceptanceDoc(), true));
    const oldStart = harness.text().indexOf("old");
    harness.apply({
      changes: { from: oldStart, to: oldStart + 3, insert: "new wording" },
      userEvent: "input",
    });

    const replacement = "Entirely unrelated external document.";
    harness.apply({ changes: { from: 0, to: harness.text().length, insert: replacement } });
    expect(harness.tracker.anchors).toEqual([]);
    harness.tracker.destroy();
  });
});
