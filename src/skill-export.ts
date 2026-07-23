export const SKILL_MARKDOWN = `---
name: obsidian-tandem-comments
description: Read, write, reply to and resolve comments and edit suggestions in Markdown files that use the tandem-comments format (a \`\`\`tandem-comments fenced JSON block near the end of the file, quote-anchored via W3C TextQuoteSelector). Trigger whenever a Markdown file contains a tandem-comments block, or the user asks to comment on / annotate / review text in an Obsidian note, suggest an edit, reply to a comment, or resolve comments.
---

# Obsidian Tandem Comments — comments and edit suggestions in Markdown

Comments live in a fenced block at the **end of the file** (footnote definitions
that Obsidian appends after the block are fine and must be preserved). The prose
stays **100% untouched** — never write markers into the body text.

\`\`\`\`markdown
\`\`\`tandem-comments
// Schema: { "<id>": { anchor:{exact,prefix,suffix,pos?}, status:open|resolved, thread:[{author,ts,text}], suggestion?:{replacement,author,ts,result?} } }
// Anchor = quote from the prose. To locate: search for "exact", disambiguate via prefix/suffix.
{
  "a1f3": {
    "anchor": { "exact": "cut prices hard", "prefix": "we should ", "suffix": " in Q3", "pos": 22 },
    "status": "open",
    "thread": [
      { "author": "Leon", "ts": "2026-06-10T10:24:00Z", "text": "Too aggressive?" }
    ]
  }
}
\`\`\`
\`\`\`\`

## Rules

- **Locating a passage:** search the prose for \`anchor.exact\`; on multiple hits
  disambiguate via \`prefix\`/\`suffix\`, falling back to the hit closest to \`pos\`
  (character offset into the prose).
- **Replying:** append \`{ "author": "Claude", "ts": "<ISO-8601 UTC>", "text": "..." }\`
  to the \`thread\` array.
- **New comment:** add a new key (4-digit hex id, e.g. \`"7c2e"\`) with \`anchor\` +
  \`status: "open"\` + \`thread\`. Anchor: \`exact\` = exact quote from the prose,
  \`prefix\`/\`suffix\` = ~20 chars of context before/after, \`pos\` = character offset.
- **New edit suggestion:** create a normal open comment entry and add
  \`"suggestion": { "replacement": "<proposed text>", "author": "<name>", "ts": "<ISO-8601 UTC>" }\`.
  The replacement must be non-empty. Put the reason for the change in the
  \`thread\`. **Do not edit the prose when proposing a suggestion.**
- **Accepting a suggestion:** only when the user explicitly asks. Resolve the
  anchor immediately before editing and refuse if it is missing or ambiguous.
  Before editing, also resolve every other open entry against the old prose and
  remember its range only when it resolves uniquely; leave missing or ambiguous
  anchors unchanged and never choose among duplicate matches. Map each remembered
  range through the replacement (range start with forward affinity, range end with
  backward affinity), then regenerate its \`anchor.exact\`, \`prefix\`, \`suffix\`,
  and \`pos\` from the resulting prose. Do not search again using stale anchor
  metadata or retarget a collapsed range. Replace the accepted range, update all
  surviving uniquely resolved open anchors, and remove the accepted entry in the
  same file update. If history was explicitly requested, keep it with
  \`status: "resolved"\` and
  \`suggestion.result: "accepted"\`.
- **Declining a suggestion:** leave the prose untouched and remove the entry.
  If history was explicitly requested, keep it with \`status: "resolved"\` and
  \`suggestion.result: "declined"\`.
- **Resolving:** **remove the entry entirely** — the user wants Markdown files kept
  clean. Only if history is explicitly requested, set \`status\` to \`"resolved"\` instead.
- **Block lifecycle:** when no comments remain, **remove the block entirely**
  (including the single separating newline before it). If no block exists yet, append
  it at the end of the file: exactly one \\n between prose and the \`\`\`tandem-comments line.
- **Content after the block:** anything following the closing \`\`\` (e.g. footnote
  definitions like \`[^1]: ...\` that Obsidian appends at the very end) is legitimate —
  keep it byte-exact and leave it after the block when rewriting. If removing the
  block would join non-empty prose directly to this content, retain one separating
  newline.
- **Never** modify the prose while commenting. Comment text may contain Markdown;
  JSON strings escape newlines as \\\\n.
`;

interface NodeFsLike {
  mkdirSync(dir: string, opts: { recursive: boolean }): void;
  writeFileSync(file: string, data: string, encoding: string): void;
}
interface NodeOsLike {
  homedir(): string;
}
interface NodePathLike {
  join(...parts: string[]): string;
}

declare const require: ((m: string) => unknown) | undefined;

/** Schreibt die Skill-Datei nach ~/.claude/skills/obsidian-tandem-comments/SKILL.md (nur Desktop). */
export function exportSkill(): string {
  if (typeof require !== "function") {
    throw new Error("Skill export is only available in the desktop app.");
  }
  const fs = require("fs") as NodeFsLike;
  const os = require("os") as NodeOsLike;
  const path = require("path") as NodePathLike;
  const dir = path.join(os.homedir(), ".claude", "skills", "obsidian-tandem-comments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, SKILL_MARKDOWN, "utf8");
  return file;
}
