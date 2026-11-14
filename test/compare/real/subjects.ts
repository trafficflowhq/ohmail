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

/** Follow each actual tag in the expanded or folded rail through its stored identity. */
export function taggedRail(tags: readonly { id: string }[]): Element[] {
  const entries = tags.flatMap(({ id }, index) => {
    const key = JSON.stringify(id);
    const app = `q('[data-rail-tag-id=' + CSS.escape(${key}) + '] button')`;
    const reference = `q('#rail button[data-tag=' + CSS.escape(${key}) + ']')`;
    const name = `tag ${index + 1}`;
    return [
      box(name, app, reference, IN_RAIL),
      text(`${name}.label`, `within(${app}, ".oh-railentry-name")`, `within(${reference}, ".w")`, IN_RAIL),
      box(`${name}.dot`, `within(${app}, ".oh-railentry-dot")`, `within(${reference}, ".tdot")`, IN_RAIL),
      text(`${name}.count`, `within(${app}, ".oh-railentry-count")`, `within(${reference}, ".c")`, { ...IN_RAIL, count: true }),
    ];
  });
  return [...entries, box("New tag", 'railEntry("New tag")', 'q("#rail button.newtag")', IN_RAIL)];
}

/** THE FRAME: the rail with its foot, the columns' handles; on a phone the dock. */
const FRAME_DESK: Element[] = [
  box("rail", `q("nav.oh-rail")`, `q("nav#rail")`),
  box("rail.switch (ohmail | ohcal)", null, `q("#rail .swi")`, { matchedApp: 'q("nav.oh-rail .oh-switcher")' }),
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
  text("foot.pull.label", `within(footPull(), "span")`, `q("#rail .foot .pull .w")`, { in: "rail.foot", matchedApp: 'within(footPull(), ".oh-railentry-name")' }),
  text("foot.pull.key (p)", `within(footPull(), "kbd")`, `q("#rail .foot .pull kbd")`, { in: "rail.foot" }),
  box("foot.account", `q(".oh-railfoot-account")`, `q("#rail button.me")`, { in: "rail.foot" }),
  text("foot.account.avatar", `q(".oh-railfoot-account .oh-avatar")`, `q("#rail button.me .av")`, { in: "rail.foot" }),
  text("foot.account.name", `q(".oh-railfoot-name")`, `q("#rail button.me .w b")`, { in: "rail.foot" }),
  text("foot.account.note", `q(".oh-railfoot-note")`, `q("#rail button.me .w span")`, { in: "rail.foot" }),
  box("foot.tools (palette, scheme)", `q(".oh-railfoot-tools")`, `q("#rail .metools")`, { in: "rail.foot", matchedApp: 'q(".oh-railfoot-end")' }),
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
  box("list.head.switch (ohcal)", null, `q("section#list header.head .swi1")`, { matchedApp: 'q(".oh-listhead .oh-switcher-round")' }),
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
  box("list.sheet", `q(".fr-list > .oh-sheet")`, `q("section#list")`),
  ...HEAD,
  box("list.head.title.dot", `within(q(".oh-listhead-title"), "i, .oh-enddot, [class*=dot]")`, `q("section#list h1.title i.dot")`, { in: "list.head" }),
  text("list.head.markall", `byText("header.oh-listhead button", "Mark all read")`, `q("section#list .markall")`, { in: "list.head" }),
  box("list.head.more", `q('header.oh-listhead button[aria-haspopup], header.oh-listhead [aria-label="Ohbox actions"]')`, `q('section#list header.head button[aria-label="List"]')`, { in: "list.head" }),
  text("list.group.New", `groupHead("New")`, `groupHead("New")`),
];
/** The visible date and each available event row on the signed-in Calendar reader. */
export const TODAY_WORDS: readonly Element[] = [
  text("today.date", 'q(".oh-today-date")', 'q("#reader .tdy h4 small")', { in: "read.empty.agenda" }),
  ...Array.from({ length: 5 }, (_, index) => [
    text(`today.time.${index + 1}`, `qa(".oh-today-row time")[${index}]`, `qa("#reader .tdy .tr time")[${index}]`, { in: "read.empty.agenda" }),
    text(`today.title.${index + 1}`, `qa(".oh-today-title")[${index}]`, `qa("#reader .tdy .tt")[${index}]`, { in: "read.empty.agenda" }),
  ]).flat(),
];

/** THE READER with nothing open: the reading column and what it says while empty. The phone has no such column. */
const READER_DESK: Element[] = [
  box("read.column", `q(".fr-reading")`, `q("section#reader")`),
  box("read.empty", `q(".fr-reading .oh-blankcolumn")`, `q("section#reader .blank")`, { in: "read.column" }),
  text("read.empty.words", `q(".fr-reading .oh-blankcolumn-label")`, `q("section#reader .empty .lbl")`, { in: "read.column" }),
  box("read.empty.agenda", null, `q("section#reader .tdy")`, { in: "read.column", matchedApp: 'q(".fr-reading .oh-today")' }),
];
const OHBOX_PHONE: Element[] = [
  ...HEAD,
  text("list.group.New", `groupHead("New")`, `groupHead("New")`),
  box("list.sheet", `q(".fr-list")`, `q("section#list")`),
];

const COMPOSE: Element[] = [
  box("letter", 'q(".oh-composer")', 'q("#composer")'),
  box("recipients", 'q(".oh-recipients")', 'q("#composer .cw-rcpt")', { in: "letter" }),
  text("to.label", `q('.oh-recipients [data-line-id="to"] .oh-recipients-label')`, 'q("#composer .cw-to .cw-lab")', { in: "recipients" }),
  text("subject", 'q(".oh-recipients-subject")', 'q("#composer .cw-subject")', { in: "letter" }),
  box("editor", 'q(".oh-composer-editor")', 'q("#composer .cw-ed")', { in: "letter" }),
  box("message", `q('.oh-composer-text [role="textbox"]')`, 'q("#composer .cw-body")', { in: "editor" }),
  box("format", 'q(".oh-composer-marks")', 'q("#composer .cw-bar")', { in: "editor" }),
  box("attachment.tools", 'q(".oh-composer-foot")', 'q("#composer .cw-foot")', { in: "editor" }),
  box("send", `q('.oh-actionpanel-verb[data-id="send"]')`, `q('button[data-act="compose:send"]')`),
];

const COMPOSE_PHONE = [
  ...COMPOSE,
  box("back", 'q(".oh-sheet-back button")', 'q("#reader .rtop button")'),
];

const ACCOUNT: Element[] = [
  box("account", 'q(".oh-sheet:has(> .oh-settingssheet)")', 'q("#reader .sheet.set")', { contentChild: ":scope > .oh-settingssheet" }),
  box("identity.head", 'q(".oh-settingssheet-head")', 'q("#reader .sheet.set .mh")', { in: "account" }),
  text("identity.note", 'q(".oh-settingssheet-aside > :first-child") ?? q(".oh-settingssheet-aside")', 'q("#reader .sheet.set .mh .state > :first-child")', { in: "account" }),
  text("password", 'byText("button", "Change password")', 'byText("button", "Change password")', { in: "account" }),
  text("signout", 'byText("button", "Sign out")', 'byText("button", "Sign out")'),
  box("erase", 'qa(".oh-sheet:has(> .oh-settingssheet)")[1]', 'qa("#reader .sheet.set")[1]', { contentChild: ":scope > .oh-settingssheet" }),
  text("erase.title", 'qa(".oh-settingssheet-title")[1]', 'qa("#reader .sheet.set .mh b")[1]', { in: "erase" }),
  text("erase.action", 'byText("button", "Delete my account")', 'byText("button", "Delete my account")', { in: "erase" }),
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
    id: "compose", page: "web", route: PLACES.compose.route, reference: "screen=compose&state=blank",
    ready: {
      app: 'q(".oh-composer-signature") && q(".oh-draft-control")',
      reference: 'q("#composer .cw-sig") && q("#composer .cw-ai")',
    },
    desk: COMPOSE, phone: COMPOSE_PHONE,
  },
  {
    id: "settings-account", page: "web", route: PLACES["settings-account"].route, reference: "screen=settings&sec=account",
    ready: { app: 'byText("button", "Sign out")', reference: 'q("#reader .sheet.set")' }, desk: ACCOUNT, phone: ACCOUNT,
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
