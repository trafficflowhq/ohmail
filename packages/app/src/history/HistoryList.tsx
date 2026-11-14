/**
 * HISTORY'S LIST: every letter, newest first, the place it is in on its row, the count in the head. While the
 * mirror is owed it says so; with the server's store silent, the device's recent mail stands under that sentence.
 * The month rail at the list's right edge steps through its time (`months.ts` lays it out for the room).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useHistoryModel, type HistoryModel, type HistoryMonth } from "@ohmail/app-logic/history";
import { Empty, RefusalLine, Seg } from "@ohmail/ui/base";
import { ListHead, MonthRail } from "@ohmail/ui/mail";
import type { PaneProps } from "../frame/contract.js";
import { ProductSwitch } from "../frame/ProductSwitch.js";
import { LetterRows, ListColumn, ListMenu } from "../place-list/index.js";
import { useLocale, useText } from "../text/index.js";
import { monthAt, railOf, yearsOf } from "./months.js";
import "./history.css";

export function HistoryList({ plan }: PaneProps) {
  const model = useHistoryModel();
  const t = useText("history");
  const locale = useLocale();
  const { months } = model;
  const localScroller = useRef<HTMLDivElement>(null);
  const scroller = model.windowed?.scroller ?? localScroller;
  const windowed = model.windowed;
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
  const go = useMonthScroll(scroller, model, setAt);
  const pick = (id: string, keyboard = false): void => {
    const month = monthAt(months, id);
    const destination = months.find((entry) => entry.month === month);
    if (destination) go(destination, keyboard);
  };
  const years = yearsOf(months);
  const head = (
    <ListHead
      title={t("title")}
      hot={model.list.rows.some((m) => m.unread)}
      /* Where the store does not answer, the device's mail stands and is not every letter owned: no count. */
      count={
        model.count !== undefined && (model.count > 0 || windowed !== undefined) && !model.store.down
          ? t("metaCount", { count: model.count })
          : undefined
      }
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
    <ListColumn
      head={
        <div className="history-head" data-heading-overlay="">
          {plan.rail === "dock" ? <ProductSwitch kind="round" /> : null}
          {head}
        </div>
      }
      plan={plan}
      showEdges
      cursor={model.list.cursor}
      scrollerRef={scroller}
      manualScrollAnchor={windowed !== undefined}
    >
      {model.store.down ? (
        <RefusalLine way={{ label: t("storeRetry"), onPress: model.store.retry }}>
          {t("storeUnavailable")}
        </RefusalLine>
      ) : null}
      <MonthRail
        spaced
        label={byFinger ? t("year") : t("month")}
        entries={inHead ? [] : rail.entries}
        current={rail.current}
        onPick={pick}
      >
        {model.list.rows.length > 0 || windowed?.slots.length ? (
          <LetterRows
            label={t("title")}
            rows={model.list.rows}
            windowed={
              windowed && {
                start: windowed.window.start,
                top: windowed.window.padTop,
                bottom: windowed.window.padBottom,
                rowHeight: windowed.window.rowHeight,
                slots: windowed.slots,
              }
            }
            cursor={model.list.cursor}
            press={model.list.press}
            stamp={model.stamp}
            file={t("row.file")}
            who={(m) => m.from.name ?? m.from.address}
            fitAddress
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

/** Keep the rail's target while its page and measured row heights settle. Hand scrolling releases it. */
function useMonthScroll(
  scroller: RefObject<HTMLDivElement | null>,
  model: HistoryModel,
  setAt: (month: string | null) => void,
) {
  const pin = useRef<{ slot: number; keyboard: boolean } | null>(null);
  const { months, windowed } = model;
  const readTop = useCallback(
    (box: HTMLElement): void => {
      const top = box.getBoundingClientRect().top + 0.5;
      const rows = [...box.querySelectorAll<HTMLElement>("[role=option][data-id]")];
      const at = rows.findIndex((row) => {
        const rect = row.getBoundingClientRect();
        return rect.top <= top && rect.bottom > top;
      });
      const row = rows[at];
      if (!row) return;
      const slot = row.dataset.index === undefined ? at : Number(row.dataset.index);
      const month = months.find((entry) => slot >= entry.start && slot < entry.start + entry.count);
      if (month) setAt(month.month);
    },
    [months, setAt],
  );
  const move = (box: HTMLElement, offset: number): void => {
    const before = box.scrollTop;
    box.scrollTop = offset;
    if (box.scrollTop !== before) box.dispatchEvent(new Event("scroll"));
  };

  useLayoutEffect(() => {
    const box = scroller.current;
    const target = pin.current;
    if (!box || !windowed) return;
    if (!target) {
      readTop(box);
      return;
    }
    const row = box.querySelector<HTMLElement>(`[role=option][data-index="${target.slot}"]`);
    if (!row) {
      move(box, windowed.window.offsetOf(target.slot));
      return;
    }
    const drift = row.getBoundingClientRect().top - box.getBoundingClientRect().top;
    if (Math.abs(drift) >= 1) move(box, box.scrollTop + drift);
    if (target.keyboard && row.dataset.id) {
      target.keyboard = false;
      model.list.walk.select(row.dataset.id);
      row.focus({ preventScroll: true });
    }
  });

  useEffect(() => {
    const box = scroller.current;
    if (!box || months.length < 2) return;
    let frame = 0;
    const release = (): void => {
      pin.current = null;
    };
    const look = (): void => {
      frame = 0;
      if (pin.current === null) readTop(box);
    };
    const onScroll = (): void => {
      if (frame === 0) frame = requestAnimationFrame(look);
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    for (const event of ["wheel", "touchstart", "pointerdown"])
      box.addEventListener(event, release, { passive: true });
    box.ownerDocument.addEventListener("keydown", release, true);
    return () => {
      box.removeEventListener("scroll", onScroll);
      for (const event of ["wheel", "touchstart", "pointerdown"]) box.removeEventListener(event, release);
      box.ownerDocument.removeEventListener("keydown", release, true);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [scroller, months, readTop]);

  return (month: HistoryMonth, keyboard: boolean): void => {
    const box = scroller.current;
    if (!box) return;
    setAt(month.month);
    pin.current = { slot: month.start, keyboard };
    if (windowed) {
      windowed.jump(month.start);
      move(box, windowed.window.offsetOf(month.start));
    } else {
      const row = box.querySelectorAll<HTMLElement>("[role=option][data-id]")[month.start];
      row?.scrollIntoView({ block: "start" });
      if (keyboard && row?.dataset.id) {
        model.list.walk.select(row.dataset.id);
        row.focus({ preventScroll: true });
      }
    }
  };
}
