/**
 * A typed address, read: what a person types to reach a calendar, as the two readers ask it and
 * as a door that takes it checks it. Shapes only: nothing here looks a name up or opens a socket.
 * Where a name leads is decided at the dial, by the request port, for every request and redirect.
 */
import { canonicalHost } from "@trafficflow/core/net";
import { MAX_URL_CHARS } from "./limits.js";
import { shapeRefusal, type AddressPolicy, type ShapeRefusal } from "./request/shape.js";

/** Apple's own address of its calendar service: where the way "iCloud" starts. A person types none. */
export const ICLOUD_CALDAV_START = "https://caldav.icloud.com/";

/** What a person typed for a CalDAV server, read: the host the sign-in belongs to, and the addresses to start at, in order. */
export interface Typed {
  readonly host: string;
  readonly starts: readonly string[];
  /** The same starts over TLS, for an address typed without it: asked only when the request port does not allow the plain ones. */
  readonly secured: readonly string[] | null;
}

const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
/** A mail address and nothing else: its domain is the host to ask. */
const MAIL_ADDRESS = /^[^\s@/:?#]+@([^\s@/:?#]+)$/;
const WELL_KNOWN = "/.well-known/caldav";
const FEED_SCHEME = /^(webcals?|https?):\/\//i;

function parse(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    // No address: answered as one that is invalid. The text is never kept: it may be a secret.
    return null;
  }
}

function startsOf(url: URL): string[] {
  const typed = url.pathname === "/" ? [] : [`${url.origin}${url.pathname}${url.search}`];
  return [...new Set([...typed, `${url.origin}${WELL_KNOWN}`, `${url.origin}/`])];
}

/** The typed text as one address: a host alone is asked over TLS, a mail address gives its domain. `null` for none. */
function serverAddress(typed: string): URL | null {
  const text = typed.trim();
  if (text === "" || text.length > MAX_URL_CHARS) return null;
  const written = ANY_SCHEME.test(text);
  const mail = written ? null : MAIL_ADDRESS.exec(text);
  const url = parse(mail !== null ? `https://${mail[1]}/` : written ? text : `https://${text}`);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  return url.username !== "" || url.password !== "" ? null : url;
}

/**
 * The typed address as the starts to ask. A host alone is asked over TLS; a mail address gives its
 * domain; an address with a user or a password in it, or of another scheme, is none (`null`).
 */
export function typedAddress(typed: string): Typed | null {
  const url = serverAddress(typed);
  if (url === null) return null;
  let secured: string[] | null = null;
  if (url.protocol === "http:") {
    const over = new URL(url.href);
    over.protocol = "https:";
    secured = startsOf(over);
  }
  return { host: url.hostname, starts: startsOf(url), secured };
}

/**
 * The addresses to ask for a subscription as typed, in order; `null` for what is no address of a
 * calendar. `webcal` only ever meant "fetch this and subscribe", and is asked over https. An address
 * typed with http is asked as typed first: the request port lets that through for a person's own
 * server on the person's own network and for nothing else, and then it is asked over https.
 */
export function subscriptionAddresses(typed: string): readonly string[] | null {
  if (typed.length > MAX_URL_CHARS) return null;
  const address = typed.trim();
  const scheme = FEED_SCHEME.exec(address);
  if (scheme === null) return null;
  const rest = address.slice(scheme[0].length);
  return scheme[1]!.toLowerCase() === "http" ? [`http://${rest}`, `https://${rest}`] : [`https://${rest}`];
}

/** A typed address as a door keeps it: the bare host, and for a CalDAV server the address to start at. */
export type TypedAddressReading =
  | { readonly ok: true; readonly host: string; readonly start: string | null }
  | { readonly ok: false; readonly reason: ShapeRefusal };

const refused = (reason: ShapeRefusal): TypedAddressReading => ({ ok: false, reason });

/**
 * A typed address checked by its shape, for a door that takes it and dials nothing. The address
 * is read as typed: no second form of it is tried here, so one this deployment does not ask as it
 * was written is refused, and a person writes the one it does.
 *
 * `caldav`: `start` is the server's origin and path, with the scheme it was typed with (https for
 * a host alone or a mail address). An address with a query or a fragment is none: a start is kept
 * in the clear, and neither belongs to a server's address. `ics`: `start` is `null`; the address is
 * a secret and only its host is handed back.
 */
export function readTypedAddress(
  way: "caldav" | "ics",
  typed: string,
  policy: AddressPolicy,
): TypedAddressReading {
  let url: URL | null;
  if (way === "caldav") {
    url = serverAddress(typed);
    if (url !== null && (url.search !== "" || url.hash !== "")) return refused("address_invalid");
  } else {
    const asked = subscriptionAddresses(typed);
    url = asked === null ? null : parse(asked[0]!);
  }
  if (url === null) return refused("address_invalid");
  const shape = shapeRefusal(url, policy, null);
  if (shape !== null) return refused(shape);
  return {
    ok: true,
    host: canonicalHost(url.hostname),
    start: way === "caldav" ? `${url.origin}${url.pathname}` : null,
  };
}
