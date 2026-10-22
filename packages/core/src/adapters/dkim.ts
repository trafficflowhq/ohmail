import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import type { NormalizedMessage } from "../types.js";

/**
 * THE SENDER'S OWN DKIM SIGNATURE, checked at ingest where the mailbox's provider writes no
 * `Authentication-Results` ohmail believes (`authserv-ids.ts`). RFC 6376, with RFC 8463 (EdDSA) and
 * RFC 8301 (no sha1, no key under 1024 bits).
 *
 * The answer is `pass` or `unavailable`, never `fail`: a broken signature is no evidence against the
 * author (lists and forwarders break them), and routing reads `fail` alone. `pass` needs every rule
 * below; anything unusual is `unavailable`. Only the aligned-DKIM half of DMARC is here: SPF judges
 * the connecting address, which only the receiving server saw, so it cannot be checked from IMAP.
 * Injected into the plan step by the Node compositions; nothing imports it by default.
 */

/** One TXT lookup's answer: the records (chunks joined), none, or a failure to ask. */
export type DkimKeyAnswer =
  | { kind: "records"; records: readonly string[] }
  | { kind: "none" }
  | { kind: "error" };

/** The TXT lookup of `<selector>._domainkey.<domain>` (`dkim-keys.ts` in production). */
export interface DkimKeyLookup {
  lookup(name: string): Promise<DkimKeyAnswer>;
}

/** Why a letter read what it read — logged and tested, never shown. A closed list. */
export const SIGNATURE_REASONS = [
  "pass", "too_large", "header_block", "from", "parser_disagrees", "no_signature", "malformed",
  "algorithm", "identity", "unaligned", "coverage", "body_length", "body_hash", "expired",
  "key_none", "key_error", "key_budget", "key_invalid", "key_testing", "key_strict", "key_size",
  "bad_signature", "fault",
] as const;
export type SignatureReason = (typeof SIGNATURE_REASONS)[number];

export interface SignatureResult {
  verdict: "pass" | "unavailable";
  reason: SignatureReason;
}

/**
 * One mailbox cycle's allowance of time spent waiting on key lookups, shared by every letter the
 * cycle plans. Each lookup is given at most what is left and charged what it took; once it is spent,
 * a letter that needs a lookup reads `key_budget` without one.
 */
export interface LookupBudget {
  remainingMs: number;
}

export interface SignatureCheck {
  /**
   * `raw` is the message as the server holds it; `msg` is ohmail's own parse of the same bytes;
   * `budget` is the cycle's lookup allowance (absent: each lookup has its own deadline only).
   */
  check(raw: Buffer, msg: NormalizedMessage, budget?: LookupBudget): Promise<SignatureResult>;
  /** The clock expiry is judged by. */
  now(): Date;
  /** A fresh lookup allowance for one mailbox cycle. */
  cycleBudget(): LookupBudget;
}

/** The largest message checked. */
export const MAX_SIGNED_BYTES = 4 * 1024 * 1024;
/** Aligned signatures tried per letter: each may cost a lookup. */
const MAX_CANDIDATES = 2;
/** A backstop for a lookup that never answers; the DNS lookup's own deadline is shorter. */
const LOOKUP_DEADLINE_MS = 3_000;
/**
 * What one mailbox cycle may spend waiting on key lookups, whatever its letters name: two of the
 * DNS lookup's deadlines. A page is up to 200 letters planned one after another, and their senders
 * choose the domains; past this the rest of the page reads `unavailable`, as it did before the check.
 */
const CYCLE_LOOKUP_MS = 4_000;
/** The most header names one `h=` may list: real signers list a few dozen. */
const MAX_SIGNED_NAMES = 256;

const FIELD_NAME = /^[\x21-\x39\x3b-\x7e]+$/;
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** Lower-case LDH labels, one or more. */
const DOMAIN = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const FWS = /[ \t\r\n]/g;
/** The SPKI prefix of a bare 32-byte Ed25519 public key. */
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

interface Field {
  /** Lower-case name. */
  name: string;
  /** The whole field as it stands, folds included, without its final CRLF (latin1). */
  raw: string;
}

interface Candidate {
  field: Field;
  a: "rsa-sha256" | "ed25519-sha256";
  header: "simple" | "relaxed";
  body: "simple" | "relaxed";
  domain: string;
  selector: string;
  /** The `i=` domain, or `d=` when absent. */
  identity: string;
  signed: string[];
  bh: Buffer;
  b: Buffer;
  l?: number;
  x?: number;
}

const unavailable = (reason: SignatureReason): SignatureResult => ({ verdict: "unavailable", reason });

/** What one check asks keys of, and within what. */
interface Asking {
  keys: DkimKeyLookup;
  now: Date;
  deadline: number;
  budget: LookupBudget | undefined;
}

export function makeSignatureCheck(deps: {
  keys: DkimKeyLookup;
  now?: () => Date;
  /** Test seam: the backstop deadline on one lookup. */
  lookupDeadlineMs?: number;
  /** Test seam: what one cycle's budget holds. */
  cycleLookupMs?: number;
}): SignatureCheck {
  const now = deps.now ?? (() => new Date());
  const deadline = deps.lookupDeadlineMs ?? LOOKUP_DEADLINE_MS;
  const cycleMs = deps.cycleLookupMs ?? CYCLE_LOOKUP_MS;
  return {
    now,
    cycleBudget: () => ({ remainingMs: cycleMs }),
    async check(raw, msg, budget) {
      try {
        return await checkSignature(raw, msg, { keys: deps.keys, now: now(), deadline, budget });
      } catch {
        return unavailable("fault");
      }
    },
  };
}

async function checkSignature(raw: Buffer, msg: NormalizedMessage, asking: Asking): Promise<SignatureResult> {
  if (raw.length > MAX_SIGNED_BYTES) return unavailable("too_large");
  const text = raw.toString("latin1");
  const end = text.startsWith("\r\n") ? -1 : text.indexOf("\r\n\r\n");
  if (end < 0) return unavailable("header_block");
  const fields = headerFields(text.slice(0, end + 2));
  if (fields === null) return unavailable("header_block");
  const body = text.slice(end + 4);

  // The From the signature vouches for must be the one ohmail shows and acts on.
  const froms = fields.filter((f) => f.name === "from");
  if (froms.length !== 1 || parsedCount(msg, "from") !== 1) return unavailable("from");
  const shown = msg.from.address;
  if (shown === "" || soleAddress(valueOf(froms[0]!)) !== shown) return unavailable("from");
  const fromDomain = shown.slice(shown.lastIndexOf("@") + 1);
  if (!DOMAIN.test(fromDomain) || !fromDomain.includes(".")) return unavailable("from");
  for (const name of ["subject", "list-unsubscribe", "list-unsubscribe-post"]) {
    if (count(fields, name) !== parsedCount(msg, name)) return unavailable("parser_disagrees");
  }

  const signatures = fields.filter((f) => f.name === "dkim-signature");
  if (signatures.length === 0) return unavailable("no_signature");
  const byName = new Map<string, Field[]>();
  for (const f of fields) {
    const same = byName.get(f.name);
    if (same === undefined) byName.set(f.name, [f]);
    else same.push(f);
  }
  let refusal: SignatureReason | null = null;
  const candidates: Candidate[] = [];
  for (const field of signatures) {
    const judged = judge(field, fromDomain);
    if (typeof judged === "string") {
      refusal ??= judged;
      continue;
    }
    candidates.push(judged);
    if (candidates.length === MAX_CANDIDATES) break;
  }
  if (candidates.length === 0) return unavailable(refusal ?? "unaligned");

  // A domain whose lookup just failed is not asked again for the letter's other signature: its
  // name servers would be waited out twice.
  const failed = new Set<string>();
  let first: SignatureReason | null = null;
  for (const c of candidates) {
    const reason = failed.has(c.domain) ? "key_error" : await verifyOne(c, byName, body, asking);
    if (reason === "pass") return { verdict: "pass", reason: "pass" };
    if (reason === "key_error") failed.add(c.domain);
    first ??= reason;
  }
  return unavailable(first ?? "bad_signature");
}

/** The header block's fields: CRLF lines only, no NUL, every line `name:` or a fold. */
function headerFields(head: string): Field[] | null {
  for (let i = 0; i < head.length; i++) {
    const c = head.charCodeAt(i);
    if (c === 0) return null;
    if (c === 13 && head.charCodeAt(i + 1) !== 10) return null;
    if (c === 10 && head.charCodeAt(i - 1) !== 13) return null;
  }
  const lines = head.split("\r\n");
  lines.pop();
  const fields: Field[] = [];
  for (const line of lines) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      const last = fields[fields.length - 1];
      if (last === undefined) return null;
      last.raw += `\r\n${line}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0 || !FIELD_NAME.test(line.slice(0, colon))) return null;
    fields.push({ name: line.slice(0, colon).toLowerCase(), raw: line });
  }
  return fields;
}

const count = (fields: readonly Field[], name: string): number => fields.filter((f) => f.name === name).length;

function parsedCount(msg: NormalizedMessage, name: string): number {
  if (!Object.prototype.hasOwnProperty.call(msg.headers, name)) return 0;
  const v = (msg.headers as Record<string, unknown>)[name];
  return Array.isArray(v) ? v.length : 0;
}

/** A field's value, unfolded. */
const valueOf = (f: Field): string => f.raw.slice(f.raw.indexOf(":") + 1).replace(/\r\n/g, "");

/** `s` without leading and trailing characters of `set`, by index: a trimming regex can backtrack. */
function trim(s: string, set = " \t\r\n"): string {
  let a = 0;
  let b = s.length;
  while (a < b && set.includes(s[a]!)) a++;
  while (b > a && set.includes(s[b - 1]!)) b--;
  return s.slice(a, b);
}

/**
 * The one address a From value holds, lower-cased, or `null`: quoted strings and comments set aside,
 * what is left must name exactly one `@` and no list, group or route.
 */
function soleAddress(value: string): string | null {
  let rest = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quoted) {
      if (c === "\\") i++;
      else if (c === "\"") quoted = false;
      continue;
    }
    if (depth > 0) {
      if (c === "\\") i++;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
      continue;
    }
    if (c === "\"") quoted = true;
    else if (c === "(") depth = 1;
    else if (c === ")") return null;
    else rest += c;
  }
  if (quoted || depth > 0 || /[,;:]/.test(rest) || rest.split("@").length !== 2) return null;
  const lt = rest.indexOf("<");
  let address = rest;
  if (lt >= 0) {
    const gt = rest.indexOf(">", lt);
    if (gt < 0 || rest.indexOf("<", lt + 1) >= 0 || rest.indexOf(">", gt + 1) >= 0) return null;
    if (rest.slice(gt + 1).trim() !== "") return null;
    address = rest.slice(lt + 1, gt);
  } else if (rest.includes(">")) {
    return null;
  }
  address = trim(address, " \t").toLowerCase();
  return address === "" || /[ \t<>]/.test(address) ? null : address;
}

/** RFC 6376 §3.2 tag-list: names case-sensitive, no repeats, values trimmed of FWS. */
function tagList(value: string): Map<string, string> | null {
  const tags = new Map<string, string>();
  const parts = value.split(";");
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k]!;
    if (part.replace(FWS, "") === "") {
      if (k === parts.length - 1 && k > 0) continue;
      return null;
    }
    const eq = part.indexOf("=");
    if (eq < 0) return null;
    const name = part.slice(0, eq).replace(FWS, "");
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || tags.has(name)) return null;
    const val = trim(part.slice(eq + 1));
    if (/[^\x21-\x3a\x3c-\x7e \t\r\n]/.test(val)) return null;
    tags.set(name, val);
  }
  return tags;
}

const list = (v: string): string[] => v.split(":").map((s) => s.replace(FWS, ""));

function base64Of(v: string): Buffer | null {
  const s = v.replace(FWS, "");
  return s !== "" && BASE64.test(s) ? Buffer.from(s, "base64") : null;
}

function numberOf(v: string | undefined, digits: number): number | null | undefined {
  if (v === undefined) return undefined;
  return new RegExp(`^[0-9]{1,${digits}}$`).test(v) ? Number(v) : null;
}

/** Does this signature count, and is it aligned with the From? A candidate, or why not. */
function judge(field: Field, fromDomain: string): Candidate | SignatureReason {
  const tags = tagList(valueOf(field));
  if (tags === null) return "malformed";
  const [v, a, d, s, h] = ["v", "a", "d", "s", "h"].map((k) => tags.get(k));
  const bh = base64Of(tags.get("bh") ?? "");
  const b = base64Of(tags.get("b") ?? "");
  if (v === undefined || a === undefined || d === undefined || s === undefined || h === undefined || bh === null || b === null) {
    return "malformed";
  }
  if (v !== "1" || (a !== "rsa-sha256" && a !== "ed25519-sha256")) return "algorithm";
  const q = tags.get("q");
  if (q !== undefined && q !== "dns/txt") return "algorithm";
  const [header = "simple", body = "simple", ...extra] = (tags.get("c") ?? "simple/simple").split("/");
  if (extra.length > 0 || (header !== "simple" && header !== "relaxed") || (body !== "simple" && body !== "relaxed")) {
    return "algorithm";
  }
  const domain = d.toLowerCase();
  const selector = s.toLowerCase();
  if (!DOMAIN.test(domain) || !DOMAIN.test(selector) || `${selector}._domainkey.${domain}`.length > 253) return "malformed";
  const signed = list(h).map((n) => n.toLowerCase());
  if (signed.length > MAX_SIGNED_NAMES || signed.some((n) => !FIELD_NAME.test(n))) return "malformed";
  if (!signed.includes("from")) return "coverage";

  const i = tags.get("i");
  let identity = domain;
  if (i !== undefined) {
    const at = i.lastIndexOf("@");
    identity = at < 0 ? "" : i.slice(at + 1).toLowerCase();
    if (!DOMAIN.test(identity)) return "malformed";
  }
  if (identity !== domain && !identity.endsWith(`.${domain}`)) return "identity";
  // Equal to the From domain or a parent of it, of two labels or more: stricter than DMARC's
  // relaxed alignment, which would need the public suffix list to tell siblings apart.
  if (!domain.includes(".") || (fromDomain !== domain && !fromDomain.endsWith(`.${domain}`))) return "unaligned";

  const l = numberOf(tags.get("l"), 76);
  const t = numberOf(tags.get("t"), 12);
  const x = numberOf(tags.get("x"), 12);
  if (l === null || t === null || x === null) return "malformed";
  if (t !== undefined && x !== undefined && x < t) return "malformed";
  return {
    field, a, header, body, domain, selector, identity, signed, bh, b,
    ...(l !== undefined ? { l } : {}), ...(x !== undefined ? { x } : {}),
  };
}

async function verifyOne(
  c: Candidate, byName: ReadonlyMap<string, readonly Field[]>, body: string, asking: Asking,
): Promise<SignatureReason> {
  // The copies of a header the signature could have signed: never itself.
  const others = (byName.get(c.field.name) ?? []).filter((f) => f !== c.field);
  const copies = (name: string): readonly Field[] => (name === c.field.name ? others : byName.get(name) ?? []);
  // What a replay could add without breaking the signature: a Subject, a list header, a second copy.
  const listed = new Map<string, number>();
  for (const n of c.signed) listed.set(n, (listed.get(n) ?? 0) + 1);
  const present = (name: string): number => copies(name).length;
  if (present("subject") > 0 && !listed.has("subject")) return "coverage";
  if ((present("list-unsubscribe") > 0 || present("list-unsubscribe-post") > 0)
    && (!listed.has("list-unsubscribe") || !listed.has("list-unsubscribe-post"))) return "coverage";
  for (const [name, k] of listed) if (present(name) > k) return "coverage";

  const canonical = c.body === "simple" ? simpleBody(body) : relaxedBody(body);
  if (c.l !== undefined && c.l !== canonical.length) return "body_length";
  if (!createHash("sha256").update(canonical, "latin1").digest().equals(c.bh)) return "body_hash";
  if (c.x !== undefined && c.x * 1000 < asking.now.getTime()) return "expired";

  const answer = await keyWithin(`${c.selector}._domainkey.${c.domain}`, asking);
  if (answer === "budget") return "key_budget";
  if (answer.kind === "none") return "key_none";
  if (answer.kind === "error") return "key_error";
  if (answer.records.length !== 1) return "key_invalid";
  const key = publicKeyOf(answer.records[0]!, c);
  if (typeof key === "string") return key;

  const data = Buffer.from(signedHeaders(c, copies), "latin1");
  try {
    const ok = c.a === "rsa-sha256"
      ? verify("sha256", data, key, c.b)
      : verify(null, createHash("sha256").update(data).digest(), key, c.b);
    if (!ok) return "bad_signature";
    return "pass";
  } catch {
    return "bad_signature";
  }
}

/**
 * The key lookup within the deadline and what is left of the cycle's budget, charged what it took;
 * `budget` when the budget was spent before it, or cut it short (then it is spent).
 */
async function keyWithin(name: string, asking: Asking): Promise<DkimKeyAnswer | "budget"> {
  const { budget, deadline } = asking;
  const left = budget === undefined ? Infinity : budget.remainingMs;
  if (left <= 0) return "budget";
  const ms = Math.min(deadline, left);
  const started = performance.now();
  const answer = await withDeadline(asking.keys.lookup(name), ms);
  if (budget !== undefined) budget.remainingMs -= performance.now() - started;
  if (answer !== "late") return answer;
  if (budget === undefined || ms === deadline) return { kind: "error" };
  budget.remainingMs = Math.min(budget.remainingMs, 0);
  return "budget";
}

async function withDeadline(p: Promise<DkimKeyAnswer>, ms: number): Promise<DkimKeyAnswer | "late"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((res) => { timer = setTimeout(() => res("late"), ms); });
  try {
    return await Promise.race([p.catch((): DkimKeyAnswer => ({ kind: "error" })), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The key record (RFC 6376 §3.6.1) as a key this signature may be checked with, or why not. */
function publicKeyOf(record: string, c: Candidate): KeyObject | SignatureReason {
  const tags = tagList(record);
  if (tags === null) return "key_invalid";
  const v = tags.get("v");
  if (v !== undefined && (v !== "DKIM1" || [...tags.keys()][0] !== "v")) return "key_invalid";
  if ((tags.get("k") ?? "rsa") !== (c.a === "rsa-sha256" ? "rsa" : "ed25519")) return "key_invalid";
  const h = tags.get("h");
  if (h !== undefined && !list(h).includes("sha256")) return "key_invalid";
  const service = tags.get("s");
  if (service !== undefined && !list(service).some((x) => x === "email" || x === "*")) return "key_invalid";
  const flags = list(tags.get("t") ?? "");
  if (flags.includes("y")) return "key_testing";
  if (flags.includes("s") && c.identity !== c.domain) return "key_strict";
  const p = base64Of(tags.get("p") ?? "");
  if (p === null) return "key_invalid";

  if (c.a === "ed25519-sha256") {
    if (p.length !== 32) return "key_invalid";
    return createPublicKey({ key: Buffer.concat([ED25519_SPKI, p]), format: "der", type: "spki" });
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: p, format: "der", type: "spki" });
  } catch {
    try {
      key = createPublicKey({ key: p, format: "der", type: "pkcs1" });
    } catch {
      return "key_invalid";
    }
  }
  if (key.asymmetricKeyType !== "rsa") return "key_invalid";
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  return bits < 1024 || bits > 4096 ? "key_size" : key;
}

/** RFC 6376 §3.7: the listed fields bottom-up, a name with no copy left adding nothing, then the
 *  signature itself with `b=` emptied. */
function signedHeaders(c: Candidate, copies: (name: string) => readonly Field[]): string {
  const taken = new Map<string, number>();
  let data = "";
  for (const name of c.signed) {
    const pool = copies(name);
    const k = taken.get(name) ?? 0;
    if (k >= pool.length) continue;
    taken.set(name, k + 1);
    data += `${canonicalHeader(pool[pool.length - 1 - k]!.raw, c.header)}\r\n`;
  }
  return data + canonicalHeader(withoutSignature(c.field.raw), c.header);
}

function canonicalHeader(raw: string, how: "simple" | "relaxed"): string {
  if (how === "simple") return raw;
  const colon = raw.indexOf(":");
  const value = raw.slice(colon + 1).replace(/\r\n/g, "").replace(/[ \t]+/g, " ").replace(/^ | $/g, "");
  return `${raw.slice(0, colon).toLowerCase()}:${value}`;
}

/** The signature field with its `b=` value removed, surrounding whitespace included. */
function withoutSignature(raw: string): string {
  let start = raw.indexOf(":") + 1;
  while (start <= raw.length) {
    const semi = raw.indexOf(";", start);
    const end = semi < 0 ? raw.length : semi;
    const eq = raw.indexOf("=", start);
    if (eq >= 0 && eq < end && raw.slice(start, eq).replace(FWS, "") === "b") return raw.slice(0, eq + 1) + raw.slice(end);
    start = end + 1;
  }
  return raw;
}

/** RFC 6376 §3.4.3: trailing empty lines dropped, one CRLF kept, an empty body read as CRLF. */
function simpleBody(body: string): string {
  let end = body.length;
  while (end >= 2 && body.charCodeAt(end - 2) === 13 && body.charCodeAt(end - 1) === 10) end -= 2;
  return `${body.slice(0, end)}\r\n`;
}

/** RFC 6376 §3.4.4: whitespace runs to one space, none at a line's end, trailing empty lines dropped. */
function relaxedBody(body: string): string {
  const lines = body.split("\r\n").map((l) => l.replace(/[ \t]+/g, " ").replace(/ $/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length === 0 ? "" : `${lines.join("\r\n")}\r\n`;
}
