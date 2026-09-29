import { describe, expect, it, vi } from "vitest";
import { formatSidebarTimestamp } from "../src/timestamp";

describe("sidebar timestamp formatting", () => {
  const timestamp = "2026-08-11T10:30:00Z";

  it("shows full and compact timestamps", () => {
    expect(formatSidebarTimestamp(timestamp, "full", { locale: "en-US" })).toContain("2026");
    expect(formatSidebarTimestamp(timestamp, "compact", { locale: "en-US" })).toContain("Aug");
  });

  it("shows relative timestamps against the supplied time", () => {
    expect(
      formatSidebarTimestamp(timestamp, "relative", {
        now: new Date("2026-08-11T12:30:00Z"),
        locale: "en",
      })
    ).toBe("2 hours ago");
  });

  it("can hide timestamps and preserves malformed values otherwise", () => {
    expect(formatSidebarTimestamp(timestamp, "hidden")).toBeNull();
    expect(formatSidebarTimestamp("not-a-date", "compact")).toBe("not-a-date");
  });
  it("reuses one formatter across summer and winter dates and renews it periodically", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T12:00:00Z"));
    const dates = ["2026-01-11T10:30:00Z", "2026-08-11T10:30:00Z"];
    const formatter = new Intl.DateTimeFormat("de-DE", {
      year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
    const expected = dates.map(date => formatter.format(new Date(date)));
    // Make the seasonal offset difference deterministic on every test machine.
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockImplementation(function (this: Date) {
      return this.getUTCMonth() < 6 ? -60 : -120;
    });
    const created = vi.spyOn(Intl, "DateTimeFormat");
    try {
      for (let i = 0; i < 20; i++) {
        expect(formatSidebarTimestamp(dates[i % 2], "compact", { locale: "de-DE" })).toBe(expected[i % 2]);
      }
      expect(created).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      expect(formatSidebarTimestamp(dates[0], "compact", { locale: "de-DE" })).toBe(expected[0]);
      expect(created).toHaveBeenCalledTimes(2);
    } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
  });

});
