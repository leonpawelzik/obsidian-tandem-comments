import { App, Notice, PluginSettingTab, Setting } from "obsidian";
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
}

export const DEFAULT_SETTINGS: CommentsSettings = {
  highlightColor: "#ffd54a",
  showResolvedByDefault: false,
  resolveBehavior: "remove",
  schemaHint: true,
  copyIncludeQuote: true,
  exportNameTemplate: "{{filename}} – Comments",
  exportScope: "all",
};

export class CommentsSettingTab extends PluginSettingTab {
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
      .setDesc("Color for open comment highlights in the text.")
      .addColorPicker((c) =>
        c.setValue(this.plugin.settings.highlightColor).onChange(async (v) => {
          this.plugin.settings.highlightColor = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show resolved by default")
      .setDesc("Show resolved comments in the sidebar without using the toggle.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showResolvedByDefault).onChange(async (v) => {
          this.plugin.settings.showResolvedByDefault = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Resolve behavior")
      .setDesc("What happens when you resolve a comment. \"Remove entirely\" keeps Markdown files clean (default).")
      .addDropdown((d) =>
        d
          .addOption("remove", "Remove entirely on resolve")
          .addOption("keep", "Keep entry as history")
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
      .setDesc("Copy the quoted passage along with the comment text when using the Copy button.")
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
      .setDesc("Which comments to include when exporting a file's comments.")
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
