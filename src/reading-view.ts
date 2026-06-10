import type CommentsPlugin from "./main";
import { parseBlockBody } from "./store";

/** Rendert den tandem-comments-Block in der Reading-View als „💬 N"-Pille statt JSON. */
export function registerReadingView(plugin: CommentsPlugin): void {
  plugin.registerMarkdownCodeBlockProcessor("tandem-comments", (source, el) => {
    el.empty();
    let open = 0;
    let resolved = 0;
    try {
      for (const c of Object.values(parseBlockBody(source))) {
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
    pill.onclick = () => void plugin.openSidebar();
  });
}
