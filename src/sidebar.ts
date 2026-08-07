import { ItemView, MarkdownRenderer, Menu, Notice, setIcon, setTooltip, TFile, WorkspaceLeaf } from "obsidian";
import { resolveAuthorColor, type AuthorColorOverrides } from "./author-color";
import { confirmAction } from "./confirm-action";
import { formatComment, formatTs } from "./export";
import type CommentsPlugin from "./main";
import { shouldSubmitComment, sortSidebarComments } from "./sidebar-preferences";
import { formatSidebarTimestamp } from "./timestamp";
import {
  addComment,
  addReply,
  addSuggestion,
  declineSuggestion,
  editThreadEntry,
  generateId,
  removeComment,
  removeThreadEntry,
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

/** Colors an author name span with accessible light and dark variants. */
function paintAuthor(
  el: HTMLElement,
  author: string,
  overrides: AuthorColorOverrides,
  enabled: boolean
): void {
  el.dataset.tcAuthor = author;
  if (!enabled) {
    el.removeClass("tc-author-colored");
    el.style.removeProperty("--tc-author-color-light");
    el.style.removeProperty("--tc-author-color-dark");
    return;
  }
  el.style.setProperty("--tc-author-color-light", resolveAuthorColor(author, overrides, "light"));
  el.style.setProperty("--tc-author-color-dark", resolveAuthorColor(author, overrides, "dark"));
  el.addClass("tc-author-colored");
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
  /** After a reply (or focus), scroll this card’s latest entry into view. */
  private revealThreadEndId: string | null = null;

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
    this.registerInterval(
      window.setInterval(() => {
        if (this.plugin.settings.timestampDisplay === "relative") this.refreshTimestamps();
      }, 60_000)
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
    this.revealThreadEndId = id;
    void this.render();
  }

  toggleResolved(): void {
    this.showResolved = !this.showResolved;
    void this.render();
  }

  settingsChanged(resetResolved: boolean): void {
    if (resetResolved) this.showResolved = this.plugin.settings.showResolvedByDefault;
    void this.render();
  }

  refreshAuthorColors(): void {
    for (const el of Array.from(this.contentEl.querySelectorAll<HTMLElement>(".tc-author[data-tc-author]"))) {
      const author = el.dataset.tcAuthor;
      if (author != null) {
        paintAuthor(
          el,
          author,
          this.plugin.settings.authorColorOverrides,
          this.plugin.settings.colorAuthorNames
        );
      }
    }
  }

  /** Nicht neu rendern, während in einem Eingabefeld getippter Text verloren ginge. */
  private hasPendingInput(): boolean {
    return Array.from(this.contentEl.querySelectorAll("textarea")).some(
      (t) => t.value.length > 0 || t.classList.contains("tc-edit-input")
    );
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
    const open = this.sortComments(
      all.filter((r) => r.comment.status === "open" && r.resolution.kind === "resolved")
    );
    const orphans = this.sortComments(
      all.filter((r) => r.comment.status === "open" && r.resolution.kind === "orphaned")
    );
    const done = this.sortComments(all.filter((r) => r.comment.status === "resolved"));

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
      attr: {
        placeholder:
          this.plugin.settings.submitShortcut === "enter"
            ? "Comment… (Enter = save, Esc = cancel)"
            : "Comment… (Cmd/Ctrl+Enter = save, Esc = cancel)",
        rows: "3",
      },
    });
    window.setTimeout(() => input.focus(), 0);
    input.onkeydown = (e) => {
      if (e.key === "Escape") {
        this.draft = null;
        void this.render();
      } else if (this.shouldSubmit(e)) {
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
      } else if (this.shouldSubmit(e)) {
        e.preventDefault();
        submit();
      }
    };
    note.onkeydown = (e) => {
      if (e.key === "Escape") {
        this.draft = null;
        void this.render();
      } else if (this.shouldSubmit(e)) {
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
    const copyThread = (): void => {
      void navigator.clipboard
        .writeText(formatComment(r, { includeQuote: this.plugin.settings.copyIncludeQuote, formatTs }))
        .then(() => new Notice("Thread copied."));
    };
    const showMenu = (trigger: HTMLElement, build: (menu: Menu) => void): void => {
      const menu = new Menu();
      build(menu);
      trigger.setAttr("aria-expanded", "true");
      menu.onHide(() => trigger.setAttr("aria-expanded", "false"));
      const rect = trigger.getBoundingClientRect();
      menu.showAtPosition({ x: rect.right, y: rect.bottom, left: true }, trigger.ownerDocument);
    };
    const addCopyMenuItem = (menu: Menu): void => {
      menu.addItem((item) => item.setTitle("Copy").setIcon("copy").onClick(copyThread));
    };
    const addResolveButton = (controls: HTMLElement): void => {
      const resolveBtn = controls.createEl("button", {
        cls: "tc-entry-action clickable-icon",
        attr: {
          "aria-label": "Resolve comment",
        },
      });
      setIcon(resolveBtn, "check");
      setTooltip(resolveBtn, "Resolve");
      resolveBtn.onclick = () => {
        void (async () => {
          if (
            this.plugin.settings.resolveBehavior === "remove" &&
            this.plugin.settings.confirmDestructiveActions &&
            !(await confirmAction(this.app, {
              title: "Resolve comment?",
              message: "This will permanently remove the comment thread from the note.",
              confirmLabel: "Resolve",
            }))
          ) {
            return;
          }
          await this.plugin.updateDoc(file, (d) => {
            if (this.plugin.settings.resolveBehavior === "remove") removeComment(d.comments, r.id);
            else setStatus(d.comments, r.id, "resolved");
          });
        })();
      };
    };
    const addMenuTrigger = (
      controls: HTMLElement,
      ariaLabel: string,
      deleteTitle: string,
      deleteMessage: string,
      deleteAction: () => Promise<unknown>
    ): void => {
      const trigger = controls.createEl("button", {
        cls: "tc-entry-menu-trigger clickable-icon",
        attr: {
          "aria-label": ariaLabel,
          "aria-haspopup": "menu",
          "aria-expanded": "false",
        },
      });
      setIcon(trigger, "ellipsis");
      trigger.onclick = () =>
        showMenu(trigger, (menu) => {
          addCopyMenuItem(menu);
          menu.addItem((item) =>
            item
              .setTitle(deleteTitle)
              .setIcon("trash-2")
              .setWarning(true)
              .onClick(() => {
                void (async () => {
                  if (
                    this.plugin.settings.confirmDestructiveActions &&
                    !(await confirmAction(this.app, {
                      title: `${deleteTitle}?`,
                      message: deleteMessage,
                      confirmLabel: deleteTitle,
                    }))
                  ) {
                    return;
                  }
                  await deleteAction();
                })();
              })
          );
        });
    };
    if (r.id === this.focusedId) {
      card.addClass("tc-focused");
      this.focusedId = null;
    }
    const shouldRevealEnd = r.id === this.revealThreadEndId;
    if (shouldRevealEnd) this.revealThreadEndId = null;

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
      paintAuthor(
        meta.createSpan({ text: suggestion.author, cls: "tc-author" }),
        suggestion.author,
        this.plugin.settings.authorColorOverrides,
        this.plugin.settings.colorAuthorNames
      );
      this.addTimestamp(meta, suggestion.ts);
      const suggestionControls = meta.createDiv({ cls: "tc-entry-controls" });
      addMenuTrigger(
        suggestionControls,
        "More options for suggestion",
        "Delete Suggestion",
        "This will permanently remove the suggestion and its discussion from the note.",
        () => this.plugin.updateDoc(file, (d) => removeComment(d.comments, r.id))
      );
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
      if (r.comment.thread.length === 0) {
        const fallbackMeta = card.createDiv({ cls: "tc-meta" });
        const fallbackControls = fallbackMeta.createDiv({ cls: "tc-entry-controls" });
        if (r.comment.status === "open") addResolveButton(fallbackControls);
        addMenuTrigger(
          fallbackControls,
          "More options for comment",
          "Delete Comment",
          "This will permanently remove the comment thread from the note.",
          () => this.plugin.updateDoc(file, (d) => removeComment(d.comments, r.id))
        );
      }
    }

    // Thread body → reply composer → actions. Keeping the composer directly under
    // the latest entry avoids Resolve/Copy/Delete sitting between the conversation
    // and the input (which scrolled the latest message out of view under the reply box).
    const thread = card.createDiv({ cls: "tc-thread" });
    for (const [entryIndex, entry] of r.comment.thread.entries()) {
      const row = thread.createDiv({ cls: "tc-entry" });
      const meta = row.createDiv({ cls: "tc-meta" });
      paintAuthor(
        meta.createSpan({ text: entry.author, cls: "tc-author" }),
        entry.author,
        this.plugin.settings.authorColorOverrides,
        this.plugin.settings.colorAuthorNames
      );
      this.addTimestamp(meta, entry.ts);
      const entryControls = meta.createDiv({ cls: "tc-entry-controls" });
      if (entryIndex === 0 && r.comment.status === "open" && !r.comment.suggestion) {
        addResolveButton(entryControls);
      }
      addMenuTrigger(
        entryControls,
        `More options for comment by ${entry.author}`,
        "Delete Comment",
        entryIndex === 0
          ? "This will permanently remove the comment thread from the note."
          : "This will permanently remove this reply from the comment thread.",
        () => this.plugin.updateDoc(file, (d) => removeThreadEntry(d.comments, r.id, entryIndex))
      );

      const textEl = row.createDiv({
        cls: "tc-text tc-text-editable",
        attr: {
          tabindex: "0",
          title: "Double-click to edit",
          "aria-label": `Comment by ${entry.author}. Double-click or press Enter to edit.`,
        },
      });
      // Use Obsidian's renderer and inherit its Markdown, sanitization, and
      // registered post-processor behavior.
      void MarkdownRenderer.render(this.app, entry.text, textEl, file.path, this);
      const beginEdit = (): void => {
        const expected = { ...entry };
        const input = row.createEl("textarea", {
          cls: "tc-input tc-edit-input",
          attr: { rows: "3", "aria-label": `Edit comment by ${entry.author}` },
        });
        input.value = entry.text;
        textEl.replaceWith(input);
        const editActions = row.createDiv({ cls: "tc-actions tc-edit-actions" });
        const save = editActions.createEl("button", { text: "Save", cls: "mod-cta" });
        const cancel = editActions.createEl("button", { text: "Cancel" });

        const submit = (): void => {
          if (save.disabled) return;
          const text = input.value.trim();
          if (!text) {
            new Notice("Comment cannot be empty.");
            input.focus();
            return;
          }
          if (text === expected.text) {
            void this.render();
            return;
          }
          save.disabled = true;
          cancel.disabled = true;
          let failure: "missing" | "conflict" | null = null;
          void this.plugin
            .updateDoc(file, (d) => {
              const result = editThreadEntry(d.comments, r.id, entryIndex, expected, text);
              if (!result.ok) failure = result.reason;
            })
            .then((ok) => {
              if (!ok) {
                save.disabled = false;
                cancel.disabled = false;
                return;
              }
              if (failure === "conflict") {
                new Notice("This comment changed while you were editing it. Your edit was not saved.");
              } else if (failure === "missing") {
                new Notice("This comment no longer exists. Your edit was not saved.");
              }
              void this.render();
            });
        };

        save.onclick = submit;
        cancel.onclick = () => void this.render();
        input.onkeydown = (e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            void this.render();
          } else if (this.shouldSubmit(e)) {
            e.preventDefault();
            submit();
          }
        };
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      };
      textEl.ondblclick = (e) => {
        if (e.target instanceof Element && e.target.closest("a")) return;
        e.preventDefault();
        beginEdit();
      };
      textEl.onkeydown = (e) => {
        if (e.target !== textEl) return;
        if (e.key === "Enter" || e.key === "F2") {
          e.preventDefault();
          beginEdit();
        }
      };
    }

    if (r.comment.status === "open") {
      const replyWrap = card.createDiv({ cls: "tc-reply" });
      const reply = replyWrap.createEl("textarea", {
        cls: "tc-input tc-reply-input",
        attr: {
          placeholder:
            this.plugin.settings.submitShortcut === "enter"
              ? "Reply… (Enter = send)"
              : "Reply… (Cmd/Ctrl+Enter = send)",
          rows: "2",
          "aria-label": "Reply to thread",
        },
      });
      reply.onkeydown = (e) => {
        if (this.shouldSubmit(e)) {
          e.preventDefault();
          const text = reply.value.trim();
          if (!text) return;
          reply.value = "";
          this.revealThreadEndId = r.id;
          void this.plugin
            .updateDoc(file, (d) =>
              addReply(d.comments, r.id, this.plugin.currentAuthor(), this.plugin.nowTs(), text)
            )
            .then((ok) => {
              // Force a paint even if vault.modify coalesces oddly; revealThreadEndId
              // scrolls the new latest entry into view above the composer.
              if (ok) void this.render();
            });
        }
      };
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
      declineBtn.onclick = () => {
        void (async () => {
          if (
            this.plugin.settings.resolveBehavior === "remove" &&
            this.plugin.settings.confirmDestructiveActions &&
            !(await confirmAction(this.app, {
              title: "Decline suggestion?",
              message: "This will permanently remove the suggestion and its discussion from the note.",
              confirmLabel: "Decline",
            }))
          ) {
            return;
          }
          await this.plugin.updateDoc(file, (d) => {
            const result = declineSuggestion(d.comments, r.id, this.plugin.settings.resolveBehavior);
            if (!result.ok) new Notice(suggestionFailureMessage(result.reason));
          });
        })();
      };
    } else if (r.comment.status === "resolved" && !r.comment.suggestion) {
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
    if (!actions.hasChildNodes()) actions.remove();

    if (shouldRevealEnd) {
      window.setTimeout(() => {
        const latest =
          card.querySelector<HTMLElement>(".tc-entry:last-child") ??
          card.querySelector<HTMLElement>(".tc-reply") ??
          card;
        latest.scrollIntoView({ block: "nearest" });
      }, 0);
    }
  }

  private shouldSubmit(event: KeyboardEvent): boolean {
    return shouldSubmitComment(event, this.plugin.settings.submitShortcut);
  }

  private addTimestamp(container: HTMLElement, timestamp: string): void {
    const formatted = formatSidebarTimestamp(timestamp, this.plugin.settings.timestampDisplay);
    if (formatted === null) return;
    const element = container.createSpan({ text: formatted, cls: "tc-ts" });
    element.dataset.tcTimestamp = timestamp;
    if (this.plugin.settings.timestampDisplay !== "full") {
      setTooltip(element, formatTs(timestamp));
    }
  }

  private refreshTimestamps(): void {
    for (const element of Array.from(
      this.contentEl.querySelectorAll<HTMLElement>(".tc-ts[data-tc-timestamp]")
    )) {
      const timestamp = element.dataset.tcTimestamp;
      if (!timestamp) continue;
      const formatted = formatSidebarTimestamp(timestamp, this.plugin.settings.timestampDisplay);
      if (formatted !== null) element.setText(formatted);
    }
  }

  private sortComments(items: ResolvedComment[]): ResolvedComment[] {
    return sortSidebarComments(items, this.plugin.settings.sidebarSortOrder);
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
