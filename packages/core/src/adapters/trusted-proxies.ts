import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

/**
 * WHICH PEERS MAY SAY WHO THE CLIENT IS. A self-hosted server sits behind its own proxy, whose
 * socket is the only peer the server ever sees; that proxy writes the real client into
 * `x-forwarded-for`, and nothing else may. The operator names the proxy in `TF_TRUSTED_PROXIES`:
 * addresses, CIDRs and hostnames (`proxy` on the bundled compose). A hostname is resolved when a
 * peer misses the set, at most once per {@link TRUSTED_PROXY_LOOKUP_MIN_MS}, and again on a hit
 * older than {@link TRUSTED_PROXY_TTL_MS}, so boot order does not matter and a recreated proxy is
 * trusted on its first request. A name that does not resolve contributes nothing.
 */

/** At most one lookup per interval, whatever a peer that misses the set sends. */
export const TRUSTED_PROXY_LOOKUP_MIN_MS = 5_000;
/** A resolved address older than this is looked up again before it is trusted. */
export const TRUSTED_PROXY_TTL_MS = 60_000;
/** A lookup that has not answered by then has failed; the request does not wait longer. */
export const TRUSTED_PROXY_LOOKUP_TIMEOUT_MS = 2_000;

/** A parsed `TF_TRUSTED_PROXIES` entry, or the reason it is not one. */
export type TrustedProxyEntry =
  | { kind: "address"; address: string }
  | { kind: "cidr"; network: string; prefix: number; family: "ipv4" | "ipv6" }
  | { kind: "name"; name: string };

/** A fact about a configured name, said once per change. */
export type TrustedProxyNote =
  | { kind: "resolved"; name: string; addresses: string[] }
  | { kind: "unresolved"; name: string };

export interface TrustedProxies {
  /** No entries: nothing is ever trusted and no lookup ever runs. */
  readonly empty: boolean;
  /** Is this canonical address trusted on what is known now? Never resolves. */
  has(ip: string): boolean;
  /**
   * Is this canonical peer trusted? Resolves the names first on a miss or a stale hit; never
   * rejects. `forwarding`: the request carries `x-forwarded-for`, so it may be a proxy that has
   * not been judged yet, and it waits for the next permitted lookup rather than being refused.
   */
  trustsPeer(ip: string, forwarding?: boolean): Promise<boolean>;
}

export interface TrustedProxyOptions {
  /** The addresses a name resolves to. Production passes {@link systemLookup}. */
  lookup: (name: string) => Promise<readonly string[]>;
  now?: () => number;
  minLookupMs?: number;
  ttlMs?: number;
  lookupTimeoutMs?: number;
  /** How a waiting request waits for the next permitted lookup. Tests move their clock instead. */
  sleep?: (ms: number) => Promise<void>;
  onNote?: (note: TrustedProxyNote) => void;
}

/** How many peers a lookup refuted are remembered; past it the oldest is forgotten. */
const REFUTED_MAX = 256;

/**
 * ONE SPELLING PER ADDRESS: `::ffff:a.b.c.d` (and every other spelling of an IPv4-mapped address)
 * is `a.b.c.d`, IPv6 is lowercase and compressed, a zone id is dropped. A dual-stack listener
 * reports `::ffff:…` where a proxy writes plain IPv4, so without this one client is two buckets.
 * Anything that is not an address is `""`.
 */
export function canonicalIp(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const family = isIP(s);
  if (family === 4) return s;
  if (family !== 6) return "";
  let host: string;
  try {
    host = new URL(`http://[${s}]`).hostname.slice(1, -1);
  } catch {
    return "";
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!mapped) return host;
  const hi = parseInt(mapped[1]!, 16);
  const lo = parseInt(mapped[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** A Docker service or container name, a DNS name: letters, digits, `_`, `-`, dots between labels. */
const NAME_RE = /^(?=.{1,254}$)[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,62})(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,62}))*\.?$/;

/**
 * Parse one entry. An address or CIDR that does not parse is a PROBLEM (the boot refuses); a
 * well-formed name is never one, because whether it resolves is a fact about later, not about
 * the configuration. A string made only of digits and dots, or carrying a colon, is meant as an
 * address and is held to that.
 */
export function parseTrustedProxyEntry(raw: string): TrustedProxyEntry | { problem: string } {
  const entry = raw.trim();
  const slash = entry.indexOf("/");
  if (slash >= 0) {
    const network = canonicalIp(entry.slice(0, slash));
    const bits = entry.slice(slash + 1);
    if (network === "" || !/^\d{1,3}$/.test(bits)) return { problem: "a CIDR must be an address, a slash and a prefix length" };
    const v4 = isIP(network) === 4;
    // A mapped-IPv4 network was folded to IPv4 above; its prefix counts from the mapped bits.
    const mappedPrefix = v4 && isIP(entry.slice(0, slash).trim()) === 6 ? Number(bits) - 96 : Number(bits);
    if (mappedPrefix < 0 || mappedPrefix > (v4 ? 32 : 128)) return { problem: "the prefix length is out of range for the address" };
    return { kind: "cidr", network, prefix: mappedPrefix, family: v4 ? "ipv4" : "ipv6" };
  }
  const address = canonicalIp(entry);
  if (address !== "") return { kind: "address", address };
  if (/^[\d.]+$/.test(entry) || entry.includes(":") || entry.includes("[")) {
    return { problem: "it reads as an address but is not one" };
  }
  if (!NAME_RE.test(entry)) return { problem: "it is neither an address, a CIDR nor a host name" };
  return { kind: "name", name: entry.toLowerCase() };
}

/** The entries of one `TF_TRUSTED_PROXIES` value: commas and whitespace both separate. */
export function splitTrustedProxyList(raw: string): string[] {
  return raw.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Why an `OHMAIL_TLS_TERMINATOR` value is refused: a shape the proxy and the api read differently. */
export type TlsTerminatorRefusal = "comma" | "line" | "whitespace" | "mapped" | "word" | "malformed";

/**
 * An unset `OHMAIL_TLS_TERMINATOR`, here and in the proxy's entrypoint alike: nothing but space, tab,
 * line feed, carriage return, vertical tab, form feed and U+00A0 (proxy-entrypoint.sh tests the same
 * bytes). The proxy then takes its network's gateway; any other value is read as written, untrimmed.
 */
export const UNSET_TLS_TERMINATOR = /^[ \t\n\r\v\f\u00a0]*$/;

export type TlsTerminatorList =
  | { ok: true; entries: string[] }
  | { ok: false; refusal: TlsTerminatorRefusal; position: number };

/**
 * `OHMAIL_TLS_TERMINATOR` as the proxy reads it, Caddy's `trusted_proxies static` list, untrimmed:
 * only the shapes both read alike. Entries are IPv4 or IPv6 addresses or CIDRs as written, separated
 * by single spaces. Refused: a comma (the proxy will not start), a line break (a new proxy
 * directive), any other whitespace, an IPv4 address in IPv6 form (IPv6 to the proxy, IPv4 here), a
 * word (a Caddy keyword such as `private_ranges`, or a name) and anything else that is not a plain
 * address. {@link UNSET_TLS_TERMINATOR} is unset. `position` is 1-based, 0 for the whole value.
 */
export function parseTlsTerminatorList(raw: string): TlsTerminatorList {
  if (UNSET_TLS_TERMINATOR.test(raw)) return { ok: true, entries: [] };
  if (raw.includes(",")) return { ok: false, refusal: "comma", position: 0 };
  if (/[\r\n\v\f\u0085\u2028\u2029]/.test(raw)) return { ok: false, refusal: "line", position: 0 };
  if (!/^\S+(?: \S+)*$/.test(raw)) return { ok: false, refusal: "whitespace", position: 0 };
  const entries = raw.split(" ");
  for (const [i, entry] of entries.entries()) {
    const slash = entry.indexOf("/");
    const address = slash >= 0 ? entry.slice(0, slash) : entry;
    const family = address.includes("%") ? 0 : isIP(address);
    const refuse = (refusal: TlsTerminatorRefusal): TlsTerminatorList => ({ ok: false, refusal, position: i + 1 });
    if (family === 0) return refuse(/^[\d.]+$/.test(address) || /[:[\]%]/.test(address) ? "malformed" : "word");
    if (family === 6 && isIP(canonicalIp(address)) === 4) return refuse("mapped");
    if (slash >= 0) {
      const bits = entry.slice(slash + 1);
      if (!/^(?:0|[1-9]\d{0,2})$/.test(bits) || Number(bits) > (family === 4 ? 32 : 128)) return refuse("malformed");
    }
  }
  return { ok: true, entries };
}

/** The production lookup: every address the system resolver gives, `/etc/hosts` and Docker's included. */
export async function systemLookup(name: string): Promise<readonly string[]> {
  const answers = await dnsLookup(name, { all: true, verbatim: true });
  return answers.map((a) => a.address);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("lookup timed out")), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e: unknown) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * Build the set. Entries are the strings config already validated; a problem here is a
 * programming error and throws. Names share one cache: a refresh resolves every name, a failed
 * name contributes no address, and each change of a name's answer is noted once. A peer a
 * complete refresh did not return is REFUTED for the TTL and costs no further lookup, so the
 * server's own health check and its web container never spend the budget a recreated proxy needs.
 */
export function makeTrustedProxies(entries: readonly string[], opts: TrustedProxyOptions): TrustedProxies {
  const addresses = new Set<string>();
  const blocks = new BlockList();
  let blockCount = 0;
  const names: string[] = [];
  for (const raw of entries) {
    const parsed = parseTrustedProxyEntry(raw);
    if ("problem" in parsed) throw new Error(`trusted proxy entry is not usable: ${parsed.problem}`);
    if (parsed.kind === "address") addresses.add(parsed.address);
    else if (parsed.kind === "cidr") { blocks.addSubnet(parsed.network, parsed.prefix, parsed.family); blockCount++; }
    else if (!names.includes(parsed.name)) names.push(parsed.name);
  }
  const now = opts.now ?? Date.now;
  const minLookupMs = opts.minLookupMs ?? TRUSTED_PROXY_LOOKUP_MIN_MS;
  const ttlMs = opts.ttlMs ?? TRUSTED_PROXY_TTL_MS;
  const timeoutMs = opts.lookupTimeoutMs ?? TRUSTED_PROXY_LOOKUP_TIMEOUT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));

  const answered = new Map<string, string[] | null>();
  let resolved = new Set<string>();
  let resolvedAt = Number.NEGATIVE_INFINITY;
  let lastLookupAt = Number.NEGATIVE_INFINITY;
  let complete = false;
  let inflight: Promise<void> | null = null;
  let scheduled: Promise<void> | null = null;
  const refuted = new Map<string, number>();

  const staticHas = (ip: string): boolean =>
    addresses.has(ip) || (blockCount > 0 && blocks.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6"));

  const refresh = (): Promise<void> => {
    if (inflight) return inflight;
    lastLookupAt = now();
    inflight = (async () => {
      const next = new Set<string>();
      let all = true;
      for (const name of names) {
        let got: string[] | null;
        try {
          got = [...new Set((await withTimeout(opts.lookup(name), timeoutMs)).map(canonicalIp).filter((a) => a !== ""))].sort();
          if (got.length === 0) got = null;
        } catch {
          got = null; // a failed or timed-out lookup is an answer: this name contributes no address
        }
        if (got === null) all = false;
        const before = answered.get(name);
        answered.set(name, got);
        if (got !== null) {
          for (const a of got) next.add(a);
          if (before == null || before.join(",") !== got.join(",")) opts.onNote?.({ kind: "resolved", name, addresses: got });
        } else if (before !== null) {
          // `undefined` (never asked) and a resolved answer both change state; a repeat failure does not.
          opts.onNote?.({ kind: "unresolved", name });
        }
      }
      resolved = next;
      resolvedAt = now();
      complete = all;
    })().finally(() => { inflight = null; });
    return inflight;
  };

  /** The next permitted lookup, shared by every request waiting for it. */
  const nextSlot = (): Promise<void> => {
    scheduled ??= sleep(Math.max(0, lastLookupAt + minLookupMs - now()))
      .then(() => (now() - lastLookupAt >= minLookupMs ? refresh() : inflight ?? undefined))
      .finally(() => { scheduled = null; });
    return scheduled;
  };

  const refute = (ip: string): void => {
    refuted.delete(ip);
    if (refuted.size >= REFUTED_MAX) refuted.delete(refuted.keys().next().value!);
    refuted.set(ip, now());
  };

  const empty = addresses.size === 0 && blockCount === 0 && names.length === 0;
  return {
    empty,
    has: (ip) => ip !== "" && (staticHas(ip) || resolved.has(ip)),
    async trustsPeer(ip, forwarding = false) {
      if (ip === "" || empty) return false;
      try {
        if (staticHas(ip)) return true;
        if (names.length === 0) return false;
        const allowed = (): boolean => now() - lastLookupAt >= minLookupMs;
        if (resolved.has(ip)) {
          if (now() - resolvedAt < ttlMs) return true;
          // Past the TTL: look again if the budget allows; if it is spent, the cached proxy stays
          // trusted until the next lookup, which is at most one interval away.
          if (inflight) await inflight;
          else if (allowed()) await refresh();
          else return true;
          return resolved.has(ip);
        }
        // A miss. A peer a lookup refuted is not asked about again within the TTL unless it now
        // forwards (a proxy recreated at a reused address); a forwarder never judged waits for
        // the next permitted lookup; anything else takes the lookup the budget allows, or none.
        const refutedAt = refuted.get(ip);
        if (refutedAt !== undefined && now() - refutedAt < ttlMs && !forwarding) return false;
        if (inflight) await inflight;
        else if (allowed()) await refresh();
        else if (forwarding && refutedAt === undefined) await nextSlot();
        else return false;
        if (resolved.has(ip)) return true;
        if (complete) refute(ip);
        return false;
      } catch {
        return false;
      }
    },
  };
}
