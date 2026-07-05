import { Editor, MarkdownView, Notice, normalizePath, Plugin, TFile } from "obsidian";
import { AUTHOR_OVERRIDE_KEY, detectOsUsername, FALLBACK_AUTHOR, resolveAuthorName } from "./author";
import { buildEditorExtension } from "./editor-extension";
import { buildExportNote, formatTs, renderExportFileName } from "./export";
import { registerReadingView } from "./reading-view";
import { CommentsSettingTab, CommentsSettings, DEFAULT_SETTINGS } from "./settings";
import { CommentSidebar, VIEW_TYPE_COMMENTS } from "./sidebar";
import { makeAnchor, parseDocument, resolveAll, resolveAnchor, serializeDocument } from "./store";
import type { Anchor, ParsedDoc } from "./types";

export default class CommentsPlugin extends Plugin {
  settings: CommentsSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.applyHighlightColor();

    this.registerView(VIEW_TYPE_COMMENTS, (leaf) => new CommentSidebar(leaf, this));
    this.registerEditorExtension(buildEditorExtension(this));
    registerReadingView(this);
    this.addSettingTab(new CommentsSettingTab(this.app, this));

    this.addCommand({
      id: "add-comment",
      name: "Add comment",
      editorCallback: (editor) => this.addCommentFromSelection(editor),
    });
    this.addCommand({
      id: "open-sidebar",
      name: "Open comment sidebar",
      callback: () => void this.openSidebar(),
    });
    this.addCommand({
      id: "toggle-resolved",
      name: "Toggle resolved comments",
      callback: () => void this.openSidebar().then((v) => v?.toggleResolved()),
    });
    this.addCommand({
      id: "purge-resolved",
      name: "Remove resolved comments from file",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return;
        void this.updateDoc(file, (d) => {
          let n = 0;
          for (const [id, c] of Object.entries(d.comments)) {
            if (c.status === "resolved") {
              delete d.comments[id];
              n++;
            }
          }
          new Notice(n > 0 ? `${n} resolved comment${n === 1 ? "" : "s"} removed.` : "No resolved comments in this file.");
        });
      },
    });

    this.addCommand({
      id: "export-comments",
      name: "Export comments of active file",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") {
          new Notice("No active Markdown file.");
          return;
        }
        void this.exportComments(file);
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        if (!editor.somethingSelected()) return;
        menu.addItem((item) =>
          item
            .setTitle("Add comment")
            .setIcon("message-square")
            .onClick(() => this.addCommentFromSelection(editor))
        );
      })
    );

    this.registerEvent(
      this.app.workspace.on("window-open", (win) => {
        win.doc.body.style.setProperty("--tc-highlight-color", this.settings.highlightColor);
      })
    );
  }

  onunload(): void {
    for (const doc of this.allDocuments()) {
      doc.body.style.removeProperty("--tc-highlight-color");
    }
  }

  async loadSettings(): Promise<void> {
    const data = ((await this.loadData()) as (Partial<CommentsSettings> & { authorName?: string }) | null) ?? {};
    const hadLegacy = "authorName" in data;
    this.migrateLegacyAuthorName(data);
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    // remove authorName from synced data if it was in there previously
    if (hadLegacy) await this.saveData(this.settings);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.applyHighlightColor();
  }

  /**
   * The author label attached to new comments/replies from this device: the
   * manual override if set, otherwise the detected OS account username, else a
   * generic fallback. See {@link resolveAuthorName}.
   */
  currentAuthor(): string {
    return resolveAuthorName(this.authorOverride(), detectOsUsername());
  }

  /** The name auto-detection would use — shown as the settings placeholder. */
  detectedAuthor(): string {
    return detectOsUsername() ?? FALLBACK_AUTHOR;
  }

  /** Device-local manual override for the author label ("" when unset). Never synced. */
  authorOverride(): string {
    const v = this.app.loadLocalStorage(AUTHOR_OVERRIDE_KEY);
    return typeof v === "string" ? v : "";
  }

  /** Persist the override to per-vault localStorage; an empty value clears it. */
  setAuthorOverride(value: string): void {
    const trimmed = value.trim();
    this.app.saveLocalStorage(AUTHOR_OVERRIDE_KEY, trimmed || null);
  }

  /**
   * One-time transition: the author name used to live in synced settings. Seed
   * it as this device's local override (unless one already exists) and drop it
   * from the settings object so it stops being synced.
   */
  private migrateLegacyAuthorName(data: { authorName?: string }): void {
    const legacy = data.authorName?.trim();
    if (legacy && legacy !== FALLBACK_AUTHOR && !this.authorOverride()) {
      this.setAuthorOverride(legacy);
    }
    delete data.authorName;
  }

  /** Haupt-Fenster + alle Popout-Fenster. */
  private allDocuments(): Set<Document> {
    const docs = new Set<Document>([activeDocument]);
    this.app.workspace.iterateAllLeaves((leaf) => docs.add(leaf.view.containerEl.ownerDocument));
    return docs;
  }

  applyHighlightColor(): void {
    for (const doc of this.allDocuments()) {
      doc.body.style.setProperty("--tc-highlight-color", this.settings.highlightColor);
    }
  }

  nowTs(): string {
    return new Date().toISOString();
  }

  async readDoc(file: TFile): Promise<ParsedDoc> {
    return parseDocument(await this.app.vault.read(file));
  }

  /** Alle Mutationen laufen hierdurch: read → parse → mutate → serialize → write. */
  async updateDoc(file: TFile, mutate: (doc: ParsedDoc) => void): Promise<boolean> {
    const raw = await this.app.vault.read(file);
    const doc = parseDocument(raw);
    if (doc.error) {
      new Notice("tandem-comments block is invalid — please fix the JSON: " + doc.error);
      return false;
    }
    mutate(doc);
    const out = serializeDocument(doc, this.settings.schemaHint);
    if (out !== raw) await this.app.vault.modify(file, out);
    return true;
  }

  /** Exportiert alle Kommentare der Datei als Notiz neben der Quelldatei (überschreibt bei erneutem Export). */
  async exportComments(file: TFile): Promise<void> {
    const doc = await this.readDoc(file);
    if (doc.error) {
      new Notice("tandem-comments block is invalid — please fix the JSON: " + doc.error);
      return;
    }
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const content = buildExportNote(file.basename, resolveAll(doc.prose, doc.comments), {
      scope: this.settings.exportScope,
      date,
      formatTs,
    });
    if (!content) {
      new Notice("No comments to export.");
      return;
    }
    const name = renderExportFileName(this.settings.exportNameTemplate, file.basename, date);
    const folder = file.parent && file.parent.path !== "/" ? file.parent.path + "/" : "";
    const path = normalizePath(folder + name + ".md");
    if (path === file.path) {
      new Notice("Export name matches the source file — change the template in settings.");
      return;
    }
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, content);
    else if (existing) {
      new Notice("Export target is a folder: " + path);
      return;
    } else await this.app.vault.create(path, content);
    new Notice("Comments exported to " + path);
  }

  addCommentFromSelection(editor: Editor): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    if (!editor.somethingSelected()) {
      new Notice("Select some text first.");
      return;
    }
    const from = editor.posToOffset(editor.getCursor("from"));
    const to = editor.posToOffset(editor.getCursor("to"));
    const doc = parseDocument(editor.getValue());
    if (to > doc.prose.length) {
      new Notice("Only prose can be commented (not the comment block).");
      return;
    }
    const anchor = makeAnchor(doc.prose, from, to);
    void this.openSidebar().then((view) => view?.startDraft(file, anchor));
  }

  /** Aktuelle Editor-Selektion als Anker (für Re-Anchoring von Orphans). */
  getProseSelection(file: TFile): { anchor: Anchor } | null {
    const leaf = this.app.workspace
      .getLeavesOfType("markdown")
      .find((l) => l.view instanceof MarkdownView && l.view.file?.path === file.path);
    if (!leaf) return null;
    const editor = (leaf.view as MarkdownView).editor;
    if (!editor.somethingSelected()) return null;
    const from = editor.posToOffset(editor.getCursor("from"));
    const to = editor.posToOffset(editor.getCursor("to"));
    const doc = parseDocument(editor.getValue());
    if (to > doc.prose.length || from === to) return null;
    return { anchor: makeAnchor(doc.prose, from, to) };
  }

  async openSidebar(focusId?: string): Promise<CommentSidebar | null> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_COMMENTS)[0];
    if (!leaf) {
      const right = workspace.getRightLeaf(false);
      if (!right) return null;
      leaf = right;
      await leaf.setViewState({ type: VIEW_TYPE_COMMENTS, active: true });
    }
    await workspace.revealLeaf(leaf);
    const view = leaf.view instanceof CommentSidebar ? leaf.view : null;
    if (view && focusId) view.focusComment(focusId);
    return view;
  }

  /** Scrollt im Markdown-Editor zur aufgelösten Anker-Stelle. */
  revealAnchor(file: TFile, anchor: Anchor): void {
    const leaf = this.app.workspace
      .getLeavesOfType("markdown")
      .find((l) => l.view instanceof MarkdownView && l.view.file?.path === file.path);
    if (!leaf) {
      new Notice("File is not open in any editor.");
      return;
    }
    const view = leaf.view as MarkdownView;
    void this.app.workspace.revealLeaf(leaf);
    const editor = view.editor;
    const doc = parseDocument(editor.getValue());
    const r = resolveAnchor(doc.prose, anchor);
    if (r.kind !== "resolved") {
      new Notice("Comment is orphaned — text passage not found.");
      return;
    }
    const fromPos = editor.offsetToPos(r.start);
    const toPos = editor.offsetToPos(r.end);
    editor.setSelection(fromPos, toPos);
    editor.scrollIntoView({ from: fromPos, to: toPos }, true);
  }
}
