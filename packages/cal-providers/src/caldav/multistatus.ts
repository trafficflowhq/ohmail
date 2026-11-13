/**
 * A WebDAV multistatus answer (RFC 4918 section 13) read as data, under bounds. The text is a
 * stranger's: the server is one a person named.
 *
 * What is read: every response with its address, its own status and its property blocks, each block
 * with the status it states; and the token a sync report hands back. Names are resolved to their
 * namespaces, so a server may write its prefixes and its default namespace as it likes.
 *
 * What is refused, by word and whole: a document that declares types or entities of its own, one
 * that is not a multistatus, one that ends before its elements do, and one past a ceiling. Nothing
 * is expanded beyond the five entities XML has and character references; nothing outside the text
 * is ever fetched.
 */
import { Parser } from "htmlparser2";
import { MAX_MULTISTATUS_DEPTH, MAX_MULTISTATUS_RESPONSES } from "../limits.js";

export const DAV = "DAV:";
export const CALDAV = "urn:ietf:params:xml:ns:caldav";
export const CALENDARSERVER = "http://calendarserver.org/ns/";
export const APPLE_ICAL = "http://apple.com/ns/ical/";

/**
 * Elements and attributes of one answer, counted together: each becomes an object or a string of
 * its own, so it is this count and not the size of the text that the answer weighs once read. The
 * most compact listing a server writes is six elements a member in about 125 bytes; at the fetch's
 * ceiling of 8 MiB that is 67,000 members and 400,000 parts.
 */
export const MAX_MULTISTATUS_PARTS = 600_000;

export interface MultistatusLimits {
  readonly maxDepth: number;
  readonly maxResponses: number;
  readonly maxParts: number;
}
export const MULTISTATUS_LIMITS: MultistatusLimits = { maxDepth: MAX_MULTISTATUS_DEPTH, maxResponses: MAX_MULTISTATUS_RESPONSES, maxParts: MAX_MULTISTATUS_PARTS };

/** A property, or an element inside one. */
export interface XmlElement {
  /** The namespace the name is bound to; empty for none, and for a prefix nothing declares (`local` is then the name as written). */
  readonly ns: string;
  readonly local: string;
  /** By name as written; namespace declarations are not among them. */
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: readonly XmlElement[];
  /** The element's own text, as written between its tags (its children's is theirs). */
  readonly text: string;
}
export interface DavPropstat {
  /** The block's status; 0 when it states none that can be read. */
  readonly status: number;
  readonly props: readonly XmlElement[];
}
export interface DavResponse {
  /** As written, without the space around it. */
  readonly href: string;
  /** The response's own status: 404 for a member a sync report names as removed, 507 where more is to come. */
  readonly status: number | null;
  readonly propstats: readonly DavPropstat[];
}
export interface Multistatus {
  readonly responses: readonly DavResponse[];
  /** The token a sync report answers with (RFC 6578 section 6.4), wherever in the answer it stands. */
  readonly syncToken: string | null;
}
export type MultistatusRefusal = "unreadable" | "too_large";
export type ReadMultistatus = { readonly ok: true; readonly value: Multistatus } | { readonly ok: false; readonly reason: MultistatusRefusal };

/** The property of that name, from a block that says 200 and from no other (RFC 4918 section 9.1). */
export function propOf(response: DavResponse, ns: string, local: string): XmlElement | null {
  for (const block of response.propstats) {
    if (block.status !== 200) continue;
    for (const p of block.props) if (p.local === local && p.ns === ns) return p;
  }
  return null;
}
export const childrenOf = (e: XmlElement, ns: string, local: string): XmlElement[] => e.children.filter((c) => c.local === local && c.ns === ns);
export const childOf = (e: XmlElement, ns: string, local: string): XmlElement | null => e.children.find((c) => c.local === local && c.ns === ns) ?? null;

/** The three digits of a status line (`HTTP/1.1 200 OK`), or 0 for anything else. */
function statusOf(line: string): number {
  const text = line.trim();
  const space = text.indexOf(" ");
  if (!text.startsWith("HTTP/") || space === -1) return 0;
  let at = space;
  while (text.charCodeAt(at) === 32) at++;
  const end = at + 3;
  if (end > text.length || (end < text.length && text.charCodeAt(end) !== 32)) return 0;
  let code = 0;
  for (let i = at; i < end; i++) {
    const digit = text.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return 0;
    code = code * 10 + digit;
  }
  return code;
}

/**
 * Does the text declare a document type or an entity? Read outside comments and outside sections
 * of plain text only: there the same letters are data for every reader of XML, and a calendar
 * object a server carries in such a section may hold them (a description written as a web page
 * begins with that very word).
 */
function declaresTypes(text: string): boolean {
  const marks = /<!(?:--|\[CDATA\[|[dD][oO][cC][tT][yY][pP][eE]|[eE][nN][tT][iI][tT][yY])/g;
  for (;;) {
    const found = marks.exec(text);
    if (found === null) return false;
    const close = found[0] === "<!--" ? "-->" : found[0] === "<![CDATA[" ? "]]>" : null;
    if (close === null) return true;
    const end = text.indexOf(close, marks.lastIndex);
    if (end === -1) return false;
    marks.lastIndex = end + close.length;
  }
}

type Role = "root" | "response" | "href" | "status" | "propstat" | "blockStatus" | "prop" | "property" | "token" | "skip";
interface Building {
  ns: string;
  local: string;
  attributes: ReadonlyMap<string, string>;
  children: Building[];
  text: string;
}
interface Frame {
  readonly role: Role;
  /** The namespaces this element declares: prefix to name, the default under "". */
  readonly declared: Map<string, string> | null;
  readonly node: Building | null;
  /** Its text in the pieces the reader hands over, joined once at its end. */
  readonly pieces: string[] | null;
}
interface OpenBlock {
  status: number;
  props: Building[];
}
interface OpenResponse {
  hrefs: string[];
  status: number | null;
  propstats: OpenBlock[];
}
/** Where the reading stands. */
interface Reading {
  syncToken: string | null;
  refused: MultistatusRefusal | null;
  parts: number;
  rootSeen: boolean;
  rootClosed: boolean;
  /** The element opened by the event before this one: only such a one may be closed without its own end tag (`<a/>`). */
  justOpened: boolean;
  /** Set once the whole text is handed over: an element still open then never ended. */
  finishing: boolean;
  response: OpenResponse | null;
  block: OpenBlock | null;
}

const NO_ATTRIBUTES: ReadonlyMap<string, string> = new Map();

/** The answer's bytes are read as UTF-8, a byte order mark left off; no other encoding is honoured. */
export function readMultistatus(body: Uint8Array, limits: MultistatusLimits = MULTISTATUS_LIMITS): ReadMultistatus {
  const text = new TextDecoder("utf-8").decode(body);
  if (declaresTypes(text)) return { ok: false, reason: "unreadable" };

  const frames: Frame[] = [];
  const responses: DavResponse[] = [];
  const at: Reading = { syncToken: null, refused: null, parts: 0, rootSeen: false, rootClosed: false, justOpened: false, finishing: false, response: null, block: null };

  const refuse = (reason: MultistatusRefusal): void => {
    at.refused ??= reason;
    parser.pause();
  };
  const count = (): boolean => {
    if (++at.parts <= limits.maxParts) return true;
    refuse("too_large");
    return false;
  };
  const bound = (prefix: string, own: Map<string, string> | null): string | undefined => {
    const mine = own?.get(prefix);
    if (mine !== undefined) return mine;
    for (let i = frames.length - 1; i >= 0; i--) {
      const outer = frames[i]!.declared?.get(prefix);
      if (outer !== undefined) return outer;
    }
    return undefined;
  };

  const parser = new Parser(
    {
      onattribute() {
        if (at.refused === null) count();
      },
      onopentag(name, attribs) {
        if (at.refused !== null || !count()) return;
        at.justOpened = true;
        if (frames.length >= limits.maxDepth) return refuse("too_large");

        let declared: Map<string, string> | null = null;
        let attributes: Map<string, string> | null = null;
        for (const key of Object.keys(attribs)) {
          if (key === "xmlns") (declared ??= new Map()).set("", attribs[key]!);
          else if (key.startsWith("xmlns:")) (declared ??= new Map()).set(key.slice(6), attribs[key]!);
          else (attributes ??= new Map()).set(key, attribs[key]!);
        }
        const colon = name.indexOf(":");
        const prefix = colon === -1 ? "" : name.slice(0, colon);
        const ns = bound(prefix, declared);
        // A prefix nothing declares names no namespace: the element keeps its written name and matches nothing asked for.
        const local = ns === undefined ? name : name.slice(colon + 1);
        const is = (wanted: string): boolean => ns === DAV && local === wanted;

        const parent = frames.length === 0 ? null : frames[frames.length - 1]!;
        let role: Role = "skip";
        let node: Building | null = null;
        if (parent === null) {
          if (at.rootSeen || !is("multistatus")) return refuse("unreadable");
          at.rootSeen = true;
          role = "root";
        } else if (parent.role === "root") {
          if (is("response")) {
            if (responses.length >= limits.maxResponses) return refuse("too_large");
            role = "response";
            at.response = { hrefs: [], status: null, propstats: [] };
          } else if (is("sync-token")) role = "token";
        } else if (parent.role === "response") {
          if (is("href")) role = "href";
          else if (is("status")) role = "status";
          else if (is("propstat")) {
            role = "propstat";
            at.block = { status: 0, props: [] };
          }
        } else if (parent.role === "propstat") {
          if (is("prop")) role = "prop";
          else if (is("status")) role = "blockStatus";
        } else if (parent.role === "prop" || parent.role === "property") {
          role = "property";
          node = { ns: ns ?? "", local, attributes: attributes ?? NO_ATTRIBUTES, children: [], text: "" };
          if (parent.node !== null) parent.node.children.push(node);
          else at.block!.props.push(node);
        }
        const hasText = role === "href" || role === "status" || role === "blockStatus" || role === "property" || role === "token";
        frames.push({ role, declared, node, pieces: hasText ? [] : null });
      },
      ontext(data) {
        if (at.refused !== null) return;
        at.justOpened = false;
        if (frames.length > 0) frames[frames.length - 1]!.pieces?.push(data);
      },
      onclosetag(_name, implied) {
        if (at.refused !== null) return;
        // Closed by another element's end tag after holding something, or by the end of the text: it never ended.
        if (at.finishing || (implied && !at.justOpened)) return refuse("unreadable");
        at.justOpened = false;
        const frame = frames.pop()!;
        const own = frame.pieces === null ? "" : frame.pieces.length === 1 ? frame.pieces[0]! : frame.pieces.join("");
        switch (frame.role) {
          case "href":
            at.response!.hrefs.push(own.trim());
            break;
          case "status":
            at.response!.status = statusOf(own);
            break;
          case "blockStatus":
            at.block!.status = statusOf(own);
            break;
          case "propstat":
            at.response!.propstats.push(at.block!);
            at.block = null;
            break;
          case "property":
            frame.node!.text = own;
            break;
          case "token":
            at.syncToken = own.trim();
            break;
          case "response": {
            // Several addresses under one status (RFC 4918 section 14.24) are one response for each.
            const { hrefs, status, propstats } = at.response!;
            at.response = null;
            if (responses.length + hrefs.length > limits.maxResponses) return refuse("too_large");
            for (const href of hrefs) responses.push({ href, status, propstats });
            break;
          }
          case "root":
            at.rootClosed = true;
            break;
          default:
            break;
        }
      },
      onprocessinginstruction(name) {
        // `<?xml ...?>` and its like are nothing; a declaration (`<!...>`) that came this far is one too many.
        if (at.refused === null && name.startsWith("!")) refuse("unreadable");
      },
    },
    { xmlMode: true, decodeEntities: true },
  );

  parser.write(text);
  if (at.refused === null) {
    at.finishing = true;
    parser.end();
  }
  if (at.refused !== null) return { ok: false, reason: at.refused };
  if (!at.rootClosed) return { ok: false, reason: "unreadable" };
  return { ok: true, value: { responses, syncToken: at.syncToken } };
}
