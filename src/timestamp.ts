import type { TimestampDisplay } from "./settings-model";

export interface TimestampFormatOptions {
  now?: Date;
  locale?: string;
}

// One formatter per mode: bounded even if arbitrary locales are requested.
let compactCache: { locale: string | undefined; offset: number; createdAt: number; formatter: Intl.DateTimeFormat } | undefined;
let relativeCache: { locale: string | undefined; formatter: Intl.RelativeTimeFormat } | undefined;

export function formatSidebarTimestamp(
  timestamp: string,
  display: TimestampDisplay,
  options: TimestampFormatOptions = {}
): string | null {
  if (display === "hidden") return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return timestamp;

  if (display === "full") return date.toLocaleString(options.locale);
  if (display === "compact") {
    // Use today's offset, not each entry's seasonal offset. Periodic renewal
    // also picks up system timezone/locale changes with the same current offset.
    const current = new Date();
    const offset = current.getTimezoneOffset();
    const now = current.getTime();
    if (!compactCache || compactCache.locale !== options.locale || compactCache.offset !== offset ||
        now < compactCache.createdAt || now - compactCache.createdAt >= 60_000) {
      compactCache = { locale: options.locale, offset, createdAt: now, formatter: new Intl.DateTimeFormat(options.locale, {
        year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      }) };
    }
    return compactCache.formatter.format(date);
  }

  const now = options.now ?? new Date();
  const deltaSeconds = (date.getTime() - now.getTime()) / 1000;
  const absoluteSeconds = Math.abs(deltaSeconds);
  const [divisor, unit]: [number, Intl.RelativeTimeFormatUnit] =
    absoluteSeconds < 60
      ? [1, "second"]
      : absoluteSeconds < 3_600
        ? [60, "minute"]
        : absoluteSeconds < 86_400
          ? [3_600, "hour"]
          : absoluteSeconds < 2_592_000
            ? [86_400, "day"]
            : absoluteSeconds < 31_536_000
              ? [2_592_000, "month"]
              : [31_536_000, "year"];
  if (!relativeCache || relativeCache.locale !== options.locale) {
    relativeCache = { locale: options.locale, formatter: new Intl.RelativeTimeFormat(options.locale, { numeric: "auto" }) };
  }
  return relativeCache.formatter.format(
    Math.round(deltaSeconds / divisor),
    unit
  );
}
