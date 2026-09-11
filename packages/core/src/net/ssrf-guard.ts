/**
 * The SSRF gate — one implementation, here and not in `services`: the worker POSTs a wake to a
 * user-registered UnifiedPush endpoint and must resolve-and-clear the URL first, and the worker's
 * dependency test forbids `@trafficflow/services` (its barrel puts an HTML sanitiser in the boot
 * graph — a hard `ERR_REQUIRE_CYCLE_MODULE` on Node 23). The alternative was a second copy of the
 * parsers and refusal sets — two hand-kept gates agree until one is edited, and a range added on
 * one side is a bypass no test can see. One implementation, two thin adapters. The refusal is
 * {@link SsrfRefusal}, not `ServiceError`: core has no business knowing HTTP statuses; the
 * services adapter re-wraps.
 */

/**
 * The refusal. `why` is the SAME short reason string the services adapter interpolates into its
 * `ServiceError` message, so a refusal reads identically whichever host caught it.
 *
 * Deliberately NOT carrying the URL, the hostname or the resolved addresses: this error is logged
 * by the worker on a path where the endpoint is a user's own device registration, and a log line
 * naming it would put a per-device identifier in the drain. The caller knows which endpoint it
 * asked about; the gate only says no, and why in general terms.
 */
export class SsrfRefusal extends Error {
  readonly why: string;
  constructor(why: string) {
    super(`not a permitted url: ${why}`);
    this.name = "SsrfRefusal";
    this.why = why;
  }
}

/**
 * The injected DNS port. A URL guard that checks only the submitted string is not a guard:
 * `https://images.acme.com/` is ordinary right up until it resolves to `169.254.169.254` — the
 * name must become addresses before anything decides, and that turn is I/O, so it is a
 * dependency. REQUIRED at every construction site, deliberately no default: a fallback to
 * `node:dns` would be worse than no guard — the test sandbox blocks DNS, so every test would take
 * the refuse branch and the permit branch would ship never executed. The same trap applies to any
 * DNS-dependent check (`verifyAlignedDkim` is the other), which is why {@link nodeHostResolver}
 * is a separate named export wired at the composition root.
 */
export interface HostResolver {
  /**
   * A/AAAA addresses for `hostname`, as textual IPs. An empty array, a throw, or
   * an unparseable address are all treated as a refusal — the guard fails CLOSED.
   */
  resolve(hostname: string): Promise<string[]>;
}

/**
 * The production resolver. Referenced ONLY from composition roots — the hosted API's dependency
 * wiring, the standalone server's, and the worker's push-wake sender — never as a default inside
 * a service, for the reason spelled out on {@link HostResolver}.
 */
export const nodeHostResolver: HostResolver = {
  async resolve(hostname: string): Promise<string[]> {
    const { promises: dns } = await import("node:dns");
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    return records.map((r) => r.address);
  },
};

// ── address parsing ────────────────────────────────────────────────────────
// Both parsers are STRICT: a leading zero, a short quad, an out-of-range group
// or anything else non-canonical returns null, and null means blocked. Being
// permissive here is how `0177.0.0.1` and `2130706433` become working bypasses.

/** Canonical dotted-quad only. `010.0.0.1` and `127.1` are rejected, not "fixed". */
function parseIpv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    if (p.length > 1 && p[0] === "0") return null;   // octal ambiguity → refuse
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** RFC 4291 textual IPv6 → 16 bytes, including the embedded-IPv4 tail form. */
function parseIpv6(input: string): Uint8Array | null {
  const pct = input.indexOf("%");                     // strip a zone id (`fe80::1%en0`)
  const s = pct >= 0 ? input.slice(0, pct) : input;
  if (!s.includes(":")) return null;

  const dbl = s.indexOf("::");
  if (dbl >= 0 && s.indexOf("::", dbl + 1) >= 0) return null;   // at most one "::"
  const headStr = dbl >= 0 ? s.slice(0, dbl) : s;
  const tailStr = dbl >= 0 ? s.slice(dbl + 2) : "";

  const emit = (groups: string[], out: number[]): boolean => {
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]!;
      if (g.includes(".")) {
        if (i !== groups.length - 1) return false;    // IPv4 tail only in last position
        const v4 = parseIpv4(g);
        if (!v4) return false;
        out.push(...v4);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return false;
      const n = parseInt(g, 16);
      out.push((n >> 8) & 0xff, n & 0xff);
    }
    return true;
  };

  const head: number[] = [];
  const tail: number[] = [];
  if (headStr !== "" && !emit(headStr.split(":"), head)) return null;
  if (tailStr !== "" && !emit(tailStr.split(":"), tail)) return null;

  if (dbl < 0) return head.length === 16 ? Uint8Array.from(head) : null;
  const fill = 16 - head.length - tail.length;
  if (fill < 0) return null;
  return Uint8Array.from([...head, ...new Array<number>(fill).fill(0), ...tail]);
}

/** The IPv4 refusal set. Everything the SSRF acceptance criteria name, plus the obvious neighbours. */
function blockedIpv4(b: number[]): boolean {
  const [a, x, y] = b as [number, number, number, number];
  if (a === 0) return true;                                   // 0.0.0.0/8 "this network"
  if (a === 10) return true;                                  // 10/8 private
  if (a === 127) return true;                                 // 127/8 loopback
  if (a === 169 && x === 254) return true;                    // 169.254/16 link-local → cloud metadata
  if (a === 172 && x >= 16 && x <= 31) return true;           // 172.16/12 private
  if (a === 192 && x === 168) return true;                    // 192.168/16 private
  if (a === 100 && x >= 64 && x <= 127) return true;          // 100.64/10 CGNAT
  if (a === 192 && x === 0 && y === 0) return true;           // 192.0.0/24 IETF protocol assignments
  if (a === 192 && x === 0 && y === 2) return true;           // 192.0.2/24 TEST-NET-1
  if (a === 198 && (x === 18 || x === 19)) return true;       // 198.18/15 benchmarking
  if (a === 198 && x === 51 && y === 100) return true;        // 198.51.100/24 TEST-NET-2
  if (a === 203 && x === 0 && y === 113) return true;         // 203.0.113/24 TEST-NET-3
  if (a >= 224) return true;                                  // multicast, reserved, 255.255.255.255
  return false;
}

/** The IPv6 refusal set — and every v4-carrying form is unwrapped, not waved through. */
function blockedIpv6(b: Uint8Array): boolean {
  const zeroThrough = (n: number): boolean => b.slice(0, n).every((o) => o === 0);
  const tailV4 = (): number[] => [b[12]!, b[13]!, b[14]!, b[15]!];

  if (b.every((o) => o === 0)) return true;                                   // ::
  if (zeroThrough(15) && b[15] === 1) return true;                            // ::1 loopback
  if (zeroThrough(10) && b[10] === 0xff && b[11] === 0xff) {
    return blockedIpv4(tailV4());                                             // ::ffff:a.b.c.d (v4-mapped)
  }
  if (zeroThrough(12)) return blockedIpv4(tailV4());                          // ::a.b.c.d (v4-compatible)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return blockedIpv4(tailV4());                                             // 64:ff9b::/96 NAT64
  }
  if ((b[0]! & 0xfe) === 0xfc) return true;                                   // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true;                  // fe80::/10 link-local
  if (b[0] === 0xff) return true;                                             // ff00::/8 multicast
  return false;
}

/**
 * True when `ip` must never be connected to. **Unparseable is blocked** — the
 * guard has no way to reason about a string it cannot decode, and the safe
 * reading of "I do not know what this is" is "no".
 */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  const v4 = parseIpv4(bare);
  if (v4) return blockedIpv4(v4);
  const v6 = parseIpv6(bare);
  if (v6) return blockedIpv6(v6);
  return true;
}

/** A DNS name we are willing to resolve: LDH labels, and a non-numeric last label. */
const DNS_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** Names that must never leave the building even if some resolver would answer. */
const BLOCKED_SUFFIXES = [".onion", ".local", ".localhost", ".internal", ".home.arpa"];

const refuse = (why: string): never => {
  throw new SsrfRefusal(why);
};

/**
 * How much a caller is willing to relax. Every field defaults to the STRICT reading, so an
 * omitted options object is the historical behaviour exactly — which is the only acceptable
 * default for a security gate: a new option must never be able to loosen an existing call site
 * by being added.
 */
export interface PublicUrlOptions {
  /**
   * Permit an explicit non-default port (`https://push.example.com:8443/…`). OFF by default: for
   * the two original callers — the unsubscribe fetch and the privacy proxy — a port is a strong
   * signal the URL is aimed at something other than a web server, and refusing it costs nothing
   * real. ON for the UnifiedPush wake sender, and that is not a weakening of the address rules: a
   * self-hosted distributor behind a reverse proxy on 8443 legitimately publishes an endpoint
   * with a port, and the endpoint is a URL the DEVICE chose. A port on a private address is still
   * refused.
   */
  allowExplicitPort?: boolean;
  /**
   * Refuse `http:`, permitting `https:` only. Phrased this way round because the other way was a
   * live regression: `allowHttp` defaulting to `false` reads like the safe choice and changed
   * every existing caller — the image proxy passes no options, so plain-`http:` images in real
   * mail stopped loading, silently, a refusal indistinguishable from an image that would not load
   * anyway. An added option must not change what an existing call site does, and TIGHTENING is as
   * much a change as loosening. The default is the historical behaviour; the UnifiedPush strict
   * arm opts in — a plaintext wake tells anyone on the path that this account just received mail,
   * exactly the metadata the content-free payload withholds.
   */
  httpsOnly?: boolean;
}

/**
 * The SSRF gate for every caller-supplied URL this service is willing to fetch. Refuses, before
 * any socket: a non-`http(s)` scheme, userinfo, a non-default port, an absent host, the
 * `.onion`/`.local`/`.internal` name spaces; an IP literal in a refused range, with no DNS; a
 * name whose resolution returns ANY refused address — any, not the first. The return value is
 * load-bearing: IT IS THE PIN. Returning `void` made this half a defence — the caller handed the
 * hostname to a bare `fetch`, which resolves a second time: the rebinding hole. The fetch port
 * connects only to a returned address ({@link pinnedLookup}), and `redirect: "manual"` is the
 * other half: a 302 is a second URL nobody validated.
 */
export async function assertPublicHttpUrl(
  raw: string, resolver: HostResolver, opts: PublicUrlOptions = {},
): Promise<string[]> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    refuse("unparseable");
  }

  if (u!.protocol !== "https:" && u!.protocol !== "http:") refuse("scheme must be http or https");
  if (opts.httpsOnly === true && u!.protocol !== "https:") refuse("scheme must be https");
  if (u!.username !== "" || u!.password !== "") refuse("userinfo is not allowed");

  if (opts.allowExplicitPort !== true) {
    const defaultPort = u!.protocol === "https:" ? "443" : "80";
    if (u!.port !== "" && u!.port !== defaultPort) refuse("port is not allowed");
  }

  // `URL.hostname` brackets an IPv6 literal and keeps a FQDN's trailing dot.
  return assertPublicHost(u!.hostname, resolver);
}

/**
 * The host half of {@link assertPublicHttpUrl}, without the http-only scheme/port
 * checks — for a caller that has a HOSTNAME rather than a URL (the IMAP/SMTP
 * add-time probe dials `host:port` on transports this file knows nothing about).
 * Returns the validated address(es) to pin to; throws on anything private,
 * unresolvable or unparseable. Fails CLOSED for the same reason
 * {@link isBlockedAddress} does.
 */
export async function assertPublicHost(hostname: string, resolver: HostResolver): Promise<string[]> {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "") refuse("host is empty");
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) refuse("host is not public");

  const bracketed = host.startsWith("[") && host.endsWith("]");
  const bare = bracketed ? host.slice(1, -1) : host;
  const isLiteral = bracketed || bare.includes(":") || /^[\d.]+$/.test(bare);
  if (isLiteral) {
    if (isBlockedAddress(bare)) refuse("host resolves to a non-public address");
    return [bare];                               // a permitted literal needs no DNS; it IS the pin
  }

  // Anything that is not a literal must look like a DNS name, and its last label
  // must not be all digits — that is what stops `2130706433` and `127.1` from
  // sliding past the literal check and being handed to a resolver that would
  // helpfully read them as `127.0.0.1`.
  const labels = bare.split(".");
  if (!DNS_NAME.test(bare) || /^\d+$/.test(labels[labels.length - 1]!)) refuse("host is not a valid dns name");

  let addrs: string[];
  try {
    addrs = await resolver.resolve(bare);
  } catch {
    refuse("host did not resolve");
  }
  if (addrs!.length === 0) refuse("host did not resolve");
  for (const a of addrs!) {
    if (isBlockedAddress(a)) refuse("host resolves to a non-public address");
  }
  return addrs!;                                 // every record cleared → the whole set is the pin
}

/**
 * The resolve-only variant, for a caller willing to dial an address the strict gate refuses and
 * still wanting the PIN. It exists for one deployment shape, named rather than obtained by
 * omission: a self-host operator whose UnifiedPush distributor is on their own LAN
 * (`TF_PUSH_ALLOW_PRIVATE=1`). The address rules are skipped; everything else is not — the URL
 * must still parse, be http(s), carry no userinfo, and the name must still resolve, because the
 * pin is what stops the socket re-resolving later. A literal returns itself; a name that does not
 * resolve is a refusal: there is nothing to pin to.
 */
export async function resolvePinUnchecked(raw: string, resolver: HostResolver): Promise<string[]> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    refuse("unparseable");
  }
  if (u!.protocol !== "https:" && u!.protocol !== "http:") refuse("scheme must be http or https");
  if (u!.username !== "" || u!.password !== "") refuse("userinfo is not allowed");

  const host = u!.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "") refuse("host is empty");
  const bracketed = host.startsWith("[") && host.endsWith("]");
  const bare = bracketed ? host.slice(1, -1) : host;
  if (bracketed || bare.includes(":") || /^[\d.]+$/.test(bare)) return [bare];

  let addrs: string[];
  try {
    addrs = await resolver.resolve(bare);
  } catch {
    refuse("host did not resolve");
  }
  if (addrs!.length === 0) refuse("host did not resolve");
  return addrs!;
}
