/**
 * Author-name resolution.
 *
 * The label attached to comments is intentionally device-local: it is never
 * written to the plugin's synced data.json, so collaborators sharing a vault
 * via Obsidian Sync each keep their own identity instead of inheriting one
 * another's name.
 *
 * Resolution order:
 *   1. Manual override, stored per-vault in localStorage (Settings → Display name).
 *   2. The operating-system account username (desktop only).
 *   3. A generic fallback, so comments are never left unattributed.
 */

/** localStorage key for the per-vault, non-synced author override. */
export const AUTHOR_OVERRIDE_KEY = "author-name-override";

/** Used when neither an override nor an OS username is available (e.g. mobile). */
export const FALLBACK_AUTHOR = "Me";

// `require` is provided by Obsidian's desktop (Electron) runtime; absent on mobile.
declare const require: ((module: string) => unknown) | undefined;

/**
 * The OS account username, or null when it cannot be determined — e.g. on
 * mobile, where Node's `os` module is unavailable.
 */
export function detectOsUsername(): string | null {
  try {
    if (typeof require !== "function") return null;
    const os = require("os") as { userInfo?: () => { username?: string } };
    const name = os.userInfo?.().username?.trim();
    return name ? name : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the author label from the manual override and the detected OS
 * username, following the precedence documented above.
 */
export function resolveAuthorName(override: string | null | undefined, osUsername: string | null): string {
  const trimmedOverride = override?.trim();
  if (trimmedOverride) return trimmedOverride;
  if (osUsername) return osUsername;
  return FALLBACK_AUTHOR;
}
