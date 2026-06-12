import { describe, expect, it } from "vitest";
import { buildExportNote, formatComment, renderExportFileName } from "../src/export";
import type { ResolvedComment } from "../src/types";

function rc(over: Partial<ResolvedComment["comment"]> & { id?: string; start?: number; orphaned?: boolean }): ResolvedComment {
  return {
    id: over.id ?? "a1f3",
    comment: {
      anchor: over.anchor ?? { exact: "the quoted passage" },
      status: over.status ?? "open",
      thread: over.thread ?? [{ author: "Me", ts: "2026-06-12T10:30:00Z", text: "Tighten this." }],
    },
    resolution: over.orphaned
      ? { kind: "orphaned" }
      : { kind: "resolved", start: over.start ?? 0, end: (over.start ?? 0) + 5 },
  };
}

describe("formatComment", () => {
  it("renders quote as blockquote followed by thread entries", () => {
    const out = formatComment(rc({}), { includeQuote: true });
    expect(out).toBe("> the quoted passage\n\n**Me** (2026-06-12T10:30:00Z): Tighten this.");
  });

  it("omits the quote when includeQuote is false", () => {
    const out = formatComment(rc({}), { includeQuote: false });
    expect(out).toBe("**Me** (2026-06-12T10:30:00Z): Tighten this.");
  });

  it("prefixes every line of a multi-line quote", () => {
    const out = formatComment(rc({ anchor: { exact: "line one\nline two" } }), { includeQuote: true });
    expect(out).toContain("> line one\n> line two");
  });

  it("renders all thread entries on separate lines", () => {
    const out = formatComment(
      rc({
        thread: [
          { author: "Me", ts: "t1", text: "First" },
          { author: "Claude", ts: "t2", text: "Reply" },
        ],
      }),
      { includeQuote: false }
    );
    expect(out).toBe("**Me** (t1): First\n**Claude** (t2): Reply");
  });

  it("uses the provided timestamp formatter", () => {
    const out = formatComment(rc({}), { includeQuote: false, formatTs: () => "formatted" });
    expect(out).toBe("**Me** (formatted): Tighten this.");
  });
});

describe("renderExportFileName", () => {
  it("substitutes {{filename}} and {{date}}", () => {
    expect(renderExportFileName("{{filename}} – Comments {{date}}", "Draft", "2026-06-12")).toBe(
      "Draft – Comments 2026-06-12"
    );
  });

  it("replaces characters that are invalid in file names or wikilinks", () => {
    expect(renderExportFileName("{{filename}}: a/b", "Dr*aft", "2026-06-12")).toBe("Dr-aft- a-b");
  });

  it("falls back to a default when the template renders empty", () => {
    expect(renderExportFileName("   ", "Draft", "2026-06-12")).toBe("Draft – Comments");
  });
});

describe("buildExportNote", () => {
  it("groups comments into Open, Resolved and Orphaned sections", () => {
    const out = buildExportNote(
      "Draft",
      [rc({ id: "1" }), rc({ id: "2", status: "resolved" }), rc({ id: "3", orphaned: true })],
      { scope: "all", date: "2026-06-12" }
    );
    expect(out).toContain("# Comments: Draft");
    expect(out).toContain("Exported from [[Draft]] on 2026-06-12");
    expect(out).toContain("## Open");
    expect(out).toContain("## Resolved");
    expect(out).toContain("## Orphaned");
  });

  it("omits empty sections", () => {
    const out = buildExportNote("Draft", [rc({})], { scope: "all", date: "2026-06-12" });
    expect(out).toContain("## Open");
    expect(out).not.toContain("## Resolved");
    expect(out).not.toContain("## Orphaned");
  });

  it("excludes resolved comments when scope is open, but keeps orphaned ones", () => {
    const out = buildExportNote(
      "Draft",
      [rc({ id: "1" }), rc({ id: "2", status: "resolved" }), rc({ id: "3", orphaned: true })],
      { scope: "open", date: "2026-06-12" }
    );
    expect(out).toContain("## Open");
    expect(out).toContain("## Orphaned");
    expect(out).not.toContain("## Resolved");
  });

  it("sorts open comments by their position in the prose", () => {
    const a = rc({ id: "1", start: 50, thread: [{ author: "Me", ts: "t", text: "Later" }] });
    const b = rc({ id: "2", start: 5, thread: [{ author: "Me", ts: "t", text: "Earlier" }] });
    const out = buildExportNote("Draft", [a, b], { scope: "all", date: "2026-06-12" });
    expect(out!.indexOf("Earlier")).toBeLessThan(out!.indexOf("Later"));
  });

  it("returns null when nothing matches the scope", () => {
    const out = buildExportNote("Draft", [rc({ status: "resolved" })], { scope: "open", date: "2026-06-12" });
    expect(out).toBeNull();
  });

  it("returns null for an empty comment list", () => {
    expect(buildExportNote("Draft", [], { scope: "all", date: "2026-06-12" })).toBeNull();
  });
});
