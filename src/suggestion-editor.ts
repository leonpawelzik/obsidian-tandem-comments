import type { Editor } from "obsidian";
import type { SuggestionAcceptancePlan } from "./store";

type SuccessfulSuggestionAcceptancePlan = Extract<SuggestionAcceptancePlan, { ok: true }>;

/** Commits a prepared acceptance plan as exactly one undoable editor transaction. */
export function commitSuggestionAcceptance(
  editor: Editor,
  plan: SuccessfulSuggestionAcceptancePlan
): void {
  editor.transaction({
    changes: plan.changes.map((change) => ({
      from: editor.offsetToPos(change.from),
      to: editor.offsetToPos(change.to),
      text: change.insert,
    })),
  });
  editor.setCursor(editor.offsetToPos(plan.cursor));
}
