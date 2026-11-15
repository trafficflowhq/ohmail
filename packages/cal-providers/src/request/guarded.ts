/**
 * The one way a byte leaves this package or enters it. Every address, typed by a person or fixed in
 * code, passes the product's address gate before a socket opens; the connection is pinned to the
 * addresses the gate cleared; a redirect is a second address and passes the gate again. The request
 * carries a list of headers of its own and nothing of the caller's, asks for no packing, and is
 * bounded in bytes and in time.
 *
 * Two policies, and the program that composes this package names one; there is no default.
 * `cloud`: https only, public addresses only. `own-network`: a person's own computer or server, which
 * may also reach this machine and private addresses, and those alone without encryption.
 */
import {
  MAX_PINNED_ADDRESSES, SsrfRefusal, assertPublicHostShape, assertPublicHttpUrl, canonicalHost, isBlockedAddress,
  isPrivateNetworkAddress, resolvePinUnchecked, type HostResolver, type PinnedRequestOptions, type PinnedResponse,
} from "@trafficflow/core/net";
import { MAX_URL_CHARS, MAX_VALIDATOR_CHARS, MIN_EXPLICIT_PORT } from "../limits.js";
import type { ProviderRefusal } from "../refusals.js";
import { readCapped } from "./capped-body.js";
import type { HttpAnswer, HttpPort, HttpRequest } from "./index.js";

export type AddressPolicy = { readonly kind: "cloud" } | { readonly kind: "own-network" };

export interface GuardLimits {
  /** From a hop's start to its answer's head, the name's lookup included. */
  readonly connectMs: number;
  /** The whole call: every hop and the body. */
  readonly totalMs: number;
  /** Redirects followed. With 0 a redirect is handed back as the answer it is. */
  readonly maxRedirects: number;
  readonly maxBodyBytes: number;
}

export interface GuardDeps {
  /** The lookup of a name. Required: a default would ship the permitting branch never run. */
  readonly resolver: HostResolver;
  /** The pinned request. The package's makers hand in the product's own and nothing else. */
  readonly request: (url: string, opts: PinnedRequestOptions) => Promise<PinnedResponse>;
  readonly policy: AddressPolicy;
  readonly limits: GuardLimits;
  /** A provider's fixed hosts: no other host is dialled. `null` for a host a person named. */
  readonly hosts: ReadonlySet<string> | null;
}

const USER_AGENT = "ohmail-Calendar/2.0";
const ADAPTER_HEADERS: ReadonlySet<string> = new Set(["accept", "content-type", "depth", "prefer"]);
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/** Names of a person's own network. The gate refuses them; the own-network policy admits these and no other name it refuses. */
const OWN_NETWORK_SUFFIXES = [".local", ".localhost", ".home.arpa"];
const PRINTABLE = /^[\x20-\x7e]*$/;
const TOKEN = /^[\x21-\x7e]+$/;

/** A socket's or a lookup's failure, by its code. Anything else is a fault of this program and is thrown on. */
const TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH",
  "ENETDOWN", "EPIPE", "EADDRNOTAVAIL", "EHOSTDOWN", "ERR_SOCKET_CONNECTION_TIMEOUT", "ERR_SOCKET_CLOSED", "ERR_STREAM_PREMATURE_CLOSE",
  // A handshake that is no TLS at all (a plain server on the port) fails as a protocol error of the socket.
  "EPROTO",
  // A certificate that failed its check: the platform's list of what one can fail with has these beside the
  // families below, and `UNSPECIFIED` for a fault its table does not name.
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "INVALID_CA", "INVALID_PURPOSE", "PATH_LENGTH_EXCEEDED", "HOSTNAME_MISMATCH",
  "OUT_OF_MEM", "UNSPECIFIED",
]);
const isTransportFailure = (err: unknown): boolean => {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && (TRANSPORT_CODES.has(code) || /^(CERT_|CRL_|UNABLE_TO_|ERROR_IN_|ERR_TLS_|ERR_SSL_|ERR_OSSL_|HPE_)/.test(code));
};

function parse(text: string, against?: string): URL | null {
  try {
    return new URL(text, against);
  } catch {
    // No address: the caller answers with its own word for that.
    return null;
  }
}

type Cleared = { readonly pin: readonly string[] } | { readonly refused: ProviderRefusal };

/** The address rules, in order, each before any lookup that a later one needs. The answer is the pin. */
async function clear(url: URL, deps: GuardDeps): Promise<Cleared> {
  if (url.protocol !== "https:" && url.protocol !== "http:") return { refused: "address_invalid" };
  if (url.username !== "" || url.password !== "") return { refused: "address_invalid" };
  const host = canonicalHost(url.hostname);
  if (deps.hosts !== null && !deps.hosts.has(host)) return { refused: "address_not_allowed" };
  // `port` is empty for the scheme's own; below 1024 nothing else is dialled.
  if (url.port !== "" && Number(url.port) < MIN_EXPLICIT_PORT) return { refused: "port_not_allowed" };
  const https = url.protocol === "https:";

  // Whether the gate refused a name for what it resolved to, or for resolving to nothing, is read
  // off the lookup itself and not off the gate's wording.
  let asked = false;
  let answered = false;
  const resolver: HostResolver = {
    async resolve(name) {
      asked = true;
      const addresses = await deps.resolver.resolve(name);
      answered = addresses.length > 0;
      return addresses;
    },
  };
  try {
    if (deps.policy.kind === "cloud") {
      const pin = await assertPublicHttpUrl(url.href, resolver, { httpsOnly: true, allowExplicitPort: true });
      return { pin: pin.slice(0, MAX_PINNED_ADDRESSES) };
    }
    const own = host === "localhost" || OWN_NETWORK_SUFFIXES.some((s) => host.endsWith(s)) || isPrivateNetworkAddress(host);
    if (!own) assertPublicHostShape(url.hostname);
    const pin = await resolvePinUnchecked(url.href, resolver);
    // Public or private, each of them: a link-local, a shared or a reserved address is neither.
    if (!pin.every((a) => isPrivateNetworkAddress(a) || !isBlockedAddress(a))) return { refused: "address_not_allowed" };
    if (!https && !pin.every(isPrivateNetworkAddress)) return { refused: "address_not_allowed" };
    return { pin: pin.slice(0, MAX_PINNED_ADDRESSES) };
  } catch (err) {
    if (!(err instanceof SsrfRefusal)) throw err;
    return { refused: asked && !answered ? "host_unresolved" : "address_not_allowed" };
  }
}

/** `p`, or `"late"` once the signal has aborted. The work behind `p` is not ended; the wait is. */
function unlessAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T | "late"> {
  if (signal.aborted) {
    // The work goes on unwaited: a failure of it later is heard here, or it would be nobody's and end the program.
    void p.catch(() => undefined);
    return Promise.resolve("late");
  }
  return new Promise((resolve, reject) => {
    const late = (): void => resolve("late");
    signal.addEventListener("abort", late, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", late));
  });
}

const base64 = (text: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

/** The request's lines for one hop, made new each time: nothing of an earlier hop rides along. `null`: the credential is no line. */
function headersFor(req: HttpRequest, body: Uint8Array | null, hop: number): Record<string, string> | null {
  const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: req.headers.accept ?? "*/*", "accept-encoding": "identity" };
  for (const name of ["content-type", "depth", "prefer"] as const) {
    const value = req.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  if (body !== null) headers["content-length"] = String(body.byteLength);
  if (req.auth !== null) {
    const c = req.auth.credential;
    if (c.kind === "bearer") {
      if (!TOKEN.test(c.token)) return null;
      headers.authorization = `Bearer ${c.token}`;
    } else {
      // The one place a password is revealed: this line, for this hop, for a host that is admitted.
      if (c.user === "" || c.user.includes(":")) return null;
      headers.authorization = `Basic ${base64(`${c.user}:${c.password()}`)}`;
    }
  }
  const v = hop === 0 ? req.validators : null;
  const usable = (text: string | null): text is string => text !== null && text !== "" && text.length <= MAX_VALIDATOR_CHARS && PRINTABLE.test(text);
  if (v !== null && usable(v.etag)) headers["if-none-match"] = v.etag;
  else if (v !== null && usable(v.lastModified)) headers["if-modified-since"] = v.lastModified;
  return headers;
}

const headerOf = (res: PinnedResponse, name: string): string | null => {
  const value = res.headers[name.toLowerCase()];
  return value === undefined ? null : Array.isArray(value) ? value.join(", ") : value;
};

async function run(deps: GuardDeps, first: string, req: HttpRequest): Promise<HttpAnswer> {
  for (const [name, value] of Object.entries(req.headers)) {
    if (!ADAPTER_HEADERS.has(name) || !PRINTABLE.test(value)) throw new TypeError(`a calendar request may not carry the header ${name} as given`);
  }
  const refused = (reason: ProviderRefusal): HttpAnswer => ({ arrived: false, reason });
  if (req.signal.aborted) return refused("timeout");

  // One signal for the whole call: the caller's, the whole call's clock and each hop's.
  const ac = new AbortController();
  const end = (): void => ac.abort();
  req.signal.addEventListener("abort", end, { once: true });
  const whole = setTimeout(end, deps.limits.totalMs);
  /** What a failed request or body is called: the clock's word once the signal fired, a network's by its code. */
  const failure = (err: unknown): ProviderRefusal => {
    if (ac.signal.aborted) return "timeout";
    if (isTransportFailure(err)) return "connection_failed";
    throw err;
  };
  const body = req.body === null ? null : new TextEncoder().encode(req.body);

  try {
    let current = first;
    let cameByHttps = false;
    for (let hop = 0; ; hop++) {
      // What is wrong with an address has the address's word on every hop; what is wrong with the
      // redirect itself (no address, too long, a step down to http) is the redirect's.
      const noAddress: ProviderRefusal = hop === 0 ? "address_invalid" : "redirect_invalid";
      if (current.length > MAX_URL_CHARS) return refused(noAddress);
      const url = parse(current);
      if (url === null) return refused(noAddress);
      if (cameByHttps && url.protocol === "http:") return refused("redirect_invalid");
      // A sign-in for TLS alone: the step down a redirect makes is refused above, and this is the one no redirect
      // makes, an address that is plain from its first request. Before any lookup.
      if (req.auth !== null && req.auth.tlsOnly && url.protocol === "http:") return refused("address_not_allowed");

      const head = setTimeout(end, deps.limits.connectMs);
      let res: PinnedResponse;
      try {
        // Before any lookup: a host the credential may not travel to is not asked about either.
        if (req.auth !== null && !req.auth.admits(canonicalHost(url.hostname))) return refused("host_changed");
        const cleared = await unlessAborted(clear(url, deps), ac.signal);
        if (cleared === "late") return refused("timeout");
        if ("refused" in cleared) return refused(cleared.refused);
        const headers = headersFor(req, body, hop);
        if (headers === null) return refused("sign_in_refused");
        // The wait is this call's, not the request's: a connection can end with neither an answer nor an error
        // (a server that answers with a change of protocol), and such a request never settles and hears no signal.
        const asking = deps.request(url.href, { method: req.method, headers, body: body ?? undefined, pin: cleared.pin, signal: ac.signal });
        const answered = await unlessAborted(asking, ac.signal);
        if (answered === "late") {
          // An answer that still comes is nobody's: its connection is ended.
          void asking.then((late) => late.stream.destroy(), () => undefined);
          return refused("timeout");
        }
        res = answered;
      } catch (err) {
        return refused(failure(err));
      } finally {
        clearTimeout(head);
      }

      // Nothing is unpacked here, so nothing can grow after it was counted.
      const encoding = headerOf(res, "content-encoding")?.trim().toLowerCase() ?? "";
      if (encoding !== "" && encoding !== "identity") {
        res.stream.destroy();
        return refused("unreadable");
      }

      // The same request goes to the new address, method and body as they were: a calendar server's
      // well-known address answers a PROPFIND with a redirect, and means that PROPFIND.
      if (deps.limits.maxRedirects > 0 && REDIRECTS.has(res.status)) {
        res.stream.destroy();
        const location = headerOf(res, "location");
        if (location === null) return refused("redirect_invalid");
        if (hop === deps.limits.maxRedirects) return refused("too_many_redirects");
        const next = parse(location, url.href);
        if (next === null) return refused("redirect_invalid");
        cameByHttps = url.protocol === "https:";
        current = next.href;
        continue;
      }

      let bytes: Uint8Array | null;
      try {
        // The body is waited for the same way: a stream that neither ends nor fails is left at the call's bound.
        const reading = readCapped(res.stream, headerOf(res, "content-length"), deps.limits.maxBodyBytes);
        const read = await unlessAborted(reading, ac.signal);
        if (read === "late") {
          res.stream.destroy();
          return refused("timeout");
        }
        bytes = read;
      } catch (err) {
        return refused(failure(err));
      }
      if (bytes === null) return refused("too_large");
      return { arrived: true, status: res.status, header: (name) => headerOf(res, name), body: bytes, location: headerOf(res, "location"), url: url.href, hops: hop };
    }
  } finally {
    clearTimeout(whole);
    req.signal.removeEventListener("abort", end);
  }
}

/** The request port over the gate. The package's two makers call it; a test may, with stand-ins. */
export function guardedRequest(deps: GuardDeps): HttpPort {
  return { request: (url, req) => run(deps, url, req) };
}
