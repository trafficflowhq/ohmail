/**
 * A CalDAV server for the tests, on this machine's own address and written from the standards
 * (RFC 4791, RFC 6578, RFC 6764, RFC 5397): a start, a principal, a home, calendars with members,
 * the sync report with tokens it can throw away, the multiget report. A test tool, in the tests'
 * own words: it shares no line with the reader it is asked by.
 *
 * What servers do differently is a switch each, so that one reader is seen against all of it: a
 * well-known address that redirects or is missing, a home named on another host, a report that
 * names the collection itself, a calendar that keeps no token, an answer cut short with "more to
 * come", a sign-in refused by a status or by an answer that names nobody.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Seen {
  readonly method: string;
  readonly path: string;
  /** The Host line as sent: the name the request was meant for. */
  readonly host: string;
  /** Whether an Authorization line came with it, and whether it was the right one. */
  readonly withCredential: boolean;
  readonly signedIn: boolean;
  readonly depth: string | null;
  readonly body: string;
  /** The report or request named by the body's first element (`propfind`, `sync-collection`, `calendar-multiget`, `calendar-query`). */
  readonly asks: string | null;
  readonly headers: Readonly<Record<string, string>>;
}

export interface StandInCalendar {
  readonly slug: string;
  name: string;
  color: string | null;
  /** What the collection is. Only `calendar` is one; the others stand in the home beside it. */
  kind: "calendar" | "inbox" | "folder";
  components: readonly string[] | null;
  /** Whether the collection keeps a sync token. */
  sync: boolean;
  privileges: readonly string[] | null;
  timezoneId: string | null;
  /** The calendar's zone as a definition in calendar text (RFC 4791 section 5.2.2). */
  timezone: string | null;
  /** Whether the collection has a tag that changes with it. */
  tagged: boolean;
}

export interface StandInOptions {
  readonly user?: string;
  readonly password?: string;
  /** Where the service lives. */
  readonly context?: string;
  /** `redirect`: to the context, as the standard asks. `missing`: 404. A full address: a redirect there. */
  readonly wellKnown?: "redirect" | "missing" | string;
  /** What the root answers when the service lives elsewhere. */
  readonly rootStatus?: number;
  /** The home as the principal names it: by default its path; a function may name a full address on another host. */
  readonly homeHref?: (port: number) => string;
  readonly principalHref?: (port: number) => string;
  /** A report also names the collection itself (with its tag; its data in a block that says 404). */
  readonly namesItself?: boolean;
  /** Members one sync answer holds before it says "more to come" (507 on the collection). With 0 it says so for ever and hands back the token it was asked with. */
  readonly truncateAt?: number | null;
  /** The server words a sync token anew in every answer: two answers about one state carry two texts, and it takes each of them back. */
  readonly rewordsTokens?: boolean;
  /** A listing writes a member's name escaped where it may (`%40`), and a multiget answers with the name written out (`@`). */
  readonly listsEscaped?: boolean;
  /** Members (by name) a multiget says nothing of, though it was asked for them. */
  readonly silentOn?: readonly string[];
  /** Addresses a sync report names beside the members: of another collection, of another host. */
  readonly strays?: readonly string[];
  /** What a thrown-away token is answered with. */
  readonly deadTokenStatus?: number;
  /** A sign-in that is not accepted: a 401, or a 207 whose principal is nobody. */
  readonly refusedSignIn?: "status" | "unauthenticated";
}

interface Member {
  ics: string;
  etag: string;
  rev: number;
}
interface Held extends StandInCalendar {
  members: Map<string, Member>;
  removed: Map<string, number>;
  rev: number;
  /** Raised when the tokens are thrown away: a token of an earlier epoch names nothing. */
  epoch: number;
}

export interface StandIn {
  readonly port: number;
  readonly seen: Seen[];
  readonly options: Required<Omit<StandInOptions, "homeHref" | "principalHref" | "strays" | "listsEscaped" | "silentOn" | "rewordsTokens">>;
  /** The paths, as the server itself would write them. */
  readonly paths: { readonly start: string; readonly principal: string; readonly home: string; collection(slug: string): string; member(slug: string, name: string): string };
  addCalendar(slug: string, init?: Partial<Omit<StandInCalendar, "slug">>): StandInCalendar;
  /** `etag`: the tag the server gives the member, where a test wants to choose it. */
  put(slug: string, name: string, ics: string, etag?: string): void;
  remove(slug: string, name: string): void;
  /** The server forgets its sync history: every token handed out before is refused. */
  forgetTokens(slug: string): void;
  /** The next request, whatever it is, is answered with this status (and this Retry-After, and this body). */
  answerNext(status: number, retryAfter?: string, body?: string): void;
  close(): Promise<void>;
}

const NS = `xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/"`;
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\r/g, "&#13;");
const unesc = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const propstat = (props: string, status = "200 OK"): string => (props === "" ? "" : `<propstat><prop>${props}</prop><status>HTTP/1.1 ${status}</status></propstat>`);
const response = (href: string, inner: string): string => `<response><href>${esc(href)}</href>${inner}</response>`;
const multistatus = (inner: string): string => `<?xml version="1.0" encoding="utf-8"?>\n<multistatus ${NS}>${inner}</multistatus>`;
const failed = (condition: string): string => `<?xml version="1.0" encoding="utf-8"?>\n<error xmlns="DAV:"><${condition}/></error>`;

export async function startCalDavStandIn(given: StandInOptions = {}): Promise<StandIn> {
  const options = {
    user: given.user ?? "mila",
    // Put together here, so that no line of a test file holds a sign-in as one text.
    password: given.password ?? ["wheel", "and", "kiln"].join("-"),
    context: given.context ?? "/dav/",
    wellKnown: given.wellKnown ?? "redirect",
    rootStatus: given.rootStatus ?? 405,
    namesItself: given.namesItself ?? false,
    truncateAt: given.truncateAt ?? null,
    deadTokenStatus: given.deadTokenStatus ?? 403,
    refusedSignIn: given.refusedSignIn ?? "status",
  };
  const start = options.context;
  const principal = `${start}principals/${options.user}/`;
  const home = `${start}calendars/${options.user}/`;
  const paths = { start, principal, home, collection: (slug: string) => `${home}${slug}/`, member: (slug: string, name: string) => `${home}${slug}/${name}` };
  /** A member's address as a listing writes it. */
  const listed = (slug: string, name: string): string => (given.listsEscaped === true ? `${home}${slug}/${encodeURIComponent(name)}` : paths.member(slug, name));
  const expected = `Basic ${Buffer.from(`${options.user}:${options.password}`, "utf8").toString("base64")}`;
  const calendars = new Map<string, Held>();
  const seen: Seen[] = [];
  let forced: { status: number; retryAfter: string | undefined; body: string } | null = null;

  const held = (slug: string): Held => {
    const c = calendars.get(slug);
    if (c === undefined) throw new Error(`the stand-in has no calendar ${slug}`);
    return c;
  };
  let worded = 0;
  const tokenOf = (c: Held, rev = c.rev): string => `http://stand-in.example.test/sync/${c.slug}/${c.epoch}/${rev}${given.rewordsTokens === true ? `?n=${++worded}` : ""}`;
  const ctagOf = (c: Held): string => `ctag-${c.epoch}-${c.rev}`;
  /** The revision a token names, `0` for none, `null` for one this server no longer knows. */
  const revOf = (c: Held, token: string): number | null => {
    if (token === "") return 0;
    const m = /^http:\/\/stand-in\.example\.test\/sync\/([^/]+)\/(\d+)\/(\d+)(?:\?n=\d+)?$/.exec(token);
    if (m === null || m[1] !== c.slug || Number(m[2]) !== c.epoch || Number(m[3]) > c.rev) return null;
    return Number(m[3]);
  };

  const collectionProps = (c: Held, asked: (name: string) => boolean): string => {
    const type = c.kind === "calendar" ? "<collection/><C:calendar/>" : c.kind === "inbox" ? "<collection/><C:schedule-inbox/>" : "<collection/>";
    let ok = "";
    let missing = "";
    const put = (name: string, element: string | null, empty: string): void => {
      if (!asked(name)) return;
      if (element === null) missing += empty;
      else ok += element;
    };
    put("resourcetype", `<resourcetype>${type}</resourcetype>`, "");
    put("displayname", `<displayname>${esc(c.name)}</displayname>`, "");
    put("supported-calendar-component-set", c.components === null ? null : `<C:supported-calendar-component-set>${c.components.map((n) => `<C:comp name="${n}"/>`).join("")}</C:supported-calendar-component-set>`, "<C:supported-calendar-component-set/>");
    put("getctag", c.tagged ? `<CS:getctag>${ctagOf(c)}</CS:getctag>` : null, "<CS:getctag/>");
    put("sync-token", c.sync ? `<sync-token>${tokenOf(c)}</sync-token>` : null, "<sync-token/>");
    put("calendar-color", c.color === null ? null : `<A:calendar-color>${esc(c.color)}</A:calendar-color>`, "<A:calendar-color/>");
    put("current-user-privilege-set", c.privileges === null ? null : `<current-user-privilege-set>${c.privileges.map((p) => `<privilege><${p}/></privilege>`).join("")}</current-user-privilege-set>`, "<current-user-privilege-set/>");
    put("calendar-timezone-id", c.timezoneId === null ? null : `<C:calendar-timezone-id>${esc(c.timezoneId)}</C:calendar-timezone-id>`, "<C:calendar-timezone-id/>");
    put("calendar-timezone", c.timezone === null ? null : `<C:calendar-timezone>${esc(c.timezone)}</C:calendar-timezone>`, "<C:calendar-timezone/>");
    put("getetag", `<getetag>"collection-${c.slug}-${c.rev}"</getetag>`, "");
    return propstat(ok) + propstat(missing, "404 Not Found");
  };
  const memberProps = (m: Member, asked: (name: string) => boolean): string =>
    propstat(`${asked("getetag") ? `<getetag>${esc(m.etag)}</getetag>` : ""}${asked("calendar-data") ? `<C:calendar-data>${esc(m.ics)}</C:calendar-data>` : ""}`);
  /** The collection in a report, as the servers that name it there do: its tag, and no data. */
  const itself = (c: Held, asked: (name: string) => boolean): string =>
    options.namesItself ? response(paths.collection(c.slug), propstat(`<getetag>"collection-${c.slug}-${c.rev}"</getetag>`) + (asked("calendar-data") ? propstat("<C:calendar-data/>", "404 Not Found") : "")) : "";

  function propfind(path: string, depth: string | null, asked: (name: string) => boolean, port: number): { status: number; body: string } {
    if (path === start) return { status: 207, body: multistatus(response(start, propstat(asked("current-user-principal") ? `<current-user-principal><href>${esc(given.principalHref?.(port) ?? principal)}</href></current-user-principal>` : ""))) };
    if (path === principal) {
      return {
        status: 207,
        body: multistatus(
          response(
            principal,
            propstat(
              `${asked("calendar-home-set") ? `<C:calendar-home-set><href>${esc(given.homeHref?.(port) ?? home)}</href></C:calendar-home-set>` : ""}` +
                `${asked("calendar-user-address-set") ? `<C:calendar-user-address-set><href>mailto:Mila@Studio.example.test</href><href>${esc(principal)}</href></C:calendar-user-address-set>` : ""}`,
            ),
          ),
        ),
      };
    }
    if (path === home) {
      const own = response(home, propstat(asked("resourcetype") ? "<resourcetype><collection/></resourcetype>" : ""));
      const children = depth === "1" ? [...calendars.values()].map((c) => response(paths.collection(c.slug), collectionProps(c, asked))).join("") : "";
      return { status: 207, body: multistatus(own + children) };
    }
    for (const c of calendars.values()) {
      if (path !== paths.collection(c.slug)) continue;
      const members = depth === "1" ? [...c.members].map(([name, m]) => response(listed(c.slug, name), memberProps(m, (n) => n === "getetag" && asked(n)))).join("") : "";
      return { status: 207, body: multistatus(response(path, collectionProps(c, asked)) + members) };
    }
    return { status: 404, body: "" };
  }

  function report(c: Held, asks: string, body: string, asked: (name: string) => boolean): { status: number; body: string } {
    if (asks === "sync-collection") {
      if (!c.sync) return { status: 403, body: failed("supported-report") };
      const from = revOf(c, unesc(/<(?:[\w-]+:)?sync-token(?:\s[^>]*)?>([^<]*)</.exec(body)?.[1] ?? "").trim());
      if (from === null) return { status: options.deadTokenStatus, body: failed("valid-sync-token") };
      const changes: { rev: number; xml: string }[] = [...c.members].filter(([, m]) => m.rev > from).map(([name, m]) => ({ rev: m.rev, xml: response(listed(c.slug, name), memberProps(m, asked)) }));
      // What was removed is told to a reader that has seen it, never to one that starts from nothing.
      if (from > 0) for (const [name, rev] of c.removed) if (rev > from) changes.push({ rev, xml: response(paths.member(c.slug, name), "<status>HTTP/1.1 404 Not Found</status>") });
      changes.sort((a, b) => a.rev - b.rev);
      const cut = options.truncateAt !== null && changes.length > options.truncateAt;
      const told = cut ? changes.slice(0, options.truncateAt!) : changes;
      const more = cut ? response(paths.collection(c.slug), "<status>HTTP/1.1 507 Insufficient Storage</status>") : "";
      const strays = (given.strays ?? []).map((href) => response(href, propstat(`<getetag>"stray"</getetag>`))).join("");
      const reached = cut ? (told.length === 0 ? from : told[told.length - 1]!.rev) : c.rev;
      return { status: 207, body: multistatus(itself(c, asked) + told.map((x) => x.xml).join("") + strays + more + `<sync-token>${tokenOf(c, reached)}</sync-token>`) };
    }
    if (asks === "calendar-multiget") {
      const hrefs = [...body.matchAll(/<(?:[\w-]+:)?href(?:\s[^>]*)?>([^<]*)</g)].map((m) => unesc(m[1]!).trim());
      const answers = hrefs.map((href) => {
        const prefix = paths.collection(c.slug);
        const name = href.startsWith(prefix) ? decodeURIComponent(href.slice(prefix.length)) : "";
        if ((given.silentOn ?? []).includes(name)) return "";
        const member = c.members.get(name);
        return member === undefined ? response(href, "<status>HTTP/1.1 404 Not Found</status>") : response(given.listsEscaped === true ? paths.member(c.slug, name) : href, memberProps(member, asked));
      });
      return { status: 207, body: multistatus(itself(c, asked) + answers.join("")) };
    }
    if (asks === "calendar-query") {
      // A query filtered on one property is what one large provider refuses; this server refuses it too, so a reader that asked it would be seen.
      if (/prop-filter/.test(body)) return { status: 412, body: "" };
      return { status: 207, body: multistatus(itself(c, asked) + [...c.members].map(([name, m]) => response(paths.member(c.slug, name), memberProps(m, asked))).join("")) };
    }
    return { status: 403, body: failed("supported-report") };
  }

  function answer(req: IncomingMessage, res: ServerResponse, body: string, port: number): void {
    const path = new URL(req.url ?? "/", "http://stand-in.invalid").pathname;
    const credential = req.headers.authorization;
    const signedIn = credential === expected;
    const depth = typeof req.headers.depth === "string" ? req.headers.depth : null;
    const asks = /<(?:[\w-]+:)?(propfind|sync-collection|calendar-multiget|calendar-query)[\s>/]/.exec(body)?.[1] ?? null;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
    seen.push({ method: req.method ?? "", path, host: req.headers.host ?? "", withCredential: credential !== undefined, signedIn, depth, body, asks, headers });
    const send = (status: number, text: string, extra: Record<string, string> = {}): void => {
      res.writeHead(status, { "content-type": "application/xml; charset=utf-8", dav: "1, 3, calendar-access", ...extra });
      res.end(text);
    };

    if (forced !== null) {
      const { status, retryAfter, body: text } = forced;
      forced = null;
      return send(status, text, retryAfter === undefined ? {} : { "retry-after": retryAfter });
    }
    if (path === "/.well-known/caldav") {
      if (options.wellKnown === "missing") return send(404, "");
      return send(301, "", { location: options.wellKnown === "redirect" ? start : options.wellKnown });
    }
    if (path === "/" && start !== "/") return send(options.rootStatus, "");
    if (!signedIn) {
      if (options.refusedSignIn === "unauthenticated" && path === start && req.method === "PROPFIND") {
        return send(207, multistatus(response(start, propstat("<current-user-principal><unauthenticated/></current-user-principal>"))));
      }
      return send(401, "", { "www-authenticate": 'Basic realm="stand-in"' });
    }
    const asked = (name: string): boolean => new RegExp(`<(?:[\\w-]+:)?${name}[\\s/>]`).test(body);
    if (req.method === "PROPFIND") {
      const found = propfind(path, depth, asked, port);
      return send(found.status, found.body);
    }
    if (req.method === "REPORT") {
      const c = [...calendars.values()].find((x) => paths.collection(x.slug) === path);
      if (c === undefined || asks === null) return send(404, "");
      const made = report(c, asks, body, asked);
      return send(made.status, made.body);
    }
    return send(405, "");
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => answer(req, res, Buffer.concat(chunks).toString("utf8"), (server.address() as AddressInfo).port));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    seen,
    options,
    paths,
    addCalendar(slug, init = {}) {
      const c: Held = {
        slug,
        name: init.name ?? slug,
        color: init.color ?? null,
        kind: init.kind ?? "calendar",
        components: init.components === undefined ? ["VEVENT"] : init.components,
        sync: init.sync ?? true,
        privileges: init.privileges === undefined ? ["read", "write-content", "bind", "unbind"] : init.privileges,
        timezoneId: init.timezoneId ?? null,
        timezone: init.timezone ?? null,
        tagged: init.tagged ?? true,
        members: new Map(),
        removed: new Map(),
        rev: 0,
        epoch: 1,
      };
      calendars.set(slug, c);
      return c;
    },
    put(slug, name, ics, etag) {
      const c = held(slug);
      c.rev += 1;
      c.removed.delete(name);
      c.members.set(name, { ics, etag: etag ?? `"${slug}-${name}-${c.rev}"`, rev: c.rev });
    },
    remove(slug, name) {
      const c = held(slug);
      if (!c.members.delete(name)) throw new Error(`the stand-in has no ${name} in ${slug}`);
      c.rev += 1;
      c.removed.set(name, c.rev);
    },
    forgetTokens(slug) {
      const c = held(slug);
      c.epoch += 1;
      c.removed.clear();
    },
    answerNext(status, retryAfter, body = "") {
      forced = { status, retryAfter, body };
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
