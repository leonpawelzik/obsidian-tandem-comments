import type { ResolvedComment } from "./types";

export type ExportScope = "all" | "open";

export function formatTs(ts: string): string {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleString();
}

interface FormatOptions {
  includeQuote: boolean;
  formatTs?: (ts: string) => string;
}

export function formatComment(r: ResolvedComment, opts: FormatOptions): string {
  const fmt = opts.formatTs ?? ((ts: string) => ts);
  const thread = r.comment.thread.map((e) => `**${e.author}** (${fmt(e.ts)}): ${e.text}`).join("\n");
  if (!opts.includeQuote) return thread;
  const quote = r.comment.anchor.exact
    .split("\n")
    .map((l) => "> " + l)
    .join("\n");
  return quote + "\n\n" + thread;
}

/** Zeichen, die in Dateinamen oder Wikilinks Probleme machen. */
const INVALID_FILENAME_CHARS = /[\\/:*?"<>|#^[\]]/g;

export function renderExportFileName(template: string, filename: string, date: string): string {
  const rendered = template
    .replaceAll("{{filename}}", filename)
    .replaceAll("{{date}}", date)
    .replace(INVALID_FILENAME_CHARS, "-")
    .trim();
  return rendered || `${filename.replace(INVALID_FILENAME_CHARS, "-")} – Comments`;
}

interface ExportOptions {
  scope: ExportScope;
  date: string;
  formatTs?: (ts: string) => string;
}

export function buildExportNote(sourceName: string, all: ResolvedComment[], opts: ExportOptions): string | null {
  const startOf = (r: ResolvedComment) => (r.resolution.kind === "resolved" ? r.resolution.start : 0);
  const open = all
    .filter((r) => r.comment.status === "open" && r.resolution.kind === "resolved")
    .sort((a, b) => startOf(a) - startOf(b));
  const orphans = all.filter((r) => r.comment.status === "open" && r.resolution.kind === "orphaned");
  const done = opts.scope === "all" ? all.filter((r) => r.comment.status === "resolved") : [];
  if (!open.length && !orphans.length && !done.length) return null;

  const fmt = (r: ResolvedComment) => formatComment(r, { includeQuote: true, formatTs: opts.formatTs });
  const sections: string[] = [`# Comments: ${sourceName}`, `Exported from [[${sourceName}]] on ${opts.date}`];
  if (open.length) sections.push("## Open", ...open.map(fmt));
  if (done.length) sections.push("## Resolved", ...done.map(fmt));
  if (orphans.length) sections.push("## Orphaned", ...orphans.map(fmt));
  return sections.join("\n\n") + "\n";
}
