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

/** What the approval read answers about the two networks; never either class itself. */
export type NetworkVerdict = "same" | "different" | "unknown";

/**
 * Is a reader at `readerIp` on the network a request's stored class names? A class missing on
 * either side is `unknown`, never `different`. Two classes of different families are `different`:
 * one machine can reach a server over both, but whoever crafts a request must not be able to pick
 * the family that keeps the note off the page, and the page's sentence holds either way.
 */
export function networkVerdict(storedClass: string | null | undefined, readerIp: string | null | undefined): NetworkVerdict {
  const stored = (storedClass ?? "").trim();
  const reader = ipClassOf(readerIp);
  if (familyOf(stored) === null || familyOf(reader) === null) return "unknown";
  return stored === reader ? "same" : "different";
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
