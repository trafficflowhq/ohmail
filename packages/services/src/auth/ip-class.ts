import { isIP } from "node:net";

/**
 * The NETWORK a request came from, never the address: the first two IPv4 octets as `a.b.x.x`, or
 * the IPv6 /48 as `p:q:r::/48` (an IPv4-mapped IPv6 address, in any spelling, is read as the IPv4
 * it carries). It is what the approval page shows beside a computer's name and what the row keeps
 * at rest, so a person can tell "my own network" from "somewhere else" and nothing identifies a
 * single host. An empty or unparseable input answers `""`.
 */
export function ipClassOf(raw: string | null | undefined): string {
  const ip = (raw ?? "").trim();
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".");
    return `${a}.${b}.x.x`;
  }
  if (isIP(ip) !== 6) return "";
  const groups = hextetsOf(ip);
  if (!groups) return "";
  // `::ffff:0:0/96`: `::ffff:a.b.c.d`, `0:0:0:0:0:ffff:a.b.c.d` and `::ffff:hhhh:hhhh` alike.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 0xff}.x.x`;
  }
  return `${groups.slice(0, 3).map((g) => g.toString(16)).join(":")}::/48`;
}

/**
 * What `same` is decided on: the whole IPv4 address (an IPv4-mapped IPv6 address, in any spelling,
 * as the IPv4 it carries), or the IPv6 /64 as `p:q:r:s::/64`. Never stored or returned, only its
 * keyed digest. An empty or unparseable input answers `""`.
 */
export function addressUnitOf(raw: string | null | undefined): string {
  const ip = (raw ?? "").trim();
  if (isIP(ip) === 4) return ip; // node rejects leading-zero spellings: canonical
  if (isIP(ip) !== 6) return "";
  const g = hextetsOf(ip);
  if (!g) return "";
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

/** What the approval read answers about the two networks; never either class itself. */
export type NetworkVerdict = "same" | "different" | "unknown";

/**
 * Is a reader at `readerIp` at the address a request was made from (over IPv6, in its /64)?
 * `storedKey` is the request's keyed digest of that unit, and `keyOf` digests the reader's the same
 * way. A class or a reader address missing is `unknown`, never `different`. A row kept without the
 * key never reads `same`. Two families are `different`: one machine can reach a server over both,
 * but whoever crafts a request must not be able to pick the family that keeps the note off the
 * page, and the page's sentence holds either way.
 */
export function networkVerdict(
  storedClass: string | null | undefined, storedKey: string | null | undefined,
  readerIp: string | null | undefined, keyOf: (unit: string) => string,
): NetworkVerdict {
  const cls = (storedClass ?? "").trim();
  const key = (storedKey ?? "").trim();
  const unit = addressUnitOf(readerIp);
  if (familyOf(cls) === null || unit === "") return "unknown";
  if (key === "") return cls === ipClassOf(readerIp) ? "unknown" : "different";
  return keyOf(unit) === key ? "same" : "different";
}

/** The family a class was written for by `ipClassOf`, or null for an empty or foreign one. */
function familyOf(cls: string): 4 | 6 | null {
  if (cls.endsWith(".x.x")) return 4;
  if (cls.endsWith("::/48")) return 6;
  return null;
}

/** The eight hextets of a valid IPv6 literal (`isIP` said 6), an embedded IPv4 tail included. */
function hextetsOf(ip: string): number[] | null {
  let bare = ip.split("%")[0]!;
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(bare);
  if (quad) {
    const [a, b, c, d] = quad.slice(1).map(Number) as [number, number, number, number];
    bare = `${bare.slice(0, quad.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const all = [...head, ...Array<string>(Math.max(0, fill)).fill("0"), ...tail];
  if (all.length !== 8) return null;
  const out = all.map((g) => Number.parseInt(g, 16));
  return out.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? out : null;
}
