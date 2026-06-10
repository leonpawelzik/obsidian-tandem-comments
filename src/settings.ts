import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type CommentsPlugin from "./main";
import { exportSkill } from "./skill-export";

export interface CommentsSettings {
  authorName: string;
  highlightColor: string;
  showResolvedByDefault: boolean;
  resolveBehavior: "keep" | "remove";
  schemaHint: boolean;
}

export const DEFAULT_SETTINGS: CommentsSettings = {
  authorName: "Me",
  highlightColor: "#ffd54a",
  showResolvedByDefault: false,
  resolveBehavior: "remove",
  schemaHint: true,
};

export class CommentsSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: CommentsPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Display name")
      .setDesc("Author label for your comments.")
      .addText((t) =>
        t.setValue(this.plugin.settings.authorName).onChange(async (v) => {
          this.plugin.settings.authorName = v.trim() || DEFAULT_SETTINGS.authorName;
          await this.plugin.saveSettings();
        })
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
