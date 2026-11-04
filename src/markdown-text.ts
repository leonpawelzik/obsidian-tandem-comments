/** Hilfsfunktionen für Markdown-Quelltext, geteilt von Tabellen- und Callout-Highlights. */

export interface Line {
  text: string;
  from: number;
}

export function splitLines(text: string, limit: number): Line[] {
  const lines: Line[] = [];
  let from = 0;
  for (const part of text.slice(0, limit).split("\n")) {
    lines.push({ text: part, from });
    from += part.length + 1; // +1 für das entfernte "\n"
  }
  return lines;
}

/**
 * Sichtbarer Text einer Inline-Markdown-Spanne — Syntax wird entfernt, sodass
 * er dem gerenderten textContent der Zelle entspricht (z.B. `**Preis**` → `Preis`).
 * Der Anker-`exact` stammt aus dem Quelltext (mit Syntax); im Tabellen-DOM steht
 * aber nur der gerenderte Text, daher muss danach gesucht werden.
 */
export function visibleText(md: string): string {
  return md
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2") // [[Ziel|Alias]] → Alias
    .replace(/\[\[([^\]]+)\]\]/g, "$1") // [[Ziel]] → Ziel
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [Label](url) / ![alt](url) → Label
    .replace(/(\*\*|__)(.+?)\1/g, "$2") // **fett** / __fett__
    .replace(/(\*|_)(.+?)\1/g, "$2") // *kursiv* / _kursiv_
    .replace(/~~(.+?)~~/g, "$1") // ~~durchgestrichen~~
    .replace(/==(.+?)==/g, "$1") // ==hervorgehoben==
    .replace(/`([^`]+)`/g, "$1"); // `code`
}
