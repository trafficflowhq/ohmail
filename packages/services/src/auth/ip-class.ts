import { isIP } from "node:net";

/**
 * The NETWORK a request came from, never the address: the first two IPv4 octets as `a.b.x.x`, or
 * the IPv6 /48 as `p:q:r::/48` (an IPv4-mapped IPv6 address is read as the IPv4 it carries). It
 * is what the approval page shows beside a computer's name and what the row keeps at rest, so a
 * person can tell "my own network" from "somewhere else" and nothing identifies a single host.
 * An empty or unparseable input answers `""`.
 */
export function ipClassOf(raw: string | null | undefined): string {
  const ip = (raw ?? "").trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const v4 = mapped ? mapped[1]! : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".");
    return `${a}.${b}.x.x`;
  }
  if (isIP(ip) !== 6) return "";
  const groups = expandV6(ip);
  if (!groups) return "";
  return `${groups.slice(0, 3).join(":")}::/48`;
}

/** What the approval read answers about the two networks; never either class itself. */
export type NetworkVerdict = "same" | "different" | "unknown";

/**
 * Is a reader at `readerIp` on the network a request's stored class names? Only two classes of
 * one family are compared: a class missing on either side, or an IPv4 class against an IPv6 one
 * (one machine can reach a server over both), is `unknown`, never `different`.
 */
export function networkVerdict(storedClass: string | null | undefined, readerIp: string | null | undefined): NetworkVerdict {
  const stored = (storedClass ?? "").trim();
  const reader = ipClassOf(readerIp);
  const family = familyOf(stored);
  if (family === null || family !== familyOf(reader)) return "unknown";
  return stored === reader ? "same" : "different";
}

/** The family a class was written for by `ipClassOf`, or null for an empty or foreign one. */
function familyOf(cls: string): 4 | 6 | null {
  if (cls.endsWith(".x.x")) return 4;
  if (cls.endsWith("::/48")) return 6;
  return null;
}

/** The eight hextets of a valid IPv6 literal, lowercase and without leading zeros. */
function expandV6(ip: string): string[] | null {
  const bare = ip.split("%")[0]!;
  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  // An embedded IPv4 tail counts as two hextets; only the /48 is read, so its value is not needed.
  const width = (parts: string[]): number => parts.reduce((n, p) => n + (p.includes(".") ? 2 : 1), 0);
  const fill = halves.length === 2 ? 8 - width(head) - width(tail) : 0;
  const all = [...head, ...Array<string>(Math.max(0, fill)).fill("0"), ...tail];
  if (all.length < 3) return null;
  return all.map((g) => (g.includes(".") ? g : (Number.parseInt(g, 16) || 0).toString(16)));
}
