"use client";

/**
 * THE MONTH RAIL — History's jump strip on the right edge, read from the store's timeline. Up to
 * {@link RAIL_MONTHS_MAX} months it lists every month; past that it lists years and opens the year
 * the window stands in into its months. A press places the list at that month's first message.
 */
import { useLayoutEffect, useRef } from "react";
import { useFormatter, useTranslations } from "next-intl";
import type { TimelineSegment } from "@ohmail/client-engine";

/** Months listed one by one before the rail collapses to years. */
export const RAIL_MONTHS_MAX = 24;

interface Entry {
  key: string;
  label: string;
  count: number;
  start: number;
  current: boolean;
  year?: boolean;
}

export function HistoryRail({
  segments,
  at,
  onJump,
}: {
  segments: readonly TimelineSegment[];
  /** A slot of the month on show: the one pressed, else the one under the top edge. Its entry is current. */
  at: number;
  onJump: (start: number) => void;
}) {
  const t = useTranslations("history");
  const format = useFormatter();
  const holds = (s: TimelineSegment) => at >= s.start && at < s.start + s.count;
  const monthLabel = (s: TimelineSegment, withYear: boolean): string => {
    if (s.month === null) return t("railUndated");
    // Mid-month, midday UTC: the same month in every zone the label may be formatted in.
    const d = new Date(Date.UTC(Number(s.month.slice(0, 4)), Number(s.month.slice(5, 7)) - 1, 15, 12));
    return format.dateTime(d, withYear ? { month: "short", year: "numeric" } : { month: "short" });
  };

  const entries: Entry[] = [];
  if (segments.length <= RAIL_MONTHS_MAX) {
    for (const s of segments) {
      entries.push({ key: s.month ?? "undated", label: monthLabel(s, true), count: s.count, start: s.start, current: holds(s) });
    }
  } else {
    const here = segments.find(holds)?.month?.slice(0, 4) ?? null;
    let year: string | null = null;
    for (const s of segments) {
      const y = s.month?.slice(0, 4) ?? null;
      if (y !== null && y !== year) {
        year = y;
        const inYear = segments.filter((x) => x.month?.startsWith(y));
        entries.push({
          key: y, label: y, count: inYear.reduce((n, x) => n + x.count, 0), start: s.start,
          current: false, year: true,
        });
      }
      if (y === null || y === here) {
        entries.push({ key: s.month ?? "undated", label: monthLabel(s, false), count: s.count, start: s.start, current: holds(s) });
      }
    }
  }

  /**
   * THE RAIL NEVER COVERS A ROW: its own width is the scroller's `--history-gutter`, which the
   * rows reserve on their right (history-rail.css). Measured, because the labels are the locale's
   * ("Okt. 2026", "Ohne Datum"); taken back off when the rail unmounts.
   */
  const navRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    const scroller = nav?.parentElement?.parentElement;
    if (!nav || !scroller) return;
    const write = (): void => {
      scroller.style.setProperty("--history-gutter", `${Math.ceil(nav.offsetWidth)}px`);
    };
    write();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(write);
    ro?.observe(nav);
    return () => {
      ro?.disconnect();
      scroller.style.removeProperty("--history-gutter");
    };
  }, []);

  return (
    <div className="history-rail-anchor">
      <nav ref={navRef} className="history-rail" aria-label={t("railLabel")}>
        {entries.map((e) => (
          <button
            key={e.key}
            type="button"
            className={["history-rail-item", e.year ? "year" : "", e.current ? "cur" : ""].filter(Boolean).join(" ")}
            {...(e.current ? { "aria-current": "true" as const } : {})}
            title={t("railCount", { count: e.count })}
            onClick={() => onJump(e.start)}
          >
            {e.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
