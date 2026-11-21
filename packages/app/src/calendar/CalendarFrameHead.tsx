import { useRef, useState } from "react";
import {
  addDays,
  dayLong,
  dayShort,
  dayNumberOf,
  firstOfMonth,
  monthName,
  monthOfDay,
  spanOfView,
  weekOf,
  weekTitle,
  yearOf,
  type CalendarPort,
} from "@ohmail/app-logic/calendar";
import { CalendarHead, ViewSwitch } from "@ohmail/ui/calendar";
import { Doorbell } from "@ohmail/ui/mail";
import { ProductSwitch } from "../frame/ProductSwitch.js";
import type { CalendarPlaceId, FrameCommands, LayoutPlan, Route } from "../frame/contract.js";
import type { MonthRun } from "../month/use-month-run.js";
import { useInvitations } from "../invitations/index.js";
import { useLocale, useText } from "../text/index.js";
import { weekLayout } from "../week/index.js";
import { CalendarHeadMenu, type HeadMenu } from "./CalendarHeadMenu.js";
import { invitationsRoute, useCalendarNavigationKeys } from "./CalendarKeys.js";
import { CalendarMiniMonth } from "./CalendarMiniMonth.js";
import { shifted, type Where, VIEWS, isView } from "./where.js";
import { useCalendarSwipe } from "./use-calendar-swipe.js";
import type { CalendarViewSettings } from "./view.js";

type Go = (to: Partial<Route> & { place: CalendarPlaceId }) => void;

interface CalendarFrameHeadProps {
  where: Where;
  route: Route;
  plan: LayoutPlan;
  panelOn: boolean;
  go: Go;
  commands: FrameCommands;
  keysHere: boolean;
  settings: CalendarViewSettings;
  port: CalendarPort;
  monthRun: MonthRun | null;
  onToday: () => void;
}

export function CalendarFrameHead(props: CalendarFrameHeadProps) {
  const { where, settings, port, go, commands } = props;
  const head = useCalendarHead(props);
  const {
    showStrip,
    swipe,
    anchor,
    today,
    toDate,
    menu,
    anchors,
    views,
    dated,
    jump,
    select,
    search,
    todayNow,
    step,
    agenda,
    invitations,
    setMenu,
    close,
  } = head;
  return (
    <>
      {calendarHeadBar(head, props)}
      {showStrip ? (
        <div className="cal-body-strip" {...swipe}>
          <CalendarMiniMonth
            anchor={anchor}
            today={today}
            weekStart={settings.weekStart}
            weekNumbers={settings.weekNumbers}
            mode="strip"
            onPick={toDate}
            onWeek={(day) => go({ place: "week", sub: day })}
          />
        </div>
      ) : null}
      {menu ? (
        <CalendarHeadMenu
          menu={menu}
          where={where}
          settings={settings}
          port={port}
          anchors={anchors}
          views={views}
          dated={dated}
          toDate={jump}
          goToView={(view, day) => go({ place: view, sub: day })}
          select={select}
          search={search}
          today={todayNow}
          step={step}
          agenda={agenda}
          invitations={invitations}
          openSettings={() => commands.go({ place: "calsettings" })}
          onOpen={setMenu}
          onClose={close}
        />
      ) : null}
    </>
  );
}

function headingOf(
  where: Where,
  plan: LayoutPlan,
  panelOn: boolean,
  settings: CalendarViewSettings,
  monthRun: MonthRun | null,
  locale: ReturnType<typeof useLocale>,
  t: ReturnType<typeof useText>,
) {
  const { place, anchor, today } = where;
  const { one } = weekLayout(plan, panelOn);
  const phone = plan.device === "phone";
  const span = spanOfView(
    place === "week" && one ? "day" : isView(place) ? place : "day",
    anchor,
    settings.weekStart,
  );
  const visibleMonth = monthRun?.month ?? monthOfDay(anchor);
  const hot = monthRun ? visibleMonth === monthOfDay(today) : span.first <= today && today <= span.last;
  const dated = isView(place) || place === "agenda";
  const thisYear = yearOf(today);
  const single = place === "day" || (place === "week" && one);
  const title = !dated
    ? t("search")
    : single
      ? phone
        ? dayShort(anchor, locale, thisYear)
        : dayLong(anchor, locale, thisYear)
      : place === "week"
        ? weekTitle(span.first, span.last, locale, thisYear)
        : place === "year"
          ? yearOf(anchor)
          : monthName(visibleMonth, locale, phone ? thisYear : null);

  const shortTitle = single
    ? dayShort(anchor, locale, thisYear)
    : place === "week"
      ? weekTitle(span.first, span.last, locale, thisYear, true)
      : undefined;
  const weekNumber =
    settings.weekNumbers && !phone && (place === "day" || place === "week")
      ? weekOf(dayNumberOf(anchor)!, settings.weekStart).week
      : null;
  return { one, phone, hot, dated, single, title, shortTitle, weekNumber, visibleMonth };
}

function useCalendarHead({
  where,
  route,
  plan,
  panelOn,
  go,
  commands,
  keysHere,
  settings,
  port,
  monthRun,
  onToday,
}: CalendarFrameHeadProps) {
  const t = useText("calendar");
  const locale = useLocale();
  const { place, anchor, today } = where;
  const { one, phone, hot, dated, single, title, shortTitle, weekNumber, visibleMonth } = headingOf(
    where,
    plan,
    panelOn,
    settings,
    monthRun,
    locale,
    t,
  );
  const [menu, setMenu] = useState<HeadMenu | null>(null);
  const openDate = () => setMenu("date");
  const dateAnchor = useRef<HTMLButtonElement>(null);
  const moreAnchor = useRef<HTMLButtonElement>(null);
  const viewsAnchor = useRef<HTMLButtonElement>(null);
  const toDate = (day: string | null) => go({ place: dated ? place : "day", sub: day });
  const jump = (day: string | null) => {
    monthRun?.jump(day ?? today);
    toDate(day);
  };
  const step = (n: number) => jump(shifted(place, monthRun ? firstOfMonth(visibleMonth) : anchor, n, one));
  const todayNow = () => {
    jump(null);
    onToday();
  };
  const select = (view: CalendarPlaceId) => {
    if (view === place) return;
    const carried =
      !monthRun || visibleMonth === monthOfDay(anchor)
        ? route.sub
        : visibleMonth === monthOfDay(today)
          ? null
          : firstOfMonth(visibleMonth);
    go({ place: view, sub: carried });
  };
  const search = () => commands.go({ place: "calsearch", sub: route.sub });
  const agenda = () =>
    phone || place === "agenda"
      ? select("agenda")
      : commands.go({
          place: dated ? place : "week",
          sub: route.sub,
          open: route.open,
          words: panelOn ? {} : { panel: "agenda" },
        });
  const invitations = () => commands.go(invitationsRoute(route));
  const waiting = useInvitations(port)?.groups.waiting ?? 0;
  const views = VIEWS.map((value, index) => ({
    value,
    label: t(`view.${value}`),
    keyHint: String(index + 1),
    shortcut: String(index + 1),
  }));
  useCalendarNavigationKeys({
    enabled: keysHere && menu === null && route.words.panel !== "new",
    eventOpen: route.open !== null,
    place,
    anchor,
    dated,
    panelOn,
    views,
    select,
    todayNow,
    agenda,
    openDate,
    step,
    toDate,
    selectDay: (day) => go({ place: "day", sub: day }),
  });
  const toggleMenu = (next: HeadMenu) => setMenu((current) => (current === next ? null : next));
  const close = () => setMenu(null);
  const showStrip = phone && single;
  const swipe = useCalendarSwipe((n) => toDate(addDays(anchor, 7 * n)));

  return {
    t,
    place,
    anchor,
    today,
    dated,
    phone,
    hot,
    title,
    shortTitle,
    weekNumber,
    menu,
    anchors: { date: dateAnchor, more: moreAnchor, views: viewsAnchor },
    openDate,
    toDate,
    jump,
    step,
    todayNow,
    select,
    search,
    agenda,
    invitations,
    waiting,
    views,
    toggleMenu,
    close,
    showStrip,
    swipe,
    setMenu,
  };
}

function calendarHeadBar(
  head: ReturnType<typeof useCalendarHead>,
  { plan, route, panelOn }: CalendarFrameHeadProps,
) {
  const {
    t,
    place,
    dated,
    phone,
    hot,
    title,
    shortTitle,
    weekNumber,
    menu,
    anchors,
    openDate,
    step,
    todayNow,
    select,
    search,
    agenda,
    invitations,
    waiting,
    views,
    toggleMenu,
    close,
  } = head;
  return (
    <CalendarHead
      title={title}
      shortTitle={shortTitle}
      hot={dated && hot}
      away={!hot}
      switcher={plan.rail === "dock" ? <ProductSwitch kind="round" /> : undefined}
      {...(dated
        ? {
            goTo: {
              label: t("dateHeading", { date: title }),
              ref: anchors.date,
              onPress: menu === "date" ? close : openDate,
            },
            before: { label: t("before"), onPress: () => step(-1) },
            after: { label: t("after"), onPress: () => step(1) },
            today: { label: t("today"), keyHint: "t", onPress: todayNow },
          }
        : {})}
      week={
        weekNumber === null
          ? undefined
          : {
              word: t("view.week"),
              short: t("weekShort"),
              number: weekNumber,
              label: t("weekNumber", { number: weekNumber }),
              onPress: place === "day" ? () => select("week") : undefined,
            }
      }
      views={
        phone ? undefined : (
          <ViewSwitch
            label={t("views")}
            views={views}
            value={isView(place) ? place : null}
            compact={plan.device === "fold"}
            menuOpen={menu === "views"}
            onChange={select}
            capsuleRef={anchors.views}
            onOpen={() => toggleMenu("views")}
          />
        )
      }
      search={{ label: t("search"), onPress: search }}
      agenda={phone || place === "agenda" ? undefined : { label: t("agenda"), on: panelOn, onPress: agenda }}
      bell={
        waiting ? (
          <Doorbell
            count={String(waiting)}
            label={t("waiting", { count: waiting })}
            expanded={route.words.panel === "invitations"}
            onPress={invitations}
          />
        ) : undefined
      }
      more={{
        label: t("more"),
        ref: anchors.more,
        open: menu === "more" || menu === "hours",
        onPress: () => toggleMenu("more"),
      }}
    />
  );
}
