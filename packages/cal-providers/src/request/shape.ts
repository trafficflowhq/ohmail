/**
 * What an address is by its shape alone, before any name is looked up or any socket opens. One rule,
 * asked twice: by the request port as the first thing it does with every address and every
 * redirect, and by a door that takes a typed address and dials nothing. So what the door admits is
 * never something the port refuses at sight, and a rule added here binds both.
 *
 * A shape cannot say where a NAME leads: that is the port's own lookup, at the dial, where a name
 * that resolves to any forbidden address is refused and the socket is pinned to what was cleared.
 */
import {
  SsrfRefusal,
  assertPublicHostShape,
  assertPublicHttpUrlShape,
  canonicalHost,
  isPrivateNetworkAddress,
} from "@trafficflow/core/net";
import { MIN_EXPLICIT_PORT } from "../limits.js";
import type { ProviderRefusal } from "../refusals.js";

/**
 * What a deployment may fetch, named by the program that composes this package; there is no default.
 * `cloud`: https only, public addresses only. `own-network`: a person's own computer or server, which
 * may also reach this machine and private addresses, and those alone without encryption.
 */
export type AddressPolicy = { readonly kind: "cloud" } | { readonly kind: "own-network" };

/** The words a shape is refused with. */
export type ShapeRefusal = Extract<
  ProviderRefusal,
  "address_invalid" | "address_not_allowed" | "port_not_allowed"
>;

/** Names of a person's own network. The gate refuses them; the own-network policy admits these and no other name it refuses. */
const OWN_NETWORK_SUFFIXES = [".local", ".localhost", ".home.arpa"];

/** Does this host, in its one spelling, name a person's own network by its name or its number? */
export function ownNetworkHost(host: string): boolean {
  return (
    host === "localhost" ||
    OWN_NETWORK_SUFFIXES.some((s) => host.endsWith(s)) ||
    isPrivateNetworkAddress(host)
  );
}

/**
 * The address rules that need no lookup, in order; `null` for an address whose shape is admitted.
 * `hosts` is a provider's fixed set (no other host is asked), or `null` for a host a person named.
 */
export function shapeRefusal(
  url: URL,
  policy: AddressPolicy,
  hosts: ReadonlySet<string> | null,
): ShapeRefusal | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return "address_invalid";
  if (url.username !== "" || url.password !== "") return "address_invalid";
  const host = canonicalHost(url.hostname);
  if (hosts !== null && !hosts.has(host)) return "address_not_allowed";
  // `port` is empty for the scheme's own; below 1024 nothing else is dialled.
  if (url.port !== "" && Number(url.port) < MIN_EXPLICIT_PORT) return "port_not_allowed";
  try {
    if (policy.kind === "cloud") {
      assertPublicHttpUrlShape(url.href, { httpsOnly: true, allowExplicitPort: true });
      return null;
    }
    if (ownNetworkHost(host)) return null;
    // A numbered public address is its own pin: asked without encryption it is refused here as it is at the dial.
    const { literal } = assertPublicHostShape(url.hostname);
    return literal !== null && url.protocol === "http:" ? "address_not_allowed" : null;
  } catch (err) {
    if (!(err instanceof SsrfRefusal)) throw err;
    return "address_not_allowed";
  }
}

/**
 * An address's origin in one spelling: its scheme, its host in lower case without a root dot, and
 * its port where that is not the scheme's own. Whether two addresses are one server's is asked of
 * this text and of no other, by the port and by every rule on where a sign-in may travel.
 */
export const originOf = (url: URL): string =>
  `${url.protocol}//${canonicalHost(url.hostname)}${url.port === "" ? "" : `:${url.port}`}`;

/**
 * One address a request is about to be sent to, as the port asks whether a sign-in may travel
 * there: the address the caller asked for, or one a redirect sent the request on to.
 */
export interface Hop {
  /** The host in lower case and without a root dot. */
  readonly host: string;
  /** The address's {@link originOf}. */
  readonly origin: string;
  /** The origin whose answer sent the request on to this address; `null` for the address the caller asked for. */
  readonly from: string | null;
}

export const hopOf = (url: URL, from: string | null): Hop => ({
  host: canonicalHost(url.hostname),
  origin: originOf(url),
  from,
});
