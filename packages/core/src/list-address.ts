import { headerValues } from "./rules.js";

/** The address shape a Sent copy's recipients are taught under (`pipeline.ts#sentCopyRecipients`). */
export const ADDRESS_SHAPE = /^[^\s@<>,"]+@[^\s@<>,"]+$/;

/** One stored message names at most this many list addresses. */
export const LIST_POST_ADDRESSES_MAX = 5;

/**
 * THE ADDRESSES A MAILING LIST POSTS AS, from `List-Post` (RFC 2369 §3.4): each `mailto:` URL, its
 * query cut and its address percent-decoded, its domain read as the parser reads a From's
 * ({@link parserDomain}), lower-cased, kept only when address-shaped. `NO` (posting not allowed) is
 * no URL and names nothing. Whitespace inside a URL is ignored, as the RFC says, so a folded line
 * reads whole; outside angle brackets a comment is dropped. The one parser: every reader of a list
 * address calls it, and none respells it.
 */
export function listPostAddresses(headers: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const value of headerValues(headers, "list-post") ?? []) {
    const urls = value.includes("<")
      ? [...value.matchAll(/<([^<>]*)>/g)].map((m) => m[1]!)
      : value.replace(/\([^()]*\)/g, " ").split(",");
    for (const url of urls) {
      const target = /^mailto:([^?]*)/i.exec(url.replace(/\s+/g, ""))?.[1];
      for (const part of target?.split(",") ?? []) {
        const decoded = percentDecoded(part)?.trim();
        const address = decoded === undefined ? undefined : parserDomain(decoded).toLowerCase();
        if (address === undefined || !ADDRESS_SHAPE.test(address) || out.includes(address)) continue;
        out.push(address);
        if (out.length === LIST_POST_ADDRESSES_MAX) return out;
      }
    }
  }
  return out;
}

/** `undefined` for a malformed escape: no address is read out of bytes that do not decode. */
function percentDecoded(s: string): string | undefined {
  try { return decodeURIComponent(s); } catch { return undefined; }
}

/**
 * THE PARSER'S RULE FOR AN ADDRESS'S DOMAIN (mailparser 3.9.32, which hands the gate every From):
 * an address containing `@xn--`, in that case, has the domain after its last `@` read by
 * punycode.js 2.3.1's `toUnicode`, and keeps its spelling when that throws. Before the lower-casing,
 * so an `XN--` or a punycode label that is not the first after the `@` stays ASCII, as it does there.
 */
function parserDomain(address: string): string {
  if (!/@xn--/.test(address)) return address;
  const at = address.lastIndexOf("@");
  try {
    return address.slice(0, at + 1) + domainToUnicode(address.slice(at + 1));
  } catch {
    return address;
  }
}

/** punycode.js 2.3.1's `toUnicode` over a domain: the RFC 3490 separators read as `.`, each `xn--` label decoded. */
function domainToUnicode(domain: string): string {
  return domain.replace(/[。．｡]/g, ".").split(".")
    .map((label) => (/^xn--/.test(label) ? punycodeDecode(label.slice(4).toLowerCase()) : label))
    .join(".");
}

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const MAX_INT = 0x7fffffff;

/** RFC 3492 §6.1. */
function adapt(delta: number, points: number, first: boolean): number {
  let d = first ? Math.floor(delta / 700) : delta >> 1;
  d += Math.floor(d / points);
  let k = 0;
  for (; d > ((BASE - T_MIN) * T_MAX) >> 1; k += BASE) d = Math.floor(d / (BASE - T_MIN));
  return Math.floor(k + ((BASE - T_MIN + 1) * d) / (d + 38));
}

/** A basic code point's digit value, or {@link BASE} when it is none. */
function digitOf(code: number): number {
  if (code >= 0x30 && code < 0x3a) return code - 0x30 + 26;
  if (code >= 0x41 && code < 0x5b) return code - 0x41;
  if (code >= 0x61 && code < 0x7b) return code - 0x61;
  return BASE;
}

/** RFC 3492 decoding as punycode.js 2.3.1 does it, throwing where it throws. */
function punycodeDecode(input: string): string {
  const output: number[] = [];
  const basic = Math.max(0, input.lastIndexOf("-"));
  for (let j = 0; j < basic; j++) {
    if (input.charCodeAt(j) >= 0x80) throw new RangeError("not-basic");
    output.push(input.charCodeAt(j));
  }
  let i = 0;
  let n = 0x80;
  let bias = 72;
  for (let index = basic > 0 ? basic + 1 : 0; index < input.length;) {
    const oldi = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (index >= input.length) throw new RangeError("invalid-input");
      const digit = digitOf(input.charCodeAt(index++));
      if (digit >= BASE || digit > Math.floor((MAX_INT - i) / w)) throw new RangeError("invalid-input");
      i += digit * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) break;
      if (w > Math.floor(MAX_INT / (BASE - t))) throw new RangeError("overflow");
      w *= BASE - t;
    }
    const out = output.length + 1;
    bias = adapt(i - oldi, out, oldi === 0);
    if (Math.floor(i / out) > MAX_INT - n) throw new RangeError("overflow");
    n += Math.floor(i / out);
    i %= out;
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}
