import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import {
  authorHue,
  hasAuthorColorOverride,
  renameAuthorColorOverride,
  type AuthorColorOverrides,
} from "./author-color";
import type CommentsPlugin from "./main";
import { exportSkill } from "./skill-export";

export interface CommentsSettings {
  highlightColor: string;
  showResolvedByDefault: boolean;
  resolveBehavior: "keep" | "remove";
  schemaHint: boolean;
  copyIncludeQuote: boolean;
  exportNameTemplate: string;
  exportScope: "all" | "open";
  authorColorOverrides: AuthorColorOverrides;
}

export const DEFAULT_SETTINGS: CommentsSettings = {
  highlightColor: "#ffd54a",
  showResolvedByDefault: false,
  resolveBehavior: "remove",
  schemaHint: true,
  copyIncludeQuote: true,
  exportNameTemplate: "{{filename}} – Comments",
  exportScope: "all",
  authorColorOverrides: {},
};

export class CommentsSettingTab extends PluginSettingTab {
  private authorColorsExpanded = false;

  constructor(app: App, private plugin: CommentsPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const detected = this.plugin.detectedAuthor();
    new Setting(containerEl)
      .setName("Display name")
      .setDesc(
        `Author label for your comments. Leave empty to use your detected account name ("${detected}"). ` +
          "Stored per device and not synced, so collaborators sharing this vault keep separate names."
      )
      .addText((t) =>
        t
          .setPlaceholder(detected)
          .setValue(this.plugin.authorOverride())
          .onChange((v) => this.plugin.setAuthorOverride(v))
      );

    new Setting(containerEl)
      .setName("Highlight color")
      .setDesc("Color for open review-thread highlights in the text.")
      .addColorPicker((c) =>
        c.setValue(this.plugin.settings.highlightColor).onChange(async (v) => {
          this.plugin.settings.highlightColor = v;
          await this.plugin.saveSettings();
        })
      );

    const authorColors = containerEl.createEl("details", { cls: "tc-author-colors-collapse" });
    authorColors.open = this.authorColorsExpanded;
    authorColors.ontoggle = () => {
      this.authorColorsExpanded = authorColors.open;
    };
    const authorColorNames = Object.keys(this.plugin.settings.authorColorOverrides).sort((a, b) =>
      a.localeCompare(b)
    );
    const summary = authorColors.createEl("summary", { cls: "tc-author-colors-summary" });
    summary.createSpan({ text: "Author Colors" });
    const authorColorsContent = authorColors.createDiv({ cls: "tc-author-colors-content" });
    authorColorsContent.createDiv({
      text:
        "Unknown authors receive an automatic accessible color. Manual overrides use the exact selected color " +
        "in both light and dark themes.",
      cls: "tc-author-colors-description",
    });

    let newAuthor = "";
    let newColor = "#2680d9";
    let authorInput: HTMLInputElement | null = null;
    const addAuthorRow = new Setting(authorColorsContent)
      .setName("Add author override")
      .setDesc("Enter the exact author name used in comment threads.")
      .addText((text) => {
        authorInput = text.inputEl;
        text
          .setPlaceholder("Author name…")
          .onChange((value) => {
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
        });
      })
      .addButton((button) =>
        button.setButtonText("Add Override").setCta().onClick(async () => {
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
          this.plugin.settings.authorColorOverrides = {
            ...this.plugin.settings.authorColorOverrides,
            [author]: newColor,
          };
          await this.plugin.saveSettings();
          this.plugin.refreshAuthorColors();
          this.display();
        })
      );
    const validationEl = addAuthorRow.descEl.createDiv({
      cls: "tc-setting-error",
      attr: { "aria-live": "polite" },
    });
    addAuthorRow.controlEl
      .querySelector<HTMLInputElement>('input[type="color"]')
      ?.setAttr("aria-label", "Color hue for new author override");

    if (authorColorNames.length > 0) {
      authorColorsContent.createDiv({ text: "Existing overrides", cls: "tc-author-colors-list-title" });
    }
    for (const author of authorColorNames) {
      const row = new Setting(authorColorsContent)
        .setClass("tc-author-color-row")
        .setDesc(`Automatic hue: ${authorHue(author)}°.`)
        .addColorPicker((picker) =>
          picker
            .setValue(String(this.plugin.settings.authorColorOverrides[author]))
            .onChange(async (value) => {
              this.plugin.settings.authorColorOverrides = {
                ...this.plugin.settings.authorColorOverrides,
                [author]: value,
              };
              await this.plugin.saveSettings();
              this.plugin.refreshAuthorColors();
            })
        )
        .addButton((button) =>
          button
            .setButtonText("Reset")
            .setTooltip(`Reset ${author} to its automatic color`)
            .onClick(async () => {
              const overrides = { ...this.plugin.settings.authorColorOverrides };
              delete overrides[author];
              this.plugin.settings.authorColorOverrides = overrides;
              await this.plugin.saveSettings();
              this.plugin.refreshAuthorColors();
              this.display();
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
        this.plugin.settings.authorColorOverrides = result.overrides;
        void this.plugin.saveSettings().then(() => {
          this.plugin.refreshAuthorColors();
          this.display();
        });
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
        ?.setAttr("aria-label", `Color hue for ${author}`);
    }

    new Setting(containerEl)
      .setName("Show resolved by default")
      .setDesc("Show resolved comments and suggestions in the sidebar without using the toggle.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showResolvedByDefault).onChange(async (v) => {
          this.plugin.settings.showResolvedByDefault = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Resolve behavior")
      .setDesc(
        "What happens when you resolve a comment or accept/decline a suggestion. " +
          "\"Remove entirely\" keeps Markdown files clean (default)."
      )
      .addDropdown((d) =>
        d
          .addOption("remove", "Remove resolved entries entirely")
          .addOption("keep", "Keep resolved entries as history")
          .setValue(this.plugin.settings.resolveBehavior)
          .onChange(async (v) => {
            this.plugin.settings.resolveBehavior = v === "remove" ? "remove" : "keep";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Schema hint in block")
      .setDesc("Writes two //-comment lines with the format rules at the top of the block (travels with each file).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.schemaHint).onChange(async (v) => {
          this.plugin.settings.schemaHint = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Include quote when copying")
      .setDesc("Copy the quoted passage along with the review thread when using the Copy button.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.copyIncludeQuote).onChange(async (v) => {
          this.plugin.settings.copyIncludeQuote = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Export note name")
      .setDesc("Name of the exported note. Placeholders: {{filename}}, {{date}}. The note is created next to the source file and overwritten on re-export.")
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.exportNameTemplate)
          .setValue(this.plugin.settings.exportNameTemplate)
          .onChange(async (v) => {
            this.plugin.settings.exportNameTemplate = v.trim() || DEFAULT_SETTINGS.exportNameTemplate;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Export scope")
      .setDesc("Which comments and suggestions to include when exporting a file's review threads.")
      .addDropdown((d) =>
        d
          .addOption("all", "All (open, resolved, orphaned)")
          .addOption("open", "Open only")
          .setValue(this.plugin.settings.exportScope)
          .onChange(async (v) => {
            this.plugin.settings.exportScope = v === "open" ? "open" : "all";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Export Claude skill")
      .setDesc("Writes the bundled skill file to ~/.claude/skills/obsidian-tandem-comments/SKILL.md")
      .addButton((b) =>
        b.setButtonText("Export").onClick(() => {
          try {
            new Notice("Skill exported: " + exportSkill());
          } catch (e) {
            new Notice("Export failed: " + (e instanceof Error ? e.message : String(e)));
          }
        })
      );
  }
}
