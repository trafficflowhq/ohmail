/**
 * THE EDGES OF WHAT THIS DEVICE HOLDS, as every view says them: where its days reach before the first day held, Load
 * earlier (or, where the host cannot read a span, that those days stay with the calendar); where they reach after the
 * last day held, that later days stay with the calendar. Days beyond an edge are never drawn as empty without a word.
 */
import { Notice } from "@ohmail/ui/base";
import { dayShort, useEarlier, yearOf, type HeldEdge } from "@ohmail/app-logic/calendar";
import { useLocale, useText } from "../text/index.js";

export interface HeldNoticeProps {
  readonly edge: HeldEdge;
  /** The first and the last day the view draws. */
  readonly first: string;
  readonly last: string;
  readonly today: string;
  /** The view's own placement of the notices. */
  readonly className: string;
}

export function HeldNotice({ edge, first, last, today, className }: HeldNoticeProps) {
  const t = useText("calendar");
  const locale = useLocale();
  const earlier = useEarlier(edge, first);
  const later = edge.later !== null && last > edge.later ? edge.later : null;
  if (earlier.kind === "none" && later === null) return null;
  const thisYear = yearOf(today);
  return (
    <div className={className}>
      {earlier.kind === "edge" ? (
        <Notice
          place="bar"
          title={t("held.from", { day: dayShort(earlier.from, locale, thisYear) })}
          line={earlier.press === null ? t("held.none") : earlier.failed ? t("held.failed") : undefined}
          acts={earlier.press === null ? undefined : [{ label: t("held.load"), onPress: earlier.press }]}
        />
      ) : null}
      {later !== null ? (
        <Notice
          place="bar"
          title={t("held.until", { day: dayShort(later, locale, thisYear) })}
          line={t("held.after")}
        />
      ) : null}
    </div>
  );
}
