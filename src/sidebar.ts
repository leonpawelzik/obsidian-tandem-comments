import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { formatComment, formatTs } from "./export";
import type CommentsPlugin from "./main";
import {
  addComment,
  addReply,
  addSuggestion,
  declineSuggestion,
  generateId,
  removeComment,
  resolveAll,
  setStatus,
  type SuggestionFailureReason,
} from "./store";
import type { Anchor, ResolvedComment } from "./types";

export const VIEW_TYPE_COMMENTS = "tandem-comments-sidebar";

interface Draft {
  filePath: string;
  anchor: Anchor;
  kind: "comment" | "suggestion";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function suggestionFailureMessage(reason: SuggestionFailureReason): string {
  switch (reason) {
    case "no-editor":
      return "Open this file in a Markdown editor before accepting the suggestion.";
    case "invalid-document":
      return "The tandem-comments block is invalid. Fix its JSON before accepting the suggestion.";
    case "invalid-suggestion":
      return "The suggestion data is invalid. Its replacement must be text.";
    case "orphaned":
      return "The original passage no longer exists. Re-anchor the suggestion before accepting it.";
    case "ambiguous":
      return "The original passage appears more than once. Re-anchor the suggestion before accepting it.";
    case "empty-replacement":
      return "Empty replacements are not supported yet.";
    case "already-resolved":
      return "This suggestion has already been resolved.";
    case "not-suggestion":
      return "This entry is not an edit suggestion.";
    case "missing":
      return "The suggestion or its editor is no longer available.";
  }
}

export class CommentSidebar extends ItemView {
  private draft: Draft | null = null;
  private showResolved: boolean;
  private focusedId: string | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: CommentsPlugin) {
    super(leaf);
    this.showResolved = plugin.settings.showResolvedByDefault;
  }

  getViewType(): string {
    return VIEW_TYPE_COMMENTS;
  }
  getDisplayText(): string {
    return "Comments";
  }
  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    this.registerEvent(this.app.workspace.on("file-open", () => void this.render()));
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (f.path === this.app.workspace.getActiveFile()?.path && !this.hasPendingInput()) {
          void this.render();
        }
      })
    );
    await this.render();
  }

  startDraft(file: TFile, anchor: Anchor): void {
    this.draft = { filePath: file.path, anchor, kind: "comment" };
    void this.render();
  }

  startSuggestionDraft(file: TFile, anchor: Anchor): void {
    this.draft = { filePath: file.path, anchor, kind: "suggestion" };
    void this.render();
  }

  focusComment(id: string): void {
    this.focusedId = id;
    void this.render();
  }

  toggleResolved(): void {
    this.showResolved = !this.showResolved;
    void this.render();
  }

  /** Nicht neu rendern, während in einem Eingabefeld getippter Text verloren ginge. */
  private hasPendingInput(): boolean {
    return Array.from(this.contentEl.querySelectorAll("textarea")).some((t) => t.value.length > 0);
  }

  async render(): Promise<void> {
    const container = this.contentEl;
    const prevScroll = container.scrollTop;
    container.empty();
    container.addClass("tc-sidebar");

    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      container.createDiv({ text: "No active Markdown file.", cls: "tc-empty" });
      return;
    }
    const doc = await this.plugin.readDoc(file);
    if (doc.error) {
      container.createDiv({ text: "tandem-comments block is invalid: " + doc.error, cls: "tc-error" });
      return;
    }

    const header = container.createDiv({ cls: "tc-header" });
    header.createSpan({ text: "Comments", cls: "tc-title" });
    const toggle = header.createEl("button", {
      text: this.showResolved ? "Hide resolved" : "Show resolved",
      cls: "tc-toggle",
    });
    toggle.onclick = () => this.toggleResolved();
    const exportBtn = header.createEl("button", { text: "Export", cls: "tc-toggle" });
    exportBtn.onclick = () => void this.plugin.exportComments(file);

    if (this.draft && this.draft.filePath === file.path) this.renderDraft(container, file);
    else this.draft = null;

    const all = resolveAll(doc.prose, doc.comments);
    const open = all
      .filter((r) => r.comment.status === "open" && r.resolution.kind === "resolved")
      .sort(
        (a, b) =>
          (a.resolution.kind === "resolved" ? a.resolution.start : 0) -
          (b.resolution.kind === "resolved" ? b.resolution.start : 0)
      );
    const orphans = all.filter((r) => r.comment.status === "open" && r.resolution.kind === "orphaned");
    const done = all.filter((r) => r.comment.status === "resolved");

    if (!open.length && !orphans.length && !(this.showResolved && done.length) && !this.draft) {
      container.createDiv({ text: "No comments or suggestions in this file.", cls: "tc-empty" });
      return;
    }

    for (const r of open) this.renderComment(container, file, r);
    if (orphans.length) {
      container.createDiv({ text: "Orphaned — text passage not found", cls: "tc-section" });
      for (const r of orphans) this.renderComment(container, file, r);
    }
    if (this.showResolved && done.length) {
      container.createDiv({ text: "Resolved", cls: "tc-section" });
      for (const r of done) this.renderComment(container, file, r);
    }
    container.scrollTop = prevScroll;
  }

  private renderDraft(container: HTMLElement, file: TFile): void {
    const draft = this.draft;
    if (!draft) return;
    const card = container.createDiv({ cls: "tc-card tc-draft" });
    card.createDiv({ text: `"${truncate(draft.anchor.exact, 80)}"`, cls: "tc-quote" });
    if (draft.kind === "suggestion") {
      this.renderSuggestionDraft(card, file, draft);
      return;
    }
    const input = card.createEl("textarea", {
      cls: "tc-input",
      attr: { placeholder: "Comment… (Enter = save, Esc = cancel)", rows: "3" },
    });
    window.setTimeout(() => input.focus(), 0);
    input.onkeydown = (e) => {
      if (e.key === "Escape") {
        this.draft = null;
        void this.render();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        void this.plugin
          .updateDoc(file, (d) => {
            addComment(
              d.comments,
              generateId(d.comments),
              draft.anchor,
              this.plugin.currentAuthor(),
              this.plugin.nowTs(),
              text
            );
          })
          .then((ok) => {
            if (ok) {
              this.draft = null;
              void this.render();
            }
          });
      }
    };
  }

  private renderSuggestionDraft(card: HTMLElement, file: TFile, draft: Draft): void {
    card.createDiv({ text: "Suggested replacement", cls: "tc-field-label" });
    const replacement = card.createEl("textarea", {
      cls: "tc-input",
      attr: { placeholder: "Replacement text…", rows: "3", "aria-label": "Suggested replacement" },
    });
    card.createDiv({ text: "Explanation (optional)", cls: "tc-field-label" });
    const note = card.createEl("textarea", {
      cls: "tc-input",
      attr: { placeholder: "Why this change?", rows: "2", "aria-label": "Suggestion explanation" },
    });
    const actions = card.createDiv({ cls: "tc-actions" });
    const save = actions.createEl("button", { text: "Add suggestion", cls: "mod-cta" });
    const cancel = actions.createEl("button", { text: "Cancel" });

    const submit = (): void => {
      if (save.disabled) return;
      if (replacement.value.length === 0) {
        new Notice("Enter replacement text first.");
        replacement.focus();
        return;
      }
      save.disabled = true;
      const proposedText = replacement.value;
      const explanation = note.value.trim();
      void this.plugin
        .updateDoc(file, (d) => {
          addSuggestion(
            d.comments,
            generateId(d.comments),
            draft.anchor,
            this.plugin.currentAuthor(),
            this.plugin.nowTs(),
            proposedText,
            explanation || undefined
          );
        })
        .then((ok) => {
          if (ok) {
            this.draft = null;
            void this.render();
          } else {
            save.disabled = false;
          }
        });
    };

    save.onclick = submit;
    cancel.onclick = () => {
      this.draft = null;
      void this.render();
    };
    replacement.onkeydown = (e) => {
      if (e.key === "Escape") {
        this.draft = null;
        void this.render();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    };
    note.onkeydown = (e) => {
      if (e.key === "Escape") {
        this.draft = null;
        void this.render();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    };
    window.setTimeout(() => replacement.focus(), 0);
  }

  private renderComment(container: HTMLElement, file: TFile, r: ResolvedComment): void {
    const cls = ["tc-card"];
    if (r.comment.status === "resolved") cls.push("tc-resolved");
    if (
      r.resolution.kind === "orphaned" &&
      !(r.comment.suggestion?.result === "accepted" && r.comment.status === "resolved")
    ) {
      cls.push("tc-orphan");
    }
    if (r.comment.suggestion) cls.push("tc-suggestion-card");
    if (r.resolution.kind === "resolved" && r.resolution.ambiguous) cls.push("tc-ambiguous");
    const card = container.createDiv({ cls: cls.join(" ") });
    if (r.id === this.focusedId) {
      card.addClass("tc-focused");
      window.setTimeout(() => card.scrollIntoView({ block: "nearest" }), 0);
      this.focusedId = null;
    }

    if (r.comment.suggestion) {
      const suggestion = r.comment.suggestion;
      const replacement =
        typeof suggestion.replacement === "string" ? suggestion.replacement : "";
      const suggestionResult =
        suggestion.result === "accepted" || suggestion.result === "declined"
          ? suggestion.result
          : undefined;
      const heading = card.createDiv({ cls: "tc-suggestion-heading" });
      heading.createSpan({ text: "Suggested edit", cls: "tc-suggestion-title" });
      if (suggestionResult) {
        heading.createSpan({
          text: suggestionResult === "accepted" ? "Accepted" : "Declined",
          cls: `tc-suggestion-result tc-suggestion-${suggestionResult}`,
        });
      }
      const meta = card.createDiv({ cls: "tc-meta" });
      meta.createSpan({ text: suggestion.author, cls: "tc-author" });
      meta.createSpan({ text: formatTs(suggestion.ts), cls: "tc-ts" });
      const change = card.createDiv({ cls: "tc-suggestion-change" });
      const original = change.createDiv({ text: r.comment.anchor.exact, cls: "tc-suggestion-original" });
      if (r.resolution.kind === "resolved") {
        original.addClass("tc-quote-link");
        original.onclick = () => this.plugin.revealAnchor(file, r.comment.anchor);
      }
      change.createDiv({ text: "↓", cls: "tc-suggestion-arrow", attr: { "aria-hidden": "true" } });
      change.createDiv({
        text: replacement || (typeof suggestion.replacement === "string" ? "" : "Invalid replacement data"),
        cls: "tc-suggestion-replacement",
      });
      if (r.comment.status === "open" && r.resolution.kind === "orphaned") {
        card.createDiv({ text: "Original passage not found.", cls: "tc-suggestion-warning" });
      } else if (
        r.comment.status === "open" &&
        r.resolution.kind === "resolved" &&
        r.resolution.ambiguous
      ) {
        card.createDiv({
          text: "Original passage appears more than once. Re-anchor before accepting.",
          cls: "tc-suggestion-warning",
        });
      } else if (r.comment.status === "open" && replacement.length === 0) {
        card.createDiv({
          text:
            typeof suggestion.replacement === "string"
              ? "Empty replacements are not supported yet."
              : "Replacement must be text.",
          cls: "tc-suggestion-warning",
        });
      }
    } else {
      const quote = card.createDiv({ text: `"${truncate(r.comment.anchor.exact, 80)}"`, cls: "tc-quote" });
      if (r.resolution.kind === "resolved") {
        quote.addClass("tc-quote-link");
        quote.onclick = () => this.plugin.revealAnchor(file, r.comment.anchor);
      }
    }

    for (const entry of r.comment.thread) {
      const row = card.createDiv({ cls: "tc-entry" });
      const meta = row.createDiv({ cls: "tc-meta" });
      meta.createSpan({ text: entry.author, cls: "tc-author" });
      meta.createSpan({ text: formatTs(entry.ts), cls: "tc-ts" });
      row.createDiv({ text: entry.text, cls: "tc-text" });
    }

    const actions = card.createDiv({ cls: "tc-actions" });
    if (r.comment.status === "open" && r.comment.suggestion && !r.comment.suggestion.result) {
      const canAccept =
        r.resolution.kind === "resolved" &&
        !r.resolution.ambiguous &&
        typeof r.comment.suggestion.replacement === "string" &&
        r.comment.suggestion.replacement.length > 0;
      const acceptBtn = actions.createEl("button", { text: "Accept", cls: "mod-cta" });
      acceptBtn.disabled = !canAccept;
      acceptBtn.onclick = () => {
        const result = this.plugin.acceptEditSuggestion(file, r.id);
        if (!result.ok) {
          new Notice(suggestionFailureMessage(result.reason));
          return;
        }
        card.remove();
      };
      const declineBtn = actions.createEl("button", { text: "Decline" });
      declineBtn.onclick = () =>
        void this.plugin.updateDoc(file, (d) => {
          const result = declineSuggestion(d.comments, r.id, this.plugin.settings.resolveBehavior);
          if (!result.ok) new Notice(suggestionFailureMessage(result.reason));
        });
    } else if (r.comment.status === "open" && !r.comment.suggestion) {
      const resolveBtn = actions.createEl("button", { text: "Resolve" });
      resolveBtn.onclick = () =>
        void this.plugin.updateDoc(file, (d) => {
          if (this.plugin.settings.resolveBehavior === "remove") removeComment(d.comments, r.id);
          else setStatus(d.comments, r.id, "resolved");
        });
    } else if (!r.comment.suggestion) {
      const reopenBtn = actions.createEl("button", { text: "Reopen" });
      reopenBtn.onclick = () => void this.plugin.updateDoc(file, (d) => setStatus(d.comments, r.id, "open"));
    }
    if (
      r.comment.status === "open" &&
      (r.resolution.kind === "orphaned" ||
        (r.comment.suggestion && r.resolution.kind === "resolved" && r.resolution.ambiguous))
    ) {
      const reBtn = actions.createEl("button", { text: "Re-anchor to selection" });
      reBtn.onclick = () => this.reanchorFromSelection(file, r.id);
    }
    const copyBtn = actions.createEl("button", { text: "Copy" });
    copyBtn.onclick = () =>
      void navigator.clipboard
        .writeText(formatComment(r, { includeQuote: this.plugin.settings.copyIncludeQuote, formatTs }))
        .then(() => new Notice("Thread copied."));
    const delBtn = actions.createEl("button", { text: "Delete" });
    delBtn.onclick = () => void this.plugin.updateDoc(file, (d) => removeComment(d.comments, r.id));

    if (r.comment.status === "open") {
      const reply = card.createEl("textarea", {
        cls: "tc-input",
        attr: { placeholder: "Reply… (Enter = send)", rows: "2" },
      });
      reply.onkeydown = (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const text = reply.value.trim();
          if (!text) return;
          reply.value = "";
          void this.plugin.updateDoc(file, (d) =>
            addReply(d.comments, r.id, this.plugin.currentAuthor(), this.plugin.nowTs(), text)
          );
        }
      };
    }
  }

  private reanchorFromSelection(file: TFile, id: string): void {
    const sel = this.plugin.getProseSelection(file);
    if (!sel) {
      new Notice("Select the new text passage in the editor first.");
      return;
    }
    void this.plugin.updateDoc(file, (d) => {
      const c = d.comments[id];
      if (c) c.anchor = sel.anchor;
    });
  }
}
