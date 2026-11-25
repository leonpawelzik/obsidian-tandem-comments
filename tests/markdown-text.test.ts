import { describe, expect, it } from "vitest";
import { visibleText } from "../src/markdown-text";

describe("visibleText", () => {
  it("strips bold and italic", () => {
    expect(visibleText("cut **prices** hard")).toBe("cut prices hard");
    expect(visibleText("a *very* nice _idea_")).toBe("a very nice idea");
  });

  it("strips strikethrough, highlight and code", () => {
    expect(visibleText("~~old~~ ==new== `code`")).toBe("old new code");
  });

  it("reduces links and wikilinks to their visible label", () => {
    expect(visibleText("see [the docs](https://x.com)")).toBe("see the docs");
    expect(visibleText("[[Note|alias]] and [[Other]]")).toBe("alias and Other");
  });

  it("leaves plain text untouched", () => {
    expect(visibleText("just plain text")).toBe("just plain text");
  });
});
