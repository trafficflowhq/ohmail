/**
 * Turns a provider's real answer into a fixture that carries nothing of the account it came from.
 *
 * There is no raw mode. An answer is scrubbed in memory, then `assertClean` reads the result, and only then
 * is anything written. A fixture that still carries an address on a real domain, a credential's shape, a
 * Meet room or iCloud's account number is refused and nothing reaches the disk.
 *
 * Identifiers are mapped with counters that are stable inside one `Scrubber` (`evt-1`, `cal-1`, `sync-1`,
 * `principal-1`, `person-1`), so an event keeps one name across the answers that mention it, and across
 * providers: Google's invitation and its copy at iCloud get the same `evt-N`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CalendarTestAccounts } from "./calendar-test-accounts.ts";

export type Provider = "google" | "caldav";
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const FIXED_ISO = "2026-11-13T12:00:00.000Z";
const FIXED_ICS = "20261113T120000Z";
const BENCH_DOMAIN = "bench.example";

const RESERVED_TLD = new Set(["example", "invalid", "test", "localhost"]);
const RESERVED_DOMAIN = /(^|\.)example\.(com|net|org)$/;
const ADDRESS = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;

/** The shapes no fixture may carry. A name is reported, never the text that matched. */
const REFUSED: readonly [string, RegExp][] = [
  ["a bearer credential", /Bearer /],
  ["a basic credential", /Basic /],
  ["a Google access token", /ya29\./],
  ["a Google refresh token", /1\/\//],
  ["a Google client secret", /GOCSPX-/],
  ["a Google client id", /apps\.googleusercontent\.com/],
  ["a Meet room", /meet\.google\.com\//],
  ["a Google Calendar link", /calendar\.google\.com|google\.com\/calendar/],
  ["an event link's token", /[?&;](?:eid|tok)=/],
  ["an account number in a path", /\/\d{6,}\//],
];

export class NotClean extends Error {
  readonly rule: string;
  constructor(rule: string) {
    super(`refused, not written: the scrubbed text still carries ${rule}`);
    this.rule = rule;
  }
}

/** An armed exchange was answered otherwise than it was armed for: nothing of the run is kept. */
export class NotRecorded extends Error {
  constructor(name: string, status: number, wanted: number | undefined) {
    super(`not recorded, nothing kept: ${name} was answered ${status}, armed for ${wanted ?? "2xx"}`);
  }
}

/** Throws `NotClean` when the text carries a refused shape or an address outside the reserved domains. */
export function assertClean(text: string): void {
  for (const [rule, shape] of REFUSED) if (shape.test(text)) throw new NotClean(rule);
  for (const m of text.matchAll(ADDRESS)) {
    const domain = m[1]!.toLowerCase();
    if (!RESERVED_TLD.has(domain.slice(domain.lastIndexOf(".") + 1)) && !RESERVED_DOMAIN.test(domain)) throw new NotClean("an address on a domain that is not reserved");
  }
}

function unxml(s: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  if (cdata) return cdata[1]!;
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#13;/g, "\r").replace(/&amp;/g, "&");
}
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#13;");

export class Scrubber {
  readonly #accounts: CalendarTestAccounts | undefined;
  readonly #seen = new Map<string, Map<string, number>>();

  /** `accounts` is absent only for a bench-only run, where no account's value can be in an answer. */
  constructor(o: { accounts?: CalendarTestAccounts } = {}) {
    this.#accounts = o.accounts;
  }

  #n(kind: string, raw: string): string {
    let of = this.#seen.get(kind);
    if (!of) this.#seen.set(kind, (of = new Map()));
    if (!of.has(raw)) of.set(raw, of.size + 1);
    return `${kind}-${of.get(raw)}`;
  }

  /** An event's identifier. One of a series' days keeps its day: `evt-3_20261201T170000Z`. */
  #event(raw: string): string {
    const day = /^(.+)_(\d{8}(?:T\d{6}Z)?)$/.exec(raw);
    return day ? `${this.#n("evt", day[1]!)}_${day[2]}` : this.#n("evt", raw);
  }
  #uid(raw: string): string {
    return `${this.#n("evt", raw.replace(/@[^@]*$/, ""))}@${BENCH_DOMAIN}`;
  }
  #address(raw: string): string {
    const bare = raw.replace(/^mailto:/i, "").trim();
    if (bare.endsWith(`@${BENCH_DOMAIN}`)) return bare;
    if (this.#accounts?.GOOGLE_TEST_ACCOUNT.is(bare)) return `google-account@${BENCH_DOMAIN}`;
    if (this.#accounts?.ICLOUD_APPLE_ID.is(bare)) return `icloud-account@${BENCH_DOMAIN}`;
    return `${this.#n("person", bare.toLowerCase())}@${BENCH_DOMAIN}`;
  }

  /**
   * A provider's own links into its calendar pages, and the tokens of such a link wherever they stand.
   * Google writes one into an invitation's text; its `eid` and `tok` are base64 of the event's id and of
   * both accounts' addresses. The link becomes one fixed invented address.
   */
  #links(text: string): string {
    return text
      .replace(/https?:\/\/(?:calendar\.google\.com|(?:www\.)?google\.com\/calendar)[^\s"'<>\\]*/gi, `https://calendar.${BENCH_DOMAIN}/event`)
      .replace(/([?&;])(?:eid|tok)=[^\s"'<>\\&;#]*/g, "$1scrubbed=1");
  }

  /** Every written form of every value of the accounts file, taken out; a provider's own links with them. */
  values(text: string): string {
    let out = this.#links(text);
    if (!this.#accounts) return out;
    out = this.#accounts.GOOGLE_TEST_ACCOUNT.redactIn(out, `google-account@${BENCH_DOMAIN}`);
    out = this.#accounts.ICLOUD_APPLE_ID.redactIn(out, `icloud-account@${BENCH_DOMAIN}`);
    for (const key of ["ICLOUD_APP_PASSWORD", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_TEST_REFRESH_TOKEN"] as const) {
      out = this.#accounts[key].redactIn(out, "[scrubbed]");
    }
    return out;
  }

  #person(v: Json): Json {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
    const out: { [k: string]: Json } = {};
    if (typeof v.email === "string") out.email = this.#address(v.email);
    for (const k of ["self", "organizer", "optional", "resource", "responseStatus"]) if (v[k] !== undefined) out[k] = v[k]!;
    return out;
  }

  #meet(raw: string): string {
    return `https://meet.${BENCH_DOMAIN}/${this.#n("room", raw.replace(/^https?:\/\/[^/]+\//, "").replace(/[?#].*$/, ""))}`;
  }

  /** A Meet room is a live door: its shape stays, its room becomes an invented one. */
  #conference(v: Json): Json {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
    const out: { [k: string]: Json } = {};
    const request = v.createRequest;
    if (request && typeof request === "object" && !Array.isArray(request)) {
      out.createRequest = { requestId: this.#n("request", String(request.requestId ?? "")), conferenceSolutionKey: request.conferenceSolutionKey ?? {}, status: request.status ?? {} };
    }
    const key = (v.conferenceSolution as { key?: Json } | undefined)?.key;
    if (key !== undefined) out.conferenceSolution = { key, name: "Google Meet" };
    if (typeof v.conferenceId === "string") out.conferenceId = this.#n("room", v.conferenceId);
    if (Array.isArray(v.entryPoints)) {
      out.entryPoints = v.entryPoints
        .filter((e): e is { [k: string]: Json } => e !== null && typeof e === "object" && !Array.isArray(e) && e.entryPointType === "video")
        .map((e) => ({ entryPointType: "video", uri: this.#meet(String(e.uri ?? "")) }));
    }
    return out;
  }

  /** A Google Calendar answer (or request body), walked key by key. */
  google(node: Json, under = ""): Json {
    if (Array.isArray(node)) return node.map((x) => this.google(x, under));
    if (node === null || typeof node !== "object") return node;
    const kind = node.kind;
    const out: { [k: string]: Json } = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "etag" || k === "htmlLink" || k === "source" || k === "attachments" || k === "gadget") continue;
      else if (k === "id" && typeof v === "string") out.id = kind === "calendar#calendarListEntry" ? this.#n("cal", v) : this.#event(v);
      else if (k === "iCalUID" && typeof v === "string") out.iCalUID = this.#uid(v);
      else if (k === "recurringEventId" && typeof v === "string") out.recurringEventId = this.#event(v);
      else if ((k === "nextSyncToken" || k === "nextPageToken") && typeof v === "string") out[k] = this.#n("sync", v);
      else if (k === "updated" || k === "created") out[k] = FIXED_ISO;
      else if (k === "creator" || k === "organizer") out[k] = this.#person(v);
      else if (k === "attendees" && Array.isArray(v)) out[k] = v.map((a) => this.#person(a));
      else if (k === "hangoutLink" && typeof v === "string") out[k] = this.#meet(v);
      else if (k === "conferenceData") out[k] = this.#conference(v);
      else out[k] = this.google(v, k);
    }
    return out;
  }

  /** iCalendar text: unfolded, identities mapped, Apple's own lines and the write stamps dropped or fixed. */
  ics(text: string): string {
    const out: string[] = [];
    for (const line of text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)) {
      let colon = -1;
      for (let i = 0, quoted = false; i < line.length; i++) {
        if (line[i] === '"') quoted = !quoted;
        else if (line[i] === ":" && !quoted) {
          colon = i;
          break;
        }
      }
      if (colon < 0) {
        out.push(line);
        continue;
      }
      const [name, ...params] = line.slice(0, colon).split(";");
      const value = line.slice(colon + 1);
      const upper = name!.toUpperCase();
      if (upper.startsWith("X-APPLE-")) continue;
      if (upper === "UID") out.push(`UID:${this.#uid(value)}`);
      else if (upper === "ORGANIZER" || upper === "ATTENDEE") {
        const kept = params.filter((p) => /^(PARTSTAT|ROLE|RSVP|CUTYPE)=/i.test(p));
        out.push([upper, ...kept].join(";") + `:mailto:${this.#address(value)}`);
      } else if (upper === "DTSTAMP" || upper === "CREATED" || upper === "LAST-MODIFIED") out.push(`${upper}:${FIXED_ICS}`);
      else out.push(line);
    }
    return this.values(this.#paths(out.join("\r\n")));
  }

  #paths(s: string): string {
    return s.replace(/p\d{1,3}-caldav\.icloud\.com(?::443)?/g, "p00-caldav.icloud.com").replace(/\/(\d{6,})(?=\/)/g, (_m, id: string) => `/${this.#n("principal", id)}`);
  }

  /** A WebDAV multistatus (or any DAV body): paths, identities, tokens and the calendar text inside it. */
  dav(body: string): string {
    // The calendar text is scrubbed by its own rules and set aside, so that the rules for the XML around it
    // do not read it a second time.
    const texts: string[] = [];
    // An element written `<calendar-data .../>` is empty, not an opening tag: iCloud sends one for the
    // collection itself, and reading it as an opening swallows the next member whole.
    let s = body.replace(/<((?:[\w-]+:)?calendar-data)(?![\w-])([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g, (m, tag: string, attrs: string, inner: string | undefined) => {
      if (inner === undefined) return m;
      texts.push(`<${tag}${attrs}>${xml(this.ics(unxml(inner)))}</${tag}>`);
      return `\u0000${texts.length - 1}\u0000`;
    });
    s = this.#paths(s);
    s = s.replace(/mailto:([^<"\s]+)/gi, (_m, a: string) => `mailto:${this.#address(a)}`);
    s = s.replace(/urn:uuid:[0-9A-Fa-f-]{8,}/g, (m) => `urn:uuid:${this.#n("uuid", m)}`);
    s = s.replace(/(<(?:[\w-]+:)?sync-token(?![\w-])[^>]*(?<!\/)>)([^<]+)(<)/g, (_m, a: string, t: string, b: string) => `${a}${this.#n("sync", t.trim())}${b}`);
    s = s.replace(/(<(?:[\w-]+:)?getctag(?![\w-])[^>]*(?<!\/)>)([^<]+)(<)/g, (_m, a: string, t: string, b: string) => `${a}${this.#n("ctag", t.trim())}${b}`);
    s = s.replace(/(<(?:[\w-]+:)?getetag(?![\w-])[^>]*(?<!\/)>)([^<]+)(<)/g, (_m, a: string, t: string, b: string) => `${a}&quot;${this.#n("etag", t.trim())}&quot;${b}`);
    return this.values(s).replace(/\u0000(\d+)\u0000/g, (_m, i: string) => texts[Number(i)]!);
  }

  /** A request's address: the calendar, the event and the tokens in it are mapped as in the answers. */
  url(provider: Provider, raw: string): string {
    if (provider === "caldav") return this.values(this.#paths(raw));
    const u = new URL(raw);
    u.pathname = u.pathname
      .replace(/\/calendars\/([^/]+)/, (_m, id: string) => `/calendars/${this.#n("cal", decodeURIComponent(id))}`)
      .replace(/\/events\/([^/]+)/, (_m, id: string) => `/events/${this.#event(decodeURIComponent(id))}`);
    for (const k of ["syncToken", "pageToken"]) if (u.searchParams.has(k)) u.searchParams.set(k, this.#n("sync", u.searchParams.get(k)!));
    return this.values(u.href);
  }
}

export interface Exchange {
  method: string;
  url: string;
  depth?: string;
  requestBody?: string;
  status: number;
  contentType: string;
  body: string;
}
export interface Keep {
  /** Google: which items of a list stay. */
  item?: (item: { [k: string]: Json }) => boolean;
  /** CalDAV: which `<response>` elements of a multistatus stay (given the raw element, in memory). */
  response?: (responseXml: string) => boolean;
}
export interface Armed extends Keep {
  /** The one status this exchange is recorded with: a refusal kept as a refusal. Absent: any 2xx. */
  status?: number;
}

export class Recorder {
  readonly #dir: string;
  readonly #scrubber: Scrubber;

  constructor(o: { dir: string; scrubber: Scrubber }) {
    this.#dir = o.dir;
    this.#scrubber = o.scrubber;
  }

  /** Scrubs, checks, writes. Returns the fixture's path; throws `NotClean` and writes nothing otherwise. */
  save(provider: Provider, name: string, x: Exchange, keep: Keep = {}): string {
    const { path, text } = this.#prepare(provider, name, x, keep);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  }

  #prepare(provider: Provider, name: string, x: Exchange, keep: Keep): { path: string; text: string } {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("a fixture's name is lower-case letters, digits and hyphens");
    const s = this.#scrubber;
    let body: Json;
    let requestBody: Json | undefined;
    if (provider === "google") {
      const parsed = (x.body ? JSON.parse(x.body) : {}) as { [k: string]: Json };
      if (keep.item && Array.isArray(parsed.items)) parsed.items = parsed.items.filter((i) => keep.item!(i as { [k: string]: Json }));
      body = JSON.parse(s.values(JSON.stringify(s.google(parsed)))) as Json;
      if (x.requestBody) requestBody = JSON.parse(s.values(JSON.stringify(s.google(JSON.parse(x.requestBody) as Json)))) as Json;
    } else {
      const kept = keep.response ? x.body.replace(/<(?:[\w-]+:)?response(?![\w-])[^>]*>[\s\S]*?<\/(?:[\w-]+:)?response>\s*/g, (r) => (keep.response!(r) ? r : "")) : x.body;
      body = /calendar/.test(x.contentType) && !/xml/.test(x.contentType) ? s.ics(kept) : s.dav(kept);
      if (x.requestBody) requestBody = s.dav(x.requestBody);
    }
    const request: { [k: string]: Json } = { method: x.method, url: s.url(provider, x.url) };
    if (x.depth !== undefined) request.depth = x.depth;
    if (requestBody !== undefined) request.body = requestBody;
    const fixture = { provider, name, request, response: { status: x.status, contentType: x.contentType.split(";")[0]!.trim(), body } };
    const text = JSON.stringify(fixture, null, 2) + "\n";
    assertClean(text);
    // What the scrub would still change is not scrubbed. `assertClean` knows shapes; this knows the values.
    if (this.#scrubber.values(text) !== text) throw new NotClean("a value of the accounts file, or a provider's own link");
    return { path: join(this.#dir, `${name}.json`), text };
  }

  /**
   * A `fetch` that passes everything through and holds the one next exchange it was armed for.
   * The sign-in's own exchange (Google's token address) is never recorded, armed or not.
   *
   * A run is kept whole or not at all: fixtures are held in memory until `commit()`. An armed exchange
   * that is answered otherwise than armed for (any 2xx, or the one status named) throws `NotRecorded`,
   * and after that `commit()` writes nothing. A refusal is a fixture only when it was armed as one.
   */
  tap(inner: FetchLike): { fetch: FetchLike; next: (provider: Provider, name: string, armedFor?: Armed) => void; commit: () => string[] } {
    let armed: { provider: Provider; name: string; armedFor: Armed } | undefined;
    let failed: NotRecorded | undefined;
    const held: { path: string; text: string }[] = [];
    const tapped: FetchLike = async (input, init) => {
      const r = await inner(input, init);
      if (!armed || /^https:\/\/oauth2\.googleapis\.com\//.test(input)) return r;
      const a = armed;
      armed = undefined;
      const wanted = a.armedFor.status;
      if (wanted === undefined ? r.status < 200 || r.status > 299 : r.status !== wanted) throw (failed = new NotRecorded(a.name, r.status, wanted));
      const headers = new Headers(init?.headers);
      held.push(
        this.#prepare(
          a.provider,
          a.name,
          {
            method: init?.method ?? "GET",
            url: input,
            depth: headers.get("depth") ?? undefined,
            requestBody: typeof init?.body === "string" ? init.body : undefined,
            status: r.status,
            contentType: r.headers.get("content-type") ?? "",
            body: await r.clone().text(),
          },
          a.armedFor,
        ),
      );
      return r;
    };
    const commit = () => {
      if (failed) throw failed;
      if (armed) throw new Error(`not recorded, nothing kept: ${armed.name} was armed and never asked`);
      for (const f of held) (mkdirSync(dirname(f.path), { recursive: true }), writeFileSync(f.path, f.text));
      return held.map((f) => f.path);
    };
    return { fetch: tapped, next: (provider, name, armedFor = {}) => void (armed = { provider, name, armedFor }), commit };
  }
}
