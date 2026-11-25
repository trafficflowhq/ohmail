/**
 * Finding a person's calendars from what they typed: an address, a user and a password. The steps
 * are the standards' own and the same for every server.
 *
 *   1. Where to start (RFC 6764): the address as typed when it names a path, then the well-known
 *      address of its host, then the host's root. A server answers the well-known address with a
 *      redirect to where its service lives; the request port follows it.
 *   2. Who is signed in (RFC 5397): the start is asked for the principal of the request's sign-in.
 *   3. Where the calendars are (RFC 4791 section 6.2.1): the principal names its calendar homes,
 *      each perhaps on another host.
 *
 * Only the first step differs between servers. Every address an answer names is read against the
 * address that answered and asked through the same request port.
 *
 * THESE THREE STEPS ARE HOW A SERVER NAMES A HOST for the turn's sign-in (`hosts.ts`): a redirect
 * one of their requests is answered with, the principal a start names, the homes the principal
 * names. They are asked with the session of the discovery (`finding`, in `ask.ts`), whose requests
 * begin at the sealed record's own starts and go on only by the server's own answers; no address
 * of a caller's is ever asked here.
 */
import { mailAddressOf } from "@ohmail/cal-core";
import type { Typed } from "../address.js";
import { MAX_PAGES_PER_CALL } from "../limits.js";
import type { ProviderRefusal } from "../refusals.js";
import { addressOf, ask, propfindOf, refuse, tlsAlone, type Refused, type Session } from "./ask.js";
import { CALDAV, DAV, childrenOf, propOf, type Multistatus } from "./multistatus.js";

/* What a person typed, read, is the package's one reading of a typed address (`../address.ts`): the door that takes it asks the same. */
export { typedAddress, type Typed } from "../address.js";

/** Calendar homes one principal may name. One is the rule; a few where calendars of others are kept apart. Each is one request of a listing. */
export const MAX_HOMES = MAX_PAGES_PER_CALL;

/** Calendar addresses of the signed-in person that are kept: their mail addresses, a handful at the most. */
export const MAX_OWN_ADDRESSES = 32;

const NOBODY = Symbol("unauthenticated");
const CONFLICT = Symbol("ambiguous principal");

function responsesFor(answer: Multistatus, resource: string) {
  const queried = addressOf(resource);
  return answer.responses.filter(({ href, status }) => {
    const address = addressOf(href, resource);
    return address !== null && address === queried && (status === null || status === 200);
  });
}

function propertyValues(answer: Multistatus, resource: string, namespace: string, name: string) {
  return responsesFor(answer, resource).flatMap(({ propstats }) =>
    propstats.filter(({ status }) => status === 200).flatMap(({ props }) =>
      props.filter(({ ns, local }) => ns === namespace && local === name)));
}

/** The principal named by the resource actually queried. Every successful value must agree. */
function principalIn(answer: Multistatus, base: string): string | typeof NOBODY | typeof CONFLICT | null {
  const values = new Set<string | typeof NOBODY>();
  for (const who of propertyValues(answer, base, DAV, "current-user-principal")) {
    const [node] = who.children;
    if (who.children.length !== 1 || node?.ns !== DAV) return CONFLICT;
    if (node.local === "unauthenticated") values.add(NOBODY);
    else {
      const address = node.local === "href" ? addressOf(node.text.trim(), base) : null;
      if (!address) return CONFLICT;
      values.add(address);
    }
  }
  return values.size > 1 ? CONFLICT : ([...values][0] ?? null);
}

/**
 * Words that end the search at the start that met them. A sign-in that was refused is refused at
 * the next start too, and a server that counts failures locks the address out. An address the
 * request port does not ask, a host that is not found and one that does not answer are the same
 * host at every start.
 */
const ENDS_THE_SEARCH: ReadonlySet<ProviderRefusal> = new Set<ProviderRefusal>([
  "sign_in_refused", "throttled", "address_invalid", "address_not_allowed", "port_not_allowed", "host_unresolved", "timeout", "connection_failed",
]);

type Principal = { readonly ok: true; readonly principal: string } | Refused;

async function searchFrom(s: Session, starts: readonly string[]): Promise<Principal> {
  // What is said when no start names a principal: no service, unless a start said something more exact.
  let none: ProviderRefusal = "no_service";
  for (const start of starts) {
    const asked = await ask(s, "PROPFIND", start, "0", propfindOf("<D:current-user-principal/>"));
    if (asked.ok) {
      const who = principalIn(asked.answer, asked.url);
      if (who === CONFLICT) return refuse("unreadable");
      if (who === NOBODY) return refuse("sign_in_refused");
      if (who !== null) {
        s.hosts.names(who, asked.url);
        return { ok: true, principal: who };
      }
    } else if (ENDS_THE_SEARCH.has(asked.reason)) return refuse(asked.reason, asked.retryAfterMs);
    else if (asked.reason === "host_changed") none = "host_changed";
    else if (asked.reason === "unavailable" && none === "no_service") none = "unavailable";
  }
  return refuse(none);
}

/**
 * Steps 1 and 2: the signed-in principal's address, and the session the rest of the discovery asks
 * with. That is the one handed in, unless the search had to turn to TLS.
 */
export async function findPrincipal(s: Session, typed: Typed): Promise<(Extract<Principal, { ok: true }> & { readonly session: Session }) | Refused> {
  const found = await searchFrom(s, typed.starts);
  if (found.ok) return { ...found, session: s };
  if (found.reason !== "address_not_allowed" || typed.secured === null) return found;
  // Typed without TLS, and not an address that may be asked so: the same starts over TLS. Never the other way
  // round, and from here on the sign-in is not sent without TLS either, whatever address an answer names.
  const secure = tlsAlone(s);
  const again = await searchFrom(secure, typed.secured);
  return again.ok ? { ...again, session: secure } : again;
}

/** Step 3: the principal's calendar homes, and the mail addresses the server lists as the person's own. */
export async function findHomes(s: Session, principal: string): Promise<{ readonly ok: true; readonly homes: readonly string[]; readonly addresses: readonly string[] } | Refused> {
  const asked = await ask(s, "PROPFIND", principal, "0", propfindOf("<C:calendar-home-set/><C:calendar-user-address-set/>"));
  if (!asked.ok) return refuse(asked.reason, asked.retryAfterMs);
  const homes = new Set<string>();
  for (const response of responsesFor(asked.answer, asked.url)) {
    const set = propOf(response, CALDAV, "calendar-home-set");
    for (const href of set === null ? [] : childrenOf(set, DAV, "href")) {
      const home = addressOf(href.text.trim(), asked.url);
      if (home !== null) homes.add(home);
    }
  }
  let seen: readonly string[] | undefined;
  let addresses: readonly string[] = [];
  for (const set of propertyValues(asked.answer, asked.url, CALDAV, "calendar-user-address-set")) {
    const values = [...new Set(childrenOf(set, DAV, "href").map(({ text }) =>
      /^mailto:/i.test(text.trim()) ? text.trim().toLowerCase() : text.trim()))].sort();
    if (seen && (seen.length !== values.length || seen.some((value, i) => value !== values[i]))) {
      return refuse("unreadable");
    }
    seen = values;
    addresses = [...new Set(values.flatMap((value) => {
      const address = mailAddressOf(value);
      return address && !/[:/\s<>?,]/.test(address) ? [address] : [];
    }))];
  }
  if (addresses.length > MAX_OWN_ADDRESSES) return refuse("too_large");
  // A principal that names no home is signed in to something that keeps no calendars.
  if (homes.size === 0) return refuse("no_service");
  if (homes.size > MAX_HOMES) return refuse("too_large");
  for (const home of homes) s.hosts.names(home, asked.url);
  return { ok: true, homes: [...homes], addresses };
}
