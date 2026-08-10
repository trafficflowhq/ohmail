import { createHash } from "node:crypto";
import type { CanonicalId, NormalizedMessage } from "./types.js";

/**
 * Strip ONE pair of angle brackets, trim, and **keep the case**.
 *
 * ── WHY THE `.toLowerCase()` THAT USED TO BE HERE IS GONE ─────────────────────────────────────
 *
 * RFC 5322 §3.6.4 defines `msg-id = "<" id-left "@" id-right ">"` with `id-left` a
 * `dot-atom-text`. Atoms are case-SENSITIVE; only the domain literal on the right is not. So a
 * Message-ID is an opaque token chosen by the sending mail client, and `<AbC@x>` and `<abc@x>` are two
 * different identifiers. Folding them destroyed a distinction the sender made — and since the
 * old `dedupKey` was `mid:<that value>`, two messages whose ids differ only in case collapsed
 * onto ONE `messages` row and one of them was silently never shown.
 *
 * The legacy population was written with the fold applied, which is exactly why
 * {@link legacyDedupKey} re-applies it: the key that reaches those rows has to be spelled the way
 * they were stored. Everything NEW is keyed by {@link messageFingerprint}, which reads this
 * value as it is.
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
 * The dedup key EVERY LEGACY ROW CARRIES, written before the current fingerprint scheme.
 * Read-only vocabulary.
 *
 * `mid:<lowercased Message-ID>` or, with no Message-ID, `body:<sha256 of the canonical body>`.
 * Two questions were answered by that one string and it got both wrong:
 *
 *  · **The body-only collision** — `body:` alone. Two different messages with no Message-ID and
 *    the same body text (an empty auto-reply, a bare "thanks") are ONE row. The second is dropped.
 *  · **The message-id forgery** — `mid:` alone. The Message-ID is chosen by whoever sent the mail,
 *    so a stranger can name the id of a message the user already holds and have their bytes
 *    recognised as it.
 *
 * It survives here for exactly one purpose: step 2 of the dual-key lookup in
 * `pipeline.ts#planChange`. A row found under this key is NOT accepted as the same message on the
 * strength of the key — see {@link verifiesLegacyIdentity}, which is what makes the fallback safe.
 *
 * **`.toLowerCase()` is deliberate and must stay.** These rows were written by a
 * `normalizeMessageId` that folded case; a key computed without the fold would miss every row
 * whose Message-ID had an upper-case character, and the message would be re-inserted as new.
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
 * Append ONE length-prefixed, domain-separated field.
 *
 * ── WHY BARE CONCATENATION IS NOT AN OPTION ─────────────────────────────────────────────────
 *
 * `sha256(subject + from)` cannot tell `subject="a", from="b"` from `subject="ab", from=""` —
 * both hash the four bytes `ab`. That is not a theoretical collision: an attacker chooses both
 * halves, so they can manufacture a message whose logical identity equals one the user already
 * consented to, and the adoption attack starts from exactly that. Length-prefixing removes it
 * by construction rather than by hoping the values never line up.
 *
 * The encoding is `label SEP length SEP payload END`, where `length` is the payload's BYTE count
 * in ASCII decimal and `payload` is `[ABSENT]` or `[PRESENT, ...utf8]`. It is injective:
 *
 *  · the label is drawn from {@link LABEL} and contains no SEP, so the first SEP ends it;
 *  · the length is ASCII digits and contains no SEP, so the second SEP ends it;
 *  · the payload's own bytes are never scanned — the length says where it stops — so a value may
 *    contain SEP, END, NUL, anything at all, without becoming ambiguous.
 *
 * Therefore the whole buffer parses back to exactly one ordered list of (label, payload) pairs,
 * and two different field lists cannot produce one buffer. `identity.test.ts` proves the
 * `"a"+"b"` vs `"ab"+""` case rather than asserting the property in prose.
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
 * THE LOGICAL IDENTITY OF ONE MESSAGE — `sha256` over every field a sender can choose,
 * length-prefixed and domain-separated.
 *
 * ── WHAT IT REPLACES, AND WHY A PATCH TO THE OLD KEY COULD NOT WORK ─────────────────────────
 *
 * One string used to answer three different questions: is this the same logical message, which
 * bytes on the server is it, and did the user move it. {@link legacyDedupKey} answered the first
 * with either the Message-ID alone or the body text alone. Both are single attacker-chosen
 * values, so both are forgeable, and neither notices a message that differs in the other.
 *
 * Every input below is present at ingest, in `change.raw`, and is derived from it and from
 * nothing else. That is the property that makes a BACKFILL impossible and it is why the ruling
 * prohibits one outright: `message_bodies.text` is redacted for sensitive mail, `html` is
 * `prepareHtmlForStorage`'d and capped at 256 KiB, `attachments` had no content digest before
 * this slice, and `messages.to_addresses` is NEVER WRITTEN. A batch job over stored columns would
 * compute a DIFFERENT value than ingest does for the same message, so every row it touched would
 * insert a SECOND `messages` row the first time the mail was re-observed — and no delta removes
 * the first — a convergence break. The dual-key lookup in `planChange` is the migration path instead.
 *
 * ── THE INPUT LIST, IN ORDER ────────────────────────────────────────────────────────────────
 *
 *   mid       the normalized Message-ID, CASE PRESERVED, or absent
 *   from      the author address (lowercased at parse by `mime.ts#toAddr`)
 *   to        every `To:` address, in header order, one field each
 *   cc        every `Cc:` address, in header order, one field each
 *   subj      the subject
 *   date      the `Date:` header as epoch milliseconds, or absent
 *   text      sha256 of the text body …
 *   html      … and sha256 of the html body, SEPARATELY, or absent
 *   att.*     per attachment, in MIME order: filename, content type, size, sha256(content)
 *
 * Two of those choices are worth stating. The body is hashed as TWO fields rather than one
 * because a message with text `x` and html `<p>y</p>` and a message with text `x` and no html are
 * different messages, and the pre-existing single `bodyHash` (which prefers text, falling back to
 * html only on the `skipHtmlToText` path) cannot express the difference. And `date` is IN the
 * fingerprint but deliberately OUT of {@link verifiesLegacyIdentity}: here it is computed from
 * the raw bytes on both sides, so it is stable; there it would be compared against a
 * `timestamptz` that has been through Postgres.
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
 * IS THE ROW FOUND UNDER A LEGACY KEY REALLY THIS MESSAGE? Four columns, all of which exist.
 *
 * Step 2 of the dual-key lookup. A `mid:`/`body:` hit alone is not evidence — that key IS the
 * defect — so the row's own stored columns are compared against the message in hand:
 *
 *  · `message_id_header`, CASE-INSENSITIVELY. The stored value was folded by the pre-slice
 *    `normalizeMessageId`; the value in hand is not. Comparing them raw would refuse every
 *    mixed-case legacy row and re-insert the message as new.
 *  · `body_hash` — this is what kills the body-only collision. Two anchorless messages sharing a `body:` key now have
 *    to share the body as well, which they do by definition of that key, so the real work here is
 *    the `mid:` case: a stranger naming somebody else's Message-ID has a different body and is
 *    refused.
 *  · `subject` and `from_address` — this is what kills the message-id forgery. A forged `mid:` with the same body
 *    (a replay of the user's own bytes) still has to match the author and the subject.
 *
 * `date` is deliberately NOT in the tuple. `messages.date` is `timestamptz` and has been through
 * Postgres; `parsed.date` has not. Sub-millisecond and zone round-tripping would make the
 * comparison fail for genuine re-observations, and a failed comparison here means a SECOND
 * `messages` row — the highest-damage outcome available on this path (a convergence
 * break, plus `pipeline.ts`'s `stored.threadId` guard minting a second `threads` row).
 *
 * **ANY mismatch ⇒ the caller treats this as a NEW message. Never collapse on a partial match.**
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
