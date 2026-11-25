import { describe, expect, it } from "vitest";
import { SKILL_MARKDOWN, writeSkill } from "../src/skill-export";

describe("exported Claude skill edit-suggestion contract", () => {
  it("documents the optional suggestion schema and replacement metadata", () => {
    expect(SKILL_MARKDOWN).toContain("suggestion?:{replacement,author,ts,result?}");
    expect(SKILL_MARKDOWN).toContain('"suggestion": { "replacement": "<proposed text>"');
  });

  it("tells assistants not to edit prose while merely proposing a suggestion", () => {
    expect(SKILL_MARKDOWN).toContain("Do not edit the prose when proposing a suggestion");
  });

  it("requires explicit acceptance and rejects missing or ambiguous anchors", () => {
    expect(SKILL_MARKDOWN).toContain("only when the user explicitly asks");
    expect(SKILL_MARKDOWN).toContain("refuse if it is missing or ambiguous");
  });

  it("requires surviving open anchors to be rebased during acceptance", () => {
    const contract = SKILL_MARKDOWN.replace(/\s+/g, " ");
    expect(contract).toContain("resolve every other open entry against the old prose");
    expect(contract).toContain("only when it resolves uniquely");
    expect(contract).toContain("leave missing or ambiguous anchors unchanged");
    expect(contract).toContain("Map each remembered range through the replacement");
    expect(contract).toContain(
      "regenerate its `anchor.exact`, `prefix`, `suffix`, and `pos`"
    );
    expect(contract).toContain("update all surviving uniquely resolved open anchors");
    expect(contract).toContain("in the same file update");
  });

  it("preserves a separator when block removal exposes trailing content", () => {
    expect(SKILL_MARKDOWN).toContain("retain one separating");
    expect(SKILL_MARKDOWN).toContain("newline");
  });

  it("explains anchors whose quote was deleted", () => {
    const contract = SKILL_MARKDOWN.replace(/\s+/g, " ");
    expect(contract).toContain("`anchor.orphaned: true` means the user deleted the quoted passage");
    expect(contract).toContain("remove `orphaned` when you give the comment a new anchor");
  });

  it("documents accepted and declined history outcomes", () => {
    expect(SKILL_MARKDOWN).toContain('suggestion.result: "accepted"');
    expect(SKILL_MARKDOWN).toContain('suggestion.result: "declined"');
  });
});

describe("exported skill coverage contract (issue #35)", () => {
  const contract = SKILL_MARKDOWN.replace(/\s+/g, " ");

  it("makes agents inventory every open thread before addressing comments", () => {
    expect(contract).toContain("handle **every** open thread");
    expect(contract).toContain("parse the JSON block with a script and list every id");
  });

  it("forbids skipping an open thread silently and asks for a per-id report", () => {
    expect(contract).toContain("Never skip an id silently");
    expect(contract).toContain("per-id summary");
  });

  it("keeps unlocatable anchors instead of dropping them", () => {
    expect(contract).toContain("an anchor you cannot locate: keep the entry");
  });

  it("does not sign replies as Claude when another assistant uses the skill", () => {
    expect(SKILL_MARKDOWN).not.toContain('"author": "Claude"');
    expect(contract).toContain("Use your own assistant name as author");
  });

  it("triggers on requests to address review comments", () => {
    expect(SKILL_MARKDOWN.split("\n")[2]).toContain("address or work through review comments");
  });
});

describe("skill export targets", () => {
  function fakeNode() {
    const writes: Record<string, string> = {};
    const dirs: string[] = [];
    return {
      writes,
      dirs,
      deps: {
        fs: {
          mkdirSync: (dir: string) => void dirs.push(dir),
          writeFileSync: (file: string, data: string) => void (writes[file] = data),
        },
        os: { homedir: () => "/home/u" },
        path: { join: (...parts: string[]) => parts.join("/") },
      },
    };
  }

  it("writes the Claude Code skill to ~/.claude/skills", () => {
    const node = fakeNode();
    const file = writeSkill("claude", node.deps);
    expect(file).toBe("/home/u/.claude/skills/obsidian-tandem-comments/SKILL.md");
    expect(node.writes[file]).toBe(SKILL_MARKDOWN);
  });

  it("writes the Codex skill to ~/.agents/skills, where Codex discovers user skills", () => {
    const node = fakeNode();
    const file = writeSkill("codex", node.deps);
    expect(file).toBe("/home/u/.agents/skills/obsidian-tandem-comments/SKILL.md");
    expect(node.dirs).toContain("/home/u/.agents/skills/obsidian-tandem-comments");
    expect(node.writes[file]).toBe(SKILL_MARKDOWN);
  });
});
