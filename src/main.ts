import type { EditorView } from "@codemirror/view";
import { PendingAnchorSaves } from "./pending-anchor-saves";
import { editorInfoField, Editor, MarkdownView, Notice, normalizePath, Plugin, TFile } from "obsidian";
import {
  AUTHOR_OVERRIDE_KEY,
  detectOsUsername,
  FALLBACK_AUTHOR,
  LEGACY_AUTHOR_OVERRIDE_KEY,
  resolveAuthorName,
} from "./author";
import { confirmAction } from "./confirm-action";
import { buildEditorExtension, type AnchorSaveTarget } from "./editor-extension";
import {
  buildExportNote,
  formatTs,
  renderExportFileName,
  resolveExportDirectory,
} from "./export";
import { registerReadingView } from "./reading-view";
import { CommentsSettingTab } from "./settings";
import {
  type CommentsSettings,
  DEFAULT_SETTINGS,
  parseCommentsSettings,
  settingsEffects,
} from "./settings-model";
import { CommentSidebar, VIEW_TYPE_COMMENTS } from "./sidebar";
import { commitSuggestionAcceptance } from "./suggestion-editor";
import {
  type SuggestionAcceptancePlan,
  makeAnchor,
  parseDocument,
  planSuggestionAcceptance,
  resolveAll,
  resolveAnchor,
  serializeDocument,
} from "./store";
import type { Anchor, ParsedDoc } from "./types";

export default class CommentsPlugin extends Plugin {
  settings: CommentsSettings = DEFAULT_SETTINGS;
  private applyingSuggestion = false;
  private anchorSaves = new PendingAnchorSaves<TFile>((file, update) => this.app.vault.process(file, update));
  private settingsWriteQueue: Promise<void> = Promise.resolve();

  captureAnchorSave(view: EditorView, previous?: AnchorSaveTarget): AnchorSaveTarget | undefined {
    const file = view.state.field(editorInfoField, false)?.file;
    if (!file) return;
    if (previous?.key === file) return previous;
    return { key: file, save: (before, after) => {
      void this.anchorSaves.queue(file, before, after).catch((error) => console.error("Tandem anchor save failed", error));
    } };
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile) void this.anchorSaves.modified(file).catch((error) => console.error("Tandem anchor save failed", error));
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file instanceof TFile) this.anchorSaves.forget(file);
    }));
    this.applyHighlightAppearance();
    this.applyReadingViewPreference();

    this.registerHoverLinkSource(this.manifest.id, {
      display: this.manifest.name,
      defaultMod: false,
    });
    this.registerView(VIEW_TYPE_COMMENTS, (leaf) => new CommentSidebar(leaf, this));
    this.registerEditorExtension(buildEditorExtension(this));
    registerReadingView(this);
    this.addSettingTab(new CommentsSettingTab(this.app, this));

    this.addCommand({
      id: "add-comment",
      name: "Add comment",
      icon: "message-square-plus",
      editorCallback: (editor) => this.addCommentFromSelection(editor),
    });
    this.addCommand({
      id: "suggest-edit",
      name: "Suggest edit",
      icon: "replace",
      editorCallback: (editor) => this.addSuggestionFromSelection(editor),
    });
    this.addCommand({
      id: "open-sidebar",
      name: "Open comment sidebar",
      icon: "message-square",
      callback: () => void this.openSidebar(),
    });
    this.addCommand({
      id: "toggle-resolved",
      name: "Toggle resolved threads",
      icon: "check-check",
      callback: () => void this.openSidebar().then((v) => v?.toggleResolved()),
    });
    this.addCommand({
      id: "purge-resolved",
      name: "Remove resolved threads from file",
      icon: "trash-2",
      callback: () => void this.removeResolvedThreads(),
    });

    this.addCommand({
      id: "export-comments",
      name: "Export review threads of active file",
      icon: "file-output",
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
        menu.addItem((item) =>
          item
            .setTitle("Suggest edit")
            .setIcon("replace")
            .onClick(() => this.addSuggestionFromSelection(editor))
        );
      })
    );

    this.registerEvent(
      this.app.workspace.on("window-open", (win) => {
        this.applyHighlightAppearanceTo(win.doc);
        this.applyReadingViewPreferenceTo(win.doc);
      })
    );
  }

  onunload(): void {
    this.anchorSaves.clear();
    for (const doc of this.allDocuments()) {
      doc.body.style.removeProperty("--tc-highlight-color");
      doc.body.style.removeProperty("--tc-highlight-opacity");
      doc.body.classList.remove("tc-hide-reading-indicator");
    }
  }

  async loadSettings(): Promise<void> {
    const parsed = parseCommentsSettings(await this.loadData());
    this.migrateLegacyAuthorName(parsed.legacyAuthorName);
    this.settings = parsed.settings;
    if (parsed.changed) await this.saveData(this.settings);
  }

  async updateSettings(patch: Partial<CommentsSettings>): Promise<void> {
    const previous = this.settings;
    const next = parseCommentsSettings({ ...previous, ...patch }).settings;
    this.settings = next;
    const write = this.settingsWriteQueue
      .catch(() => undefined)
      .then(() => this.saveData(next));
    this.settingsWriteQueue = write;
    await write;
    const effects = settingsEffects(previous, next);
    if (effects.refreshHighlights) this.applyHighlightAppearance();
    if (effects.refreshAuthorColors) this.refreshAuthorColors();
    if (effects.refreshReadingViewIndicator) this.applyReadingViewPreference();
    if (effects.refreshSidebar) {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_COMMENTS)) {
        if (leaf.view instanceof CommentSidebar) {
          leaf.view.settingsChanged(effects.resetResolvedVisibility);
        }
      }
    }
  }

  private async removeResolvedThreads(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return;
    if (
      this.settings.confirmDestructiveActions &&
      !(await confirmAction(this.app, {
        title: "Remove resolved threads?",
        message: "This will permanently remove every resolved review thread from the active note.",
        confirmLabel: "Remove threads",
      }))
    ) {
      return;
    }
    await this.updateDoc(file, (doc) => {
      let count = 0;
      for (const [id, comment] of Object.entries(doc.comments)) {
        if (comment.status === "resolved") {
          delete doc.comments[id];
          count++;
        }
      }
      new Notice(
        count > 0
          ? `${count} resolved thread${count === 1 ? "" : "s"} removed.`
          : "No resolved threads in this file."
      );
    });
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
  private migrateLegacyAuthorName(syncedAuthorName?: string): void {
    const current = this.app.loadLocalStorage(AUTHOR_OVERRIDE_KEY);
    const oldLocal = this.app.loadLocalStorage(LEGACY_AUTHOR_OVERRIDE_KEY);
    const legacy =
      typeof oldLocal === "string" && oldLocal.trim()
        ? oldLocal.trim()
        : syncedAuthorName?.trim();
    if (typeof current !== "string" && legacy && legacy !== FALLBACK_AUTHOR) {
      this.app.saveLocalStorage(AUTHOR_OVERRIDE_KEY, legacy);
    }
    if (oldLocal !== null) this.app.saveLocalStorage(LEGACY_AUTHOR_OVERRIDE_KEY, null);
  }

  /** Haupt-Fenster + alle Popout-Fenster. */
  private allDocuments(): Set<Document> {
    const docs = new Set<Document>([activeDocument]);
    this.app.workspace.iterateAllLeaves((leaf) => docs.add(leaf.view.containerEl.ownerDocument));
    return docs;
  }

  applyHighlightAppearance(): void {
    for (const doc of this.allDocuments()) {
      this.applyHighlightAppearanceTo(doc);
    }
  }

  private applyHighlightAppearanceTo(doc: Document): void {
    doc.body.style.setProperty("--tc-highlight-color", this.settings.highlightColor);
    doc.body.style.setProperty("--tc-highlight-opacity", `${this.settings.highlightOpacity}%`);
  }

  private applyReadingViewPreference(): void {
    for (const doc of this.allDocuments()) this.applyReadingViewPreferenceTo(doc);
  }

  private applyReadingViewPreferenceTo(doc: Document): void {
    doc.body.classList.toggle(
      "tc-hide-reading-indicator",
      !this.settings.showReadingViewIndicator
    );
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

  /** Exportiert alle Kommentare der Datei als Notiz und überschreibt sie bei erneutem Export. */
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
      new Notice("No review threads to export.");
      return;
    }
    const name = renderExportFileName(this.settings.exportNameTemplate, file.basename, date);
    const folder = resolveExportDirectory(
      file.parent?.path ?? null,
      this.settings.exportDestination,
      this.settings.exportFolder
    );
    const targetFolder = folder
      ? this.app.vault.getFolderByPath(normalizePath(folder))
      : this.app.vault.getRoot();
    if (!targetFolder) {
      new Notice("The selected export folder no longer exists. Choose another folder in settings.");
      return;
    }
    const path = normalizePath((folder ? folder + "/" : "") + name + ".md");
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
    new Notice("Review threads exported to " + path);
  }

  addCommentFromSelection(editor: Editor): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    const anchor = this.anchorFromSelection(editor);
    if (!anchor) return;
    void this.openSidebar().then((view) => view?.startDraft(file, anchor));
  }

  addSuggestionFromSelection(editor: Editor): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    const anchor = this.anchorFromSelection(editor);
    if (!anchor) return;
    void this.openSidebar().then((view) => view?.startSuggestionDraft(file, anchor));
  }

  private anchorFromSelection(editor: Editor): Anchor | null {
    if (!editor.somethingSelected()) {
      new Notice("Select some text first.");
      return null;
    }
    const from = editor.posToOffset(editor.getCursor("from"));
    const to = editor.posToOffset(editor.getCursor("to"));
    const doc = parseDocument(editor.getValue());
    if (to > doc.prose.length) {
      new Notice("Only prose can be commented or suggested (not the comment block).");
      return null;
    }
    return makeAnchor(doc.prose, from, to);
  }

  private editorForFile(file: TFile): Editor | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file?.path === file.path) return active.editor;
    const leaf = this.app.workspace
      .getLeavesOfType("markdown")
      .find((l) => l.view instanceof MarkdownView && l.view.file?.path === file.path);
    return leaf ? (leaf.view as MarkdownView).editor : null;
  }

  /**
   * Applies the prose replacement and comment-block mutation as one editor
   * transaction, so a single Undo restores both the text and the suggestion.
   */
  isApplyingSuggestion(): boolean {
    return this.applyingSuggestion;
  }

  acceptEditSuggestion(file: TFile, id: string): SuggestionAcceptancePlan {
    const editor = this.editorForFile(file);
    if (!editor) return { ok: false, reason: "no-editor" };
    const raw = editor.getValue();
    const plan = planSuggestionAcceptance(
      raw,
      id,
      this.settings.resolveBehavior,
      this.settings.schemaHint
    );
    if (!plan.ok) return plan;
    this.applyingSuggestion = true;
    try {
      commitSuggestionAcceptance(editor, plan);
    } finally {
      this.applyingSuggestion = false;
    }
    return plan;
  }

  /** Aktuelle Editor-Selektion als Anker (für Re-Anchoring von Orphans). */
  getProseSelection(file: TFile): { anchor: Anchor } | null {
    const editor = this.editorForFile(file);
    if (!editor) return null;
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

  refreshAuthorColors(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_COMMENTS)) {
      if (leaf.view instanceof CommentSidebar) leaf.view.refreshAuthorColors();
    }
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
      new Notice("Thread is orphaned — text passage not found.");
      return;
    }
    const fromPos = editor.offsetToPos(r.start);
    const toPos = editor.offsetToPos(r.end);
    editor.setSelection(fromPos, toPos);
    editor.scrollIntoView({ from: fromPos, to: toPos }, true);
  }
}
