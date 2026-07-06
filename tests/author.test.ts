import { describe, expect, it } from "vitest";
import { FALLBACK_AUTHOR, resolveAuthorName } from "../src/author";

describe("resolveAuthorName", () => {
  it("prefers a non-empty override over the OS username", () => {
    expect(resolveAuthorName("Leon", "felix")).toBe("Leon");
  });

  it("trims the override", () => {
    expect(resolveAuthorName("  Leon  ", "felix")).toBe("Leon");
  });

  it("falls back to the OS username when the override is empty, blank, or unset", () => {
    expect(resolveAuthorName("", "felix")).toBe("felix");
    expect(resolveAuthorName("   ", "felix")).toBe("felix");
    expect(resolveAuthorName(null, "felix")).toBe("felix");
    expect(resolveAuthorName(undefined, "felix")).toBe("felix");
  });

  it("falls back to the generic default when neither override nor OS username is available", () => {
    expect(resolveAuthorName("", null)).toBe(FALLBACK_AUTHOR);
    expect(resolveAuthorName(null, null)).toBe(FALLBACK_AUTHOR);
  });
});
