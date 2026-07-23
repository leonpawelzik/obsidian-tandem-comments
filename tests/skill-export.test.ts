import { describe, expect, it } from "vitest";
import { SKILL_MARKDOWN } from "../src/skill-export";

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

  it("documents accepted and declined history outcomes", () => {
    expect(SKILL_MARKDOWN).toContain('suggestion.result: "accepted"');
    expect(SKILL_MARKDOWN).toContain('suggestion.result: "declined"');
  });
});
