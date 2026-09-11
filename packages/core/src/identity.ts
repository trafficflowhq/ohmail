import { createHash } from "node:crypto";
import type { CanonicalId, NormalizedMessage } from "./types.js";

/**
 * Strip one pair of angle brackets, trim, and KEEP THE CASE. The `.toLowerCase()` that used to be
 * here is gone: RFC 5322 §3.6.4's `id-left` is a case-SENSITIVE atom, so `<AbC@x>` and `<abc@x>`
 * are two different identifiers — folding them destroyed a distinction the sender made, and since
 * the old `dedupKey` was `mid:<value>`, two messages differing only in case collapsed onto ONE
 * row and one was silently never shown. The legacy population was written with the fold applied,
 * which is exactly why {@link legacyDedupKey} re-applies it; everything NEW is keyed by {@link
 * messageFingerprint}, which reads this value as it is.
 */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/<([^>]+)>/);
  const id = (m ? m[1] : raw).trim();
  return id.length > 0 ? id : null;
}

export function bodyHash(body: string): string {
  const normalized = body.replace(/\r\n/g, "\n").trim();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function canonicalId(messageIdHeader: string | null | undefined, body: string): CanonicalId {
  return { messageIdHeader: normalizeMessageId(messageIdHeader), bodyHash: bodyHash(body) };
}

/**
 * The dedup key every LEGACY row carries: `mid:<lowercased Message-ID>` or `body:<sha256 of the
 * canonical body>`. It answered two questions and got both wrong: the body-only collision (two
 * Message-ID-less messages with the same body are one row, the second dropped) and the message-id
 * forgery (the Message-ID is sender-chosen). It survives for one purpose: step 2 of the dual-key
 * lookup in `pipeline.ts#planChange` — a row found under this key is NOT accepted on the key's
 * strength; {@link verifiesLegacyIdentity} makes the fallback safe. `.toLowerCase()` is
 * deliberate and must stay: these rows were written folded, and an unfolded key would miss every
 * mixed-case row and re-insert the message as new.
 */
export function legacyDedupKey(c: CanonicalId): string {
  return c.messageIdHeader ? `mid:${c.messageIdHeader.toLowerCase()}` : `body:${c.bodyHash}`;
}

/**
 * The fingerprint format tag, and — per the ruling — **the version column itself**.
 *
 * `dedup_key` changes FORMAT, not role: `UNIQUE (mailbox_id, dedup_key)` keeps working unchanged
 * and no constraint moves. A separate `dedup_key_version` column would be a second thing to keep
 * in step with the prefix that is already there, and `dedup_key NOT LIKE 'fp1:%'` is the whole
 * migration progress query.
 */
export const FINGERPRINT_VERSION = "fp1";

/**
 * The field labels, as a closed set. Every one is ASCII with no {@link SEP} or {@link END} byte in
 * it, which is half of what makes {@link messageFingerprint}'s encoding injective.
 */
const LABEL = {
  messageId: "mid",
  from: "from",
  to: "to",
  cc: "cc",
  subject: "subj",
  date: "date",
  textHash: "text",
  htmlHash: "html",
  attachmentName: "att.name",
  attachmentType: "att.type",
  attachmentSize: "att.size",
  attachmentHash: "att.sha",
} as const;

/** UNIT SEPARATOR — between a label, its payload length, and the payload. */
const SEP = 0x1f;
/** RECORD SEPARATOR — after every payload. Decoration only: the length prefix delimits. */
const END = 0x1e;
/** A payload that is `null` rather than a string. One byte, so `null` ≠ `""`. */
const ABSENT = 0x00;
/** A payload that is a present string. The utf-8 bytes follow. */
const PRESENT = 0x01;

/**
 * Append one length-prefixed, domain-separated field. Bare concatenation is not an option:
 * `sha256(subject + from)` cannot tell `subject="a", from="b"` from `subject="ab", from=""` — and
 * an attacker chooses both halves, so they can manufacture a message whose logical identity
 * equals one the user already consented to; the adoption attack starts exactly there. The
 * encoding is `label SEP length SEP payload END`, injective: the label contains no SEP, the
 * length is ASCII digits, and the payload's own bytes are never scanned — the length says where
 * it stops, so a value may contain SEP, END or NUL without ambiguity. `identity.test.ts` proves
 * the `"a"+"b"` vs `"ab"+""` case rather than asserting the property in prose.
 */
function field(out: Buffer[], label: string, value: string | null): void {
  const payload = value === null
    ? Buffer.of(ABSENT)
    : Buffer.concat([Buffer.of(PRESENT), Buffer.from(value, "utf8")]);
  const header = Buffer.concat([
    Buffer.from(label, "ascii"), Buffer.of(SEP),
    Buffer.from(String(payload.length), "ascii"), Buffer.of(SEP),
  ]);
  out.push(header, payload, Buffer.of(END));
}

/** Everything the fingerprint reads. A subset of {@link NormalizedMessage}, named so it is auditable. */
export type FingerprintInput = Pick<
  NormalizedMessage,
  "canonical" | "subject" | "from" | "to" | "cc" | "date" | "textBody" | "htmlBody" | "attachments"
>;

/**
 * The logical identity of one message — sha256 over every field a sender can choose,
 * length-prefixed and domain-separated, replacing the legacy key whose halves were single
 * attacker-chosen values. Every input derives from `change.raw` alone — which makes a BACKFILL
 * impossible: stored columns are redacted, capped or defaulted, so a batch job would compute a
 * DIFFERENT value and every touched row would insert a second `messages` row on re-observation.
 * The dual-key lookup in `planChange` is the migration path. Inputs: mid (case preserved), from,
 * to, cc, subj, date, both body hashes, per-attachment fields. `date` is IN the fingerprint and
 * OUT of {@link verifiesLegacyIdentity}, where it would meet a Postgres `timestamptz`.
 */
export function messageFingerprint(m: FingerprintInput): string {
  // The version tag is INSIDE the hashed bytes as well as on the key. A future `fp2` that reads
  // one more field must not be able to produce an `fp1` digest for any input.
  const parts: Buffer[] = [
    Buffer.from(FINGERPRINT_VERSION, "ascii"), Buffer.of(END),
  ];
  field(parts, LABEL.messageId, m.canonical.messageIdHeader);
  field(parts, LABEL.from, m.from.address);
  for (const a of m.to) field(parts, LABEL.to, a.address);
  for (const a of m.cc) field(parts, LABEL.cc, a.address);
  field(parts, LABEL.subject, m.subject);
  field(parts, LABEL.date, m.date === null ? null : String(m.date.getTime()));
  field(parts, LABEL.textHash, bodyHash(m.textBody));
  field(parts, LABEL.htmlHash, m.htmlBody === null ? null : bodyHash(m.htmlBody));
  for (const a of m.attachments) {
    field(parts, LABEL.attachmentName, a.filename);
    field(parts, LABEL.attachmentType, a.contentType);
    field(parts, LABEL.attachmentSize, String(a.sizeBytes));
    field(parts, LABEL.attachmentHash, a.contentSha256);
  }
  return createHash("sha256").update(Buffer.concat(parts)).digest("hex");
}

/** `fp1:<sha256 hex>` — what `messages.dedup_key` holds for everything ingested from here on. */
export function fingerprintDedupKey(fingerprint: string): string {
  return `${FINGERPRINT_VERSION}:${fingerprint}`;
}

/** True for a key in the new format. `dedup_key NOT LIKE 'fp1:%'` is the same question in SQL. */
export function isFingerprintDedupKey(key: string): boolean {
  return key.startsWith(`${FINGERPRINT_VERSION}:`);
}

/** The four stored columns a legacy-key hit must agree on before it may be collapsed. */
export interface LegacyIdentityColumns {
  messageIdHeader: string | null;
  bodyHash: string;
  subject: string;
  fromAddress: string;
}

/**
 * Is the row found under a legacy key really this message? Step 2 of the dual-key lookup — a
 * `mid:`/`body:` hit alone is not evidence, that key IS the defect — so stored columns are
 * compared: `message_id_header` CASE-INSENSITIVELY (the stored value was folded); `body_hash` —
 * kills the body-only collision, and a stranger naming somebody's Message-ID has a different
 * body; `subject` and `from_address` — kill the forgery: a replayed body still has to match
 * author and subject. `date` is NOT in the tuple: `messages.date` has been through Postgres, and
 * a failed comparison means a SECOND `messages` row — the highest-damage outcome here. ANY
 * mismatch means NEW; never collapse on a partial match.
 */
export function verifiesLegacyIdentity(stored: LegacyIdentityColumns, m: FingerprintInput): boolean {
  const storedMid = stored.messageIdHeader;
  const observedMid = m.canonical.messageIdHeader;
  const midEqual = storedMid === null || observedMid === null
    ? storedMid === observedMid
    : storedMid.toLowerCase() === observedMid.toLowerCase();
  return midEqual
    && stored.bodyHash === m.canonical.bodyHash
    && stored.subject === m.subject
    && stored.fromAddress === m.from.address;
}
