import { useRef, useState, type MouseEvent } from "react";
import { CalendarRail as Rail, type CalendarRailProps as KitRailProps } from "@ohmail/ui/calendar";
import { Dock, RailEntry, RailFoot, type DockPlace } from "@ohmail/ui/mail";
import { accountsOf, newEventsCalendarOf, writableOf } from "@ohmail/app-logic/calendar/setup";
import {
  dayOfIso,
  isoOfDay,
  nowIn,
  readerZones,
  viewOnlyOf,
  type CalendarPort,
} from "@ohmail/app-logic/calendar";
import { useFrame, useReport } from "../frame/commands.js";
import type { CalendarPlaceId, CalendarRailProps } from "../frame/contract.js";
import { NONE } from "../host/index.js";
import { useLocale, useText, useTimeZone } from "../text/index.js";
import { useFound } from "../frommail/index.js";
import { useInvitations } from "../invitations/index.js";
import { useCalendarMirror, useSetupPort } from "../calsetup/index.js";
import { useMonthViewport } from "../month/MonthRunScope.js";
import { useCalendarSettings } from "../calsettings/settings-read.js";
import { CalendarMenu } from "../calsettings/accounts/AccountLines.js";
import { useCalendarCheck } from "./check.js";
import { invitationsRoute } from "./CalendarKeys.js";
import { CalendarMiniMonth } from "./CalendarMiniMonth.js";
import { useNewEvent } from "./use-new-event.js";
import { isView, useNow } from "./where.js";

const PHONE_VIEWS = ["agenda", "day", "week", "month"] as const;
type RailCalendar = KitRailProps["calendars"]["accounts"][number]["calendars"][number];

export function CalendarRail(props: CalendarRailProps) {
  const port = useFrame().host.wires.calendar;
  return port === NONE ? <Navigation {...props} /> : <CountedNavigation {...props} port={port} />;
}

function CountedNavigation({ port, ...props }: CalendarRailProps & { readonly port: CalendarPort }) {
  const waiting = useInvitations(port)?.groups.waiting;
  const found = useFound(port)?.pending;
  const numeral = new Intl.NumberFormat(useLocale());
  return (
    <Navigation
      {...props}
      waiting={waiting ? numeral.format(waiting) : undefined}
      found={found ? numeral.format(found) : undefined}
    />
  );
}

function Navigation(props: CalendarRailProps & { readonly waiting?: string; readonly found?: string }) {
  const { form, route, commands, switcher, plan } = props;
  const t = useText("calendar");
  const open = useNewEvent(undefined, true);
  const create = open
    ? { label: t("create.title"), icon: "plus" as const, onPress: () => open(), keyHint: "C" }
    : undefined;
  const settings = () =>
    route.place === "calsettings" ? commands.closeCalendarSettings() : commands.go({ place: "calsettings" });
  const invitations = () => commands.go(invitationsRoute(route));
  const fromMail = () => commands.go({ place: "frommail" });
  const places: DockPlace[] = [
    {
      id: "invitations",
      label: t("invitations"),
      icon: "invite",
      current: route.words.panel === "invitations",
      count: props.waiting,
      onPress: invitations,
    },
    {
      id: "frommail",
      label: t("fromMail"),
      icon: "frommail",
      current: route.place === "frommail",
      count: props.found,
      onPress: fromMail,
    },
    {
      id: "settings",
      label: t("settings"),
      icon: "settings",
      current: route.place === "calsettings",
      onPress: settings,
    },
  ];
  const oneDay = plan.device === "phone" && plan.size === "compact";
  const pick = (place: CalendarPlaceId) =>
    commands.go({
      place,
      sub: place === route.place || dayOfIso(route.sub) === null ? null : route.sub,
    });
  const tabs: DockPlace[] = PHONE_VIEWS.filter((id) => id !== "week" || !oneDay).map((id) => ({
    id,
    label: t(`view.${id}`),
    icon: id,
    words: true,
    current: route.place === id || (oneDay && id === "day" && route.place === "week"),
    onPress: () => pick(id),
  }));

  if (form !== "words") {
    return (
      <Dock
        label={t("landmark")}
        places={form === "dock" ? tabs : places}
        write={create}
        floor={form === "dock" ? tabs.length : 0}
        upright={form === "icons"}
        switcher={switcher}
        more={{
          label: t("more"),
          drawer: true,
          count: form === "dock" ? props.waiting : undefined,
          countHot: true,
          onPress: () => commands.rail(true),
        }}
      />
    );
  }
  return <CalendarRailContents {...props} places={places} create={create} pick={pick} />;
}

function CalendarRailContents({
  route,
  commands,
  switcher,
  notice,
  plan,
  places,
  create,
  pick,
  accountFoot,
}: CalendarRailProps & {
  places: DockPlace[];
  create: KitRailProps["newEvent"];
  pick: (place: CalendarPlaceId) => void;
}) {
  const t = useText("calendar");
  const ts = useText("calsettings");
  const { said, expanded, setExpanded, rows, shown, all, check, menu } = useRailCalendars();
  const mini = useRailMiniMonth({ route, commands }, said?.weekNumbers);
  const entry = (place: DockPlace, shortcut?: string) => (
    <RailEntry
      key={place.id}
      kind="place"
      icon={place.icon}
      current={place.current}
      count={place.count}
      label={place.count ? t("placeCount", { place: place.label, count: place.count }) : undefined}
      keyHint={shortcut}
      onPress={place.onPress}
    >
      {place.label}
    </RailEntry>
  );
  return (
    <>
      <Rail
        label={t("places")}
        switcher={plan.rail === "words" ? switcher : undefined}
        newEvent={create}
        mini={mini}
        places={
          <>
            {plan.rail === "words"
              ? null
              : [
                  entry({
                    id: "week",
                    label: t("view.week"),
                    icon: "week",
                    current: route.place === "week",
                    onPress: () => pick("week"),
                  }),
                  entry({
                    id: "year",
                    label: t("view.year"),
                    icon: "year",
                    current: route.place === "year",
                    onPress: () => pick("year"),
                  }),
                  entry({
                    id: "search",
                    label: t("search"),
                    icon: "search",
                    onPress: () => commands.go({ place: "calsearch" }),
                  }),
                ]}
            {entry(places[0]!, "g i")}
            {entry(places[1]!, "g f")}
          </>
        }
        calendars={{
          label: t("calendars"),
          open: expanded,
          onToggle: () => setExpanded(!expanded),
          accounts: rows,
          note: shown < all ? t("shown", { shown, total: all }) : undefined,
        }}
        below={entry(places[2]!, "g ,")}
        foot={
          <RailFoot
            notice={notice}
            pull={
              check
                ? { label: ts("accounts.checkNow"), keyHint: "p", busy: check.busy, onPress: check.run }
                : undefined
            }
            account={
              accountFoot?.account
                ? {
                    ...accountFoot.account,
                    note: ts("accounts.calendarCount", { count: all }),
                    title: ts("accounts.calendarCount", { count: all }),
                    onPress: places[2]?.onPress,
                  }
                : undefined
            }
            tools={accountFoot?.tools}
          />
        }
      />
      {menu}
    </>
  );
}

function useRailCalendars() {
  const ts = useText("calsettings");
  const report = useReport();
  const mirror = useCalendarMirror();
  const setup = useSetupPort();
  const { said, save } = useCalendarSettings(mirror?.port ?? null, setup);
  const [expanded, setExpanded] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement | null>(null);
  const accounts = accountsOf(mirror?.connections ?? [], mirror?.calendars ?? []);
  const writable = writableOf(mirror?.calendars ?? [], mirror?.connections ?? []);
  const preferred = newEventsCalendarOf(said?.newEventsCalendarId ?? null, writable);
  const setCalendar = setup === NONE || setup.setCalendar === NONE ? undefined : setup.setCalendar;
  const check = useCalendarCheck();
  const calendar = mirror?.calendars.find((item) => item.id === opened);
  const closeMenu = () => {
    setOpened(null);
    setRenaming(false);
  };
  const saveCalendar = (id: string, change: { shown?: boolean; name?: string }) =>
    void setCalendar?.(id, change).catch(() => report(ts("notSaved")));
  const rows = accounts.map(({ connection, way, calendars }) => ({
    id: connection.id,
    name: ts(`way.${way}`),
    calendars: calendars.map((item): RailCalendar => ({
      id: item.id,
      name: item.name,
      shown: item.shown,
      tone: mirror?.tones.get(item.id) ?? "neutral",
      switchLabel: ts("accounts.show", { name: item.name }),
      onToggle: setCalendar && ((shown) => saveCalendar(item.id, { shown })),
      defaultLabel: item.id === preferred?.id ? ts("accounts.newEventsHere") : undefined,
      viewOnlyLabel: viewOnlyOf(item, connection) ? ts("accounts.viewOnly") : undefined,
      menuOpen: opened === item.id,
      onMenu:
        (setCalendar && connection.provider === "ics") || (save !== NONE && writable.includes(item))
          ? (e: MouseEvent<HTMLButtonElement>) => {
              menuAnchor.current = e.currentTarget;
              setOpened(item.id);
            }
          : undefined,
    })),
  }));
  const all = mirror?.calendars.length ?? 0;
  const shown = mirror?.calendars.filter((item) => item.shown).length ?? 0;
  const menu = calendar ? (
    <CalendarMenu
      key={calendar.id}
      calendar={calendar}
      anchor={menuAnchor}
      close={closeMenu}
      renaming={renaming}
      rename={
        mirror?.connections.some((item) => item.id === calendar.connectionId && item.provider === "ics")
          ? () => setRenaming(true)
          : undefined
      }
      setName={(name) => saveCalendar(calendar.id, { name })}
      newEventsHere={
        save !== NONE && writable.includes(calendar)
          ? {
              on: calendar.id === preferred?.id,
              set: () =>
                void save({ newEventsCalendarId: calendar.id }).then(
                  (done) => done || report(ts("notSaved")),
                ),
            }
          : null
      }
    />
  ) : null;
  return { said, expanded, setExpanded, rows, shown, all, check, menu };
}

function useRailMiniMonth(
  { route, commands }: Pick<CalendarRailProps, "route" | "commands">,
  weekNumbers: boolean | undefined,
) {
  const zone = useTimeZone();
  const monthRun = useMonthViewport();
  const current = nowIn(useNow(), zone, readerZones());
  const today = current === null ? null : isoOfDay(current.day);
  const anchor = dayOfIso(route.sub) ? route.sub! : today;
  if (!today || !anchor) return null;
  return (
    <CalendarMiniMonth
      anchor={anchor}
      today={today}
      weekStart={0}
      weekNumbers={weekNumbers}
      mode="rail"
      visibleMonth={monthRun?.month}
      onPick={(day) => {
        monthRun?.jump(day);
        commands.go({
          place: isView(route.place) || route.place === "agenda" ? route.place : "day",
          sub: day,
        });
      }}
      onMonth={(day) => {
        monthRun?.jump(day);
        commands.go({ place: "month", sub: day });
      }}
      onWeek={(day) => commands.go({ place: "week", sub: day })}
    />
  );
}
