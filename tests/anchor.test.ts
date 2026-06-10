import { describe, expect, it } from "vitest";
import { makeAnchor, resolveAnchor } from "../src/store";

describe("resolveAnchor", () => {
  it("resolves a unique verbatim match", () => {
    const prose = "Wir sollten den Preis aggressiv senken im Q3.";
    const r = resolveAnchor(prose, { exact: "aggressiv senken" });
    expect(r).toEqual({ kind: "resolved", start: 22, end: 38 });
  });

  it("disambiguates multiple matches via prefix/suffix", () => {
    const prose = "Preis senken. Kosten senken. Risiko senken.";
    const r = resolveAnchor(prose, { exact: "senken", prefix: "Kosten ", suffix: "." });
    expect(r).toEqual({ kind: "resolved", start: 21, end: 27 });
  });

  it("falls back to pos-nearest match when context is ambiguous", () => {
    const prose = "abc abc abc";
    const r = resolveAnchor(prose, { exact: "abc", pos: 7 });
    expect(r).toEqual({ kind: "resolved", start: 8, end: 11, ambiguous: true });
  });

  it("picks first match when ambiguous and no pos given", () => {
    const prose = "abc abc";
    const r = resolveAnchor(prose, { exact: "abc" });
    expect(r).toEqual({ kind: "resolved", start: 0, end: 3, ambiguous: true });
  });

  it("returns orphaned when the quote was edited away", () => {
    const prose = "Wir sollten den Preis gezielt nachschärfen im Q3.";
    expect(resolveAnchor(prose, { exact: "aggressiv senken" })).toEqual({ kind: "orphaned" });
  });

  it("returns orphaned for empty exact", () => {
    expect(resolveAnchor("abc", { exact: "" })).toEqual({ kind: "orphaned" });
  });

  it("disambiguates via prefix without vacuous matches at document start", () => {
    // Kandidaten bei 0 und 22. Der Kandidat bei 0 hat KEINEN Text davor und darf
    // den Prefix "Nochmal " nicht vakuos matchen — strikter Vergleich.
    const prose = "Preis senken. Nochmal Preis senken.";
    const r = resolveAnchor(prose, { exact: "Preis senken", prefix: "Nochmal " });
    expect(r).toEqual({ kind: "resolved", start: 22, end: 34 });
  });
});

describe("makeAnchor", () => {
  it("derives exact, context and pos from a selection", () => {
    const prose = "Wir sollten den Preis aggressiv senken im Q3.";
    const a = makeAnchor(prose, 22, 38);
    expect(a.exact).toBe("aggressiv senken");
    expect(a.prefix).toBe("r sollten den Preis "); // CONTEXT_LEN=20: prose.slice(2, 22)
    expect(a.pos).toBe(22);
    expect(a.suffix).toBe(" im Q3.");
  });

  it("clamps context at document edges and omits empty context", () => {
    const a = makeAnchor("kurz", 0, 4);
    expect(a).toEqual({ exact: "kurz", pos: 0 });
  });

  it("round-trips: makeAnchor → resolveAnchor finds the same range", () => {
    const prose = "x abc y abc z abc";
    const a = makeAnchor(prose, 8, 11); // das mittlere "abc"
    const r = resolveAnchor(prose, a);
    expect(r).toEqual({ kind: "resolved", start: 8, end: 11 });
  });
});
