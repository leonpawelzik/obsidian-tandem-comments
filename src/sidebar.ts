import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type CommentsPlugin from "./main";
import { addComment, addReply, generateId, removeComment, resolveAll, setStatus } from "./store";
import type { Anchor, ResolvedComment } from "./types";

export const VIEW_TYPE_COMMENTS = "tandem-comments-sidebar";

interface Draft {
  filePath: string;
  anchor: Anchor;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function formatTs(ts: string): string {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleString();
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
    this.draft = { filePath: file.path, anchor };
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
    return Array.from(this.contentEl.querySelectorAll("textarea")).some((t) => t.value.trim() !== "");
  }

  async render(): Promise<void> {
    const container = this.contentEl;
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
      container.createDiv({ text: "No comments in this file.", cls: "tc-empty" });
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
  }

  private renderDraft(container: HTMLElement, file: TFile): void {
    const draft = this.draft;
    if (!draft) return;
    const card = container.createDiv({ cls: "tc-card tc-draft" });
    card.createDiv({ text: `"${truncate(draft.anchor.exact, 80)}"`, cls: "tc-quote" });
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
              this.plugin.settings.authorName,
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

  private renderComment(container: HTMLElement, file: TFile, r: ResolvedComment): void {
    const cls = ["tc-card"];
    if (r.comment.status === "resolved") cls.push("tc-resolved");
    if (r.resolution.kind === "orphaned") cls.push("tc-orphan");
    const card = container.createDiv({ cls: cls.join(" ") });
    if (r.id === this.focusedId) {
      card.addClass("tc-focused");
      window.setTimeout(() => card.scrollIntoView({ block: "nearest" }), 0);
      this.focusedId = null;
    }

    const quote = card.createDiv({ text: `"${truncate(r.comment.anchor.exact, 80)}"`, cls: "tc-quote" });
    if (r.resolution.kind === "resolved") {
      quote.addClass("tc-quote-link");
      quote.onclick = () => this.plugin.revealAnchor(file, r.comment.anchor);
    }

    for (const entry of r.comment.thread) {
      const row = card.createDiv({ cls: "tc-entry" });
      const meta = row.createDiv({ cls: "tc-meta" });
      meta.createSpan({ text: entry.author, cls: "tc-author" });
      meta.createSpan({ text: formatTs(entry.ts), cls: "tc-ts" });
      row.createDiv({ text: entry.text, cls: "tc-text" });
    }

    const actions = card.createDiv({ cls: "tc-actions" });
    if (r.comment.status === "open") {
      const resolveBtn = actions.createEl("button", { text: "Resolve" });
      resolveBtn.onclick = () =>
        void this.plugin.updateDoc(file, (d) => {
          if (this.plugin.settings.resolveBehavior === "remove") removeComment(d.comments, r.id);
          else setStatus(d.comments, r.id, "resolved");
        });
    } else {
      const reopenBtn = actions.createEl("button", { text: "Reopen" });
      reopenBtn.onclick = () => void this.plugin.updateDoc(file, (d) => setStatus(d.comments, r.id, "open"));
    }
    if (r.resolution.kind === "orphaned") {
      const reBtn = actions.createEl("button", { text: "Re-anchor to selection" });
      reBtn.onclick = () => this.reanchorFromSelection(file, r.id);
    }
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
            addReply(d.comments, r.id, this.plugin.settings.authorName, this.plugin.nowTs(), text)
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
