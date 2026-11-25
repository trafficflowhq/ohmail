/**
 * One WebDAV request and what came of it: a multistatus read under bounds, or a word of the closed
 * list. Every request of this adapter, a read and a write alike, leaves through {@link leave}: by
 * the request port that was handed in, which is given the sign-in together with the turn's rule on
 * where it may travel (`hosts.ts`); no header is built here.
 *
 * An address a server writes into an answer (where the person's resources begin, where the
 * calendars are, a member) is a stranger's text: it is read against the address that answered and
 * kept only when it is a plain web address within the ceiling.
 */
import { MAX_URL_CHARS } from "../limits.js";
import type { Clock } from "../port.js";
import type { ProviderRefusal } from "../refusals.js";
import { retryAfterMs, type AdapterDeps, type Authorization, type HttpAnswer, type HttpRequest, type HttpResponse } from "../request/index.js";
import type { TurnHosts } from "./hosts.js";
import { readMultistatus, type Multistatus } from "./multistatus.js";

export interface Refused {
  readonly ok: false;
  readonly reason: ProviderRefusal;
  readonly retryAfterMs: number | null;
}
export const refuse = (reason: ProviderRefusal, retryAfterMs: number | null = null): Refused => ({ ok: false, reason, retryAfterMs });

/** What one call of the port asks with: the way out, the sign-in, the turn's hosts, the caller's signal. */
export interface Session {
  readonly deps: AdapterDeps;
  /** The sign-in. Its `admits` is the turn's: {@link TurnHosts.admits}, or in a session of the discovery {@link TurnHosts.admitsFound}. */
  readonly auth: Authorization;
  readonly signal: AbortSignal;
  /** Where the sign-in may travel in this turn. */
  readonly hosts: TurnHosts;
  /**
   * Asks the server where the person's calendars are, once in the turn, so that the hosts it names
   * are admitted: where the refused address is to be asked now, or the word of an asking that
   * failed. No function in a session of that asking itself ({@link finding}).
   */
  readonly locate: ((refused: string) => Promise<Located>) | null;
}

/** Where a refused address is asked once the server said where the calendars are: itself, or the same place at the home that answered; or a word. */
export type Located = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: ProviderRefusal };

/**
 * The session the discovery asks with: a redirect its requests are answered with names the origin
 * it sends them on to, and a host that stays refused is not asked about a second time.
 */
export const finding = (s: Session): Session => ({ ...s, auth: { ...s.auth, admits: s.hosts.admitsFound }, locate: null });

/** The same session with a sign-in that travels with TLS alone from here on. */
export const tlsAlone = (s: Session): Session => ({ ...s, auth: { ...s.auth, tlsOnly: true } });

type Request = Pick<HttpRequest, "method" | "headers" | "body" | "precondition">;

/**
 * THE ONE WAY A CALDAV REQUEST LEAVES. The request port sends the sign-in only to an origin the
 * turn admits and refuses every other address before it looks anything up (`host_changed`). An
 * address a caller's stored row names is refused so until the server itself has named its host in
 * this turn: the server is then asked where the calendars are, once in the turn, and the request is
 * made again. Where it names that host, the request goes there. Where it does not, but the address
 * lies inside a calendar home that answered this turn from another origin, the request goes to the
 * same place at that origin: the server moved the person's calendars between its hosts, and the
 * stored address names the place inside the home, not the host (a `Destination` on the stored
 * origin moves with it). Otherwise the refusal stands; where the asking itself failed, its word
 * is. A host the server could not name at all is not asked about: its refusal stands, and nobody
 * was asked. No origin is admitted by any of this: every request still goes only where the port
 * lets it.
 *
 * A write is never sent twice by this: a refused address is refused before anything is sent, and a
 * write follows no redirect.
 */
export async function leave(s: Session, url: string, req: Request): Promise<HttpAnswer> {
  const send = (to: string, r: Request): Promise<HttpAnswer> => s.deps.http.request(to, { ...r, auth: s.auth, validators: null, signal: s.signal });
  const answer = await send(url, req);
  if (answer.arrived || answer.reason !== "host_changed" || s.locate === null || !s.hosts.couldName(url)) return answer;
  const located = await s.locate(url);
  if (!located.ok) return { arrived: false, reason: located.reason };
  return send(located.url, located.url === url ? req : movedRequest(req, url, located.url));
}

/** A request's `Destination` that names the stored origin names the origin the request is sent to instead. */
function movedRequest(req: Request, from: string, to: string): Request {
  const destination = req.headers.destination;
  if (destination === undefined) return req;
  const moved = knownAt(to, from)(destination);
  return moved === destination ? req : { ...req, headers: { ...req.headers, destination: moved } };
}

/** The collection advertises its CalDAV capabilities on OPTIONS. */
export function collectionOptions(session: Session, url: string): Promise<HttpAnswer> {
  return leave(session, url, { method: "OPTIONS", headers: {}, body: null });
}

export function davCapabilities(answer: HttpResponse): string[] {
  return (answer.header("dav") ?? "").split(",").map((word) => word.trim().toLowerCase()).filter(Boolean);
}

/** Use the property response as a compatibility fallback where the OPTIONS response lacks CalDAV. */
export async function schedulingAnswer(
  session: Session,
  url: string,
  options: HttpAnswer,
): Promise<HttpAnswer> {
  if (!options.arrived) return options;
  const understood = options.status >= 200 && options.status < 300;
  if (understood && davCapabilities(options).includes("calendar-access")) return options;
  return leave(session, url, {
    method: "PROPFIND",
    headers: { accept: "application/xml, text/xml", "content-type": "application/xml; charset=utf-8", depth: "0" },
    body: propfindOf("<D:resourcetype/>"),
  });
}

export function offersScheduling(capabilities: readonly string[]): boolean {
  return capabilities.includes("calendar-access") && capabilities.includes("calendar-auto-schedule");
}

export function offersMove(answer: HttpAnswer): boolean {
  return answer.arrived && answer.status >= 200 && answer.status < 300 &&
    (answer.header("allow") ?? "").split(",").some((method) => method.trim().toUpperCase() === "MOVE");
}

export async function allowsMove(session: Session, url: string): Promise<boolean> {
  return offersMove(await collectionOptions(session, url));
}

/** `url` is the address that answered, after the redirects the request port followed. `status` is `null` when no answer arrived. */
export type Asked = { readonly ok: true; readonly answer: Multistatus; readonly url: string } | (Refused & { readonly status: number | null });

const NAMES = `xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/"`;
const HEAD = `<?xml version="1.0" encoding="utf-8"?>`;

/** A request's body: one element of the standards' own, with the four namespaces a reader asks in bound to `D`, `C`, `CS` and `A`. */
export const bodyOf = (element: string, inner: string): string => `${HEAD}<${element} ${NAMES}>${inner}</${element}>`;
export const propfindOf = (props: string): string => bodyOf("D:propfind", `<D:prop>${props}</D:prop>`);

/** Text as it stands inside an element. */
export const xmlText = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** A status that is no multistatus, as a word. A 503 that says how long to wait is a server that is busy, not one that is broken. */
function wordOf(res: HttpResponse, clock: Clock): Refused {
  const wait = retryAfterMs(res, clock);
  const status = res.status;
  if (status === 401) return refuse("sign_in_refused");
  if (status === 403) return refuse("forbidden");
  if (status === 404 || status === 410) return refuse("not_found");
  if (status === 429 || (status === 503 && wait !== null)) return refuse("throttled", wait);
  if (status >= 500) return refuse("unavailable", wait);
  return refuse("unknown");
}

/** `depth`: `null` sends no Depth line (a multiget report is asked without one, RFC 4791 section 7.9). */
export async function ask(s: Session, method: "PROPFIND" | "REPORT", url: string, depth: "0" | "1" | null, body: string): Promise<Asked> {
  const lines = { accept: "application/xml, text/xml", "content-type": "application/xml; charset=utf-8" };
  const answer = await leave(s, url, { method, headers: depth === null ? lines : { ...lines, depth }, body });
  if (!answer.arrived) return { ...refuse(answer.reason), status: null };
  if (answer.status !== 207) return { ...wordOf(answer, s.deps.clock), status: answer.status };
  const read = readMultistatus(answer.body);
  return read.ok ? { ok: true, answer: read.value, url: answer.url } : { ...refuse(read.reason), status: 207 };
}

/**
 * An address as a server or a caller wrote it, read against `base` (the address that answered): one
 * spelling, no fragment. `null` for anything that is no plain web address: another scheme, a user
 * or a password inside, longer than an address may be.
 */
export function addressOf(written: string, base?: string): string | null {
  if (written === "" || written.length > MAX_URL_CHARS) return null;
  let url: URL;
  try {
    url = new URL(written, base);
  } catch {
    // No address: the caller has its own answer for a text that is none.
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") return null;
  url.hash = "";
  return url.href.length <= MAX_URL_CHARS ? url.href : null;
}

/** A collection as two texts to compare addresses with: itself, and what every address inside it begins with. */
export interface Scope {
  readonly self: string;
  readonly under: string;
}

/** A path without the slashes it ends on, so that a collection named with and without one is one place. */
function withoutEndSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 47) end--;
  return end === text.length ? text : text.slice(0, end);
}

/** `address` is one {@link addressOf} gave, or the request port's own. */
export function scopeOf(address: string): Scope {
  const url = new URL(address);
  const self = url.origin + withoutEndSlashes(url.pathname);
  return { self, under: `${self}/` };
}

/** Is this address (one of {@link addressOf}'s) the collection itself? Its query aside. */
export function isSelf(scope: Scope, address: string): boolean {
  const query = address.indexOf("?");
  return withoutEndSlashes(query === -1 ? address : address.slice(0, query)) === scope.self;
}

export const isUnder = (scope: Scope, address: string): boolean => address.startsWith(scope.under) && !isSelf(scope, address);

/**
 * The same place at a calendar home's host: `address` (one of {@link addressOf}'s) where it is on
 * another host, with the home's scheme and port, and its path lies inside the home's path; else
 * `null`. The home is an address that answered in this turn, so its origin is one the turn admits.
 * Another port or another scheme is another server, and is never taken for the same place.
 */
export function samePlaceAt(address: string, home: string): string | null {
  const at = new URL(address);
  const inside = new URL(home);
  const under = `${withoutEndSlashes(inside.pathname)}/`;
  if (at.host === inside.host || at.protocol !== inside.protocol || at.port !== inside.port) return null;
  if (!at.pathname.startsWith(under) || withoutEndSlashes(at.pathname).length < under.length) return null;
  return `${inside.origin}${at.pathname}${at.search}`;
}

/**
 * Addresses an answer from `answeredAt` names, known under the origin of `known`: a calendar's
 * members keep the origin the calendar is stored at, whichever of the server's hosts answered for
 * it. The same function where both are one origin.
 */
export function knownAt(known: string, answeredAt: string): (address: string) => string {
  const from = new URL(answeredAt).origin;
  const to = new URL(known).origin;
  if (from === to) return (address) => address;
  return (address) => (address.startsWith(`${from}/`) ? `${to}${address.slice(from.length)}` : address);
}

/**
 * What one place of a server is known by whichever of its hosts names it: its scheme, its port, its
 * path in one spelling (each segment unescaped and escaped again, no slash at its end) and its
 * query. Only the host is left out, as {@link samePlaceAt} reads the same place at another host:
 * another port or another scheme is another server. A text that is no address is its own key.
 */
export function placeKey(address: string): string {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    // No address: it is known by its text.
    return address;
  }
  const key = sameMemberKey(url.href);
  return `${url.protocol}//:${url.port}${withoutEndSlashes(key.slice(url.origin.length).split("?")[0]!)}${url.search}`;
}

/**
 * One spelling of an address (one of {@link addressOf}'s) for telling whether two written forms name
 * one member: every segment of its path unescaped and escaped again, so that a character written
 * out in one answer and escaped in another compares equal. Only for comparing: a member is asked
 * for as the server wrote it, and known by the address it was listed under.
 */
export function sameMemberKey(address: string): string {
  const url = new URL(address);
  const segments = url.pathname.split("/").map((segment) => {
    try {
      return encodeURIComponent(decodeURIComponent(segment));
    } catch {
      // Not an escape any reader could undo: the segment compares as it was written.
      return segment;
    }
  });
  return `${url.origin}${segments.join("/")}${url.search}`;
}
