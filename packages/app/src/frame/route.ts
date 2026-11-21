/**
 * THE ROUTE AND ITS ADDRESS. `routeOf` reads the fragment, `fragmentOf` writes it, in today's form exactly:
 * the old shell's parser reads the same fragment until the last old view goes, and a test holds the two
 * equal on a corpus. Only the shell's address door reads and writes the fragment; the frame keeps no copy.
 */
import {
  CALENDAR_PANEL_IDS,
  type AnyPlaceId,
  type CalendarPlaceId,
  type PlaceId,
  type Route,
} from "./contract.js";
import { CALENDAR_HOME, isCalendarPlace } from "./product.js";

/** Each place's address, the way it is written today. */
export const ADDRESS: Readonly<Record<PlaceId, string>> = {
  ohbox: "ohbox",
  news: "reads",
  receipts: "receipts",
  screener: "screener",
  later: "triage",
  parked: "triage/aside",
  resurface: "triage/resurface",
  history: "history",
  drafts: "drafts",
  trash: "trash",
  tags: "tag",
  folder: "folder",
  address: "address",
  search: "search",
  write: "compose",
  settings: "settings",
};

/** The places that list letters, where an address may carry the open one. */
const LISTS_LETTERS: ReadonlySet<string> = new Set<PlaceId>([
  "ohbox",
  "news",
  "receipts",
  "history",
  "drafts",
  "search",
  "tags",
  "folder",
  "later",
  "parked",
  "resurface",
  "address",
  "trash",
]);
/** The places a bare name reaches. */
const PLAIN: ReadonlyMap<string, PlaceId> = new Map([
  ["ohbox", "ohbox"],
  ["reads", "news"],
  ["receipts", "receipts"],
  ["history", "history"],
  ["search", "search"],
  ["compose", "write"],
  ["drafts", "drafts"],
  ["trash", "trash"],
  ["tag", "tags"],
]);
const PILES: ReadonlyMap<string, PlaceId> = new Map([
  ["reply", "later"],
  ["aside", "parked"],
  ["resurface", "resurface"],
]);
const SEGMENTS: ReadonlySet<string> = new Set(["screened", "spam"]);

/** The frame location of a mail view name supplied by the engine. */
export function locationOfMailView(view: string | null): Pick<Route, "place" | "sub"> | null {
  if (view === null) return null;
  if (view === ADDRESS.screener || SEGMENTS.has(view)) {
    return { place: "screener", sub: view === ADDRESS.screener ? null : view };
  }
  const place = PLAIN.get(view);
  return place ? { place, sub: null } : null;
}

/** Settings' sections the route knows (`#/settings/<pane>`). */
export const PANES: ReadonlySet<string> = new Set([
  "general",
  "notifications",
  "mailboxes",
  "screener",
  "ai",
  "away",
  "billing",
  "storage",
  "invites",
  "tags",
  "rules",
  "folders",
  "signatures",
  "about",
  "help",
  "security",
  "account",
  "desktop",
  "devices",
]);
const BY_ID: ReadonlyMap<string, PlaceId> = new Map([
  ["tag", "tags"],
  ["folder", "folder"],
  ["address", "address"],
]);

const route = (place: AnyPlaceId, more: Partial<Omit<Route, "place">> = {}): Route => ({
  place,
  sub: null,
  open: null,
  stage: null,
  words: {},
  ...more,
});

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function mailboxOf(query: string): string | null {
  const named = (new URLSearchParams(query).get("mailbox") ?? "").trim();
  return named === "" ? null : named;
}

/** A message tail names the chosen letter; a thread tail names any member of the conversation. */
function cutTail(path: string): { path: string; open: string | null; wholeThread?: true } {
  const parts = path.split("/");
  const id = parts[parts.length - 1];
  const kind = parts[parts.length - 2];
  if (parts.length >= 3 && (kind === "m" || kind === "t") && id)
    return { path: parts.slice(0, -2).join("/"), open: id, ...(kind === "t" ? { wholeThread: true } : {}) };
  return { path, open: null };
}

/** Whether the address differs from its canonical form only by a letter tail. */
export function hasLetterTail(fragment: string, canonical: string): boolean {
  const at = fragment.indexOf("?");
  const { path, open } = cutTail(at === -1 ? fragment : fragment.slice(0, at));
  return open !== null && path + (at === -1 ? "" : fragment.slice(at)) === canonical;
}

function placeOf(path: string, query: string): Route {
  const [head = "", ...rest] = path.split("/");
  const tail = rest.join("/");
  const byId = BY_ID.get(head);
  if (byId && tail) return route(byId, { sub: byId === "address" ? decoded(tail) : tail });
  if (head === "screener") return route("screener", { sub: SEGMENTS.has(rest[0] ?? "") ? rest[0]! : null });
  if (head === "triage") return route(PILES.get(rest[0] ?? "") ?? "later");
  if (head === "settings") {
    const pane = PANES.has(rest[0] ?? "") || rest[0] === "calaccounts" ? rest[0]! : null;
    const mailbox = pane === "mailboxes" ? mailboxOf(query) : null;
    return route("settings", { sub: pane, words: mailbox === null ? {} : { mailbox } });
  }
  if (path === "first-run" || path === "first-run/again" || path === "first-run/add") {
    const words: Record<string, string> = {};
    if (path !== "first-run") words.how = path.slice("first-run/".length);
    const mailbox = mailboxOf(query);
    if (mailbox !== null) words.mailbox = mailbox;
    return route("ohbox", { stage: { id: "firstRun", words } });
  }
  return route(PLAIN.get(path) ?? "ohbox");
}

export function routeOf(fragment: string): Route {
  const whole = fragment.replace(/^#\/?/, "");
  const calendar = calendarRouteOf(whole);
  if (calendar !== null) return calendar;
  const at = whole.indexOf("?");
  const query = at === -1 ? "" : whole.slice(at + 1);
  const { path, ...selection } = cutTail(at === -1 ? whole : whole.slice(0, at));
  const found = placeOf(path, query);
  return selection.open !== null && found.stage === null && LISTS_LETTERS.has(found.place)
    ? { ...found, ...selection }
    : found;
}

const named = (mailbox: string | undefined) =>
  mailbox === undefined ? "" : `?mailbox=${encodeURIComponent(mailbox)}`;

export function fragmentOf(to: Route): string {
  if (to.stage?.id === "calSetup") return `#/cal/${CALENDAR_STAGE_HEAD}${queryOf(to.stage.words)}`;
  if (isCalendarPlace(to.place)) return calendarFragmentOf(to.place, to);
  if (to.stage?.id === "firstRun") {
    const how = to.stage.words.how;
    return `#/first-run${how === "again" || how === "add" ? `/${how}` : ""}${named(to.stage.words.mailbox)}`;
  }
  const tail =
    to.open !== null && LISTS_LETTERS.has(to.place) ? `/${to.wholeThread ? "t" : "m"}/${to.open}` : "";
  const head = ADDRESS[to.place];
  switch (to.place) {
    case "tags":
      return to.sub === null ? `#/${head}${tail}` : `#/${head}/${to.sub}${tail}`;
    case "folder":
      return `#/${head}/${to.sub ?? ""}${tail}`;
    case "address":
      return `#/${head}/${encodeURIComponent(to.sub ?? "")}${tail}`;
    case "screener":
      return to.sub === null ? "#/screener" : `#/screener/${to.sub}`;
    case "settings":
      if (to.sub === null) return "#/settings";
      return `#/settings/${to.sub}${to.sub === "mailboxes" ? named(to.words.mailbox) : ""}`;
    default:
      return `#/${head}${tail}`;
  }
}

/*
 * THE CALENDAR'S ADDRESSES. Canonical on every host: `#/cal/<head>[/<day>][/e/<event>][?panel=…&q=…]`; `#/cal` is
 * the week of today. A fragment whose first segment is a calendar head (`#/week/…`) reads the same, so the web's door
 * can tell the product from the fragment alone: no head here is one of mail's.
 */
export const CALENDAR_ADDRESS: Readonly<Record<CalendarPlaceId, string>> = {
  week: "week",
  day: "day",
  month: "month",
  year: "year",
  agenda: "agenda",
  calsearch: "find",
  frommail: "from-mail",
  calsettings: "calendars",
};
/** The head of the calendar's stage (its setup). */
export const CALENDAR_STAGE_HEAD = "cal-setup";
const CALENDAR_PRODUCT_HEAD = "cal";
const CALENDAR_BY_HEAD: ReadonlyMap<string, CalendarPlaceId> = new Map(
  (Object.entries(CALENDAR_ADDRESS) as [CalendarPlaceId, string][]).map(([place, head]) => [head, place]),
);
const CALENDAR_PANELS: ReadonlySet<string> = new Set([...CALENDAR_PANEL_IDS, "new"]);
const DAY_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** The tail segment before an open event. */
const EVENT_MARK = "e";

/** A civil date that exists (`2026-02-30` does not); a pure check that reads no zone. */
export function isRealDay(text: string): boolean {
  const m = DAY_SHAPE.exec(text);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  return d <= days;
}

function firstSegment(whole: string): string {
  const cut = whole.search(/[/?]/);
  return cut === -1 ? whole : whole.slice(0, cut);
}

/** Whether a fragment names the calendar: `#/cal`, `#/cal/…`, `#/cal?…`, or a calendar head first. */
export function isCalendarFragment(fragment: string): boolean {
  const head = firstSegment(fragment.replace(/^#\/?/, ""));
  return head === CALENDAR_PRODUCT_HEAD || head === CALENDAR_STAGE_HEAD || CALENDAR_BY_HEAD.has(head);
}

function calendarRouteOf(whole: string): Route | null {
  if (!isCalendarFragment(`#/${whole}`)) return null;
  const at = whole.indexOf("?");
  const query = new URLSearchParams(at === -1 ? "" : whole.slice(at + 1));
  const segments = (at === -1 ? whole : whole.slice(0, at)).split("/").filter((p) => p !== "");
  if (segments[0] === CALENDAR_PRODUCT_HEAD) segments.shift();
  const [head = "", ...rest] = segments;
  if (head === CALENDAR_STAGE_HEAD)
    return route(CALENDAR_HOME, { stage: { id: "calSetup", words: Object.fromEntries(query) } });
  const place = CALENDAR_BY_HEAD.get(head) ?? CALENDAR_HOME;
  const mark = rest.indexOf(EVENT_MARK);
  const subPart = mark === 0 ? undefined : rest[0];
  const openPart = mark === -1 ? undefined : rest[mark + 1];
  const sub =
    subPart === undefined
      ? null
      : place === "calsettings"
        ? decoded(subPart)
        : isRealDay(subPart)
          ? subPart
          : null;
  const open = openPart === undefined || openPart === "" ? null : decoded(openPart);
  const words: Record<string, string> = {};
  const panel = query.get("panel");
  if (panel !== null && CALENDAR_PANELS.has(panel)) words.panel = panel;
  const slot = query.get("slot");
  if (panel === "new" && slot !== null && /^\d{1,4}-\d{1,4}$/.test(slot)) words.slot = slot;
  const invitation = query.get("invitation");
  if (place === "day" && invitation && invitation.length < 100) words.invitation = invitation;
  const q = query.get("q");
  if (place === "calsearch" && q !== null && q.trim() !== "") words.q = q;
  return route(place, { sub, open: place === "calsettings" ? null : open, words });
}

function queryOf(words: Readonly<Record<string, string>>): string {
  const pairs = Object.entries(words).filter(([, v]) => v !== "");
  return pairs.length === 0 ? "" : `?${new URLSearchParams(pairs).toString()}`;
}

function calendarFragmentOf(place: CalendarPlaceId, to: Route): string {
  const head = `#/${CALENDAR_PRODUCT_HEAD}/${CALENDAR_ADDRESS[place]}`;
  if (place === "calsettings") return to.sub === null ? head : `${head}/${encodeURIComponent(to.sub)}`;
  const day = to.sub !== null && isRealDay(to.sub) ? `/${to.sub}` : "";
  const open = to.open !== null && to.open !== "" ? `/${EVENT_MARK}/${encodeURIComponent(to.open)}` : "";
  const words: Record<string, string> = {};
  const panel = to.words.panel;
  if (panel !== undefined && CALENDAR_PANELS.has(panel)) words.panel = panel;
  if (panel === "new" && to.words.slot !== undefined) words.slot = to.words.slot;
  if (place === "day" && to.words.invitation) words.invitation = to.words.invitation;
  if (place === "calsearch" && to.words.q !== undefined && to.words.q.trim() !== "") words.q = to.words.q;
  return `${head}${day}${open}${queryOf(words)}`;
}
