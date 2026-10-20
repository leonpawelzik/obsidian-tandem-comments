import { Notice, type TFile } from "obsidian";
import { formatTs } from "./export";
import {
  asTaskLines,
  graduateEntries,
  graduateFailureMessage,
  graduateNoteName,
  graduateText,
  type GraduateKind,
} from "./graduate";
import type CommentsPlugin from "./main";
import type { ResolvedComment } from "./types";

const DESTINATIONS: Record<GraduateKind, string> = {
  text: "to the text",
  task: "to a task",
  note: "to a new note",
};

/**
 * Builds the graduate form inside a card, the way an entry edit is built in
 * place. With `only`, it graduates that one message and skips the message
 * picker; without it, every message starts ticked. `close` removes it and is called after a successful graduation too,
 * before the sidebar refreshes, so the filled text box does not hold the
 * refresh back.
 */
export function renderGraduatePanel(
  plugin: CommentsPlugin,
  card: HTMLElement,
  file: TFile,
  r: ResolvedComment,
  kind: GraduateKind,
  only: number | undefined,
  done: () => void
): void {
  card.querySelector(".tc-graduate")?.remove();
  const panel = card.createDiv({ cls: "tc-graduate" });
  const actions = card.querySelector<HTMLElement>(".tc-actions");
  if (actions) {
    actions.before(panel);
    actions.hide();
  }
  const close = (): void => {
    panel.remove();
    actions?.show();
  };
  panel.createDiv({
    text: `Graduate ${only === undefined ? "thread" : "message"} ${DESTINATIONS[kind]}`,
    cls: "tc-field-label",
  });

  const entries = only === undefined ? graduateEntries(r.comment) : [];
  const selected = new Set(only === undefined ? entries.map(([index]) => index) : [only]);
  const picks = panel.createDiv({
    cls: "tc-graduate-pick",
    attr: { role: "group", "aria-label": "Messages to include" },
  });
  if (only !== undefined) picks.remove();
  else if (!entries.length) {
    picks.createDiv({ text: "This thread has no messages to include.", cls: "tc-field-label" });
  }

  let input: HTMLTextAreaElement | null = null;
  const fill = (): void => {
    if (!input) return;
    const text = graduateText(r.comment, selected);
    input.value = kind === "task" ? asTaskLines(text) : text;
  };
  for (const [index, entry] of entries) {
    const row = picks.createEl("label", { cls: "tc-graduate-pick-row" });
    const box = row.createEl("input", { attr: { type: "checkbox" } });
    box.checked = true;
    const body = row.createDiv();
    body.createDiv({ text: entry.text, cls: "tc-graduate-pick-text" });
    body.createDiv({ text: `${entry.author} · ${formatTs(entry.ts)}`, cls: "tc-meta" });
    box.onchange = () => {
      if (box.checked) selected.add(index);
      else selected.delete(index);
      fill();
    };
  }

  let nameInput: HTMLInputElement | null = null;
  if (kind === "note") {
    panel.createDiv({ text: "Note name", cls: "tc-field-label" });
    nameInput = panel.createEl("input", {
      cls: "tc-input",
      attr: { type: "text", "aria-label": "Note name" },
    });
    nameInput.value = graduateNoteName(r.comment.anchor.exact);
  } else {
    panel.createDiv({
      text: kind === "task" ? "Tasks to add (one per line)" : "Text to place",
      cls: "tc-field-label",
    });
    input = panel.createEl("textarea", {
      cls: "tc-input",
      attr: { rows: "4", "aria-label": kind === "task" ? "Tasks to add" : "Text to place" },
    });
    fill();
  }

  const canReplace = r.resolution.kind === "resolved" && !r.resolution.ambiguous;
  if (kind !== "note" && !canReplace) {
    panel.createDiv({
      text:
        r.resolution.kind === "orphaned"
          ? "The original passage was not found, so only inserting at the cursor is possible."
          : "The original passage appears more than once, so only inserting at the cursor is possible.",
      cls: "tc-suggestion-warning",
    });
  }

  const resolveRow = panel.createEl("label", { cls: "tc-graduate-resolve" });
  const resolveBox = resolveRow.createEl("input", { attr: { type: "checkbox" } });
  resolveRow.appendText(" Resolve the thread afterwards");

  const row = panel.createDiv({ cls: "tc-actions tc-edit-actions" });
  const buttons: HTMLButtonElement[] = [];
  const finish = (): void => {
    close();
    done();
  };

  if (kind === "note") {
    const create = row.createEl("button", { text: "Create note", cls: "mod-cta" });
    buttons.push(create);
    create.onclick = () => {
      for (const b of buttons) b.disabled = true;
      const thread = r.comment.thread.filter((_, index) => selected.has(index));
      void plugin
        .graduateToNote(file, r.id, nameInput?.value ?? "", thread, resolveBox.checked)
        .then((path) => {
          if (path) {
            new Notice(`Created ${path}`);
            finish();
          } else {
            for (const b of buttons) b.disabled = false;
          }
        });
    };
  } else {
    const place = (replaceQuote: boolean): void => {
      const result = plugin.graduateToText(
        file,
        r.id,
        kind,
        input?.value ?? "",
        replaceQuote,
        resolveBox.checked
      );
      if (!result.ok) {
        new Notice(graduateFailureMessage(result.reason));
        return;
      }
      finish();
    };
    const insert = row.createEl("button", { text: "Insert at cursor", cls: "mod-cta" });
    insert.onclick = () => place(false);
    const replace = row.createEl("button", { text: "Replace quote" });
    replace.disabled = !canReplace;
    replace.onclick = () => place(true);
    buttons.push(insert, replace);
  }
  const cancel = row.createEl("button", { text: "Cancel" });
  cancel.onclick = close;
  panel.onkeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };
  (nameInput ?? input)?.focus();
}
