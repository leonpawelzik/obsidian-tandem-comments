import { MarkdownRenderChild } from "obsidian";
import type CommentsPlugin from "./main";
import { parseBlockBody } from "./store";

/**
 * Live Preview: Block komplett unsichtbar — Kommentare erscheinen dort nur als
 * Highlights + Sidebar; die Normalisierung hält den Block am Dateiende.
 * Reading View: „💬 N"-Pille als Indikator und Sidebar-Öffner.
 */
export function registerReadingView(plugin: CommentsPlugin): void {
  plugin.registerMarkdownCodeBlockProcessor("tandem-comments", (source, el, ctx) => {
    // Der LP-/Reading-View-Check braucht das angehängte DOM — daher als
    // RenderChild, dessen onload nach dem Einhängen läuft.
    ctx.addChild(new BlockPill(el, source, plugin));
  });
}

class BlockPill extends MarkdownRenderChild {
  private unloaded = false;

  constructor(
    containerEl: HTMLElement,
    readonly source: string,
    readonly plugin: CommentsPlugin
  ) {
    super(containerEl);
  }

  onload(): void {
    this.render();
  }

  onunload(): void {
    this.unloaded = true;
  }

  render(): void {
    const el = this.containerEl;
    el.empty();
    // Beim Moduswechsel (Cmd+E) kann onload feuern, bevor das Element im DOM
    // hängt — dann liefert closest() nichts. Einen Frame warten und neu prüfen.
    if (!el.isConnected) {
      requestAnimationFrame(() => {
        if (!this.unloaded) this.render();
      });
      return;
    }
    // Pille nur bei positivem Reading-View-Beleg rendern; im Zweifel
    // unsichtbar — eine fälschliche Pille fällt in Live Preview auf,
    // eine fehlende in der Reading View wird beim nächsten Render geheilt.
    if (!el.closest(".markdown-preview-view")) {
      const widget = el.closest(".cm-embed-block");
      if (widget instanceof HTMLElement) widget.addClass("tc-lp-hidden");
      return;
    }
    let open = 0;
    let resolved = 0;
    try {
      for (const c of Object.values(parseBlockBody(this.source))) {
        if (c.status === "resolved") resolved++;
        else open++;
      }
    } catch {
      el.createDiv({ text: "💬 tandem-comments — invalid JSON", cls: "tc-pill tc-pill-error" });
      return;
    }
    // Nur erledigte Historie übrig → in der Reading-View komplett unsichtbar.
    if (open === 0) return;
    const label =
      resolved > 0 ? `💬 ${open} open · ${resolved} resolved` : `💬 ${open} comment${open === 1 ? "" : "s"}`;
    const pill = el.createEl("button", { text: label, cls: "tc-pill" });
    pill.onclick = () => void this.plugin.openSidebar();
  }
}
