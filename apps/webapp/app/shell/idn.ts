/**
 * Internationalized domains, for the screen only. {@link displayAddress} answers what a HUMAN
 * should read — applied at render sites only, never before a mutation, a rule match, a screening
 * identity, a dedup key, or anything that reaches SMTP/IMAP or the API: those keep the stored
 * A-label form for ever. The decode is one-way, and the two places an address is both shown and
 * typed (compose recipients, the connect form) are left alone — their content IS the wire value.
 */

/**
 * The LOCAL PART is never touched: SMTPUTF8 local parts arrive as UTF-8 already. Hand-rolled
 * because the browser bundle has no ToUnicode (`new URL` applies ToASCII); the decoder is total —
 * every failure falls back to the RAW label, since an unrecognisable address is a smaller defect
 * than a wrong one.
 */

/**
 * The homograph tradeoff, taken deliberately: rendering Unicode domains makes lookalike confusion
 * possible, and that is accepted because this is a MAIL CLIENT, not a URL bar — no navigation, no
 * credential prompt, no origin decision hangs off the glyphs, and the reader has the Screener, the
 * rules and the full address in the details block. Confusability scoring is out of scope. What IS
 * enforced, because it is structural: a decoded label may not smuggle characters that change what
 * the address APPEARS TO BE — no ASCII, no label separators in any Unicode spelling, no whitespace,
 * no controls, no bidi overrides; such a label is rejected and shown raw. Without that rule a
 * crafted label could decode to text containing "@" or "." and impersonate a different domain.
 */

const BASE = 36;
const TMIN = 1;
const TMAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
/** RFC 3492's initial `n`: the first code point above ASCII. */
const INITIAL_N = 128;
const MAX_INT = 0x7fffffff;

/** The A-label marker, as IDNA fixes it: `xn--`, matched case-insensitively. */
const ACE_PREFIX = "xn--";

/** A basic code point's digit value, or {@link BASE} for anything that is not one. */
function digitOf(cp: number): number {
  if (cp >= 0x30 && cp <= 0x39) return cp - 0x30 + 26; // 0-9 → 26..35
  if (cp >= 0x41 && cp <= 0x5a) return cp - 0x41; // A-Z → 0..25
  if (cp >= 0x61 && cp <= 0x7a) return cp - 0x61; // a-z → 0..25
  return BASE;
}

/** RFC 3492 §6.1, verbatim. */
function adapt(delta: number, numPoints: number, firstTime: boolean): number {
  let d = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((BASE - TMIN) * TMAX) >> 1) {
    d = Math.floor(d / (BASE - TMIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - TMIN + 1) * d) / (d + SKEW));
}

/**
 * May this decoded label be shown? — the structural policy from the header, in one pass. The rule
 * is deliberately narrow and not a confusability judgement: an A-label's Unicode form may contain
 * LDH ASCII (all a punycode literal segment can legally hold) plus non-ASCII that is neither a
 * label separator in any Unicode spelling, nor whitespace, nor a control, nor a bidi override —
 * anything else and the caller shows the raw `xn--…`. "At least one non-ASCII" is the other half:
 * a label decoding to pure ASCII had no reason to be encoded (`xn--a.b-` decodes to `a.b`, two
 * labels wearing the mask of one), so a pure-ASCII decode is treated as malformed.
 */
function isDisplayable(decoded: string): boolean {
  let sawNonAscii = false;
  for (const ch of decoded) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) {
      // Only what a DNS label may hold: letters, digits, hyphen. Never ".", "@", "/", ":" or a control.
      const ldh =
        (cp >= 0x61 && cp <= 0x7a) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x30 && cp <= 0x39) || cp === 0x2d;
      if (!ldh) return false;
      continue;
    }
    sawNonAscii = true;
    if (cp === 0x3002 || cp === 0xff0e || cp === 0xff61) return false; // ideographic / fullwidth / halfwidth stop
    if (cp <= 0x9f) return false; // the U+0080–U+009F control block
    if (cp === 0x00a0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a)) return false; // spaces
    if (cp >= 0x200b && cp <= 0x200f) return false; // zero-width and LRM/RLM
    if (cp >= 0x2028 && cp <= 0x202e) return false; // line/para separators and bidi overrides
    if (cp >= 0x205f && cp <= 0x2064) return false; // math space and invisible operators
    if (cp >= 0x2066 && cp <= 0x2069) return false; // isolate controls
    if (cp === 0x3000 || cp === 0xfeff) return false; // ideographic space, BOM
  }
  return sawNonAscii;
}

/**
 * One punycode-encoded label (the part AFTER `xn--`) → its Unicode form, or `null` when the
 * input is not a well-formed encoding. `null` is the only failure channel; nothing throws.
 */
function decodeLabel(encoded: string): string | null {
  if (encoded === "") return null;
  const out: number[] = [];
  // The delimiter separates the literal basic code points from the encoded remainder. At index 0
  // it is not a delimiter (RFC 3492's "if there is no delimiter" case, spelled with a leading
  // hyphen), so `> 0` rather than `>= 0`.
  const delim = encoded.lastIndexOf("-");
  let idx = 0;
  if (delim > 0) {
    for (let i = 0; i < delim; i++) {
      const c = encoded.charCodeAt(i);
      if (c > 0x7f) return null; // a basic segment is ASCII by definition
      out.push(c);
    }
    idx = delim + 1;
  }
  let n = INITIAL_N;
  let bias = INITIAL_BIAS;
  let i = 0;
  while (idx < encoded.length) {
    const oldi = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (idx >= encoded.length) return null; // truncated variable-length integer
      const d = digitOf(encoded.charCodeAt(idx++));
      if (d >= BASE) return null; // not a basic code point
      if (d > Math.floor((MAX_INT - i) / w)) return null; // overflow
      i += d * w;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (d < t) break;
      if (w > Math.floor(MAX_INT / (BASE - t))) return null; // overflow
      w *= BASE - t;
    }
    const outLen = out.length + 1;
    bias = adapt(i - oldi, outLen, oldi === 0);
    if (Math.floor(i / outLen) > MAX_INT - n) return null; // overflow
    n += Math.floor(i / outLen);
    i %= outLen;
    // `String.fromCodePoint` throws outside this range, and this function's contract is that it
    // never throws. The display policy itself is applied once, below.
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
    out.splice(i++, 0, n);
  }
  if (out.length === 0) return null;
  const decoded = String.fromCodePoint(...out);
  return isDisplayable(decoded) ? decoded : null;
}

/**
 * A DOMAIN, AS A HUMAN SHOULD READ IT. `xn--gtsch-jua.ch` → `götsch.ch`.
 *
 * Labels without the ACE prefix pass through untouched, and a domain in which nothing decodes is
 * returned as the very same string — so an ASCII domain is byte-identical, not merely equal.
 */
export function displayDomain(domain: string): string {
  if (domain.length < ACE_PREFIX.length) return domain;
  // Cheap reject before any splitting: the overwhelming majority of domains have no A-label.
  if (!domain.toLowerCase().includes(ACE_PREFIX)) return domain;
  const labels = domain.split(".");
  let changed = false;
  const shown = labels.map((label) => {
    if (!label.toLowerCase().startsWith(ACE_PREFIX)) return label;
    const decoded = decodeLabel(label.slice(ACE_PREFIX.length));
    if (decoded === null) return label;
    changed = true;
    return decoded;
  });
  return changed ? shown.join(".") : domain;
}

/**
 * AN ADDRESS, AS A HUMAN SHOULD READ IT — the domain half decoded, the local part verbatim.
 *
 * `lastIndexOf("@")` because a quoted local part may legally contain one; the domain is what
 * follows the LAST. Anything without an `@`, and anything whose domain holds no decodable
 * A-label, comes back as the identical string.
 *
 * NEVER call this on a value heading for a mutation, an envelope, a rule, or a hue. See the
 * header: this is the display side of a deliberate display/identity split.
 */
export function displayAddress(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 0) return address;
  const domain = address.slice(at + 1);
  const shown = displayDomain(domain);
  return shown === domain ? address : address.slice(0, at + 1) + shown;
}

/**
 * A person, as a line names them: their display name when they have one, else their address in
 * readable form. The shape `senderName`/`foldRecipient` and half the Screener's rows repeat by
 * hand; centralised so the decode cannot be forgotten at the next one.
 */
export function displayAddressee(name: string | null | undefined, address: string): string {
  return name || displayAddress(address);
}

/**
 * The address UNDER the name — readable, and `undefined` when the name already said it.
 *
 * The counterpart of {@link displayAddressee}, and the same rule `format.ts`'s `rowAddress`
 * documents: printing both when the name IS the address says it twice in one line.
 */
export function displayAddressUnder(
  name: string | null | undefined,
  address: string,
): string | undefined {
  return name ? displayAddress(address) : undefined;
}

/**
 * A RULE'S MATCH, READABLY — the one place a value is either an address or a bare domain.
 *
 * `RuleDTO.match` carries `someone@müller.example` for a sender rule and `müller.example` for a
 * domain rule, and {@link displayAddress} deliberately passes anything without an `@` through
 * untouched, so the two need telling apart here rather than by widening that contract.
 */
export function displayRuleMatch(match: string): string {
  return match.includes("@") ? displayAddress(match) : displayDomain(match);
}

/**
 * A WHOLE-DOMAIN LABEL — "@müller.example" from any address on it.
 *
 * The Screener's domain scope and its confirmation copy both name the domain rather than the
 * person, and the "@" prefix is what distinguishes "everyone at this domain" from one sender.
 * Falls back to the readable whole address when there is no domain half to take, which is what
 * every hand-written copy of this expression already did.
 */
export function displayDomainLabel(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 0) return displayAddress(address);
  return "@" + displayDomain(address.slice(at + 1));
}
