import { useSyncExternalStore } from "react";
import { daySpanOf, eventTimeOf, readerZones, type CalendarPort } from "@ohmail/app-logic/calendar";
import { useReport } from "../frame/commands.js";
import { useLocale, useText, useTimeZone } from "../text/index.js";
import { calendarInterval } from "./event-words.js";

export function RecoveredProposals({ port }: { port: CalendarPort }) {
  const t = useText("calendar");
  const locale = useLocale();
  const zone = useTimeZone();
  const report = useReport();
  useSyncExternalStore(port.subscribe, port.version, port.version);
  const rows = port.recoveredProposals?.() ?? [];
  if (rows.length === 0) return null;

  const review = async (key: string, send: boolean) => {
    if (!(await port.reviewProposal?.(key, send).catch(() => false))) report(t("proposal.failed"));
  };
  const zones = readerZones();
  const events = port.events();
  return (
    <section className="cal-recovered-proposals" aria-label={t("proposal.recovered")}>
      <strong>{t("proposal.recovered")}</strong>
      <ul>
        {rows.map(({ key, act, needsReview, reviewRefused }) => {
          const title = events.find(({ record }) => record.id === act.recordId)?.record.title;
          const start = eventTimeOf(act.start);
          const end = eventTimeOf(act.end);
          const span = start && end && daySpanOf({ start, end }, zone, zones);
          const when =
            start && end && span
              ? calendarInterval(
                  {
                    start,
                    end,
                    ref: { event: act.recordId, occurrence: act.occurrence || null, day: span.first },
                  },
                  zone,
                  zones,
                  span.first,
                  locale,
                  t,
                )
              : t("interval", { first: act.start.value, last: act.end.value });
          return (
            <li key={key} className="cal-recovered-proposal">
              {title && <strong>{title}</strong>}
              <span>{when}</span>
              {reviewRefused && <span role="status">{t("proposal.failed")}</span>}
              {needsReview ? (
                <div className="cal-recovered-proposal-actions">
                  <button type="button" onClick={() => void review(key, true)}>
                    {t("proposal.sendRecovered")}
                  </button>
                  <button type="button" onClick={() => void review(key, false)}>
                    {t("proposal.discardRecovered")}
                  </button>
                </div>
              ) : (
                <span role="status">{t("proposal.sending")}</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
