/**
 * THE ROUTE AND ITS ADDRESS. `routeOf` reads the fragment, `fragmentOf` writes it, in today's form exactly:
 * the old shell's parser reads the same fragment until the last old view goes, and a test holds the two
 * equal on a corpus. Only the shell's address door reads and writes the fragment; the frame keeps no copy.
 */
import type { PlaceId, Route } from "./contract.js";

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
const LISTS_LETTERS: ReadonlySet<PlaceId> = new Set([
  "ohbox",
  "news",
  "receipts",
  "history",
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
]);
const PILES: ReadonlyMap<string, PlaceId> = new Map([
  ["reply", "later"],
  ["aside", "parked"],
  ["resurface", "resurface"],
]);
const SEGMENTS: ReadonlySet<string> = new Set(["screened", "spam"]);
const PANES: ReadonlySet<string> = new Set([
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

const route = (place: PlaceId, more: Partial<Omit<Route, "place">> = {}): Route => ({
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

/** The open letter's tail, `…/m/<id>`, cut off the path. */
function cutTail(path: string): { path: string; open: string | null } {
  const parts = path.split("/");
  const id = parts[parts.length - 1];
  if (parts.length >= 3 && parts[parts.length - 2] === "m" && id)
    return { path: parts.slice(0, -2).join("/"), open: id };
  return { path, open: null };
}

function placeOf(path: string, query: string): Route {
  const [head = "", ...rest] = path.split("/");
  const tail = rest.join("/");
  const byId = BY_ID.get(head);
  if (byId && tail) return route(byId, { sub: byId === "address" ? decoded(tail) : tail });
  if (head === "screener") return route("screener", { sub: SEGMENTS.has(rest[0] ?? "") ? rest[0]! : null });
  if (head === "triage") return route(PILES.get(rest[0] ?? "") ?? "later");
  if (head === "settings") {
    const pane = PANES.has(rest[0] ?? "") ? rest[0]! : null;
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
  const at = whole.indexOf("?");
  const query = at === -1 ? "" : whole.slice(at + 1);
  const { path, open } = cutTail(at === -1 ? whole : whole.slice(0, at));
  const found = placeOf(path, query);
  return open !== null && found.stage === null && LISTS_LETTERS.has(found.place) ? { ...found, open } : found;
}

const named = (mailbox: string | undefined) =>
  mailbox === undefined ? "" : `?mailbox=${encodeURIComponent(mailbox)}`;

export function fragmentOf(to: Route): string {
  if (to.stage?.id === "firstRun") {
    const how = to.stage.words.how;
    return `#/first-run${how === "again" || how === "add" ? `/${how}` : ""}${named(to.stage.words.mailbox)}`;
  }
  const tail = to.open !== null && LISTS_LETTERS.has(to.place) ? `/m/${to.open}` : "";
  const head = ADDRESS[to.place];
  switch (to.place) {
    case "tags":
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
