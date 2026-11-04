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

/** Entfernt jeden Whitespace; `offsets[i]` ist die Position des i-ten verbliebenen Zeichens im Original. */
export function withoutWhitespace(s: string): { text: string; offsets: number[] } {
  let text = "";
  const offsets: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (/\s/.test(s[i])) continue;
    text += s[i];
    offsets.push(i);
  }
  return { text, offsets };
}

export function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let k = haystack.indexOf(needle); k >= 0; k = haystack.indexOf(needle, k + 1)) count++;
  return count;
}

function nthIndexOf(haystack: string, needle: string, n: number): number {
  let k = haystack.indexOf(needle);
  for (let i = 0; i < n && k >= 0; i++) k = haystack.indexOf(needle, k + 1);
  return k;
}

/**
 * Sucht das `occurrence`-te Vorkommen (0-basiert) von `visible` in gerendertem
 * Text, wobei Whitespace ignoriert wird (`visible` ist bereits ohne Whitespace).
 * Liefert die Spanne im unveränderten `rendered`, passend für wrapRange.
 */
export function locateVisibleText(
  rendered: string,
  visible: string,
  occurrence: number
): { start: number; end: number } | null {
  const { text, offsets } = withoutWhitespace(rendered);
  const k = nthIndexOf(text, visible, occurrence);
  if (k < 0) return null;
  return { start: offsets[k], end: offsets[k + visible.length - 1] + 1 };
}
