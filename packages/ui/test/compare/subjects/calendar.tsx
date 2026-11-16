import type { Page } from "@playwright/test";
import {
  cloneElement,
  createElement,
  isValidElement,
  type ComponentType,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import { Button, design, Dot, Faces, Slot } from "../../../src/base/index.js";
import {
  AgendaRow,
  AllDayRow,
  AnswerSwitch,
  CalendarHead,
  CalendarRail,
  CalendarRow,
  CalendarSquare,
  EventBridge,
  EventCard,
  EventChip,
  EventForm,
  FoundEventRow,
  InvitationCard,
  MiniMonth,
  MonthGrid,
  OutOfSightCapsule,
  QuestionBeforeAct,
  QuickAdd,
  SidePanel,
  TimeGrid,
  TodayList,
  toneOf,
  toneStyle,
  ViewSwitch,
  type AgendaMark,
  type CalendarTone,
  type EventChipProps,
  type EventFormRow,
} from "../../../src/calendar/index.js";
import {
  ActionPanel,
  Doorbell,
  GroupHeading,
  ListHead,
  RailEntry,
  RailFoot,
  Rows,
  Switcher,
} from "../../../src/mail/index.js";
import { force, type KitSubject, type Look } from "../harness.js";
import world from "./calendar-world.json" with { type: "json" };

/** One subject for every row of `test/reference/calendar/states.json`. */

/* The calendar's accent. An app's frame writes the product and the accent on the root, and the two values
   every calendar's colour is mixed from; a part only reads them. Here the stage does what the frame does. */
const ACCENT = design.calendar.accents.cobalt;
async function inCalendar(page: Page): Promise<void> {
  await page.evaluate((accent) => {
    const root = document.documentElement;
    const face = root.dataset.face === "ohmarchy" ? "ohmarchy" : "paper";
    const of = accent[face][root.dataset.scheme === "dark" ? "dark" : "light"];
    if (face === "paper") root.dataset.accent = "cobalt";
    root.style.setProperty("--cal-mark", of["cal-mark"]);
    root.style.setProperty("--cal-tint", of["cal-tint"]);
  }, ACCENT);
}
/** In mail the calendar's squares still wear the calendar's colours: the frame writes the two values there too. */
async function calendarInMail(page: Page): Promise<void> {
  await page.evaluate((accent) => {
    const root = document.documentElement;
    const of =
      accent[root.dataset.face === "ohmarchy" ? "ohmarchy" : "paper"][
        root.dataset.scheme === "dark" ? "dark" : "light"
      ];
    root.style.setProperty("--cal-mark", of["cal-mark"]);
    root.style.setProperty("--cal-tint", of["cal-tint"]);
  }, ACCENT);
}
const then =
  (...acts: ((page: Page) => Promise<void>)[]) =>
  async (page: Page): Promise<void> => {
    for (const act of acts) await act(page);
  };
const cal = { root: { product: "cal" }, act: inCalendar } as const;

/* The invented world's calendars, by the hue of the ring each one wears. */
const RING = {
  mila: "blue",
  studio: "green",
  holidays: "grey",
  birthdays: "rose",
  family: "amber",
  home: "teal",
  vidralva: "violet",
  catalogue: "violet",
} as const;
type Calendar = keyof typeof RING;
type Hue = keyof typeof ACCENT.paper.light.hues;
const hueOf = (look: Look, ring: string): CalendarTone =>
  ring === "grey" ? "neutral" : ACCENT[look.face][look.scheme].hues[ring as Hue];
const tone = (look: Look, calendar: Calendar | null): CalendarTone =>
  calendar === null ? null : hueOf(look, RING[calendar]);

/* A grid of the invented world, written out as data: `{ c: a part's name, p: its inputs }`, a colour as "tone:<ring>". */
const PARTS: Record<string, ComponentType<never>> = {
  AllDayRow,
  EventChip,
  MiniMonth,
  MonthGrid,
  OutOfSightCapsule,
  TimeGrid,
} as never;
function revive(x: unknown, look: Look): unknown {
  if (Array.isArray(x))
    return x.map((y, i) => {
      const r = revive(y, look);
      return isValidElement(r) ? cloneElement(r, { key: i }) : r;
    });
  if (x !== null && typeof x === "object") {
    const o = x as Record<string, unknown>;
    if (typeof o.c === "string" && typeof o.p === "object")
      return createElement(PARTS[o.c]!, revive(o.p, look) as never);
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, revive(v, look)]));
  }
  return typeof x === "string" && x.startsWith("tone:") ? hueOf(look, x.slice(5)) : x;
}
type Scene = { width?: number; height?: number; scroll?: number; part: unknown };
const WORLD = world as Record<string, Scene>;
type Size = "desktop" | "phone" | "fold" | "foldl";
const SIZES: readonly Size[] = ["desktop", "phone", "fold", "foldl"];
/** A scene as the device draws it: the sheet's week differs by device, the others do not. */
const sceneOf = (name: string, device: Size): Scene => WORLD[`${name}@${device}`] ?? WORLD[name]!;
/** A grid stands in a column of a set height, as an app's main column gives it. */
const column = (scene: Scene, look: Look): ReactElement => (
  <div style={{ display: "flex", flexDirection: "column", width: scene.width, height: scene.height }}>
    {revive(scene.part, look) as ReactNode}
  </div>
);
/** The hours stand where the reference's stand: the place is the device's own. */
const scrolled =
  (name: string) =>
  async (page: Page): Promise<void> => {
    const tops = Object.fromEntries(SIZES.map((size) => [size, sceneOf(name, size).scroll ?? 0]));
    await page.evaluate((by) => {
      const root = document.documentElement,
        hours = document.querySelector(".oh-tg-scroll");
      const size =
        root.dataset.device === "fold" && root.dataset.pose === "land"
          ? "foldl"
          : (root.dataset.device ?? "desktop");
      if (hours) hours.scrollTop = by[size] ?? 0;
    }, tops);
  };
const grid = (key: string, name: string, target: string): KitSubject => ({
  key,
  place: "block",
  width: WORLD[name]!.width,
  target,
  root: cal.root,
  render: (look) => column(sceneOf(name, look.device), look),
  act: then(inCalendar, scrolled(name)),
});
const mini = (
  state: string,
  name: string,
  room: CSSProperties | ((look: Look) => CSSProperties),
): KitSubject => ({
  key: `MiniMonth/${state}`,
  place: "block",
  target: ".oh-mini",
  ...cal,
  render: (look) => (
    <div style={typeof room === "function" ? room(look) : room}>
      {revive(WORLD[name]!.part, look) as ReactNode}
    </div>
  ),
});

/* A chip alone. A block's box comes from the day's column it stands in: 2 px before it and 6 after. */
type Chip = Partial<EventChipProps> & { calendar?: Calendar | null };
const first = ".oh-ev";
const over = force(first, "hover");
const keyed = force(first, "focus", "focus-visible");
function block(
  state: string,
  chip: Chip,
  o: { time?: number; width?: number; act?: (page: Page) => Promise<void> } = {},
): KitSubject {
  const { calendar = "mila", ...rest } = chip;
  const height = o.time ?? 58;
  return {
    key: `EventChip/${state}`,
    place: "block",
    target: first,
    root: cal.root,
    act: o.act ? then(inCalendar, o.act) : inCalendar,
    render: (look) => (
      <div
        style={{
          position: "relative",
          marginLeft: -2,
          width: (o.width ?? 220) + 8,
          height: Math.max(height, 22),
        }}
      >
        <EventChip
          {...({
            size: "block",
            title: "",
            tone: tone(look, calendar),
            place: { top: 0, height },
            ...rest,
          } as EventChipProps)}
        />
      </div>
    ),
  };
}
function strip(
  size: "pill" | "line",
  state: string,
  chip: Chip,
  o: { width?: number; act?: (page: Page) => Promise<void> } = {},
): KitSubject {
  const { calendar = size === "pill" ? "studio" : "mila", ...rest } = chip;
  return {
    key: `EventChip/${state}`,
    target: first,
    root: cal.root,
    act: o.act ? then(inCalendar, o.act) : inCalendar,
    render: (look) => (
      <EventChip
        {...({
          size,
          title: "",
          tone: tone(look, calendar),
          style: o.width ? { width: o.width } : undefined,
          ...rest,
        } as EventChipProps)}
      />
    ),
  };
}
const anna: Chip = { title: "Lunch with Anna", second: "Gartenlokal Rosa", handles: true };
const fest: Chip = { title: "Makersfest" };
const invoices: Chip = { title: "Invoices, new template", time: "09:00" };

const chips: KitSubject[] = [
  block("block", anna),
  block("block-hover", anna, { act: over }),
  block("block-focus", anna, { act: keyed }),
  block("block-open", {
    calendar: "studio",
    title: "Poster review",
    second: "Studio, Winterthur",
    open: true,
    handles: true,
  }),
  block("block-to-answer-new", {
    calendar: null,
    title: "Tech check, main hall",
    second: "Makersfest, Hall 2, Zürich",
    state: "to-answer",
    waits: true,
  }),
  block("block-to-answer", {
    calendar: "vidralva",
    title: "Dinner with Inês",
    second: "Porto",
    state: "to-answer",
    waits: true,
  }),
  block("block-changed", {
    calendar: "vidralva",
    title: "Catalogue shoot, day 1",
    second: "10:30–17:00 Porto",
    was: "11:00",
    waits: true,
    handles: true,
  }),
  block("block-cancelled", {
    calendar: "vidralva",
    title: "Catalogue weekly",
    state: "off",
    waits: true,
    handles: true,
  }),
  block("block-maybe", {
    title: "Stallholders’ evening",
    second: "Wintermarkt Lind",
    state: "maybe",
    handles: true,
  }),
  block("block-from-mail", {
    calendar: null,
    title: "Winternacht",
    second: "Sat 21 Nov, 19:30",
    state: "from-mail",
  }),
  /* With the keys on it: the kit rings it as it rings every chip; the sheet's found chip shows nothing new. */
  block(
    "block-from-mail-focus",
    { calendar: null, title: "Winternacht", second: "Sat 21 Nov, 19:30", state: "from-mail" },
    { act: keyed },
  ),
  block("block-draft", { title: "Lunch with Ben", state: "draft" }),
  block("block-zone", {
    calendar: "vidralva",
    title: "Catalogue shoot, day 2",
    second: "09:00–13:00 Porto",
    handles: true,
  }),
  block("block-view-only", { calendar: "catalogue", title: "Layout review", viewOnly: true }),
  block("block-waiting", { title: "Pack the stand", status: { text: "Waiting" }, handles: true }),
  block("block-not-saved", {
    title: "Pack the stand",
    status: { text: "Not saved", failed: true },
    handles: true,
  }),
  block("block-half-hour", { calendar: "studio", title: "Studio Monday", handles: true }, { time: 30 }),
  block("block-shortest", { calendar: "studio", title: "Tech check", handles: true }, { time: 15 }),
  block(
    "block-narrow",
    { calendar: "vidralva", title: "Catalogue weekly", dense: true, handles: true },
    { time: 46, width: 84 },
  ),
  block(
    "block-two-hours",
    { calendar: "studio", title: "Stand set-up, Hall 2", second: "Makersfest, Zürich", handles: true },
    { time: 120 },
  ),
  {
    key: "EventChip/block-dragged",
    place: "block",
    target: first,
    ...cal,
    render: (look) => (
      <div style={{ position: "relative", marginLeft: -2, width: 228, height: 58 }}>
        <EventChip
          size="block"
          tone={tone(look, "mila")}
          title="Dentist"
          place={{ top: 0, height: 40 }}
          handles
          drag="lifted"
        />
        <EventChip
          size="block"
          tone={tone(look, "mila")}
          title="Dentist"
          second="Thu 12 Nov, 10:15"
          place={{ top: 18, height: 40 }}
          handles
          drag="copy"
        />
      </div>
    ),
  },
  strip("pill", "pill", fest, { width: 200 }),
  strip("pill", "pill-hover", fest, { width: 200, act: over }),
  strip("pill", "pill-open", { ...fest, open: true }, { width: 200 }),
  strip("pill", "pill-view-only", { calendar: "catalogue", title: "Photo selects due", viewOnly: true }),
  strip("pill", "pill-neutral", { calendar: "holidays", title: "First Advent", viewOnly: true }),
  strip("pill", "pill-from-mail", { calendar: null, title: "Glaze order #2291 arrives", state: "from-mail" }),
  strip("pill", "pill-draft", { calendar: "mila", title: "Makersfest", state: "draft" }, { width: 160 }),
  strip("line", "line", invoices),
  strip("line", "line-hover", invoices, { act: over }),
  strip("line", "line-open", { calendar: "studio", title: "Poster review", time: "14:30", open: true }),
  strip("line", "line-to-answer", {
    calendar: null,
    title: "Tech check, main hall",
    time: "16:00",
    state: "to-answer",
    waits: true,
  }),
  strip("line", "line-changed", {
    calendar: "vidralva",
    title: "Catalogue shoot, day 1",
    time: "11:30",
    waits: true,
  }),
  strip("line", "line-cancelled", {
    calendar: "vidralva",
    title: "Catalogue weekly",
    time: "14:00",
    state: "off",
    waits: true,
  }),
  strip("line", "line-maybe", { title: "Stallholders’ evening", time: "19:00", state: "maybe" }),
  strip("line", "line-from-mail", {
    calendar: null,
    title: "Winternacht",
    time: "09:00",
    state: "from-mail",
  }),
  strip("line", "line-run", { calendar: "studio", title: "Makersfest", run: true }),
];

const square = (state: string, render: (look: Look) => ReactElement): KitSubject => ({
  key: `CalendarSquare/${state}`,
  target: ".oh-csq",
  ...cal,
  render,
});
const squares: KitSubject[] = [
  square("rest", (look) => <CalendarSquare tone={tone(look, "mila")} />),
  square("large", (look) => <CalendarSquare tone={tone(look, "mila")} size={12} />),
  square("small", (look) => <CalendarSquare tone={tone(look, "mila")} size={6} />),
  square("hidden", (look) => (
    <>
      <CalendarSquare tone={tone(look, "home")} hollow />
      <CalendarSquare tone={tone(look, "home")} size={12} hollow />
    </>
  )),
  square("neutral", (look) => (
    <>
      <CalendarSquare tone="neutral" />
      <CalendarSquare tone="neutral" size={12} />
    </>
  )),
];

const grids: KitSubject[] = [
  grid("TimeGrid/week", "week", ".oh-tg"),
  grid("TimeGrid/day", "day", ".oh-tg"),
  grid("TimeGrid/day-now", "now-day", ".oh-tg"),
  grid("TimeGrid/days-now", "now-week", ".oh-tg"),
  grid("TimeGrid/all-day", "allday", ".oh-tg"),
  grid("TimeGrid/hot", "hot", ".oh-tg"),
  grid("AllDayRow/rest", "allday", ".oh-allday"),
  grid("NowLine/rest", "now-day", ".oh-now"),
  grid("OutOfSightCapsule/rest", "now-day", ".oh-oos"),
  grid("MonthGrid/month", "month", ".oh-mo"),
  grid("MonthGrid/week-numbers", "month-numbers", ".oh-mo"),
  grid("WeekNumber/rest", "month-numbers", ".oh-mo-week:nth-child(2) > .oh-wn"),
];

const RAIL: CSSProperties = { width: 232 };
/* The rail's width is the face's own. */
const railWide = (look: Look): CSSProperties => ({
  width: look.face === "ohmarchy" && look.device === "desktop" ? 212 : 232,
});
const minis: KitSubject[] = [
  mini("rail", "mini-rail", railWide),
  mini("picked", "mini-picked", RAIL),
  mini("year", "mini-year", RAIL),
  mini("menu", "mini-menu", { width: 220 }),
  mini("phone", "mini-phone", { width: 358 }),
  mini("widget", "mini-widget", { width: 140 }),
];

/* A row is as wide as the rail it stands in, and the rail's width is the face's own. */
const row = (
  state: string,
  render: (look: Look) => ReactElement,
  act?: (page: Page) => Promise<void>,
): KitSubject => ({
  key: `CalendarRow/${state}`,
  target: ".oh-calrow",
  root: cal.root,
  act: act ? then(inCalendar, act) : inCalendar,
  render: (look) => <div style={{ width: look.face === "ohmarchy" ? 212 : 232 }}>{render(look)}</div>,
});
const rows: KitSubject[] = [
  row("rest", (look) => (
    <CalendarRow
      name="Mila"
      tone={tone(look, "mila")}
      shown
      switchLabel="Show Mila"
      defaultLabel="New events go here"
    />
  )),
  row(
    "hover",
    (look) => (
      <CalendarRow
        name="Lichtgrat studio"
        tone={tone(look, "studio")}
        shown
        switchLabel="Show Lichtgrat studio"
      />
    ),
    force(".oh-calrow", "hover"),
  ),
  row("view-only", (look) => (
    <CalendarRow
      name="Catalogue 2027"
      tone={tone(look, "catalogue")}
      shown
      switchLabel="Show Catalogue 2027"
      viewOnlyLabel="View only"
    />
  )),
  row("hidden", (look) => (
    <CalendarRow name="Home" tone={tone(look, "home")} shown={false} switchLabel="Show Home" />
  )),
  row("neutral", () => (
    <CalendarRow
      name="Holidays in Switzerland"
      tone="neutral"
      shown
      switchLabel="Show Holidays in Switzerland"
      viewOnlyLabel="View only"
    />
  )),
];

const VIEWS = [
  { value: "day", label: "Day", keyHint: "1" },
  { value: "week", label: "Week", keyHint: "2" },
  { value: "month", label: "Month", keyHint: "3" },
  { value: "year", label: "Year", keyHint: "4" },
] as const;
const views: KitSubject[] = [
  {
    key: "ViewSwitch/segments",
    target: ".oh-seg",
    ...cal,
    render: () => <ViewSwitch label="View" views={VIEWS} value="week" />,
  },
  {
    key: "ViewSwitch/capsule",
    target: ".oh-vs-cap",
    ...cal,
    render: () => <ViewSwitch label="View" views={VIEWS} value="week" compact />,
  },
];

/* The head of a view. The reference stands it in a column of the width its cell gives. */
const head = (state: string, render: (look: Look, compact: boolean) => ReactElement): KitSubject => ({
  key: `CalendarHead/${state}`,
  place: "block",
  target: ".oh-calhead",
  ...cal,
  render: (look) => render(look, look.device !== "desktop"),
});
const viewsOf = (value: string | null, compact: boolean) => (
  <ViewSwitch label="View" views={VIEWS} value={value} compact={compact} />
);
const bell = <Doorbell count="3" label="3 to answer, Invitations" />;
const SPAN = {
  before: { label: "Before · [" },
  after: { label: "After · ]" },
  today: { label: "Today", keyHint: "t" },
};
const TOOLS = {
  search: { label: "Search · /" },
  agenda: { label: "Agenda · g a", on: false },
  bell,
  more: { label: "More" },
};
const week = {
  title: "9 – 15 November",
  shortTitle: "9 – 15 Nov",
  goTo: { label: "9 – 15 November, Go to a date" },
};
const heads: KitSubject[] = [
  head("rest", (_, compact) => (
    <CalendarHead {...week} hot {...SPAN} views={viewsOf("week", compact)} {...TOOLS} />
  )),
  head("away", (_, compact) => (
    <CalendarHead
      title="16 – 22 November"
      shortTitle="16 – 22 Nov"
      hot={false}
      goTo={{ label: "16 – 22 November, Go to a date" }}
      sub="Week 47"
      away
      {...SPAN}
      views={viewsOf("week", compact)}
      {...TOOLS}
    />
  )),
  head("place", (_, compact) => (
    <CalendarHead title="Invitations" hot views={viewsOf(null, compact)} {...TOOLS} />
  )),
  head("narrow", (_, compact) => (
    <CalendarHead {...week} hot {...SPAN} views={viewsOf("week", compact)} {...TOOLS} />
  )),
  head("phone", () => (
    <CalendarHead
      title="November"
      hot
      goTo={{ label: "November, Go to a date" }}
      before={SPAN.before}
      after={SPAN.after}
      bell={bell}
      more={TOOLS.more}
      switcher={
        <Switcher
          kind="round"
          label="Mail or Calendar"
          current="cal"
          mail={{ word: "ohmail", label: "Mail", wants: true }}
          cal={{ word: "ohcal", label: "Calendar" }}
        />
      }
    />
  )),
];

/* A row of a list of events, in the list's column. */
const mark = (look: Look, calendar: Calendar): AgendaMark => ({
  kind: "calendar",
  tone: tone(look, calendar),
});
const listed = (
  state: string,
  render: (look: Look) => ReactNode,
  act?: (page: Page) => Promise<void>,
): KitSubject => ({
  key: `AgendaRow/${state}`,
  place: "block",
  /* On a phone the list stands on the ground; elsewhere on the list's sheet, which the specimen's row tops. */
  on: "ground",
  target: ".oh-erow",
  root: cal.root,
  act: act ? then(inCalendar, act) : inCalendar,
  render: (look) => (look.device === "phone" ? render(look) : <ListTop>{render(look)}</ListTop>),
});
/**
 * The top of the list's sheet: its round corners stand 8.5 px out from the row on the left and 7.5 px on
 * the right, as the specimen's list does (measured on the reference's pictures).
 */
const ListTop = ({ children }: { children: ReactNode }) => (
  <div
    style={{
      margin: "0 -7.5px 0 -8.5px",
      padding: "0 7.5px 0 8.5px",
      background: "var(--sheet)",
      borderRadius: "var(--r-sheet) var(--r-sheet) 0 0",
    }}
  >
    {children}
  </div>
);
const annaRow = (look: Look) => (
  <AgendaRow mark={mark(look, "mila")} title="Lunch with Anna" time="12:15–13:15" second="Gartenlokal Rosa" />
);
const agenda: KitSubject[] = [
  listed("rest", annaRow),
  listed("now", (look) => (
    <AgendaRow mark={mark(look, "mila")} title="Invoices, new template" time="until 10:00" now />
  )),
  listed("hover", annaRow, force(".oh-erow", "hover")),
  listed("open", (look) => (
    <AgendaRow
      mark={mark(look, "studio")}
      title="Poster review"
      time="14:30–15:30"
      second="Studio, Winterthur · Jonas Halter"
      open
    />
  )),
  listed("to-answer", () => (
    <AgendaRow
      mark={{ kind: "outlined" }}
      title="Tech check, main hall"
      time="16:00–16:15"
      second="Makersfest, Hall 2, Zürich · Petra Wyss"
      waits
    />
  )),
  listed("changed", (look) => (
    <AgendaRow
      mark={mark(look, "vidralva")}
      title="Catalogue shoot, day 1"
      time="11:30–18:00"
      second="10:30–17:00 Porto · Vidralva, Porto · Inês Carvalho"
      waits
    />
  )),
  listed("cancelled", (look) => (
    <AgendaRow
      mark={mark(look, "vidralva")}
      title="Catalogue weekly"
      time="14:00–14:45"
      second="13:00–13:45 Porto · Call · Inês Carvalho"
      off
      waits
    />
  )),
  listed("maybe", (look) => (
    <AgendaRow
      mark={mark(look, "mila")}
      title="Stallholders’ evening"
      time="19:00–21:00"
      second="Wintermarkt Lind"
      quiet
    />
  )),
  listed("all-day", (look) => (
    <AgendaRow mark={mark(look, "studio")} title="Makersfest" time="all day" second="Zürich · Jonas Halter" />
  )),
  listed("found", () => (
    <AgendaRow
      mark={{ kind: "found" }}
      title="Train to Lugano"
      time="08:02"
      second="Winterthur → Lugano · Seat 44, window, lake side"
      quiet
    />
  )),
  listed("dated", () => (
    <AgendaRow
      mark={{ kind: "mail", icon: "resurface" }}
      title="Resurface"
      time="09:00"
      second="Domain renewal: lichtgrat.example expires 30 November"
      quiet
    />
  )),
];

/* The panel beside a view: the Agenda of a far week of the invented world, which holds only what repeats. */
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"] as const;
type Repeat = [Calendar, string, string, string];
const WEEKLY: Record<string, Repeat[]> = {
  Mon: [["studio", "Studio Monday", "09:00–09:30", "Studio, Winterthur · Rahel Beck"]],
  Tue: [
    ["vidralva", "Catalogue weekly", "14:00–14:45", "13:00–13:45 Porto · Call · Inês Carvalho"],
    ["mila", "Bouldering with Tim", "18:30–20:00", "Boulder hall, Winterthur"],
  ],
  Wed: [["studio", "Open bench", "18:00–20:00", "Studio, Winterthur · Ben Arnold"]],
  Thu: [
    ["mila", "Run with Reto", "07:00–07:45", "Forest loop"],
    ["studio", "Glaze firing", "13:00–14:00", "Kiln room · Ben Arnold"],
    ["vidralva", "Catalogue check-in", "16:30–17:00", ""],
  ],
};
const MONTH_END: Repeat = ["mila", "Month-end books", "15:00–16:00", "Studio, Winterthur"];
function farAgenda(look: Look): ReactNode[] {
  const out: ReactNode[] = [];
  const day = new Date(Date.UTC(2028, 5, 5));
  const last = Date.UTC(2028, 7, 3);
  for (; day.getTime() <= last; day.setUTCDate(day.getUTCDate() + 1)) {
    const name = DAYS[day.getUTCDay() - 1];
    if (!name) continue;
    const next = new Date(day.getTime() + 7 * 86400000);
    const events =
      name === "Fri" ? (next.getUTCMonth() !== day.getUTCMonth() ? [MONTH_END] : []) : WEEKLY[name]!;
    if (!events.length) continue;
    const title = `${name} ${day.getUTCDate()} ${day.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })} 2028`;
    out.push(
      <GroupHeading key={title} count={String(events.length)}>
        {title}
      </GroupHeading>,
      <Rows key={`${title}-rows`}>
        {events.map(([calendar, name_, time, second]) => (
          <AgendaRow
            key={name_}
            mark={mark(look, calendar)}
            title={name_}
            time={time}
            second={second || undefined}
          />
        ))}
      </Rows>,
    );
  }
  return out;
}
const panels: KitSubject[] = [
  {
    key: "SidePanel/agenda",
    place: "block",
    target: ".oh-calside",
    ...cal,
    render: (look) => (
      <div style={{ display: "grid", height: look.face === "ohmarchy" ? 820 : 824 }}>
        <SidePanel
          label="Agenda"
          head={
            <ListHead title="Agenda" aside={<Button kind="quiet" size="s" icon="x" label="Close · g a" />} />
          }
        >
          {farAgenda(look)}
        </SidePanel>
      </div>
    ),
  },
];

/* The event's parts. A card stands where the app puts it: here at the corner of a room of its own. */
const THREE = [
  { value: "yes", label: "Yes" },
  { value: "maybe", label: "Maybe" },
  { value: "no", label: "No" },
] as const;
const room = (node: ReactNode, height = 860, width?: number): ReactElement => (
  <div style={{ position: "relative", height, width }}>{node}</div>
);
/* On the card the answers carry their keys; a face that shows no keys draws none. */
const THREE_KEYED = [
  { value: "yes", label: "Yes", keyHint: "y" },
  { value: "maybe", label: "Maybe", keyHint: "⇧y" },
  { value: "no", label: "No", keyHint: "n" },
] as const;
const answersOn = (value: string | null) => (
  <AnswerSwitch
    label="Answer"
    on="sheet"
    answers={{ options: THREE_KEYED, value }}
    propose={{ label: "Propose a time" }}
  />
);
/* The invented world's people who are not of the studio: a face's colour is read from its address. */
const ELSEWHERE: Record<string, string> = {
  "Inês Carvalho": "ines.carvalho@vidralva.example",
  "Duarte Pires": "duarte.pires@vidralva.example",
  "Petra Wyss": "petra@makersfest.example",
  "Anna Odermatt": "anna@gartenlokal-rosa.example",
  "Giulia Ferrari": "giulia@terracotta-milano.example",
  "Nadja Lehner": "nadja@erdton-atelier.example",
};
/* The answers stand at the end of a card's head: on the open event's own colour. */
const onHead = (look: Look, calendar: Calendar, node: ReactNode): ReactElement => {
  const of = tone(look, calendar);
  return (
    <div {...toneOf(of)} style={{ ...toneStyle(of), background: "var(--oh-cal-open)" }}>
      {node}
    </div>
  );
};
const people = (...names: string[]) =>
  names.map((name) => ({
    name,
    address: ELSEWHERE[name] ?? `${name.split(" ")[0]!.toLowerCase()}@lichtgrat.example`,
  }));
const close = { label: "Close" };
const card = (
  state: string,
  render: (look: Look) => ReactElement,
  o: Partial<KitSubject> = {},
): KitSubject => ({
  key: `EventCard/${state}`,
  place: "window",
  target: ".oh-ecard",
  ...cal,
  render: (look) => <div style={{ position: "fixed", inset: 0 }}>{render(look)}</div>,
  ...o,
});
/* Upright, the unfolded phone leaves the card less than its width, and the app narrows it. */
const narrowed = (look: Look): CSSProperties | undefined =>
  look.device === "fold" ? { width: 255.5 } : look.device === "foldl" ? { width: 344 } : undefined;
const shoot = (look: Look) => (
  <EventCard
    style={narrowed(look)}
    title="Catalogue shoot, day 1"
    tone={tone(look, "vidralva")}
    when="Wed 18 Nov, 11:30–18:00"
    where={[{ text: "10:30–17:00 Porto" }, { text: "Vidralva, Porto", maps: { label: "Open in Maps" } }]}
    tags={[{ text: "was 11:00", hot: true }]}
    why={{ text: "Invited" }}
    close={close}
    answers={answersOn(null)}
    rows={[
      { label: "Calendar", tone: tone(look, "vidralva"), text: "Vidralva" },
      { label: "Provider", text: "Microsoft 365 · “Calendar”" },
      { label: "From", link: { label: "Inês Carvalho" } },
      {
        label: "Invitees",
        children: <Faces people={people("Inês Carvalho", "Mila Brunner", "Duarte Pires")} />,
        note: "2 yes · 1 no answer",
      },
      { label: "Alert", text: "1 day before" },
    ]}
  />
);
const cards: KitSubject[] = [
  card("invited", shoot),
  card("own", (look) => (
    <EventCard
      title="Lunch with Anna"
      tone={tone(look, "mila")}
      when="Fri 13 Nov, 12:15–13:15"
      where={[{ text: "Gartenlokal Rosa", maps: { label: "Open in Maps" } }]}
      edit={{ label: "Edit" }}
      close={close}
      rows={[
        { label: "Calendar", tone: tone(look, "mila"), text: "Mila" },
        { label: "Alert", text: "30 minutes before" },
      ]}
    />
  )),
  card("view-only", (look) => (
    <EventCard
      title="Photo selects due"
      tone={tone(look, "catalogue")}
      when="Tue 24 Nov"
      why={{ text: "View only", locked: true }}
      close={close}
      rows={[
        { label: "Calendar", tone: tone(look, "catalogue"), text: "Catalogue 2027" },
        { label: "Access", text: "View only · from Inês Carvalho" },
        { label: "From", link: { label: "Inês Carvalho" } },
      ]}
    />
  )),
  card("call", (look) => (
    <EventCard
      title="Catalogue weekly"
      tone={tone(look, "vidralva")}
      when="Tue 10 Nov, 14:00–14:45"
      where={[{ text: "13:00–13:45 Porto" }, { text: "Call" }]}
      why={{ text: "Invited" }}
      close={close}
      answers={answersOn("yes")}
      rows={[
        { label: "Calendar", tone: tone(look, "vidralva"), text: "Vidralva" },
        { label: "Provider", text: "Microsoft 365 · “Calendar”" },
        { label: "From", link: { label: "Inês Carvalho" } },
        {
          label: "Invitees",
          children: <Faces people={people("Inês Carvalho", "Mila Brunner", "Duarte Pires")} />,
          note: "3 yes",
        },
        { label: "Repeat", text: "Every week on Tuesday" },
        { label: "Alert", text: "10 minutes before" },
        {
          label: "Call",
          call: {
            join: { label: "Join" },
            address: "meet.vidralva.example/catalogue-weekly",
            copy: { label: "Copy the address" },
          },
        },
        { label: "File", file: { name: "Shot-list-v4.pdf", size: "184 KB" } },
      ]}
    />
  )),
  card("found", () => (
    <EventCard
      still
      title="Train to Lugano"
      tone={null}
      when="Sat 14 Nov, 08:02–11:24"
      where={[{ text: "Winterthur → Lugano" }]}
      tags={[{ text: "from mail" }]}
      close={close}
      answers={
        <AnswerSwitch
          label="Answer"
          on="sheet"
          acts={[
            { id: "add", label: "Add", primary: true },
            { id: "dismiss", label: "Dismiss" },
          ]}
        />
      }
      rows={[
        { label: "Goes to", children: <Slot>Mila</Slot> },
        { label: "Words", words: ["Saturday 14 November", "departs 08:02", "arrives 11:24"] },
        { label: "Details", text: "Seat 44, window, lake side" },
        { label: "Letter", link: { label: "Your ticket Winterthur–Lugano, 14 November" } },
      ]}
    />
  )),
  /* Set into a list, a card is as wide as the list. */
  {
    key: "EventCard/inline",
    place: "block",
    on: "sheet",
    target: ".oh-ecard",
    ...cal,
    render: (look) => (
      <EventCard
        frame="inline"
        title="Tech check, main hall"
        tone={null}
        when="Fri 20 Nov, 16:00–16:15"
        where={[{ text: "Makersfest, Hall 2, Zürich", maps: { label: "Open in Maps" } }]}
        tags={[{ text: "overlaps Stand set-up, Hall 2", tone: tone(look, "studio") }]}
        close={close}
        rows={[
          { label: "Goes to", children: <Slot>Mila</Slot> },
          { label: "From", link: { label: "Petra Wyss" } },
          {
            label: "Invitees",
            children: <Faces people={people("Petra Wyss", "Mila Brunner")} />,
            note: "1 yes · 1 no answer",
          },
          { label: "Letter", link: { label: "Invitation: Tech check, main hall" } },
        ]}
      />
    ),
  },
  {
    key: "EventCard/sheet",
    place: "window",
    target: ".oh-ecard",
    ...cal,
    render: (look) => (
      <div style={{ position: "fixed", inset: 0 }}>
        <EventCard
          still
          frame="sheet"
          title="Poster review"
          tone={tone(look, "studio")}
          when="Tue 10 Nov, 14:30–15:30"
          where={[{ text: "Studio, Winterthur", maps: { label: "Open in Maps" } }]}
          tags={[{ text: "overlaps Catalogue weekly", tone: tone(look, "vidralva") }]}
          why={{ text: "Invited" }}
          close={close}
          answers={
            <AnswerSwitch
              label="Answer"
              answers={{ options: THREE, value: "yes" }}
              propose={{ label: "Propose a time" }}
            />
          }
          rows={[
            { label: "Calendar", tone: tone(look, "studio"), text: "Lichtgrat studio" },
            { label: "From", link: { label: "Jonas Halter" } },
            {
              label: "Invitees",
              children: <Faces people={people("Jonas Halter", "Mila Brunner")} />,
              note: "2 yes",
            },
            { label: "Alert", text: "10 minutes before" },
            { label: "File", file: { name: "Poster-A2-final.pdf", link: true } },
          ]}
          foot={
            <ActionPanel
              label="Actions"
              items={[{ id: "write", label: "Write to invitees", icon: "mail", keyHint: "r" }]}
              more={{ label: "More", behind: true }}
            />
          }
        />
      </div>
    ),
  },
  {
    key: "AnswerSwitch/rest",
    place: "block",
    target: ".oh-ans",
    ...cal,
    render: (look) => onHead(look, "vidralva", answersOn(null)),
  },
  {
    key: "AnswerSwitch/given",
    place: "block",
    target: ".oh-ans",
    ...cal,
    render: (look) => onHead(look, "studio", answersOn("yes")),
  },
];
/* A week's event four hours tall and its card ten pixels beside it, where the app measured them in a window:
   the main column, the two boxes in it, their corners, the line round both, and mail's marks in that column. */
const BESIDE = {
  paper: {
    column: { left: 256, top: 12, width: 1172, height: 876 },
    event: { left: 371.703125, top: 193, right: 506.5625, bottom: 395 },
    card: { left: 516.5625, top: 193, right: 860.5625, bottom: 401.40625 },
    round: { event: 12, card: 20 },
    line: 1.5,
    headBottom: 289.78125,
    marks: [
      { left: 347.703125, top: 234, right: 367.703125, bottom: 254 },
      { left: 506.5625, top: 183, right: 526.5625, bottom: 203 },
    ],
  },
  ohmarchy: {
    column: { left: 250, top: 12, width: 1178, height: 876 },
    event: { left: 380.5625, top: 195, right: 514.84375, bottom: 389 },
    card: { left: 524.84375, top: 195, right: 896.84375, bottom: 387.953125 },
    round: { event: 0, card: 0 },
    line: 2,
    headBottom: 278.5625,
    marks: [
      { left: 356.5625, top: 234, right: 376.5625, bottom: 254 },
      { left: 514.84375, top: 185, right: 534.84375, bottom: 205 },
    ],
  },
} as const;
const bridges: KitSubject[] = [
  {
    key: "EventBridge/beside",
    place: "window",
    target: ".oh-bridge-fill",
    ...cal,
    render: (look) => {
      const at = BESIDE[look.face];
      const of = tone(look, "studio");
      return (
        <div style={{ position: "fixed", ...at.column, background: "var(--sheet)" }}>
          <div
            style={{
              position: "absolute",
              left: at.event.left - 2,
              top: at.event.top,
              width: at.event.right - at.event.left + 8,
              height: at.event.bottom - at.event.top,
            }}
          >
            <EventChip
              size="block"
              title="Kiln technician"
              second="Kiln room"
              tone={of}
              open
              handles
              place={{ top: 0, height: at.event.bottom - at.event.top }}
            />
          </div>
          <EventCard
            still
            side="r"
            style={{ left: at.card.left, top: at.card.top }}
            title="Kiln technician"
            tone={of}
            when="Wed 11 Nov, 08:00–12:00"
            where={[{ text: "Kiln room", maps: { label: "Open in Maps" } }]}
            edit={{ label: "Edit" }}
            close={close}
            rows={[
              { label: "Calendar", tone: of, text: "Lichtgrat studio" },
              { label: "Alert", text: "30 minutes before" },
            ]}
          />
          <EventBridge
            still
            tone={of}
            width={at.column.width}
            height={at.column.height}
            event={{ box: at.event, radius: at.round.event }}
            card={{ box: at.card, radius: at.round.card, headBottom: at.headBottom }}
            side="r"
            line={at.line}
            marks={at.marks}
          />
        </div>
      );
    },
  },
];
const WHEN: EventFormRow = {
  id: "when",
  icon: "clock",
  items: [
    { kind: "slot", value: "Wed 11 Nov", label: "Day" },
    { kind: "time", value: "13:00", label: "Starts" },
    { kind: "word", text: "to" },
    { kind: "time", value: "14:00", label: "Ends" },
    { kind: "switch", label: "All day", on: false },
  ],
};
const calendarRow = (look: Look): EventFormRow => ({
  id: "cal",
  mark: tone(look, "mila"),
  items: [
    { kind: "slot", value: "Mila", label: "Calendar" },
    { kind: "slot", value: "Busy", label: "Show as" },
    { kind: "toggle", label: "Private", icon: "lock", on: false },
  ],
});
const ADDS = [
  { id: "repeat", word: "Repeat", icon: "repeat" },
  { id: "call", word: "Call", label: "Video call", icon: "video" },
  { id: "place", word: "Place", icon: "place" },
  { id: "alerts", word: "Alert", icon: "bell" },
  { id: "notes", word: "Notes", icon: "note" },
] as const;
const typedForm = (look: Look) => (
  <EventForm
    rows={[
      WHEN,
      {
        id: "invitees",
        icon: "people",
        items: [
          { kind: "word", text: "Invite" },
          { kind: "take", value: "Ben Arnold", label: "Invite Ben Arnold" },
          { kind: "slot", value: "Add", label: "Add invitees", state: "none" },
        ],
      },
      calendarRow(look),
    ]}
    adds={ADDS}
    more={{ label: "More fields" }}
    submit={{ label: "Add", keyHint: "↵" }}
  />
);
const fullForm = (look: Look) => (
  <EventForm
    rows={[
      {
        ...WHEN,
        items: [
          ...WHEN.items.slice(0, 4),
          { kind: "slot", value: "Zürich", label: "Time zone" },
          WHEN.items[4]!,
        ],
      },
      {
        id: "repeat",
        icon: "repeat",
        items: [
          { kind: "slot", value: "Every week on Wednesday", label: "Repeat" },
          { kind: "slot", value: "until Sun 20 Dec", label: "Ends" },
        ],
      },
      {
        id: "invitees",
        icon: "people",
        items: [
          {
            kind: "person",
            name: "Ben Arnold",
            address: "ben@lichtgrat.example",
            label: "Ben Arnold",
            remove: { label: "Remove Ben Arnold" },
          },
          {
            kind: "person",
            name: "Anna Odermatt",
            address: "anna@gartenlokal-rosa.example",
            note: "optional",
            label: "Anna Odermatt, optional",
            remove: { label: "Remove Anna Odermatt" },
          },
          { kind: "slot", value: "Add", label: "Add invitees", state: "none" },
        ],
      },
      {
        id: "call",
        icon: "video",
        items: [
          { kind: "slot", value: "Google Meet", label: "Video call" },
          { kind: "note", text: "meet.google.com/kuk-pokm-ptb" },
          { kind: "remove", label: "Remove the call" },
        ],
      },
      {
        id: "place",
        icon: "place",
        items: [
          { kind: "text", value: "Kino Seeblick", label: "Place", placeholder: "A place" },
          { kind: "link", text: "Open in Maps" },
        ],
      },
      {
        id: "alert",
        icon: "bell",
        items: [
          { kind: "slot", value: "30 minutes before", label: "Alert" },
          { kind: "slot", value: "and another", label: "Second alert", state: "none" },
        ],
      },
      calendarRow(look),
      {
        id: "notes",
        icon: "note",
        items: [{ kind: "notes", value: "Bring the glaze samples.", label: "Notes", placeholder: "Notes" }],
      },
    ]}
    more={{ label: "More fields" }}
    submit={{ label: "Add", keyHint: "↵" }}
  />
);
/* The view's column the panel stands at the foot of: a window's, the phone's, a half of the unfolded phone. */
const COLUMN = { desktop: 1164, phone: 390, fold: 339.5, foldl: 400.5 } as const;
const OVER_THE_VIEW: KitSubject["on"] = (look) => (look.face === "paper" ? "sheet" : "ground");
const quick = (
  state: string,
  text: string,
  found: [number, number][],
  form: (look: Look) => ReactElement,
  part: "QuickAdd" | "EventForm",
): KitSubject => ({
  key: `${part}/${state}`,
  place: "block",
  target: part === "QuickAdd" ? ".oh-qa" : ".oh-evform",
  ...cal,
  /* The panel floats over the view's sheet: its round corners and its shadow show that. */
  ...(part === "QuickAdd" ? { on: OVER_THE_VIEW } : {}),
  render: (look) =>
    room(
      <QuickAdd
        still
        label="New event"
        tone={tone(look, "mila")}
        line={{ value: text, label: "New event", placeholder: "Lunch with Ben tomorrow 1pm", found }}
        close={{ label: look.device === "desktop" ? "Close · Esc" : "Close" }}
      >
        {form(look)}
      </QuickAdd>,
      460,
      COLUMN[look.device],
    ),
});
const TYPED = "lunch with Ben tomorrow 1pm";
const forms: KitSubject[] = [
  quick(
    "typed",
    TYPED,
    [
      [15, 23],
      [24, 27],
    ],
    typedForm,
    "QuickAdd",
  ),
  quick(
    "new",
    TYPED,
    [
      [15, 23],
      [24, 27],
    ],
    typedForm,
    "EventForm",
  ),
  quick("every-row", "", [], fullForm, "EventForm"),
];

const POINT = { x: 0, y: 0 };
/* Asked with a pointer, the first answer holds the keys. */
const ask = (state: string, render: () => ReactElement, first?: string): KitSubject => ({
  key: `QuestionBeforeAct/${state}`,
  place: "block",
  target: ".oh-menu",
  root: cal.root,
  act: first ? then(inCalendar, force(first, "focus", "focus-visible")) : inCalendar,
  render,
});
const questions: KitSubject[] = [
  ask(
    "series",
    () => (
      <QuestionBeforeAct
        open
        onClose={() => {}}
        anchor={POINT}
        question="Move to Wed 11 Nov, 18:30"
        follows="Every week on Tuesday"
        scopes={[
          { id: "this", label: "This event", keyHint: "1" },
          { id: "following", label: "This and following", keyHint: "2" },
          { id: "all", label: "All events", keyHint: "3" },
        ]}
        cancel="Cancel"
      />
    ),
    '[role="menuitem"]',
  ),
  ask(
    "tell",
    () => (
      <QuestionBeforeAct
        open
        onClose={() => {}}
        anchor={POINT}
        question="Tell Ben Arnold, Giulia Ferrari and 2 more"
        follows="now Fri 13 Nov, 16:00"
        note={{ label: "A note to the invitees", placeholder: "Add a note", value: "" }}
        answers={[
          { id: "send", label: "Send update", keyHint: "↵" },
          { id: "quiet", label: "Don’t send", keyHint: "⇧↵" },
        ]}
        cancel="Cancel"
      />
    ),
    ".oh-ask-answers > :first-child",
  ),
];

/* The calendar's rail, as tall as the window leaves it. */
const calendarsOf = (look: Look) => [
  {
    name: "Google",
    calendars: [
      {
        id: "mila",
        name: "Mila",
        tone: tone(look, "mila"),
        shown: true,
        switchLabel: "Show Mila",
        defaultLabel: "New events go here",
      },
      {
        id: "studio",
        name: "Lichtgrat studio",
        tone: tone(look, "studio"),
        shown: true,
        switchLabel: "Show Lichtgrat studio",
      },
      {
        id: "holidays",
        name: "Holidays in Switzerland",
        tone: "neutral" as const,
        shown: true,
        switchLabel: "Show Holidays in Switzerland",
        viewOnlyLabel: "View only",
      },
      {
        id: "birthdays",
        name: "Birthdays",
        tone: tone(look, "birthdays"),
        shown: true,
        switchLabel: "Show Birthdays",
        viewOnlyLabel: "View only",
      },
    ],
  },
  {
    name: "iCloud",
    calendars: [
      { id: "family", name: "Family", tone: tone(look, "family"), shown: true, switchLabel: "Show Family" },
      { id: "home", name: "Home", tone: tone(look, "home"), shown: false, switchLabel: "Show Home" },
    ],
  },
  {
    name: "Microsoft 365",
    calendars: [
      {
        id: "vidralva",
        name: "Vidralva",
        tone: tone(look, "vidralva"),
        shown: true,
        switchLabel: "Show Vidralva",
      },
      {
        id: "catalogue",
        name: "Catalogue 2027",
        tone: tone(look, "catalogue"),
        shown: true,
        switchLabel: "Show Catalogue 2027",
        viewOnlyLabel: "View only",
      },
    ],
  },
  {
    name: "Mail",
    calendars: [
      {
        id: "resurface",
        name: "Resurface",
        tone: "neutral" as const,
        shown: true,
        switchLabel: "Resurface",
        layerIcon: "resurface" as const,
      },
      {
        id: "later",
        name: "Send later",
        tone: "neutral" as const,
        shown: true,
        switchLabel: "Send later",
        layerIcon: "clock" as const,
      },
      {
        id: "answer-later",
        name: "Answer Later",
        tone: "neutral" as const,
        shown: true,
        switchLabel: "Answer Later",
        layerIcon: "later" as const,
      },
      {
        id: "frommail",
        name: "From mail",
        tone: "neutral" as const,
        shown: true,
        switchLabel: "From mail",
        layerIcon: "frommail" as const,
      },
    ],
  },
];
const railOf = (state: string, open: boolean): KitSubject => ({
  key: `CalendarRail/${state}`,
  place: "block",
  target: ".oh-rail",
  ...cal,
  render: (look) => (
    <div style={{ display: "grid", height: 876, width: look.face === "ohmarchy" ? 224 : 232 }}>
      <CalendarRail
        label="Places"
        switcher={
          <Switcher
            kind="pair"
            label="Mail or Calendar"
            current="cal"
            mail={{ word: "ohmail", label: "ohmail", keyHint: "g m" }}
            cal={{ word: "ohcal", label: "ohcal", keyHint: "g c" }}
          />
        }
        newEvent={{ label: "New event", keyHint: "c" }}
        mini={revive(WORLD["mini-rail"]!.part, look) as ReactNode}
        places={
          <>
            <RailEntry
              kind="place"
              icon="invite"
              count="3"
              keyHint="g i"
              label="Invitations, 3"
              title="Invitations"
            >
              Invitations
            </RailEntry>
            <RailEntry
              kind="place"
              icon="frommail"
              count="5"
              keyHint="g f"
              label="From mail, 5"
              title="From mail"
            >
              From mail
            </RailEntry>
          </>
        }
        calendars={{ label: "Calendars", note: "11 of 12", open, accounts: calendarsOf(look) }}
        below={
          <RailEntry kind="place" icon="settings" keyHint="g ," title="Settings">
            Settings
          </RailEntry>
        }
        foot={
          <RailFoot
            pull={{ label: "Check now", keyHint: "p" }}
            account={{
              name: "Mila Brunner",
              address: "mila@lichtgrat.example",
              note: "8 calendars",
              title: "8 calendars · 3 calendar accounts",
            }}
            tools={[
              { icon: "command", label: "Command palette · Ctrl K" },
              look.scheme === "dark" ? { icon: "sun", label: "Light" } : { icon: "moon", label: "Dark" },
            ]}
          />
        }
      />
    </div>
  ),
});
const rails: KitSubject[] = [railOf("shut", false), railOf("open", true)];

/* What a letter shows of a calendar: each in the letter's own column. */
const inLetter = (key: string, target: string, render: (look: Look) => ReactElement): KitSubject => ({
  key,
  place: "block",
  on: "sheet",
  target,
  act: calendarInMail,
  render,
});
const goes = (
  <>
    Tech check goes to <Slot>Mila</Slot>
    <Dot kind="hot" />
  </>
);
const letters: KitSubject[] = [
  inLetter("InvitationCard/to-answer", ".oh-invcard", (look) => (
    <InvitationCard
      kind="Invitation"
      title="Tech check, main hall"
      when="Fri 20 Nov, 16:00–16:15"
      lines={["Makersfest, Hall 2, Zürich", "From Petra Wyss"]}
      around={[{ tone: tone(look, "studio"), text: "15:30–17:00 Stand set-up, Hall 2", tag: "overlaps" }]}
      answers={<AnswerSwitch label="Answer" on="sheet" answers={{ options: THREE, value: null }} />}
      goes={goes}
      show={{ label: "Show in calendar" }}
    />
  )),
  inLetter("InvitationCard/answered", ".oh-invcard", () => (
    <InvitationCard
      kind="Invitation"
      title="Tech check, main hall"
      when="Fri 20 Nov, 16:00–16:15"
      lines={["Makersfest, Hall 2, Zürich", "From Petra Wyss"]}
      answers={<AnswerSwitch label="Answer" on="sheet" answers={{ options: THREE, value: "yes" }} />}
      goes={
        <>
          Tech check is on <b>Mila</b>
          <Dot kind="ink" />
        </>
      }
      show={{ label: "Show in calendar" }}
    />
  )),
  inLetter("InvitationCard/proposed", ".oh-invcard", (look) => (
    <InvitationCard
      kind="New time proposed"
      title="Glaze evening, planning call"
      when="Thu 12 Nov, 15:00–15:30"
      was="10:00–10:30"
      lines={["Phone", "Yours · Nadja Lehner proposes"]}
      around={[
        { tone: tone(look, "mila"), text: "10:00–10:30 Dentist", tag: "overlaps" },
        { text: "15:00–15:30", tag: "free" },
      ]}
      answers={
        <AnswerSwitch
          label="Answer"
          on="sheet"
          /* A static drawing measures nothing: the fit the part measures in the unfolded phone's letter (267 px). */
          fit={look.device === "fold" ? "tighter" : undefined}
          answers={{
            options: [
              { value: "accept", label: "Accept 15:00" },
              { value: "keep", label: "Keep 10:00" },
            ],
            value: null,
          }}
        />
      }
      show={{ label: "Show in calendar" }}
    />
  )),
  inLetter("FoundEventRow/found", ".oh-found", () => (
    <FoundEventRow
      when="Sat 21 Nov, 11:00"
      title="Wabi-sabi for web people"
      second="Makersfest, main hall"
      add={{ label: "Add" }}
      dismiss={{ label: "Dismiss" }}
    />
  )),
  inLetter("FoundEventRow/added", ".oh-found", (look) => (
    <FoundEventRow
      when="Sat 21 Nov, 11:00"
      title="Wabi-sabi for web people"
      second="On your calendar"
      on={{ tone: tone(look, "mila"), show: { label: "Show in calendar" } }}
    />
  )),
  inLetter("FoundEventRow/guess", ".oh-found", () => (
    <FoundEventRow
      when="Sun 15 Nov, 12:00"
      title="Sunday lunch at Mum's"
      tag="a guess"
      add={{ label: "Add" }}
      dismiss={{ label: "Dismiss" }}
    />
  )),
  {
    key: "TodayList/today",
    place: "block",
    target: ".oh-today",
    act: calendarInMail,
    render: (look) => (
      <TodayList
        kind="today"
        label="Today"
        heading={{ title: "Today", date: "Tue 10 Nov" }}
        rows={[
          {
            id: "a",
            mark: { kind: "calendar", tone: tone(look, "mila") },
            time: "now",
            title: "Invoices, new template",
            now: true,
          },
          {
            id: "b",
            mark: { kind: "calendar", tone: tone(look, "vidralva") },
            time: "14:00",
            title: "Catalogue weekly",
          },
          {
            id: "c",
            mark: { kind: "calendar", tone: tone(look, "studio") },
            time: "14:30",
            title: "Poster review",
          },
          {
            id: "d",
            mark: { kind: "calendar", tone: tone(look, "mila") },
            time: "18:30",
            title: "Bouldering with Tim",
          },
        ]}
      />
    ),
  },
  {
    key: "TodayList/coming",
    place: "block",
    on: "sheet",
    target: ".oh-today",
    act: calendarInMail,
    render: () => (
      <TodayList
        kind="coming"
        label="Coming up"
        rows={[
          {
            id: "a",
            mark: { kind: "outlined" },
            time: "Fri 20 Nov, 16:00",
            title: "Tech check, main hall",
            tag: { text: "to answer", hot: true },
          },
          {
            id: "b",
            mark: { kind: "found" },
            time: "Sat 21 Nov, 11:00",
            title: "Wabi-sabi for web people",
            tag: { text: "from mail" },
          },
        ]}
      />
    ),
  },
];

/*
 * Where the sheet stands a specimen on a sheet, not on the ground: what shows around the part's round
 * corners, and the colour a fill of the ground is read against.
 */
const STANDS: Record<string, KitSubject["on"]> = {
  "MiniMonth/rail": (look) => (look.face === "ohmarchy" ? "sheet" : "ground"),
  "MiniMonth/menu": "sheet",
  "MiniMonth/widget": "sheet",
  "CalendarRow/rest": (look) => (look.face === "ohmarchy" ? "sheet" : "ground"),
};
const stood = (s: KitSubject): KitSubject => (s.key in STANDS ? { ...s, on: STANDS[s.key] } : s);

export const subjects: KitSubject[] = [
  ...squares,
  ...chips,
  ...grids,
  ...minis,
  ...rows,
  ...views,
  ...heads,
  ...agenda,
  ...panels,
  ...cards,
  ...bridges,
  ...forms,
  ...questions,
  ...rails,
  ...letters,
].map(stood);
