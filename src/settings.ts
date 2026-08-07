import {
  AbstractInputSuggest,
  App,
  Notice,
  Platform,
  PluginSettingTab,
  Setting,
  TFolder,
} from "obsidian";
import {
  authorColorReadability,
  authorHue,
  hasAuthorColorOverride,
  renameAuthorColorOverride,
} from "./author-color";
import { renderExportFileName } from "./export";
import type CommentsPlugin from "./main";
import { formatPerfSnapshot, getPerfSnapshot, resetPerf, setPerfEnabled } from "./perf";
import {
  DEFAULT_SETTINGS,
  normalizeVaultFolderPath,
  validateExportNameTemplate,
  validateVaultFolderPath,
} from "./settings-model";
import { exportSkill } from "./skill-export";

class VaultFolderSuggest extends AbstractInputSuggest<TFolder> {
  protected getSuggestions(query: string): TFolder[] {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return this.app.vault
      .getAllFolders(true)
      .filter((folder) => {
        const label = folder.isRoot() ? "Vault root" : folder.path;
        return label.toLocaleLowerCase().includes(normalizedQuery);
      });
  }

  renderSuggestion(folder: TFolder, element: HTMLElement): void {
    element.setText(folder.isRoot() ? "Vault root" : folder.path);
  }
}

function renderColorReadability(container: HTMLElement, color: string): void {
  container.empty();
  const previews = container.createDiv({ cls: "tc-color-previews" });
  for (const theme of ["light", "dark"] as const) {
    const preview = previews.createSpan({
      text: theme === "light" ? "Aa Light" : "Aa Dark",
      cls: `tc-color-preview tc-color-preview-${theme}`,
    });
    preview.style.color = color;
  }
  const readability = authorColorReadability(color);
  if (!readability || readability.lowContrastThemes.length === 0) {
    container.createDiv({
      text: "Good contrast in standard light and dark themes.",
      cls: "tc-setting-success",
    });
    return;
  }
  const themes = readability.lowContrastThemes.join(" and ");
  container.createDiv({
    text: `Low contrast in the standard ${themes} theme${readability.lowContrastThemes.length === 1 ? "" : "s"}.`,
    cls: "tc-setting-warning",
  });
}

export class CommentsSettingTab extends PluginSettingTab {
  private authorColorsExpanded = false;

  constructor(app: App, private plugin: CommentsPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Identity & appearance").setHeading();

    const detected = this.plugin.detectedAuthor();
    new Setting(containerEl)
      .setName("Display name")
      .setDesc(
        `Name added to new comments on this device. Leave empty to use “${detected}”. ` +
          "This value is not synced, so collaborators can use their own names."
      )
      .addText((text) => {
        text
          .setPlaceholder(detected)
          .setValue(this.plugin.authorOverride())
          .onChange((value) => this.plugin.setAuthorOverride(value));
        text.inputEl.name = "tandem-comments-display-name";
        text.inputEl.autocomplete = "off";
        text.inputEl.spellcheck = false;
        text.inputEl.setAttr("aria-label", "Display name");
      });

    const highlightColorSetting = new Setting(containerEl)
      .setName("Highlight color")
      .setDesc("Color used for open review-thread highlights in the editor.")
      .addColorPicker((picker) => {
        picker.setValue(this.plugin.settings.highlightColor).onChange((value) =>
          this.plugin.updateSettings({ highlightColor: value })
        );
      });
    highlightColorSetting.controlEl
      .querySelector<HTMLInputElement>('input[type="color"]')
      ?.setAttr("aria-label", "Highlight color");

    new Setting(containerEl)
      .setName("Highlight opacity")
      .setDesc("Strength of the highlight background. The underline remains fully visible.")
      .addSlider((slider) => {
        slider.sliderEl.setAttr("aria-label", "Highlight opacity");
        slider
          .setLimits(10, 80, 5)
          .setValue(this.plugin.settings.highlightOpacity)
          .setDynamicTooltip()
          .onChange((value) => this.plugin.updateSettings({ highlightOpacity: value }));
      });

    new Setting(containerEl)
      .setName("Color author names")
      .setDesc("Give authors stable, theme-aware colors in the comment sidebar.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.colorAuthorNames).onChange(async (value) => {
          await this.plugin.updateSettings({ colorAuthorNames: value });
          this.redisplayPreservingScroll();
        })
      );

    if (this.plugin.settings.colorAuthorNames) this.renderAuthorColors(containerEl);

    new Setting(containerEl).setName("Review workflow").setHeading();

    new Setting(containerEl)
      .setName("Resolved review threads")
      .setDesc("Choose whether resolved comments and completed suggestions remain in the note as history.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("remove", "Remove immediately")
          .addOption("keep", "Keep as history")
          .setValue(this.plugin.settings.resolveBehavior)
          .onChange(async (value) => {
            const resolveBehavior = value === "keep" ? "keep" : "remove";
            await this.plugin.updateSettings({
              resolveBehavior,
              showResolvedByDefault:
                resolveBehavior === "keep" ? this.plugin.settings.showResolvedByDefault : false,
            });
            this.redisplayPreservingScroll();
          })
      );

    const showResolved = new Setting(containerEl)
      .setName("Show resolved by default")
      .setDesc(
        this.plugin.settings.resolveBehavior === "keep"
          ? "Show retained review history when the sidebar opens."
          : "Available when resolved review threads are kept as history."
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showResolvedByDefault)
          .setDisabled(this.plugin.settings.resolveBehavior !== "keep")
          .onChange((value) => this.plugin.updateSettings({ showResolvedByDefault: value }));
      });
    if (this.plugin.settings.resolveBehavior !== "keep") showResolved.setDisabled(true);

    new Setting(containerEl)
      .setName("Sidebar order")
      .setDesc("Order comments within the open, orphaned, and resolved sections.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("document", "Document position")
          .addOption("newest", "Newest activity first")
          .addOption("oldest", "Oldest activity first")
          .setValue(this.plugin.settings.sidebarSortOrder)
          .onChange((value) =>
            this.plugin.updateSettings({
              sidebarSortOrder:
                value === "newest" || value === "oldest" ? value : "document",
            })
          )
      );

    new Setting(containerEl)
      .setName("Submit comments with")
      .setDesc("Choose the keyboard shortcut used for comments, replies, suggestions, and edits.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("enter", "Enter")
          .addOption("mod-enter", "Cmd/Ctrl + Enter")
          .setValue(this.plugin.settings.submitShortcut)
          .onChange((value) =>
            this.plugin.updateSettings({ submitShortcut: value === "mod-enter" ? "mod-enter" : "enter" })
          )
      );

    new Setting(containerEl)
      .setName("Timestamp display")
      .setDesc("Choose how timestamps appear in the sidebar. Copies and exports keep their full timestamps.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("full", "Full date and time")
          .addOption("compact", "Compact date and time")
          .addOption("relative", "Relative time")
          .addOption("hidden", "Hidden")
          .setValue(this.plugin.settings.timestampDisplay)
          .onChange((value) =>
            this.plugin.updateSettings({
              timestampDisplay:
                value === "compact" || value === "relative" || value === "hidden"
                  ? value
                  : "full",
            })
          )
      );

    new Setting(containerEl)
      .setName("Confirm destructive actions")
      .setDesc("Ask before permanently deleting a comment, reply, suggestion, or resolved thread.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.confirmDestructiveActions)
          .onChange((value) => this.plugin.updateSettings({ confirmDestructiveActions: value }))
      );

    new Setting(containerEl).setName("Copy & export").setHeading();

    new Setting(containerEl)
      .setName("Include quote when copying")
      .setDesc("Include the quoted passage when the Copy menu action copies a review thread.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.copyIncludeQuote)
          .onChange((value) => this.plugin.updateSettings({ copyIncludeQuote: value }))
      );

    this.renderExportNameSetting(containerEl);

    new Setting(containerEl)
      .setName("Export scope")
      .setDesc("Choose which comments and suggestions are included in an exported review note.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("all", "Open, resolved, and orphaned")
          .addOption("open", "Open and orphaned only")
          .setValue(this.plugin.settings.exportScope)
          .onChange((value) =>
            this.plugin.updateSettings({ exportScope: value === "open" ? "open" : "all" })
          )
      );

    new Setting(containerEl)
      .setName("Export destination")
      .setDesc("Choose where exported review notes are saved inside the vault.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("source", "Next to the source note")
          .addOption("folder", "Selected vault folder")
          .setValue(this.plugin.settings.exportDestination)
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              exportDestination: value === "folder" ? "folder" : "source",
            });
            this.redisplayPreservingScroll();
          })
      );

    if (this.plugin.settings.exportDestination === "folder") {
      this.renderExportFolderSetting(containerEl);
    }

    new Setting(containerEl).setName("Advanced & integrations").setHeading();

    new Setting(containerEl)
      .setName("Reading View indicator")
      .setDesc("Show a comment-count pill below notes that contain open review threads.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showReadingViewIndicator)
          .onChange((value) => this.plugin.updateSettings({ showReadingViewIndicator: value }))
      );

    new Setting(containerEl)
      .setName("Include schema hints")
      .setDesc(
        "Add format instructions to the tandem-comments block for tools that read the Markdown directly. " +
          "Existing blocks update the next time a review thread changes."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.schemaHint)
          .onChange((value) => this.plugin.updateSettings({ schemaHint: value }))
      );

    if (Platform.isDesktopApp) {
      new Setting(containerEl)
        .setName("Claude Code skill")
        .setDesc("Write the bundled skill to ~/.claude/skills/obsidian-tandem-comments/SKILL.md.")
        .addButton((button) =>
          button.setButtonText("Export skill").onClick(() => {
            try {
              new Notice("Skill exported: " + exportSkill());
            } catch (error) {
              new Notice("Export failed: " + (error instanceof Error ? error.message : String(error)));
            }
          })
        );
    }

    new Setting(containerEl)
      .setName("Debug performance counters")
      .setDesc(
        "Off by default (zero overhead). When on, counts editor updates, parses, sidebar render/skip, " +
          "and decoration map vs rebuild; over-budget work logs to the developer console. " +
          "Use the command “Show performance counters” to print a snapshot."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.debugPerf).onChange(async (value) => {
          setPerfEnabled(value);
          if (value) resetPerf();
          await this.plugin.updateSettings({ debugPerf: value });
          this.redisplayPreservingScroll();
        })
      );

    if (this.plugin.settings.debugPerf) {
      new Setting(containerEl)
        .setName("Performance snapshot")
        .setDesc(formatPerfSnapshot(getPerfSnapshot()))
        .addButton((button) =>
          button.setButtonText("Reset counters").onClick(() => {
            resetPerf();
            this.redisplayPreservingScroll();
          })
        )
        .addButton((button) =>
          button.setButtonText("Copy snapshot").onClick(async () => {
            await navigator.clipboard.writeText(formatPerfSnapshot());
            new Notice("Performance snapshot copied.");
          })
        );
    }
  }

  private renderAuthorColors(containerEl: HTMLElement): void {
    const authorColorNames = Object.keys(this.plugin.settings.authorColorOverrides).sort((a, b) =>
      a.localeCompare(b)
    );
    const authorColors = containerEl.createEl("details", { cls: "tc-author-colors-collapse" });
    authorColors.open = this.authorColorsExpanded;
    authorColors.ontoggle = () => {
      this.authorColorsExpanded = authorColors.open;
    };
    const summary = authorColors.createEl("summary", { cls: "tc-author-colors-summary" });
    summary.createSpan({
      text: `Author color overrides${authorColorNames.length ? ` (${authorColorNames.length})` : ""}`,
    });
    const content = authorColors.createDiv({ cls: "tc-author-colors-content" });
    content.createDiv({
      text:
        "Authors receive an automatic accessible color. Add an override only when you need a specific color, " +
        "then use the previews to check it in light and dark themes.",
      cls: "tc-author-colors-description",
    });

    let newAuthor = "";
    let newColor = "#2680d9";
    let authorInput: HTMLInputElement | null = null;
    let updateNewColorReadability = (_color: string): void => undefined;
    const addAuthorRow = new Setting(content)
      .setName("Add author override")
      .setDesc("Enter the exact author name used in comment threads.")
      .addText((text) => {
        authorInput = text.inputEl;
        text.setPlaceholder("Author name…").onChange((value) => {
          newAuthor = value;
          if (value.trim()) validationEl.empty();
        });
        text.inputEl.name = "tandem-author-color-name";
        text.inputEl.autocomplete = "off";
        text.inputEl.spellcheck = false;
        text.inputEl.setAttr("aria-label", "Author name for color override");
      })
      .addColorPicker((picker) => {
        picker.setValue(newColor).onChange((value) => {
          newColor = value;
          updateNewColorReadability(value);
        });
      })
      .addButton((button) =>
        button.setButtonText("Add override").setCta().onClick(async () => {
          const author = newAuthor.trim();
          if (!author) {
            validationEl.setText("Enter an author name before adding an override.");
            authorInput?.focus();
            return;
          }
          if (hasAuthorColorOverride(this.plugin.settings.authorColorOverrides, author)) {
            validationEl.setText(`An override for ${author} already exists. Edit it below.`);
            authorInput?.focus();
            return;
          }
          await this.plugin.updateSettings({
            authorColorOverrides: {
              ...this.plugin.settings.authorColorOverrides,
              [author]: newColor,
            },
          });
          this.redisplayPreservingScroll();
        })
      );
    const validationEl = addAuthorRow.descEl.createDiv({
      cls: "tc-setting-error",
      attr: { "aria-live": "polite" },
    });
    const newColorReadabilityEl = addAuthorRow.descEl.createDiv({
      cls: "tc-color-readability",
      attr: { "aria-live": "polite" },
    });
    updateNewColorReadability = (color) => renderColorReadability(newColorReadabilityEl, color);
    updateNewColorReadability(newColor);
    addAuthorRow.controlEl
      .querySelector<HTMLInputElement>('input[type="color"]')
      ?.setAttr("aria-label", "Color for new author override");

    if (authorColorNames.length > 0) {
      content.createDiv({ text: "Existing overrides", cls: "tc-author-colors-list-title" });
    }
    for (const author of authorColorNames) {
      const currentColor = String(this.plugin.settings.authorColorOverrides[author]);
      let updateReadability = (_color: string): void => undefined;
      const row = new Setting(content)
        .setClass("tc-author-color-row")
        .setDesc(`Automatic hue: ${authorHue(author)}°.`)
        .addColorPicker((picker) =>
          picker
            .setValue(currentColor)
            .onChange((value) => {
              updateReadability(value);
              return this.plugin.updateSettings({
                authorColorOverrides: {
                  ...this.plugin.settings.authorColorOverrides,
                  [author]: value,
                },
              });
            })
        )
        .addButton((button) =>
          button
            .setButtonText("Reset")
            .setTooltip(`Reset ${author} to its automatic color`)
            .onClick(async () => {
              const overrides = { ...this.plugin.settings.authorColorOverrides };
              delete overrides[author];
              await this.plugin.updateSettings({ authorColorOverrides: overrides });
              this.redisplayPreservingScroll();
            })
        );
      const nameInput = row.nameEl.createEl("input", {
        cls: "tc-author-color-name",
        attr: {
          type: "text",
          name: `tandem-author-color-${author}`,
          autocomplete: "off",
          spellcheck: "false",
          "aria-label": `Author name for ${author} color override`,
        },
      });
      nameInput.value = author;
      const renameError = row.descEl.createDiv({
        cls: "tc-setting-error",
        attr: { "aria-live": "polite" },
      });
      const readabilityEl = row.descEl.createDiv({
        cls: "tc-color-readability",
        attr: { "aria-live": "polite" },
      });
      updateReadability = (color) => renderColorReadability(readabilityEl, color);
      updateReadability(currentColor);
      nameInput.oninput = () => renameError.empty();
      nameInput.onchange = () => {
        const result = renameAuthorColorOverride(
          this.plugin.settings.authorColorOverrides,
          author,
          nameInput.value
        );
        if (!result.ok) {
          renameError.setText(
            result.reason === "empty"
              ? "Enter an author name."
              : `An override for ${nameInput.value.trim()} already exists.`
          );
          nameInput.focus();
          return;
        }
        void this.plugin.updateSettings({ authorColorOverrides: result.overrides }).then(() =>
          this.redisplayPreservingScroll()
        );
      };
      nameInput.onkeydown = (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          nameInput.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          nameInput.value = author;
          renameError.empty();
          nameInput.blur();
        }
      };
      row.controlEl
        .querySelector<HTMLInputElement>('input[type="color"]')
        ?.setAttr("aria-label", `Color for ${author}`);
    }
  }

  private renderExportNameSetting(containerEl: HTMLElement): void {
    let draft = this.plugin.settings.exportNameTemplate;
    const row = new Setting(containerEl)
      .setName("Export note name")
      .setDesc("Use {{filename}} and {{date}} as placeholders. Tandem Comments adds the .md extension.")
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.exportNameTemplate)
          .setValue(draft)
          .onChange((value) => {
            draft = value;
            renderFeedback();
          });
        text.inputEl.name = "tandem-comments-export-name";
        text.inputEl.autocomplete = "off";
        text.inputEl.spellcheck = false;
        text.inputEl.setAttr("aria-label", "Export note name");
        text.inputEl.onblur = () => void save();
        text.inputEl.onkeydown = (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            text.inputEl.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            draft = this.plugin.settings.exportNameTemplate;
            text.setValue(draft);
            renderFeedback();
            text.inputEl.blur();
          }
        };
      });
    const errorEl = row.descEl.createDiv({ cls: "tc-setting-error", attr: { "aria-live": "polite" } });
    const previewEl = row.descEl.createDiv({ cls: "tc-setting-preview", attr: { "aria-live": "polite" } });

    const renderFeedback = (): void => {
      const error = validateExportNameTemplate(draft);
      const now = new Date();
      const date = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
      ].join("-");
      errorEl.setText(error ?? "");
      previewEl.setText(
        error
          ? ""
          : `Example: ${renderExportFileName(draft, "My note", date)}.md`
      );
    };
    const save = async (): Promise<void> => {
      const error = validateExportNameTemplate(draft);
      if (error) {
        errorEl.setText(error);
        return;
      }
      const value = draft.trim();
      if (value !== this.plugin.settings.exportNameTemplate) {
        await this.plugin.updateSettings({ exportNameTemplate: value });
      }
    };
    renderFeedback();
  }

  private renderExportFolderSetting(containerEl: HTMLElement): void {
    let draft = this.plugin.settings.exportFolder;
    let setInputValue = (_value: string): void => undefined;
    const row = new Setting(containerEl)
      .setName("Export folder")
      .setDesc("Choose an existing folder. Leave empty to use the vault root.")
      .addText((text) => {
        text
          .setPlaceholder("Vault root")
          .setValue(draft)
          .onChange((value) => {
            draft = value;
            renderFeedback();
          });
        setInputValue = (value) => text.setValue(value);
        text.inputEl.name = "tandem-comments-export-folder";
        text.inputEl.autocomplete = "off";
        text.inputEl.spellcheck = false;
        text.inputEl.setAttr("aria-label", "Export folder");
        text.inputEl.onblur = () => void save();
        text.inputEl.onkeydown = (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            text.inputEl.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            draft = this.plugin.settings.exportFolder;
            text.setValue(draft);
            renderFeedback();
            text.inputEl.blur();
          }
        };
        new VaultFolderSuggest(this.app, text.inputEl).onSelect((folder) => {
          draft = folder.isRoot() ? "" : folder.path;
          text.setValue(draft);
          renderFeedback();
          void save();
        });
      });
    const errorEl = row.descEl.createDiv({ cls: "tc-setting-error", attr: { "aria-live": "polite" } });
    const previewEl = row.descEl.createDiv({ cls: "tc-setting-preview", attr: { "aria-live": "polite" } });

    const errorForDraft = (): string | null => {
      const pathError = validateVaultFolderPath(draft);
      if (pathError) return pathError;
      const path = normalizeVaultFolderPath(draft);
      if (path && !this.app.vault.getFolderByPath(path)) return "Choose an existing vault folder.";
      return null;
    };
    const renderFeedback = (): void => {
      const error = errorForDraft();
      const path = normalizeVaultFolderPath(draft);
      errorEl.setText(error ?? "");
      previewEl.setText(error ? "" : `Exports to: ${path || "Vault root"}`);
    };
    const save = async (): Promise<void> => {
      const error = errorForDraft();
      if (error) {
        errorEl.setText(error);
        return;
      }
      const value = normalizeVaultFolderPath(draft);
      draft = value;
      setInputValue(value);
      if (value !== this.plugin.settings.exportFolder) {
        await this.plugin.updateSettings({ exportFolder: value });
      }
      renderFeedback();
    };
    renderFeedback();
  }

  private redisplayPreservingScroll(): void {
    const scrollEl =
      this.containerEl.closest<HTMLElement>(".vertical-tab-content-container") ?? this.containerEl;
    const scrollTop = scrollEl.scrollTop;
    this.display();
    window.requestAnimationFrame(() => {
      scrollEl.scrollTop = scrollTop;
    });
  }
}
