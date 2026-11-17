/**
 * THE SUBJECTS OF THE REAL-APP MEASURE, one a place: how the place is reached on the real entry, the reference's state
 * of the same moment (its key in `registry.json`), and the elements read on both sides. A finder is an expression
 * over the helpers of `page.mjs` (`q`, `qa`, `within`, `byText`, `railEntry`, `refEntry`, `dockEntry`, `footPull`,
 * `headBell`, `groupHead`), or null where that side has no such element. README.md says how a subject is added.
 */
import { PLACES } from "../../journeys/vocabulary/places.js";
import { LOOKS, isPhone, type Element } from "./rows.js";

/** The real entries a place is reached on, each bundled as the browser tests bundle it (`measure.mts`). */
export type PageName = "demo" | "web";

export interface Subject {
  /** The place's id in the journeys' vocabulary, or `frame` for what stands around every place. */
  id: string;
  /** The real entry the place is drawn on. */
  page: PageName;
  /** The address inside that entry: the vocabulary's route of the place. */
  route: string;
  /** The reference's state at the same moment: its key in `registry.json`; each look adds its own parameters. */
  reference: string;
  /** The looks it is read at, by name; all eight where absent. */
  looks?: readonly string[];
  /** Both sides must draw this before anything is read: a finder that no longer finds it is a stale table, not a row. */
  ready: { app: string; reference: string };
  /** The elements read at a desktop's width and at a phone's. */
  desk: readonly Element[];
  phone: readonly Element[];
}

const box = (name: string, app: string | null, reference: string | null, more: Partial<Element> = {}): Element => ({ name, kind: "box", app, reference, ...more });
const text = (name: string, app: string | null, reference: string | null, more: Partial<Element> = {}): Element => ({ name, kind: "text", app, reference, ...more });
const icon = (name: string, app: string | null, reference: string | null, more: Partial<Element> = {}): Element => ({ name, kind: "icon", app, reference, ...more });
const said = (s: string): string => JSON.stringify(s);

/** The rail's places, by the words of their names, top to bottom. */
const RAIL = ["Ohbox", "News", "Receipts", "Screener", "Answer Later", "Parked", "Resurface", "Tags", "History", "Search", "Drafts", "Settings"];
/** The dock's places, by the first part of their accessible names. */
const DOCK = ["Ohbox", "Screener", "News", "Receipts", "More"];
const IN_RAIL = { in: "rail.scroll" } as const;

/** THE FRAME: the rail with its foot, the columns' handles; on a phone the dock. */
const FRAME_DESK: Element[] = [
  box("rail", `q("nav.oh-rail")`, `q("nav#rail")`),
  box("rail.switch (ohmail | ohcal)", null, `q("#rail .swi")`),
  box("compose", `q(".oh-rail-write button")`, `q("#rail button.write")`),
  text("compose.label", `q(".oh-rail-write button span")`, `q("#rail button.write span")`),
  icon("compose.icon", `q(".oh-rail-write button svg")`, `q("#rail button.write svg")`),
  ...RAIL.flatMap((p) => [
    box(p, `railEntry(${said(p)})`, `refEntry(${said(p)})`, IN_RAIL),
    text(`${p}.label`, `within(railEntry(${said(p)}), ".oh-railentry-name")`, `within(refEntry(${said(p)}), ".w")`, { ...IN_RAIL, beside: `${p}.count` }),
    icon(`${p}.icon`, `within(railEntry(${said(p)}), "svg")`, `within(refEntry(${said(p)}), "svg")`, IN_RAIL),
    text(`${p}.count`, `within(railEntry(${said(p)}), ".oh-railentry-count")`, `within(refEntry(${said(p)}), ".c")`, { ...IN_RAIL, count: true }),
  ]),
  ...[1, 2, 3, 4, 5].map((n) => box(`rail.group ${n}`, `qa("nav.oh-rail .oh-rail-group")[${n - 1}] ?? null`, `qa("#rail .rscroll > .grp")[${n - 1}] ?? null`, IN_RAIL)),
  box("rail.scroll", `q("nav.oh-rail .oh-rail-scroll")`, `q("#rail .rscroll")`),
  box("rail.foot", `q("nav.oh-rail .oh-railfoot")`, `q("#rail .foot")`),
  box("foot.pull", `footPull()`, `q("#rail .foot .pull")`, { in: "rail.foot" }),
  text("foot.pull.label", `within(footPull(), "span")`, `q("#rail .foot .pull .w")`, { in: "rail.foot" }),
  text("foot.pull.key (p)", `within(footPull(), "kbd")`, `q("#rail .foot .pull kbd")`, { in: "rail.foot" }),
  box("foot.account", `q(".oh-railfoot-account")`, `q("#rail button.me")`, { in: "rail.foot" }),
  text("foot.account.avatar", `q(".oh-railfoot-account .oh-avatar")`, `q("#rail button.me .av")`, { in: "rail.foot" }),
  text("foot.account.name", `q(".oh-railfoot-name")`, `q("#rail button.me .w b")`, { in: "rail.foot" }),
  text("foot.account.note", `q(".oh-railfoot-note")`, `q("#rail button.me .w span")`, { in: "rail.foot" }),
  box("foot.tools (palette, scheme)", `q(".oh-railfoot-tools")`, `q("#rail .metools")`, { in: "rail.foot" }),
  box("handle.rail", `q(".oh-columnhandle")`, `q('.colh[aria-label="Sidebar width"]')`),
  box("handle.list", `qa(".oh-columnhandle")[1] ?? null`, `q('.colh[aria-label="List width"]')`),
  box("stray: today's toast host", `q("div.toast")`, null),
];
const FRAME_PHONE: Element[] = [
  box("dock", `q("nav.oh-dock")`, `q("nav#rail")`),
  box("dock.places", `q(".oh-dock-places")`, `q("#rail .grp.dock")`, { in: "dock" }),
  ...DOCK.flatMap((p) => [
    box(`dock.${p}`, `dockEntry(${said(p)})`, `dockEntry(${said(p)})`, { in: "dock" }),
    icon(`dock.${p}.icon`, `within(dockEntry(${said(p)}), "svg")`, `within(dockEntry(${said(p)}), "svg")`, { in: "dock" }),
    text(`dock.${p}.count`, `within(dockEntry(${said(p)}), ".oh-dock-count")`, `within(dockEntry(${said(p)}), ".c")`, { in: "dock", count: true }),
  ]),
  box("dock.end", `q(".oh-dock-end")`, `q("#rail .dockb")`, { in: "dock" }),
  box("dock.Search", `dockEntry("Search")`, `q("#rail .dsearch")`, { in: "dock" }),
  icon("dock.Search.icon", `within(dockEntry("Search"), "svg")`, `q("#rail .dsearch svg")`, { in: "dock" }),
  box("dock.Write", `q(".oh-dock-write")`, `q("#rail button.write")`, { in: "dock" }),
  icon("dock.Write.icon", `q(".oh-dock-write svg")`, `q("#rail button.write svg")`, { in: "dock" }),
  box("list.head.switch (ohcal)", null, `q("section#list header.head .swi1")`),
  box("stray: today's toast host", `q("div.toast")`, null),
];

/** THE OHBOX: the list's sheet and its head. */
const HEAD: Element[] = [
  box("list.head", `q("header.oh-listhead")`, `q("section#list header.head")`),
  text("list.head.title", `q(".oh-listhead-title")`, `q("section#list h1.title")`, { in: "list.head" }),
  box("list.head.aside", `q(".oh-listhead-aside")`, `q("section#list header.head .aside")`, { in: "list.head" }),
  box("list.head.bell", `headBell()`, `q("section#list header .bell")`, { in: "list.head" }),
  text("list.head.bell.count", `within(headBell(), ".oh-doorbell-count")`, `q("section#list header .bell > b")`, { in: "list.head", count: true }),
  text("list.head.bell.key (g s)", `within(headBell(), "kbd")`, `q("section#list header .bell kbd")`, { in: "list.head" }),
];
const OHBOX_DESK: Element[] = [
  box("list.sheet", `q(".ob-today-list .oh-sheet")`, `q("section#list")`),
  ...HEAD,
  box("list.head.title.dot", `within(q(".oh-listhead-title"), "i, .oh-enddot, [class*=dot]")`, `q("section#list h1.title i.dot")`, { in: "list.head" }),
  text("list.head.markall", `byText("header.oh-listhead button", "Mark all read")`, `q("section#list .markall")`, { in: "list.head" }),
  box("list.head.more", `q('header.oh-listhead button[aria-haspopup], header.oh-listhead [aria-label="Ohbox actions"]')`, `q('section#list header.head button[aria-label="List"]')`, { in: "list.head" }),
  text("list.group.New", `groupHead("New")`, `groupHead("New")`),
];
/** THE READER with nothing open: the reading column and what it says while empty. The phone has no such column. */
const READER_DESK: Element[] = [
  box("read.column", `q(".read-col")`, `q("section#reader")`),
  box("read.empty", `q(".read-col .empty")`, `q("section#reader .blank .empty")`, { in: "read.column" }),
  text("read.empty.words", `q(".read-col .empty b")`, `q("section#reader .empty .lbl")`, { in: "read.column" }),
  box("read.empty.agenda", null, `q("section#reader .tdy")`, { in: "read.column" }),
];
const OHBOX_PHONE: Element[] = [
  ...HEAD,
  text("list.group.New", `groupHead("New")`, `groupHead("New")`),
  box("list.sheet", `q(".ob-today-list .oh-sheet")`, `q("section#list")`),
];

const RAIL_DRAWN = { app: `q("nav.oh-rail, nav.oh-dock")`, reference: `q("nav#rail")` };

export const SUBJECTS: readonly Subject[] = [
  {
    id: "frame",
    page: "demo",
    route: PLACES.ohbox.route,
    reference: "open=none&screen=ohbox",
    ready: RAIL_DRAWN,
    desk: FRAME_DESK,
    phone: FRAME_PHONE,
  },
  {
    id: "ohbox",
    page: "demo",
    route: PLACES.ohbox.route,
    reference: "open=none&screen=ohbox",
    ready: { app: `q("header.oh-listhead")`, reference: `q("section#list header.head")` },
    desk: OHBOX_DESK,
    phone: OHBOX_PHONE,
  },
  {
    id: "reader",
    page: "demo",
    route: PLACES.reader.route,
    reference: "open=none&screen=ohbox",
    looks: LOOKS.filter((l) => !isPhone(l)).map((l) => l.name),
    ready: { app: `q("header.oh-listhead")`, reference: `q("section#reader")` },
    desk: READER_DESK,
    phone: [],
  },
  {
    /* The rail's foot on the web's host, where the offer of the desktop app stands. */
    id: "frame-web",
    page: "web",
    route: PLACES.ohbox.route,
    reference: "offer=desktop&screen=ohbox",
    looks: LOOKS.filter((l) => !isPhone(l)).map((l) => l.name),
    ready: RAIL_DRAWN,
    desk: [
      box("foot.offer", `q(".fr-railnotice .oh-notice")`, `q("#rail .foot .notice")`),
      text("foot.offer.title", `q(".fr-railnotice .oh-notice-title")`, `q("#rail .foot .notice b")`),
      text("foot.offer.act", `q(".fr-railnotice .oh-notice-acts button")`, `q("#rail .foot .notice .acts button")`),
    ],
    phone: [],
  },
];
