import type { Editor, EditorPosition, EditorTransaction } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { commitSuggestionAcceptance } from "../src/suggestion-editor";
import type { SuggestionAcceptancePlan } from "../src/store";

describe("commitSuggestionAcceptance", () => {
  it("commits prose and block changes in exactly one transaction before moving the cursor", () => {
    const calls: string[] = [];
    const transaction = vi.fn((_tx: EditorTransaction) => calls.push("transaction"));
    const setCursor = vi.fn((_pos: EditorPosition) => calls.push("cursor"));
    const editor = {
      offsetToPos: (offset: number): EditorPosition => ({ line: 0, ch: offset }),
      transaction,
      setCursor,
    } as unknown as Editor;
    const plan: Extract<SuggestionAcceptancePlan, { ok: true }> = {
      ok: true,
      changes: [
        { from: 10, to: 25, insert: "replacement" },
        { from: 32, to: 200, insert: "" },
      ],
      cursor: 21,
    };

    commitSuggestionAcceptance(editor, plan);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledWith({
      changes: [
        { from: { line: 0, ch: 10 }, to: { line: 0, ch: 25 }, text: "replacement" },
        { from: { line: 0, ch: 32 }, to: { line: 0, ch: 200 }, text: "" },
      ],
    });
    expect(setCursor).toHaveBeenCalledWith({ line: 0, ch: 21 });
    expect(calls).toEqual(["transaction", "cursor"]);
  });
});
