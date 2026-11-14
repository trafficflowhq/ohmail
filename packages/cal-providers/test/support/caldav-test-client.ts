/**
 * A small CalDAV client for the bench: what a test needs to plant, count, read and remove events, by the
 * standards (RFC 4791, RFC 6578) and with no provider's name in a code path.
 *
 * It talks to two kinds of server and to no other: the bench's own on this machine, and iCloud. They are
 * two rows of `CALDAV_TEST_SERVERS`; a third server is a third row. Every request's address is checked
 * against the row BEFORE the credentials are attached, redirects included, so a server that points
 * somewhere else gets nothing.
 *
 * The multistatus reader is a test tool: it reads elements by local name with a pattern, which is enough for
 * what these two servers send and is NOT the product's parser.
 */
import { isLoopback, Secret } from "./calendar-test-accounts.ts";

export interface CalDavServerRow {
  readonly name: string;
  /** Is this the row for that base address? */
  readonly base: (url: URL) => boolean;
  /** May a request with the credentials go to that address? */
  readonly allows: (url: URL) => boolean;
}

const httpsDefaultPort = (u: URL) => u.protocol === "https:" && (u.port === "" || u.port === "443");

export const CALDAV_TEST_SERVERS: readonly CalDavServerRow[] = [
  {
    name: "bench",
    base: (u) => isLoopback(u.hostname),
    allows: (u) => (u.protocol === "http:" || u.protocol === "https:") && isLoopback(u.hostname),
  },
  {
    name: "icloud",
    base: (u) => httpsDefaultPort(u) && u.hostname === "caldav.icloud.com",
    // iCloud names the account's home on a numbered host of its own (p<NN>-caldav.icloud.com).
    allows: (u) => httpsDefaultPort(u) && /^(caldav|p\d{1,3}-caldav)\.icloud\.com$/.test(u.hostname),
  },
];

export interface DavResponse {
  status: number;
  etag: string | undefined;
  text: string;
}
export interface DavCollection {
  href: string;
  displayName: string;
  isCalendar: boolean;
  components: string[];
  ctag: string | undefined;
  syncToken: string | undefined;
}
export interface DavObject {
  href: string;
  etag: string | undefined;
  /** 404 for a member a sync report names as removed. */
  status: number;
  data: string | undefined;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"';

function unxml(s: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  if (cdata) return cdata[1]!;
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#13;/g, "\r").replace(/&amp;/g, "&");
}
function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/** The content of the first element with that local name, whatever its prefix. */
export function element(source: string, local: string): string | undefined {
  const m = new RegExp(`<(?:[\\w-]+:)?${local}(?![\\w-])[^>]*?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${local}>)`).exec(source);
  return m ? (m[1] ?? "") : undefined;
}
/** Every `<response>` of a multistatus, as its own text. */
export function davResponses(source: string): string[] {
  return [...source.matchAll(/<(?:[\w-]+:)?response(?![\w-])[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/g)].map((m) => m[1]!);
}
function hrefOf(source: string | undefined): string | undefined {
  const h = source === undefined ? undefined : element(source, "href");
  return h === undefined ? undefined : unxml(h).trim();
}

/** The UIDs in a calendar object's text (folded lines joined first). */
export function uidsOf(ics: string): string[] {
  return [...ics.replace(/\r?\n[ \t]/g, "").matchAll(/^UID(?:;[^:\r\n]*)?:(.*)$/gm)].map((m) => m[1]!.trim());
}

export interface Place {
  where: string;
  href: string;
}
export interface PlaceReading extends Place {
  status: number;
  object: DavObject | undefined;
}
/**
 * Reads each place for one UID. A place answers 207 with the object, 207 without it, or something else,
 * and something else is a FAULT: it says nothing about whether the object is there, so a caller must
 * never report it as "not found".
 */
export async function readPlacesByUid(client: Pick<CalDavTestClient, "byUid">, places: readonly Place[], uid: string): Promise<{ readings: PlaceReading[]; found: PlaceReading | undefined; faults: PlaceReading[] }> {
  const readings: PlaceReading[] = [];
  for (const p of places) {
    const r = await client.byUid(p.href, uid);
    readings.push({ ...p, status: r.status, object: r.status === 207 ? r.objects[0] : undefined });
  }
  return { readings, found: readings.find((r) => r.object !== undefined), faults: readings.filter((r) => r.status !== 207) };
}

export class CalDavTestClient {
  readonly server: CalDavServerRow;
  readonly #base: URL;
  readonly #user: Secret;
  readonly #password: Secret;
  readonly #fetch: FetchLike;

  constructor(o: { baseUrl: string; user: Secret; password: Secret; fetch?: FetchLike }) {
    this.#base = new URL(o.baseUrl);
    const row = CALDAV_TEST_SERVERS.find((r) => r.base(this.#base) && r.allows(this.#base));
    if (!row) throw new Error(`the CalDAV test client does not talk to ${this.#base.host}: it is not a test server`);
    if (!o.user.filled || !o.password.filled) throw new Error("the CalDAV test client was given no credentials");
    this.server = row;
    this.#user = o.user;
    this.#password = o.password;
    this.#fetch = o.fetch ?? ((input, init) => fetch(input, init));
  }

  #authorization(): string {
    // An app password is shown in groups; the server takes it joined.
    const pair = `${this.#user.reveal()}:${this.#password.reveal().replace(/ /g, "")}`;
    return `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
  }

  /** One request. The address is checked against the server's row first; a redirect is checked again. */
  async request(method: string, href: string, o: { depth?: "0" | "1"; body?: string; headers?: Record<string, string> } = {}): Promise<DavResponse> {
    let url = new URL(href, this.#base);
    for (let hop = 0; hop < 4; hop++) {
      if (!this.server.allows(url)) throw new Error(`refused: ${url.host} is outside the ${this.server.name} row`);
      const headers: Record<string, string> = { Authorization: this.#authorization(), "User-Agent": "ohmail-cal-bench/1", ...o.headers };
      if (o.depth !== undefined) headers.Depth = o.depth;
      if (o.body !== undefined && !headers["Content-Type"]) headers["Content-Type"] = "application/xml; charset=utf-8";
      const r = await this.#fetch(url.href, { method, headers, body: o.body, redirect: "manual" });
      const location = r.headers.get("location");
      if (r.status >= 301 && r.status <= 308 && r.status !== 304 && location) {
        url = new URL(location, url);
        continue;
      }
      return { status: r.status, etag: r.headers.get("etag") ?? undefined, text: await r.text() };
    }
    throw new Error("refused: too many redirects");
  }

  /** The signed-in principal and its calendar home (RFC 5397, RFC 4791 6.2.1). */
  async discover(): Promise<{ status: number; principal: string; home: string; scheduleInbox: string | undefined }> {
    const who = await this.request("PROPFIND", this.#base.href, { depth: "0", body: `<d:propfind ${NS}><d:prop><d:current-user-principal/></d:prop></d:propfind>` });
    const principal = hrefOf(element(who.text, "current-user-principal"));
    if (who.status !== 207 || !principal) return { status: who.status, principal: "", home: "", scheduleInbox: undefined };
    const p = await this.request("PROPFIND", principal, { depth: "0", body: `<d:propfind ${NS}><d:prop><c:calendar-home-set/><c:schedule-inbox-URL/></d:prop></d:propfind>` });
    const home = hrefOf(element(p.text, "calendar-home-set"));
    const inbox = hrefOf(element(p.text, "schedule-inbox-URL"));
    return { status: home ? 207 : p.status === 207 ? 404 : p.status, principal: this.#abs(principal), home: home ? this.#abs(home, principal) : "", scheduleInbox: inbox ? this.#abs(inbox, principal) : undefined };
  }

  #abs(href: string, from?: string): string {
    return new URL(href, from ? new URL(from, this.#base) : this.#base).href;
  }

  /** The home's members, the home itself left out. */
  async collections(home: string): Promise<{ status: number; collections: DavCollection[]; text: string }> {
    const body = `<d:propfind ${NS}><d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/><cs:getctag/><d:sync-token/></d:prop></d:propfind>`;
    const r = await this.request("PROPFIND", home, { depth: "1", body });
    const homePath = new URL(home).pathname;
    const collections = davResponses(r.text)
      .map((x) => ({
        href: this.#abs(hrefOf(x) ?? "", home),
        displayName: unxml(element(x, "displayname") ?? "").trim(),
        isCalendar: /<(?:[\w-]+:)?calendar(?![\w-])[^>]*\/>/.test(element(x, "resourcetype") ?? ""),
        components: [...(element(x, "supported-calendar-component-set") ?? "").matchAll(/name=["']([A-Z]+)["']/g)].map((m) => m[1]!),
        ctag: element(x, "getctag")?.trim() || undefined,
        syncToken: element(x, "sync-token")?.trim() || undefined,
      }))
      .filter((c) => new URL(c.href).pathname !== homePath);
    return { status: r.status, collections, text: r.text };
  }

  /** MKCALENDAR (RFC 4791 5.3.1): a calendar for events at `<home><slug>/`. */
  async makeCalendar(home: string, slug: string, displayName: string): Promise<{ status: number; href: string }> {
    const href = this.#abs(`${encodeURIComponent(slug)}/`, home);
    const body = `<c:mkcalendar ${NS}><d:set><d:prop><d:displayname>${xml(displayName)}</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>`;
    const r = await this.request("MKCALENDAR", href, { body });
    return { status: r.status, href };
  }

  /** Stores one calendar object. `onlyIfNew` is "only if nothing is there" (If-None-Match: *). */
  async put(href: string, ics: string, o: { onlyIfNew?: boolean; ifMatch?: string } = {}): Promise<DavResponse> {
    const headers: Record<string, string> = { "Content-Type": "text/calendar; charset=utf-8" };
    if (o.onlyIfNew) headers["If-None-Match"] = "*";
    if (o.ifMatch) headers["If-Match"] = o.ifMatch;
    return this.request("PUT", href, { body: ics, headers });
  }

  get(href: string): Promise<DavResponse> {
    return this.request("GET", href);
  }

  delete(href: string, o: { ifMatch?: string } = {}): Promise<DavResponse> {
    return this.request("DELETE", href, { headers: o.ifMatch ? { "If-Match": o.ifMatch } : {} });
  }

  /**
   * calendar-query (RFC 4791 7.8) for events, optionally with their text, optionally filtered on one UID.
   * The UID filter is the standard's and the bench's server takes it; iCloud answers it 412 in every way
   * it can be written (with either collation, or none). Where the server is not known, use `byUid`.
   */
  async query(collection: string, o: { uid?: string; data?: boolean } = {}): Promise<{ status: number; objects: DavObject[]; text: string }> {
    const filter = o.uid
      ? `<c:comp-filter name="VEVENT"><c:prop-filter name="UID"><c:text-match collation="i;octet">${xml(o.uid)}</c:text-match></c:prop-filter></c:comp-filter>`
      : `<c:comp-filter name="VEVENT"/>`;
    const body = `<c:calendar-query ${NS}><d:prop><d:getetag/>${o.data ? "<c:calendar-data/>" : ""}</d:prop><c:filter><c:comp-filter name="VCALENDAR">${filter}</c:comp-filter></c:filter></c:calendar-query>`;
    const r = await this.request("REPORT", collection, { depth: "1", body });
    return { status: r.status, objects: this.#objects(r.text, collection), text: r.text };
  }

  /** The members that hold that UID, found by reading every event's text: the way every server takes. */
  async byUid(collection: string, uid: string): Promise<{ status: number; objects: DavObject[] }> {
    const q = await this.query(collection, { data: true });
    return { status: q.status, objects: q.objects.filter((o) => uidsOf(o.data ?? "").includes(uid)) };
  }

  /** sync-collection (RFC 6578): everything when `token` is empty, else what changed since it. */
  async sync(collection: string, token: string): Promise<{ status: number; objects: DavObject[]; token: string | undefined; text: string }> {
    const body = `<d:sync-collection ${NS}><d:sync-token>${xml(token)}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`;
    const r = await this.request("REPORT", collection, { body });
    const tail = r.text.replace(/<(?:[\w-]+:)?response(?![\w-])[\s\S]*<\/(?:[\w-]+:)?response>/, "");
    return { status: r.status, objects: this.#objects(r.text, collection), token: element(tail, "sync-token")?.trim() || undefined, text: r.text };
  }

  /** The members a report names. iCloud also answers with the collection itself; that one is no member. */
  #objects(text: string, collection: string): DavObject[] {
    const self = new URL(collection, this.#base).pathname;
    return davResponses(text)
      .filter((x) => new URL(hrefOf(x) ?? "", new URL(collection, this.#base)).pathname !== self)
      .map((x) => {
        const data = element(x, "calendar-data");
        const status = /HTTP\/1\.1 (\d{3})/.exec(element(x.replace(/<(?:[\w-]+:)?propstat(?![\w-])[\s\S]*<\/(?:[\w-]+:)?propstat>/, ""), "status") ?? "");
        return {
          href: this.#abs(hrefOf(x) ?? "", collection),
          etag: unxml(element(x, "getetag") ?? "").trim() || undefined,
          status: status ? Number(status[1]) : 200,
          data: data === undefined ? undefined : unxml(data),
        };
      });
  }
}
