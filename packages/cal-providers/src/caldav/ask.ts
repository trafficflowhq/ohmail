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
   * are admitted: the word of an asking that failed, or `null`. No function in a session of that
   * asking itself ({@link finding}).
   */
  readonly locate: ((refused: string) => Promise<ProviderRefusal | null>) | null;
}

/**
 * The session the discovery asks with: a redirect its requests are answered with names the origin
 * it sends them on to, and a host that stays refused is not asked about a second time.
 */
export const finding = (s: Session): Session => ({ ...s, auth: { ...s.auth, admits: s.hosts.admitsFound }, locate: null });

/** The same session with a sign-in that travels with TLS alone from here on. */
export const tlsAlone = (s: Session): Session => ({ ...s, auth: { ...s.auth, tlsOnly: true } });

/**
 * THE ONE WAY A CALDAV REQUEST LEAVES. The request port sends the sign-in only to an origin the
 * turn admits and refuses every other address before it looks anything up (`host_changed`). An
 * address a caller's stored row names is refused so until the server itself has named its host in
 * this turn: the server is then asked where the calendars are, once in the turn, and the request is
 * made again. Where it names that host, the request goes there; where it does not, the port
 * refuses it again and that is the answer; where the asking itself failed, its word is. A host the
 * server could not name at all is not asked about: its refusal stands, and nobody was asked.
 *
 * A write is never sent twice by this: a refused address is refused before anything is sent, and a
 * write follows no redirect.
 */
export async function leave(s: Session, url: string, req: Pick<HttpRequest, "method" | "headers" | "body" | "precondition">): Promise<HttpAnswer> {
  const send = (): Promise<HttpAnswer> => s.deps.http.request(url, { ...req, auth: s.auth, validators: null, signal: s.signal });
  const answer = await send();
  if (answer.arrived || answer.reason !== "host_changed" || s.locate === null || !s.hosts.couldName(url)) return answer;
  const failed = await s.locate(url);
  return failed === null ? send() : { arrived: false, reason: failed };
}

export async function allowsMove(session: Session, url: string): Promise<boolean> {
  const answer = await leave(session, url, { method: "OPTIONS", headers: {}, body: null });
  return answer.arrived && answer.status >= 200 && answer.status < 300 &&
    (answer.header("allow") ?? "").split(",").some((method) => method.trim().toUpperCase() === "MOVE");
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
