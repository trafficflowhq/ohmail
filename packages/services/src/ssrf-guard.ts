import { ServiceError } from "./errors.js";

/**
 * The INJECTED DNS port. Its whole reason to exist is that a URL guard which
 * checks only the *submitted* string is not a guard: `https://images.acme.com/`
 * is a perfectly ordinary hostname right up until it resolves to
 * `169.254.169.254`. The name has to be turned into addresses before anything
 * decides, and that turn is I/O, so it is a dependency.
 *
 * **REQUIRED at every construction site — deliberately no default.** A default
 * that fell back to `node:dns` would be worse than no guard: the test sandbox
 * blocks DNS, so every test would take the refuse branch, the permit branch
 * would ship having never executed, and production would run whatever the
 * default happened to do. The same trap applies to any DNS-dependent check —
 * `verifyAlignedDkim(raw, { resolveTxt })` is the other one in this codebase — so
 * the rule is the same, and it is why {@link nodeHostResolver} is a separate
 * named export wired at the composition root rather than a parameter default.
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
 * wiring — never as a default inside a service, for the reason spelled out on
 * {@link HostResolver}.
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
  throw new ServiceError("validation_failed", 400, `u is not a permitted url: ${why}`);
};

/**
 * The SSRF gate for every caller-supplied URL this service is willing to fetch.
 * Refuses, in order and before any socket is opened:
 *
 *  · a non-`http(s)` scheme, userinfo (`https://u:p@internal/`, whose host half
 *    a careless reader — and some parsers — get wrong), a non-default port, an
 *    absent host, and the `.onion`/`.local`/`.internal` name spaces;
 *  · an IP LITERAL in a refused range, checked directly with no DNS at all;
 *  · a NAME, resolved through the injected {@link HostResolver}, refused when
 *    ANY returned address is in a refused range — any, not the first, because
 *    a multi-record answer only needs one internal address to be useful.
 *
 * ── THE RETURN VALUE IS LOAD-BEARING: IT IS THE PIN ──────────────────────────
 *
 * This used to return `void`, and returning `void` is what made it a HALF of the
 * SSRF defence rather than the whole of it. The caller then handed the same
 * *hostname* to a bare `fetch`, which resolves the name a SECOND time — so a
 * DNS-rebinding server could answer this gate with a public address and answer
 * `fetch`'s independent lookup with `169.254.169.254`. Validate-then-re-resolve
 * is a time-of-check/time-of-use hole the size of the whole guard.
 *
 * So it returns the VALIDATED addresses. The fetch port must connect ONLY to one
 * of these (see {@link pinnedLookup} / `pinned-fetch.ts`), never re-resolving the
 * name — the socket goes to an address this function has already cleared, while
 * the TLS SNI and the `Host` header still carry the original hostname. For an IP
 * literal the pin is the literal itself; for a name it is every A/AAAA record,
 * all of which were just proven public.
 *
 * `redirect: "manual"` at the fetch port is the other half and is not optional:
 * this function can only ever speak about the URL it was given, and a 302 is a
 * second URL nobody validated.
 */
export async function assertPublicHttpUrl(raw: string, resolver: HostResolver): Promise<string[]> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    refuse("unparseable");
  }

  if (u!.protocol !== "https:" && u!.protocol !== "http:") refuse("scheme must be http or https");
  if (u!.username !== "" || u!.password !== "") refuse("userinfo is not allowed");

  const defaultPort = u!.protocol === "https:" ? "443" : "80";
  if (u!.port !== "" && u!.port !== defaultPort) refuse("port is not allowed");

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
