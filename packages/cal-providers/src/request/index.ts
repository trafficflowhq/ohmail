/**
 * How a request leaves this package. An adapter is handed an `HttpPort` and builds no request of its
 * own; the two makers below are the only ones, and both stand on the product's address gate and its
 * pinned connection (`guarded.ts`).
 */
import type { ZoneSource } from "@ohmail/cal-core";
import { MAX_RETRY_AFTER_MS } from "../limits.js";
import type { Clock } from "../port.js";
import type { ProviderRefusal } from "../refusals.js";

/** The methods reading needs. A writer adds its own here. */
export type HttpMethod = "GET" | "POST" | "PROPFIND" | "REPORT";

/** The headers an adapter may name. Every other line of a request is the port's own. */
export type AdapterHeader = "accept" | "content-type" | "depth" | "prefer";

/**
 * A sign-in for one request. The Authorization line is built inside the port, for each hop anew, and
 * only for a host `admits` says yes to; a hop to any other host is not made (`host_changed`).
 */
export interface Authorization {
  readonly credential: { readonly kind: "basic"; readonly user: string; password(): string } | { readonly kind: "bearer"; readonly token: string };
  /** May the credential travel to this host? Asked with the host in lower case and without a root dot. */
  admits(host: string): boolean;
  /**
   * The sign-in travels with TLS and never without: a plain address is not asked with it
   * (`address_not_allowed`), whoever named it: a person, a server's answer, a caller's stored address.
   * `false` only for a sign-in a person typed for a plain address, which the port sends to that
   * person's own network alone. No default: an absent word must not select the plain branch.
   */
  readonly tlsOnly: boolean;
}

export interface HttpRequest {
  readonly method: HttpMethod;
  readonly headers: Readonly<Partial<Record<AdapterHeader, string>>>;
  readonly body: string | null;
  readonly auth: Authorization | null;
  /** Sent with the first request only: a validator belongs to the address it came from. With both, the tag is sent. */
  readonly validators: { readonly etag: string | null; readonly lastModified: string | null } | null;
  readonly signal: AbortSignal;
}

/** An answer that arrived, whatever its status. */
export interface HttpResponse {
  readonly arrived: true;
  readonly status: number;
  /** One header of the answer by its name in any case, or `null`. */
  header(name: string): string | null;
  /** The whole body, never a part: a body past the ceiling is the refusal `too_large`. */
  readonly body: Uint8Array;
  /** The answer's own Location line as written, where a redirect was not followed. */
  readonly location: string | null;
  /** The address that answered, after the redirects that were followed. */
  readonly url: string;
  readonly hops: number;
}

/** A provider's or a network's answer is never a throw: it arrived, or it is a word. */
export type HttpAnswer = HttpResponse | { readonly arrived: false; readonly reason: ProviderRefusal };

export interface HttpPort {
  request(url: string, req: HttpRequest): Promise<HttpAnswer>;
}

/** What every adapter is made from. One zone source for the program, one clock, one way out. */
export interface AdapterDeps {
  readonly http: HttpPort;
  readonly clock: Clock;
  readonly zones: ZoneSource;
}

export { namedHostRequest, type AddressPolicy, type RequestDeps } from "./named-host.js";
export { fixedHostRequest } from "./fixed-host.js";

/**
 * How long the answer asks to be left alone (Retry-After, in seconds or as a date), in milliseconds:
 * never below nothing and never above a day. `null` when it does not say, or not readably.
 */
export function retryAfterMs(res: HttpResponse, clock: Clock): number | null {
  const raw = res.header("retry-after");
  if (raw === null) return null;
  const text = raw.trim();
  const ms = /^\d{1,9}$/.test(text) ? Number(text) * 1000 : Date.parse(text) - clock.now();
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS) : null;
}

/** A body as text: UTF-8, a byte-order mark taken off. No other character set is honoured. */
export const textOf = (body: Uint8Array): string => new TextDecoder("utf-8").decode(body);
