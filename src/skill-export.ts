export const SKILL_MARKDOWN = `---
name: obsidian-tandem-comments
description: Read, write, reply to and resolve comments and edit suggestions in Markdown files that use the tandem-comments format (a \`\`\`tandem-comments fenced JSON block near the end of the file, quote-anchored via W3C TextQuoteSelector). Trigger whenever a Markdown file contains a tandem-comments block, or the user asks to comment on / annotate / review text in an Obsidian note, suggest an edit, address or work through review comments, reply to a comment, or resolve comments.
---

# Obsidian Tandem Comments — comments and edit suggestions in Markdown

Comments live in a fenced block at the **end of the file** (footnote definitions
that Obsidian appends after the block are fine and must be preserved). The prose
stays **100% untouched** — never write markers into the body text.

~~~markdown
\`\`\`tandem-comments
// Schema: { "<id>": { anchor:{exact,prefix,suffix,pos?}, status:open|resolved, thread:[{author,ts,text}], suggestion?:{replacement,author,ts,result?} } }
// Anchor = quote from the prose. To locate: search for "exact", disambiguate via prefix/suffix.
// Addressing comments: handle every open id. After acting, append a reply {author: your name, ts, text} to its thread, and if you edited the quoted text, update its anchor to the new wording.
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
~~~

## Addressing comments: cover every open thread

When asked to address, work through, or fix the comments in a note, handle
**every** open thread, not just the ones you happen to notice:

1. **Inventory first.** Read the whole file. If your tool output may be cut off
   (long notes, large blocks), do not rely on what you saw: parse the JSON block
   with a script and list every id whose \`status\` is \`"open"\`. That list is your
   checklist.
2. **Work the checklist in order.** For each open id, locate the anchor and act:
   - a requested change: edit only the anchored passage (and what the comment
     explicitly asks for), then reply in the thread saying what you changed;
   - a question or a request for your opinion: reply, do not edit the prose;
   - missing facts you would have to invent: ask in the thread instead of guessing;
   - an edit suggestion: reply with your view; apply it only if the user asked
     you to accept suggestions (see below);
   - an anchor you cannot locate: keep the entry, reply that the quoted text was
     not found, and mention it in your summary;
   - the last thread entry is already yours and nobody answered: it is waiting
     for the human, leave it alone.
3. **Keep threads attached.** After editing a passage, regenerate \`anchor.exact\`,
   \`prefix\`, \`suffix\` and \`pos\` of every open entry whose quoted text or
   context you changed, so its highlight follows the new wording.
4. **Leave threads open** after replying so the human can review and resolve them
   in Obsidian, unless the user asked you to resolve them.
5. **Verify and report.** Re-read the file and check that the block still opens
   with a line that is exactly \`\`\`tandem-comments (three backticks, nothing
   else) and closes with a line that is exactly three backticks, that its JSON
   parses, and that every id from your checklist is still present unless you
   deliberately removed it. Then check your checklist: every open id got a reply,
   an edit, or a stated reason why not. End with a short per-id summary. Never
   skip an id silently.

When you rewrite the block with a script, rebuild it from the parsed object
(fence line, hint lines, \`JSON.stringify(obj, null, 2)\`, closing fence) instead of
patching backticks with string replacement.

## Rules

- **Locating a passage:** search the prose for \`anchor.exact\`; on multiple hits
  disambiguate via \`prefix\`/\`suffix\`, falling back to the hit closest to \`pos\`
  (character offset into the prose).
  \`anchor.orphaned: true\` means the user deleted the quoted passage: the same
  text elsewhere is not meant, so do not attach the comment there. Treat it as an
  anchor you cannot locate, and remove \`orphaned\` when you give the comment a
  new anchor.
- **Replying:** append \`{ "author": "<your name>", "ts": "<ISO-8601 UTC>", "text": "..." }\`
  to the \`thread\` array. Use your own assistant name as author (e.g. \`"Claude"\`,
  \`"Codex"\`), never the name of a human reviewer.
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
interface NodeDeps {
  fs: NodeFsLike;
  os: NodeOsLike;
  path: NodePathLike;
}

declare const require: ((m: string) => unknown) | undefined;

export type SkillTarget = "claude" | "codex";

/**
 * Skill-Verzeichnisse relativ zum Home-Ordner. Codex liest User-Skills aus
 * ~/.agents/skills (gemeinsamer Ort, den auch andere Agents lesen), nicht aus
 * ~/.claude/skills — deshalb ein eigenes Ziel (Issue #35).
 */
const SKILL_ROOTS: Record<SkillTarget, string[]> = {
  claude: [".claude", "skills"],
  codex: [".agents", "skills"],
};

export function writeSkill(target: SkillTarget, { fs, os, path }: NodeDeps): string {
  const dir = path.join(os.homedir(), ...SKILL_ROOTS[target], "obsidian-tandem-comments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, SKILL_MARKDOWN, "utf8");
  return file;
}

/** Schreibt die Skill-Datei für Claude Code bzw. Codex ins Home-Verzeichnis (nur Desktop). */
export function exportSkill(target: SkillTarget): string {
  if (typeof require !== "function") {
    throw new Error("Skill export is only available in the desktop app.");
  }
  return writeSkill(target, {
    fs: require("fs") as NodeFsLike,
    os: require("os") as NodeOsLike,
    path: require("path") as NodePathLike,
  });
}
