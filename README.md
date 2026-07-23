# Tandem Comments

Quote-anchored comments and edit suggestions for [Obsidian](https://obsidian.md) notes. Review threads live in a single block at the end of the file — your prose stays untouched until you accept a suggestion, and AI assistants can read, write, and act on them with nothing but file access.

![Tandem Comments demo](docs/demo.gif)

## Features

- **Comment on any selection** — via command palette, hotkey, or right-click menu
- **Suggest edits** — propose a replacement for selected text, then accept or decline it from the sidebar
- **Sidebar threads** — reply, resolve, reopen, delete, re-anchor orphaned comments
- **Live highlights** in the editor; click a highlight to jump to its thread
- **Live re-anchoring** — comments follow your text as you edit; if an anchor's text disappears, the comment becomes *orphaned* and can be re-attached to a new selection
- **Resolve = remove** by default, keeping files clean (history mode available in settings)
- **Copy & export** — copy any comment as Markdown (with or without its quote), or export all of a file's comments to a companion note; name template and scope are configurable in settings
- **Reading view pill** — the comment block renders as a compact "💬 N threads" pill
- **AI-ready by design** — the block is plain, self-describing JSON; the settings tab exports a skill file that teaches Claude Code the format

## Installation

Tandem Comments is in the [Obsidian community plugin directory](https://obsidian.md/plugins?id=tandem-comments): in Obsidian, open **Settings → Community plugins → Browse**, search for **Tandem Comments**, then **Install** and **Enable**.

Manual install: download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/leonpawelzik/obsidian-tandem-comments/releases/latest) into `<vault>/.obsidian/plugins/tandem-comments/` and enable it in **Settings → Community plugins**.

## How it works

Comments are stored in a fenced code block at the **end of the file**. The text above it is never modified by commenting — no inline markers, no HTML spans, no IDs in your prose.

````markdown
Your note text. We should cut prices hard in Q3.

```tandem-comments
// Schema: { "<id>": { anchor:{exact,prefix,suffix,pos?}, status:open|resolved, thread:[{author,ts,text}], suggestion?:{replacement,author,ts,result?} } }
// Anchor = quote from the prose. To locate: search for "exact", disambiguate via prefix/suffix.
{
  "a1f3": {
    "anchor": { "exact": "cut prices hard", "prefix": "We should ", "suffix": " in Q3", "pos": 26 },
    "status": "open",
    "thread": [
      { "author": "Leon", "ts": "2026-06-10T10:24:00Z", "text": "Too aggressive?" }
    ]
  }
}
```
````

Each comment is anchored by a quote ([W3C TextQuoteSelector](https://www.w3.org/TR/annotation-model/#text-quote-selector)): the exact text plus a little surrounding context, with a character offset as tie-breaker.

## Usage

1. Select text in a Markdown note
2. Run **Add comment** or **Suggest edit** (command palette or right-click)
3. Use the sidebar to discuss comments or accept and decline proposed replacements

## Edit suggestions

Suggestions use the same quote anchors and discussion threads as comments. The
original prose is not changed until you press **Accept**:

```json
{
  "7c2e": {
    "anchor": {
      "exact": "cut prices hard",
      "prefix": "We should ",
      "suffix": " in Q3.",
      "pos": 26
    },
    "status": "open",
    "suggestion": {
      "replacement": "reduce prices significantly",
      "author": "Claude",
      "ts": "2026-07-23T12:00:00Z"
    },
    "thread": [
      {
        "author": "Claude",
        "ts": "2026-07-23T12:00:00Z",
        "text": "Keeps the recommendation strong without sounding abrupt."
      }
    ]
  }
}
```

Accepting replaces only the uniquely matched quoted passage. If the passage is
missing or matches more than one location, Tandem Comments refuses to apply the
change until you re-anchor it. Other uniquely resolved open anchors are rebased
through the edit in the same transaction; ambiguous anchors are left unchanged
rather than silently bound to one duplicate. The prose edit and suggestion update
share one editor transaction, so a single Undo restores both.

## Working with AI assistants

Because comments are plain JSON inside the note, an assistant needs no plugin, API, or MCP server — reading and writing the file is enough. Ask it to review a note and it can answer in your comment threads or propose exact replacements as suggestions. You stay in control of when the prose changes.

This shines on long-form writing, where you usually want subtle, surgical changes — not an AI rewrite of the whole piece. Comments pin your feedback to exact passages, and the assistant edits only what you pointed at:

```markdown
The morning market in Hoi An wakes before the tourists do. Vendors stack
mangosteen into careful pyramids while the river light is still gray.
…2,000 more words…
```

You leave comments where the draft needs work — *"weaker verb here?"* on one sentence, *"this paragraph drags, tighten it"* on another — then hand off:

> ❯ claude "turn my comments in hoi-an-draft.md into edit suggestions — keep the prose unchanged"

Claude proposes replacements for those two passages and explains each change in
its thread. The prose stays byte-for-byte identical until you review the
suggestions in Obsidian and accept the ones you want.

For Claude Code, **Settings → Export Claude skill** writes a ready-made skill to `~/.claude/skills/obsidian-tandem-comments/` that teaches it the format and conventions.

## Why a block at the end of the file?

Inline comment markers break plain-text workflows: they show up in exports, confuse other tools, and make diffs noisy. Tandem Comments keeps annotations out of your prose entirely — the file remains a normal Markdown document that happens to carry its review thread with it.

## License

[MIT](LICENSE)
