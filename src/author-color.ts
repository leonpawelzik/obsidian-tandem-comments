/** Stable hue (0–359) derived from an author name, so each author keeps one color. */
export function authorHue(author: string): number {
  let hash = 0;
  for (let i = 0; i < author.length; i++) {
    hash = (hash * 31 + author.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

export type AuthorColorOverrides = Record<string, string | number>;
export type AuthorColorTheme = "light" | "dark";
export interface AuthorColorHsl {
  h: number;
  s: number;
  l: number;
}

const AUTHOR_COLOR_SATURATION = 55;
const AUTHOR_COLOR_LIGHTNESS: Record<AuthorColorTheme, number> = { light: 28, dark: 72 };

function normalizeHue(hue: number): number {
  return Math.round(((hue % 360) + 360) % 360) % 360;
}

export function resolveAuthorHue(author: string, overrides: AuthorColorOverrides): number {
  const override = overrides[author];
  return typeof override === "number" && Number.isFinite(override) ? normalizeHue(override) : authorHue(author);
}

export function authorColorHsl(hue: number, theme: AuthorColorTheme): AuthorColorHsl {
  return {
    h: normalizeHue(hue),
    s: AUTHOR_COLOR_SATURATION,
    l: AUTHOR_COLOR_LIGHTNESS[theme],
  };
}

export function authorColorCss(hue: number, theme: AuthorColorTheme): string {
  const color = authorColorHsl(hue, theme);
  return `hsl(${color.h} ${color.s}% ${color.l}%)`;
}

export function resolveAuthorColor(
  author: string,
  overrides: AuthorColorOverrides,
  theme: AuthorColorTheme
): string {
  const override = overrides[author];
  if (typeof override === "string" && /^#[0-9a-f]{6}$/i.test(override)) return override;
  return authorColorCss(resolveAuthorHue(author, overrides), theme);
}

export function hasAuthorColorOverride(overrides: AuthorColorOverrides, author: string): boolean {
  return Object.prototype.hasOwnProperty.call(overrides, author);
}

function hueOverrideHex(hue: number): string {
  const normalized = normalizeHue(hue);
  const saturation = 0.7;
  const lightness = 0.5;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((normalized / 60) % 2) - 1));
  const offset = lightness - chroma / 2;
  const rgbPrime: [number, number, number] =
    normalized < 60 ? [chroma, x, 0] :
    normalized < 120 ? [x, chroma, 0] :
    normalized < 180 ? [0, chroma, x] :
    normalized < 240 ? [0, x, chroma] :
    normalized < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return "#" + rgbPrime
    .map((channel) => Math.round((channel + offset) * 255).toString(16).padStart(2, "0"))
    .join("");
}

export function normalizeAuthorColorOverrides(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const normalized: Record<string, string> = {};
  for (const [author, color] of Object.entries(value)) {
    if (typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)) {
      normalized[author] = color.toLowerCase();
    } else if (typeof color === "number" && Number.isFinite(color)) {
      normalized[author] = hueOverrideHex(color);
    }
  }
  return normalized;
}

export function renameAuthorColorOverride(
  overrides: AuthorColorOverrides,
  previousAuthor: string,
  nextAuthor: string
): { ok: true; overrides: AuthorColorOverrides } | { ok: false; reason: "duplicate" | "empty" } {
  const trimmed = nextAuthor.trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  if (trimmed !== previousAuthor && hasAuthorColorOverride(overrides, trimmed)) {
    return { ok: false, reason: "duplicate" };
  }
  const renamed = { ...overrides, [trimmed]: overrides[previousAuthor] };
  delete renamed[previousAuthor];
  return { ok: true, overrides: renamed };
}
