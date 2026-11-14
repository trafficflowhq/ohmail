/**
 * The multistatus reader: a WebDAV answer read as data, under bounds. Read on the recorded answers of two
 * servers that write the same thing in two ways, and on what a stranger's server may send instead.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APPLE_ICAL, CALDAV, CALENDARSERVER, DAV, MULTISTATUS_LIMITS, childOf, childrenOf, propOf, readMultistatus, type DavResponse, type Multistatus } from "../src/caldav/multistatus.js";
import { MAX_MULTISTATUS_DEPTH, MAX_MULTISTATUS_RESPONSES } from "../src/limits.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "support", "fixtures");
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const recorded = (server: string, name: string): Uint8Array =>
  bytes((JSON.parse(readFileSync(join(FIXTURES, server, `${name}.json`), "utf8")) as { response: { body: string } }).response.body);

function read(body: Uint8Array | string, limits = MULTISTATUS_LIMITS): Multistatus {
  const result = readMultistatus(typeof body === "string" ? bytes(body) : body, limits);
  if (!result.ok) throw new Error(`not read: ${result.reason}`);
  return result.value;
}
const refusal = (body: string, limits = MULTISTATUS_LIMITS): string => {
  const result = readMultistatus(bytes(body), limits);
  return result.ok ? "read" : result.reason;
};
const text = (r: DavResponse, ns: string, local: string): string | null => propOf(r, ns, local)?.text ?? null;
const dav = (inner: string): string => `<?xml version="1.0" encoding="utf-8"?><multistatus xmlns="DAV:">${inner}</multistatus>`;
const member = (href: string, props: string, status = "HTTP/1.1 200 OK"): string => `<response><href>${href}</href><propstat><prop>${props}</prop><status>${status}</status></propstat></response>`;

const CALENDAR = "ohmail-bench-r2-cal-accounts-20261113";
// The same five events at both servers; each lists them in its own order and numbers its own tags.
const SERVERS = [
  { name: "bench", home: "/bench/", listed: ["stall-planning-call", "wheel-class", "glaze-firing", "catalogue-proofs", "market-day"], itself: 0 },
  { name: "icloud", home: "/principal-1/calendars/", listed: ["catalogue-proofs", "glaze-firing", "market-day", "stall-planning-call", "wheel-class"], itself: 1 },
] as const;

describe.each(SERVERS)("the recorded answers of $name", ({ name, home, listed, itself }) => {
  const collection = `${home}${CALENDAR}/`;
  const tags = (from: number) => listed.map((_, i) => `"etag-${from + i}"`);

  it("the home: one calendar with its name, what it takes, its tag and its token", () => {
    const { responses, syncToken } = read(recorded(name, "home-collections"));
    expect(responses.map((r) => r.href)).toEqual([collection]);
    const calendar = responses[0]!;
    const type = propOf(calendar, DAV, "resourcetype")!;
    expect(childOf(type, CALDAV, "calendar")).not.toBeNull();
    expect(childOf(type, DAV, "collection")).not.toBeNull();
    expect(text(calendar, DAV, "displayname")).toBe(CALENDAR);
    expect(childrenOf(propOf(calendar, CALDAV, "supported-calendar-component-set")!, CALDAV, "comp").map((c) => c.attributes.get("name"))).toEqual(["VEVENT"]);
    expect(text(calendar, CALENDARSERVER, "getctag")).toBe("ctag-1");
    expect(text(calendar, DAV, "sync-token")).toBe("sync-1");
    // A property nobody asked for is not there, and the answer itself names no token.
    expect(propOf(calendar, APPLE_ICAL, "calendar-color")).toBeNull();
    expect(syncToken).toBeNull();
  });

  it("the first sync report: every member with its tag, and the token wherever the server writes it", () => {
    const { responses, syncToken } = read(recorded(name, "sync-collection-first"));
    expect(syncToken).toBe("sync-1");
    const members = responses.filter((r) => r.href !== collection);
    expect(responses.length - members.length).toBe(itself);
    expect(members.map((r) => r.href)).toEqual(listed.map((slug) => `${collection}${slug}.ics`));
    expect(members.map((r) => text(r, DAV, "getetag"))).toEqual(tags(1 + itself));
    expect(members.map((r) => r.status)).toEqual(listed.map(() => null));
  });

  it("the report with its data: each member's text whole, with the line ends the server wrote", () => {
    const { responses } = read(recorded(name, "calendar-query-with-data"));
    const members = responses.filter((r) => r.href !== collection);
    expect(responses.length - members.length).toBe(itself);
    expect(members.map((r) => text(r, DAV, "getetag"))).toEqual(tags(1 + itself));
    for (const r of members) {
      const data = text(r, CALDAV, "calendar-data")!;
      expect(data.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
      expect(data.trimEnd().endsWith("\r\nEND:VCALENDAR")).toBe(true);
      expect(data).not.toContain("&");
      expect(data).not.toContain("<");
    }
    const series = text(members[listed.indexOf("wheel-class")]!, CALDAV, "calendar-data")!;
    expect(series.split("BEGIN:VEVENT").length - 1).toBe(2);
    expect(series).toContain("\r\nRECURRENCE-ID;TZID=Europe/Zurich:20261201T180000\r\n");
    // An escaped comma of the calendar format is not an escape of this one.
    expect(text(members[listed.indexOf("catalogue-proofs")]!, CALDAV, "calendar-data")).toContain("proofs\\, page by page.");
  });
});

describe("what a block's status decides", () => {
  it("the collection a report names beside its members has its data in a block that says 404: it has none", () => {
    const itself = read(recorded("icloud", "calendar-query-with-data")).responses[0]!;
    expect(itself.href).toBe(`/principal-1/calendars/${CALENDAR}/`);
    expect(itself.propstats.map((p) => p.status)).toEqual([200, 404]);
    expect(text(itself, DAV, "getetag")).toBe('"etag-1"');
    expect(propOf(itself, CALDAV, "calendar-data")).toBeNull();
  });

  it("a property counts only where its block says 200", () => {
    const [missing, there, unsaid] = read(
      dav(
        member("/c/a.ics", "<getetag>x</getetag>", "HTTP/1.1 404 Not Found") +
          member("/c/b.ics", "<getetag>y</getetag>") +
          "<response><href>/c/c.ics</href><propstat><prop><getetag>z</getetag></prop></propstat></response>" +
          member("/c/d.ics", "<getetag>w</getetag>", "200 OK"),
      ),
    ).responses;
    expect(propOf(missing!, DAV, "getetag")).toBeNull();
    expect(text(there!, DAV, "getetag")).toBe("y");
    expect(propOf(unsaid!, DAV, "getetag")).toBeNull();
    expect(read(dav(member("/c/d.ics", "<getetag>w</getetag>", "200 OK"))).responses[0]!.propstats[0]!.status).toBe(0);
  });

  it("a member a sync report names as removed, and the sign that more is to come, are the response's own status", () => {
    const { responses, syncToken } = read(
      dav(
        "<response><href>/c/gone.ics</href><status>HTTP/1.1 404 Not Found</status></response>" +
          member("/c/kept.ics", '<getetag>"k"</getetag>') +
          "<response><href>/c/</href><status>HTTP/1.1 507 Insufficient Storage</status></response>" +
          "<sync-token>http://sync.example/ns/7</sync-token>",
      ),
    );
    expect(responses.map((r) => [r.href, r.status])).toEqual([["/c/gone.ics", 404], ["/c/kept.ics", null], ["/c/", 507]]);
    expect(syncToken).toBe("http://sync.example/ns/7");
  });

  it("a response that names several members with one status is one response for each", () => {
    const { responses } = read(dav("<response><href>/c/a.ics</href><href> /c/b.ics </href><status>HTTP/1.1 404 Not Found</status></response>"));
    expect(responses.map((r) => [r.href, r.status])).toEqual([["/c/a.ics", 404], ["/c/b.ics", 404]]);
  });
});

describe("what is written is read as written", () => {
  it("an empty element is empty, and takes nothing of the member after it", () => {
    const { responses } = read(
      `<multistatus xmlns="DAV:"><response><href>/c/</href><propstat><prop><calendar-data xmlns="urn:ietf:params:xml:ns:caldav"/><getetag/></prop><status>HTTP/1.1 200 OK</status></propstat></response>` +
        `<response><href>/c/a.ics</href><propstat><prop><calendar-data xmlns="urn:ietf:params:xml:ns:caldav">BEGIN:VCALENDAR</calendar-data><getetag>"a"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`,
    );
    expect(responses.map((r) => [r.href, text(r, CALDAV, "calendar-data"), text(r, DAV, "getetag")])).toEqual([["/c/", "", ""], ["/c/a.ics", "BEGIN:VCALENDAR", '"a"']]);
  });

  it("a name belongs to the namespace its prefix is bound to, wherever that is declared", () => {
    const { responses, syncToken } = read(
      `<x:multistatus xmlns:x="DAV:" xmlns:y="urn:ietf:params:xml:ns:caldav">` +
        `<x:response><x:href>/c/a.ics</x:href><x:propstat><x:prop><x:getetag>"a"</x:getetag><y:calendar-data>A</y:calendar-data><getetag xmlns="urn:example:other">no</getetag><z:getetag>unbound</z:getetag></x:prop><x:status>HTTP/1.1 200 OK</x:status></x:propstat></x:response>` +
        // The same prefix bound to another namespace inside one element: its members are not ours.
        `<x:response xmlns:x="urn:example:other"><x:href>/c/b.ics</x:href></x:response>` +
        `<response xmlns="DAV:"><href>/c/c.ics</href><propstat><prop><D:getetag xmlns:D="DAV:">"c"</D:getetag></prop><status>HTTP/1.1 200 OK</status></propstat></response>` +
        `<x:sync-token>t-1</x:sync-token></x:multistatus>`,
    );
    expect(responses.map((r) => r.href)).toEqual(["/c/a.ics", "/c/c.ics"]);
    expect(text(responses[0]!, DAV, "getetag")).toBe('"a"');
    expect(text(responses[0]!, CALDAV, "calendar-data")).toBe("A");
    expect(responses[0]!.propstats[0]!.props.map((p) => [p.ns, p.local])).toEqual([[DAV, "getetag"], [CALDAV, "calendar-data"], ["urn:example:other", "getetag"], ["", "z:getetag"]]);
    expect(text(responses[1]!, DAV, "getetag")).toBe('"c"');
    expect(syncToken).toBe("t-1");
  });

  it("character references are read, and an entity of the document's own making stays the letters it is", () => {
    const only = read(dav(member("/c/a%20b.ics", `<displayname>Tom &amp; Jerry &lt;3 &#13;&#x41;&apos;&quot; &own; &nbsp;</displayname>`))).responses[0]!;
    expect(text(only, DAV, "displayname")).toBe("Tom & Jerry <3 \rA'\" &own; &nbsp;");
    expect(only.href).toBe("/c/a%20b.ics");
  });

  it("a section of plain text is text, whatever it holds", () => {
    const data = "BEGIN:VCALENDAR\r\nX-ALT-DESC;FMTTYPE=text/html:<!DOCTYPE HTML PUBLIC \"-//W3C//DTD HTML 3.2//EN\"><HTML><!ENTITY x>&amp;</HTML>\r\nEND:VCALENDAR\r\n";
    const only = read(`<!-- a note: <!DOCTYPE is no word here --><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${`<D:response><D:href>/c/a.ics</D:href><D:propstat><D:prop><C:calendar-data><![CDATA[${data}]]></C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`}</D:multistatus>`).responses[0]!;
    expect(text(only, CALDAV, "calendar-data")).toBe(data);
  });

  it("a byte order mark and a stylesheet line before the answer change nothing", () => {
    const body = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(`<?xml version="1.0"?><?xml-stylesheet href="x.xsl"?><multistatus xmlns="DAV:">${member("/c/ü.ics", "<getetag>é</getetag>")}</multistatus>`)]);
    const { responses } = read(body);
    expect(responses.map((r) => [r.href, text(r, DAV, "getetag")])).toEqual([["/c/ü.ics", "é"]]);
  });
});

describe("what is refused, by word", () => {
  const laughs =
    `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">]>` +
    `<multistatus xmlns="DAV:"><response><href>/c/a.ics</href><propstat><prop><displayname>&lol2;</displayname></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;

  it.each([
    ["a document type before the answer", `<!DOCTYPE multistatus SYSTEM "http://127.0.0.1/x.dtd">${dav("")}`],
    ["a document type in small letters", `<!doctype multistatus>${dav("")}`],
    ["entities of the document's own", laughs],
    ["an entity declared with no document type around it", dav(`<!ENTITY x SYSTEM "file:///etc/hostname">`)],
    ["a document type hidden behind a comment that opens a text section", `<!-- <![CDATA[ --><!DOCTYPE x [<!ENTITY y "z">]>${dav("")}<!-- ]]> -->`],
    // No reader of markup takes these letters as a value here; the text is refused before any reader sees it.
    ["a document type written where a value stands", dav(`<response note="<!DOCTYPE x [<!ENTITY y 'z'>]>"><href>/c/a.ics</href></response>`)],
    ["a declaration of another kind", dav(`<!ELEMENT response ANY>`)],
    ["a page that is no multistatus", "<html><body><h1>Sign in</h1></body></html>"],
    ["a multistatus of another namespace", `<multistatus xmlns="urn:example:other"></multistatus>`],
    ["nothing", ""],
    ["text and no element", "207 Multi-Status"],
    ["an answer cut off", dav(member("/c/a.ics", "<getetag>a</getetag>")).slice(0, -30)],
    ["an element closed by its parent's end", dav(`<response><href>/c/a.ics</href><propstat><prop><getetag>a</prop><status>HTTP/1.1 200 OK</status></propstat></response>`)],
    ["a second answer after the first", `${dav("")}<multistatus xmlns="DAV:"></multistatus>`],
  ])("%s: unreadable", (_what, body) => {
    expect(refusal(body)).toBe("unreadable");
  });

  it("an element that opens and is closed at once by its parent is the empty element it reads as", () => {
    expect(read(dav(`<response><href>/c/a.ics</href><propstat><prop><getetag></prop><status>HTTP/1.1 200 OK</status></propstat></response>`)).responses.map((r) => text(r, DAV, "getetag"))).toEqual([""]);
  });

  it("nesting past the ceiling: too_large, and the rest is not walked", () => {
    const nested = (depth: number) => dav(member("/c/a.ics", `${"<a>".repeat(depth)}${"</a>".repeat(depth)}`));
    // multistatus, response, propstat, prop: four above the property.
    expect(MAX_MULTISTATUS_DEPTH).toBe(32);
    expect(refusal(nested(28))).toBe("read");
    expect(refusal(nested(29))).toBe("too_large");
    // 2,000,000 open elements: a reader that walked them all would not come back inside this test's time.
    expect(refusal(`<multistatus xmlns="DAV:">${"<a>".repeat(2_000_000)}`)).toBe("too_large");
  });

  it("more responses than the ceiling: too_large", () => {
    const many = (n: number) => dav("<response><href>/</href></response>".repeat(n));
    expect(read(many(3), { ...MULTISTATUS_LIMITS, maxResponses: 3 }).responses).toHaveLength(3);
    expect(refusal(many(4), { ...MULTISTATUS_LIMITS, maxResponses: 3 })).toBe("too_large");
    expect(MAX_MULTISTATUS_RESPONSES).toBe(100_000);
    expect(refusal(many(MAX_MULTISTATUS_RESPONSES + 1))).toBe("too_large");
  });

  it("more elements and attributes than the ceiling: too_large", () => {
    // multistatus and its attribute, then response, href, propstat, prop, status and two properties: 9 parts.
    const one = dav(member("/c/a.ics", "<getetag>a</getetag><displayname>b</displayname>"));
    expect(refusal(one, { ...MULTISTATUS_LIMITS, maxParts: 9 })).toBe("read");
    expect(refusal(one, { ...MULTISTATUS_LIMITS, maxParts: 8 })).toBe("too_large");
    const attributes = dav(member("/c/a.ics", `<comp ${Array.from({ length: 50 }, (_, i) => `a${i}="1"`).join(" ")}/>`));
    // Seven elements, the namespace's attribute and the fifty.
    expect(refusal(attributes, { ...MULTISTATUS_LIMITS, maxParts: 58 })).toBe("read");
    expect(refusal(attributes, { ...MULTISTATUS_LIMITS, maxParts: 57 })).toBe("too_large");
  });
});
