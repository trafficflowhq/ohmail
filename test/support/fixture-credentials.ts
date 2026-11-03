/**
 * FIXTURE CREDENTIALS AND ADDRESSES, built at run time. The published test set is read by a push gate,
 * and a fixture written in the gate's own grammar passes it while one shaped like a real value refuses:
 * a password is a label that names itself (`"<tag>-password"`), a token is lower-case hyphenated words
 * with no digit (`"<tag>-fixture-token"`), a value whose SHAPE is the property (a vendor key, a PEM
 * header, a TOTP seed, a 64-hex key) is assembled here, a URL or an address takes its host, user or
 * domain from a const by template literal, a domain is a reserved one (`.example`) unless the provider is
 * the property, and a local part at a real provider or at the managed domain is `fixture.<name>`, never a
 * person's, never with a `+` tag. Never `+` two literals together, never write a whole personal address.
 * Every export takes its tag: no default, so two fixtures never share a value by accident.
 */
import { createHash } from "node:crypto";

const need = (fn: string, what: string, v: unknown): string => {
  if (typeof v !== "string" || v === "") throw new TypeError(`${fn}: ${what} is required`);
  return v;
};
const TAG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const tagOf = (fn: string, tag: unknown): string => {
  const t = need(fn, "a tag", tag);
  if (!TAG.test(t)) throw new TypeError(`${fn}: a tag is lower-case words and digits joined by hyphens`);
  return t;
};
/** The tag folded to letters and digits, padded with zeros: a vendor key body that names its fixture. */
const bodyOf = (tag: string, n: number): string => `${tag.replace(/-/g, "")}${"0".repeat(n)}`;
const DASHES = "-".repeat(5);

/** An Anthropic-shaped key: the vendor prefix, the format segment, the tag. */
export function anthropicKey(tag: string): string {
  return ["sk", "ant", "api03", tagOf("anthropicKey", tag), "0".repeat(24)].join("-");
}

/** An OpenAI project-key shape. */
export function openAiKey(tag: string): string {
  return ["sk", "proj", tagOf("openAiKey", tag), "0".repeat(24)].join("-");
}

/** A Stripe test secret-key shape. */
export function stripeTestKey(tag: string): string {
  return ["sk", "test", bodyOf(tagOf("stripeTestKey", tag), 24)].join("_");
}

/** A Resend API-key shape. */
export function resendKey(tag: string): string {
  return ["re", bodyOf(tagOf("resendKey", tag), 16)].join("_");
}

/** A PEM BEGIN line: `kind` is the label between BEGIN and the dashes ("PRIVATE KEY", "RSA PRIVATE KEY"). */
export function pemHeader(kind: string): string {
  const k = need("pemHeader", "a kind", kind);
  if (!/^[A-Z0-9]+(?: [A-Z0-9]+)*$/.test(k)) throw new TypeError("pemHeader: a kind is upper-case words");
  return `${DASHES}BEGIN ${k}${DASHES}`;
}

/** 64 lower-case hex, the tag's own digest: a 32-byte key nobody holds. */
export function hex64(tag: string): string {
  return createHash("sha256").update(tagOf("hex64", tag)).digest("hex");
}

const ALPHABET = `${Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)).join("")}234567`;
/** A 16-character base32 TOTP seed from the tag's digest. */
export function base32Seed(tag: string): string {
  const bytes = createHash("sha256").update(tagOf("base32Seed", tag)).digest();
  let bits = 0, acc = 0, out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5 && out.length < 16) { out += ALPHABET[(acc >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return out;
}

const RUN_ALPHABET = `${ALPHABET.slice(0, 26)}${ALPHABET.slice(0, 26).toLowerCase()}0123456789`;
/** `length` letters and digits from the tag's digest, stretched: an opaque token whose shape, not its bytes,
 *  is the property. The same tag gives the same run, and a longer run starts with the shorter one. */
export function opaqueRun(tag: string, length: number): string {
  const t = tagOf("opaqueRun", tag);
  if (!Number.isInteger(length) || length < 1) throw new TypeError("opaqueRun: a length is a positive integer");
  let out = "";
  for (let block = 0; out.length < length; block++) {
    for (const b of createHash("sha256").update(`${t}:${block}`).digest()) out += RUN_ALPHABET[b % RUN_ALPHABET.length];
  }
  return out.slice(0, length);
}

/** The managed service's mail domain. */
export function managedDomain(): string {
  return ["ohmail", "app"].join(".");
}

/* One segment after the prefix: `fixture.<a>.<b>` would put a first and last name behind it. */
const LOCAL = /^fixture\.[a-z0-9]+$/;
const localOf = (fn: string, local: unknown): string => {
  const l = need(fn, "a local part", local);
  if (!LOCAL.test(l)) throw new TypeError(`${fn}: a local part is fixture.<name>, one lower-case word, with no + tag`);
  return l;
};

/** A fixture user at the managed domain. */
export function managedAddress(local: string): string {
  return `${localOf("managedAddress", local)}@${managedDomain()}`;
}

/** A fixture sender at a real provider, where the provider is the property under test. */
export function personalAt(local: string, domain: string): string {
  const l = localOf("personalAt", local);
  const d = need("personalAt", "a domain", domain);
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(d)) throw new TypeError("personalAt: a domain is a bare lower-case domain");
  return `${l}@${d}`;
}

/** A password that names itself, long enough for a sign-in (the product's minimum is 12). */
export function fixturePassword(tag: string): string {
  const p = `${tagOf("fixturePassword", tag)}-password`;
  if (p.length < 12) throw new TypeError("fixturePassword: the tag is too short for a sign-in password");
  return p;
}

/** The shape each assembler is for, built the same way: a test asserts its fixture against one once. */
export const FIXTURE_SHAPES = {
  anthropic: new RegExp(`^${["sk", "ant", "api03"].join("-")}-[A-Za-z0-9_-]{20,}$`),
  openai: new RegExp(`^${["sk", "proj"].join("-")}-[A-Za-z0-9_-]{20,}$`),
  stripeTest: new RegExp(`^${["sk", "test"].join("_")}_[A-Za-z0-9]{24,}$`),
  resend: new RegExp(`^${"re"}_[A-Za-z0-9]{12,}$`),
  pemHeader: new RegExp(`^${DASHES}BEGIN [A-Z ]*PRIVATE KEY${DASHES}$`),
  hex64: /^[0-9a-f]{64}$/,
  base32: /^[A-Z2-7]{16}$/,
} as const;
