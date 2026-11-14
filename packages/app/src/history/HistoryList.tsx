/**
 * HISTORY'S LIST: every letter, newest first, the place it is in on its row, the count in the head. While the
 * mirror is owed it says so; with the server's store silent, the device's recent mail stands under that sentence.
 * The month rail at the list's right edge steps through its time (`months.ts` lays it out for the room).
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useHistoryModel, type HistoryMonth } from "@ohmail/app-logic/history";
import { Empty, RefusalLine, Seg } from "@ohmail/ui/base";
import { ListHead, MonthRail } from "@ohmail/ui/mail";
import type { PaneProps } from "../frame/contract.js";
import { LetterRows, ListColumn, ListMenu } from "../place-list/index.js";
import { useLocale, useText } from "../text/index.js";
import { monthAt, railOf, yearsOf } from "./months.js";

export function HistoryList({ plan }: PaneProps) {
  const model = useHistoryModel();
  const t = useText("history");
  const locale = useLocale();
  const { months } = model;
  const scroller = useRef<HTMLDivElement>(null);
  /* The month on show: the one pressed, else the one the list's top stands in. */
  const [at, setAt] = useState<string | null>(null);
  const shown = months.some((m) => m.month === at) ? at : (months[0]?.month ?? null);
  /* The unfolded phone's list is too narrow for a rail beside its rows: there the years stand in the head. */
  const inHead = plan.device === "fold" && plan.pose === null;
  const byFinger = plan.pointer === "coarse";
  const rail = useMemo(
    () => railOf(months, shown, { years: byFinger, locale, undated: t("railUndated") }),
    [months, shown, byFinger, locale, t],
  );
  const held = useRef(0);
  const go = (month: string | null | undefined): void => {
    const to = months.find((m) => m.month === month);
    if (to === undefined || month === undefined) return;
    held.current = Date.now() + 900;
    setAt(month);
    const rows = scroller.current?.querySelectorAll<HTMLElement>("[data-id]") ?? [];
    [...rows].find((row) => row.getAttribute("data-id") === to.first)?.scrollIntoView({ block: "start" });
  };
  const pick = (id: string): void => go(monthAt(months, id));
  useMonthOnShow(scroller, months, setAt, held);
  const years = yearsOf(months);
  const head = (
    <ListHead
      title={t("title")}
      hot={model.list.rows.some((m) => m.unread)}
      /* Where the store does not answer, the device's mail stands and is not every letter owned: no count. */
      count={model.count > 0 && !model.store.down ? t("metaCount", { count: model.count }) : undefined}
      aside={<ListMenu label={t("list.menu")} items={[]} />}
      below={
        inHead && years.length > 0 ? (
          <Seg
            label={t("year")}
            options={years.map((year) => ({ value: `y:${year}`, label: year }))}
            value={`y:${shown?.slice(0, 4) ?? ""}`}
            onChange={pick}
          />
        ) : undefined
      }
    />
  );
  return (
    <ListColumn head={head} plan={plan} cursor={model.list.cursor} scrollerRef={scroller}>
      {model.store.down ? (
        <RefusalLine way={{ label: t("storeRetry"), onPress: model.store.retry }}>
          {t("storeUnavailable")}
        </RefusalLine>
      ) : null}
      <MonthRail
        label={byFinger ? t("year") : t("month")}
        entries={inHead ? [] : rail.entries}
        current={rail.current}
        onPick={pick}
      >
        {model.list.rows.length > 0 ? (
          <LetterRows
            label={t("title")}
            rows={model.list.rows}
            cursor={model.list.cursor}
            press={model.list.press}
            stamp={model.stamp}
            file={t("row.file")}
            who={(m) => m.from.name ?? m.from.address}
            where={model.placeOf}
            spoken={(m) => (m.unread ? t("row.unread") : t("row.read"))}
          />
        ) : null}
        {model.loading ? <Empty label={t("loading")} /> : null}
        {model.empty ? <Empty label={t("emptyTitle")} /> : null}
      </MonthRail>
    </ListColumn>
  );
}

/** The month the list's top stands in, as the hand moves the list: the rail follows it. */
function useMonthOnShow(
  scroller: RefObject<HTMLDivElement | null>,
  months: readonly HistoryMonth[],
  set: (month: string | null) => void,
  held: RefObject<number>,
): void {
  useEffect(() => {
    const box = scroller.current;
    if (!box || months.length < 2) return;
    let frame = 0;
    const look = (): void => {
      frame = 0;
      /* A press holds its month a moment: a year too short to reach the top still stands as pressed. */
      if (Date.now() < held.current) return;
      const top = box.getBoundingClientRect().top;
      const rows = box.querySelectorAll<HTMLElement>("[data-id]");
      let id: string | null = null;
      for (const row of rows) {
        if (row.getBoundingClientRect().bottom > top) {
          id = row.getAttribute("data-id");
          break;
        }
      }
      if (id === null) return;
      /* The newest month whose first letter is at or above the top. */
      const ids = [...rows].map((r) => r.getAttribute("data-id"));
      const here = ids.indexOf(id);
      let month: string | null | undefined;
      for (const m of months) if (ids.indexOf(m.first) <= here) month = m.month;
      if (month !== undefined) set(month);
    };
    const onScroll = (): void => {
      if (frame === 0) frame = requestAnimationFrame(look);
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      box.removeEventListener("scroll", onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [scroller, months, set, held]);
}
