/**
 * WHERE A PASSWORD SEALED FOR ONE CALDAV SERVER MAY TRAVEL, AND FOR HOW LONG THAT IS KNOWN.
 *
 * To the sealed server's own origin: the scheme, host and port it was typed with (and, for an
 * address typed without TLS, the same address over TLS, which the discovery itself turns to). And
 * to an origin THAT SERVER NAMED IN THIS TURN, in one of three answers and in no other:
 *
 *   - a redirect answered to a request of the discovery (a start, the principal, a home named by the principal): the standard's
 *     own way for a server to say where its service lives (RFC 6764);
 *   - the address of the signed-in person's own resources, in a start's answer (RFC 5397);
 *   - the addresses of that person's calendar homes, in the answer about those resources (RFC 4791
 *     section 6.2.1).
 *
 * Each is taken only from an answer that itself came from an origin admitted before it, and only
 * for a host that stands beside the typed one ({@link hostsBeside}): the second is no reason to
 * send a password anywhere, only a limit on what a server's word can open.
 *
 * Nothing else admits an origin. Not an address a caller hands in (a stored calendar, a stored
 * event), however alike its host's name; not another port of the server's own host; not a redirect
 * answered to any other request. A request to such an address is not made (`host_changed`).
 *
 * A server keeps its calendars where it likes, and one large provider keeps every account's on a
 * numbered host beside the one a person types. A caller's stored calendar there is still reached,
 * because a turn that is refused that host asks the server where the calendars are, once, and the
 * server names the host again. A host the server no longer names is not asked.
 *
 * What a server named is kept for ONE TURN: with the `Connection` object a caller made for the
 * turn, and gone with it. The next turn begins from the sealed origin alone.
 */
import type { Typed } from "../address.js";
import type { ProviderRefusal } from "../refusals.js";
import { hopOf, originOf, type Hop } from "../request/shape.js";

/** A host as one spelling: lower case, no dot after it, no brackets around a numbered address. */
function oneSpelling(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h;
}

/** A host that names no parent: a numbered address (with a colon, or ending in a number), or a single label. */
function hasNoParent(host: string): boolean {
  if (host.includes(":")) return true;
  const last = host.slice(host.lastIndexOf(".") + 1);
  return last === "" || (last.charCodeAt(0) >= 48 && last.charCodeAt(0) <= 57);
}

/**
 * The hosts a server typed at `typedHost` may name at all: that host, and a host that ends with the
 * typed host's parent (the name without its first label) where that parent has two labels or more.
 * `caldav.example.com` may name `p12-caldav.example.com`; `example.org` may name itself.
 *
 * No list of public suffixes is read: a host typed directly under a suffix of two labels
 * (`name.co.uk`) could name that suffix's other hosts. It is the server itself that has to name
 * one, in the turn the request is made in; and that server holds the password already.
 */
export function hostsBeside(typedHost: string): (host: string) => boolean {
  const typed = oneSpelling(typedHost);
  if (typed === "") return () => false;
  const dot = typed.indexOf(".");
  const parent = dot === -1 || hasNoParent(typed) ? "" : typed.slice(dot + 1);
  const siblings = parent.includes(".") ? `.${parent}` : null;
  return (host) => {
    const h = oneSpelling(host);
    return h === typed || (siblings !== null && h.endsWith(siblings) && !hasNoParent(h));
  };
}

/** The origins one turn's sign-in may travel to, and whether the turn has followed redirects from the homes. */
export interface TurnHosts {
  /** The request port's question for every request: is this the sealed server's own origin, or one it named in this turn? */
  admits(to: Hop): boolean;
  /**
   * The same question for a request of the discovery, where a redirect is the server saying where
   * its service lives: an address the request is sent on to is named by the origin that sent it.
   */
  admitsFound(to: Hop): boolean;
  /** An address an answer of the discovery names (the principal, a calendar home), with the address that answered. */
  names(address: string, answeredBy: string): void;
  /** Could the server name this address's host at all? Where not, there is nothing to ask it. */
  couldName(address: string): boolean;
  /**
   * Follow the discovered homes once in the turn: the first caller runs `ask`,
   * and every caller reads how it ended, the word of an asking that failed or `null`.
   */
  once(ask: () => Promise<ProviderRefusal | null>): Promise<ProviderRefusal | null>;
}

function parsed(address: string): URL | null {
  try {
    return new URL(address);
  } catch {
    // No address: it names no origin and answers for none.
    return null;
  }
}

function turnHosts(typed: Typed): TurnHosts {
  const own = new Set<string>();
  for (const start of [typed.starts[0], typed.secured?.[0]]) {
    const url = start === undefined ? null : parsed(start);
    if (url !== null) own.add(originOf(url));
  }
  const beside = hostsBeside(typed.host);
  const named = new Set<string>();
  let asked: Promise<ProviderRefusal | null> | null = null;

  const admitted = (origin: string): boolean => own.has(origin) || named.has(origin);
  /** The one way an origin is named: by an answer of an origin admitted before it, and only a host beside the typed one. */
  const learn = (to: Hop): void => {
    if (to.from !== null && admitted(to.from) && beside(to.host)) named.add(to.origin);
  };
  return {
    admits: (to) => admitted(to.origin),
    admitsFound(to) {
      learn(to);
      return admitted(to.origin);
    },
    names(address, answeredBy) {
      const to = parsed(address);
      const by = parsed(answeredBy);
      if (to !== null && by !== null) learn(hopOf(to, originOf(by)));
    },
    couldName(address) {
      const to = parsed(address);
      return to !== null && beside(hopOf(to, null).host);
    },
    once: (ask) => (asked ??= ask()),
  };
}

const TURNS = new WeakMap<object, TurnHosts>();

/**
 * The hosts of the turn a call is made in. A caller says which turn that is by the `Connection`
 * object it hands to every call of the turn: the first call with an object begins from the sealed
 * origin alone, a later call with the same object finds what the server named since, and nothing
 * outlives the object.
 */
export function turnHostsOf(turn: object, typed: Typed): TurnHosts {
  let hosts = TURNS.get(turn);
  if (hosts === undefined) {
    hosts = turnHosts(typed);
    TURNS.set(turn, hosts);
  }
  return hosts;
}
