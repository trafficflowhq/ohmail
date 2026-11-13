/**
 * Where Microsoft Graph is reached, and which of its own links may be followed.
 *
 * The base is a setting of the composing program; `MS_GRAPH_BASE` is the value it names for
 * Microsoft itself, and nothing here falls back to it. Graph hands out whole addresses for a next
 * page and for the next reading: one is followed only when it lies under the base it was asked at.
 */
import { canonicalHost } from "@trafficflow/core/net";
import { MAX_URL_CHARS } from "../limits.js";

/** Microsoft's own address of Graph. A program that reads Microsoft's calendar names it; a bench names its double's. */
export const MS_GRAPH_BASE = "https://graph.microsoft.com/v1.0";
/** Where Microsoft's sign-in is traded. No trade is made in this package; the host is named for the request port's list. */
export const MS_SIGN_IN_HOST = "login.microsoftonline.com";
/** The calendar's permission and the one that keeps a sign-in. Mail's permissions are another list and are not asked for here. */
export const MS_GRAPH_CALENDAR_SCOPE = "Calendars.ReadWrite offline_access";

export interface GraphBase {
  /** The base as it is written into an address: no slash at its end. */
  readonly href: string;
  readonly origin: string;
  /** As the request port asks about it: in lower case, without a root dot. */
  readonly host: string;
  readonly path: string;
}

/** The base taken apart. One that is no address of a service is a fault of the composing program, and thrown. */
export function graphBaseOf(base: string): GraphBase {
  const url = base.length <= MAX_URL_CHARS && URL.canParse(base) ? new URL(base) : null;
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("the Graph base is an http(s) address with no sign-in, query or fragment in it");
  }
  let path = url.pathname;
  while (path.endsWith("/")) path = path.slice(0, -1);
  return { href: url.origin + path, origin: url.origin, host: canonicalHost(url.hostname), path };
}

/** Every host a request for Microsoft's calendar may name: what the composing program builds the fixed-host request port from. */
export const microsoftHosts = (base: string): ReadonlySet<string> => new Set([graphBaseOf(base).host, MS_SIGN_IN_HOST]);

/**
 * Is this link one of the base's own? Same scheme, host and port, and a path under the base's. The
 * link is read as an address first, so a path that climbs out (`/v1.0/../beta`) is judged where it ends.
 */
export function insideBase(link: string, base: GraphBase): boolean {
  if (link.length > MAX_URL_CHARS || !URL.canParse(link)) return false;
  const url = new URL(link);
  return url.origin === base.origin && url.username === "" && url.password === "" && url.pathname.startsWith(`${base.path}/`);
}
