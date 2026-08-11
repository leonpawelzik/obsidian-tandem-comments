import { describe, expect, it } from "vitest";
import {
  authorColorCss,
  authorColorHsl,
  authorHue,
  normalizeAuthorColorOverrides,
  renameAuthorColorOverride,
  resolveAuthorColor,
  resolveAuthorHue,
} from "../src/author-color";

function hslContrast(css: string, background: [number, number, number]): number {
  const match = css.match(/^hsl\((\d+) (\d+)% (\d+)%\)$/);
  if (!match) throw new Error(`Unexpected color: ${css}`);
  const [, hueRaw, saturationRaw, lightnessRaw] = match;
  const hue = Number(hueRaw);
  const saturation = Number(saturationRaw) / 100;
  const lightness = Number(lightnessRaw) / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const offset = lightness - chroma / 2;
  const rgbPrime: [number, number, number] =
    hue < 60 ? [chroma, x, 0] :
    hue < 120 ? [x, chroma, 0] :
    hue < 180 ? [0, chroma, x] :
    hue < 240 ? [0, x, chroma] :
    hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  const luminance = (rgb: [number, number, number]): number =>
    rgb
      .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const foregroundLuminance = luminance(rgbPrime.map((channel) => channel + offset) as [number, number, number]);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

describe("authorHue", () => {
  it("uses an exact author override and generates a hue for unknown authors", () => {
    const overrides = { Claude: 42 };

    expect(resolveAuthorHue("Claude", overrides)).toBe(42);
    expect(resolveAuthorHue("ChatGPT", overrides)).toBe(authorHue("ChatGPT"));
  });

  it("renders an exact override unchanged in both themes", () => {
    const overrides = { Claude: "#123456" };

    expect(resolveAuthorColor("Claude", overrides, "light")).toBe("#123456");
    expect(resolveAuthorColor("Claude", overrides, "dark")).toBe("#123456");
    expect(resolveAuthorColor("ChatGPT", overrides, "light")).toBe(
      authorColorCss(authorHue("ChatGPT"), "light")
    );
  });

  it("migrates saved hue overrides to exact colors and discards invalid values", () => {
    expect(
      normalizeAuthorColorOverrides({ Claude: 210, ChatGPT: "#AABBCC", invalid: "red" })
    ).toEqual({
      Claude: "#2680d9",
      ChatGPT: "#aabbcc",
    });
  });

  it("ignores invalid overrides and normalizes valid hues", () => {
    expect(resolveAuthorHue("Claude", { Claude: Number.NaN })).toBe(authorHue("Claude"));
    expect(resolveAuthorHue("Claude", { Claude: 725 })).toBe(5);
  });

  it("keeps every generated hue above 4.5:1 contrast in light and dark themes", () => {
    for (let hue = 0; hue < 360; hue++) {
      expect(hslContrast(authorColorCss(hue, "light"), [1, 1, 1])).toBeGreaterThanOrEqual(4.5);
      expect(hslContrast(authorColorCss(hue, "dark"), [0.125, 0.125, 0.125])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("provides the actual theme shade for color-picker previews", () => {
    expect(authorColorHsl(101, "light")).toEqual({ h: 101, s: 55, l: 28 });
    expect(authorColorHsl(101, "dark")).toEqual({ h: 101, s: 55, l: 72 });
  });

  it("renames an override without changing its hue or other authors", () => {
    const overrides = { Claude: 230, Gemini: 301 };

    expect(renameAuthorColorOverride(overrides, "Claude", "claude")).toEqual({
      ok: true,
      overrides: { claude: 230, Gemini: 301 },
    });
    expect(overrides).toEqual({ Claude: 230, Gemini: 301 });
  });

  it("rejects a rename that would overwrite another author", () => {
    const overrides = { Claude: 230, Gemini: 301 };

    expect(renameAuthorColorOverride(overrides, "Claude", "Gemini")).toEqual({
      ok: false,
      reason: "duplicate",
    });
    expect(overrides).toEqual({ Claude: 230, Gemini: 301 });
  });

  it("allows author names that match inherited object properties", () => {
    expect(renameAuthorColorOverride({ Claude: 230 }, "Claude", "constructor")).toEqual({
      ok: true,
      overrides: { constructor: 230 },
    });
  });

  it("rejects an empty author name", () => {
    expect(renameAuthorColorOverride({ Claude: 230 }, "Claude", "   ")).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("is stable across calls for the same author", () => {
    expect(authorHue("Leon")).toBe(authorHue("Leon"));
  });

  it("stays within the hue range for a variety of names", () => {
    const names = ["Leon", "Claude", "ChatGPT", "Gemini", "", "a", "ä", "🙂", "x".repeat(500)];
    for (const name of names) {
      const hue = authorHue(name);
      expect(Number.isInteger(hue)).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("gives the example authors from the request distinct hues", () => {
    const hues = ["User", "Claude", "ChatGPT", "Gemini"].map(authorHue);
    expect(new Set(hues).size).toBe(hues.length);
  });

  it("separates names differing only in case or trailing space", () => {
    expect(authorHue("leon")).not.toBe(authorHue("Leon"));
    expect(authorHue("Leon ")).not.toBe(authorHue("Leon"));
  });

  it("spreads many authors across the wheel rather than clustering", () => {
    const hues = Array.from({ length: 200 }, (_, i) => authorHue(`author${i}`));
    // Twelve 30° buckets; a clustering hash would leave most of them empty.
    const buckets = new Set(hues.map((h) => Math.floor(h / 30)));
    expect(buckets.size).toBe(12);
  });
});
