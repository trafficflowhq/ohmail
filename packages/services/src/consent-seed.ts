import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { dialect } from "@trafficflow/db/dialect";
import {
  accountSettings, contacts, mailboxes, messageBodies, messages, recordChanges, rules,
  type LedgerTx, type OrganizedBy, type Tx,
} from "@trafficflow/db";
import { listMailboxUserFolders, listUserFolders } from "./folders.js";
import type { ServiceContext } from "./context.js";
import { DEFAULT_DORMANCY_DAYS } from "./consent-cutline.js";
import { ServiceError } from "./errors.js";
import { fenceErasedAccount } from "./erasure-fence.js";
// The COMPOSE grammar and the COMPOSE html-to-text converter, both of them — a signature is
// part of an outgoing message, so it is reduced by the same allow-list the message body is and
// its text alternative is rendered by the same function. A second sanitizer here would be a
// second door into the body with its own answer about what markup is allowed.
import { prepareOutboundBody } from "./outbound-html.js";
import { planAccountFanOut, routeMailboxWrite, writeReaderRequest } from "./reader-request.js";
import {
  fanOutProfileEdit, profileRequestPayload, profileTravelled,
  TRAVELLING_SIGNATURE_MAX_CHARS, type ProfileTravel,
} from "./profile-request.js";

/**
 * A window save's answer: the effective window and mode, plus where the edit went (mail 0094).
 * `pending`/`travel` are absent on a one-install account, so its answer is unchanged.
 */
export interface DormancyResult {
  dormancyDays: number;
  screeningScope: "window" | "all_time";
  pending?: true;
  travel?: ProfileTravel;
}

/**
 * A signature save's answer. `signature` is the column as it stands on THIS install — the saved
 * value when the write happened here, the UNCHANGED one when the edit travelled instead.
 * `signatureHtml` is the markup half on the same terms — null on a signature with no formatting.
 * It does NOT travel: a travelling save carries the derived text, so the holder's markup is
 * untouched (row SIGNATURE-MARKUP-DOES-NOT-TRAVEL-TO-THE-ORGANIZING-INSTALL).
 *
 * PER-MAILBOX, so there is one holder rather than a per-mailbox table: the request went to the
 * install that holds THIS mailbox, and there is exactly one of those.
 */
export interface MailboxSignatureResult {
  mailboxId: string;
  signature: string | null;
  signatureHtml: string | null;
  pending?: true;
  holder?: OrganizedBy;
  requestId?: string;
}

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

/**
 * The sent-mail seed — consent, read off what the user has already done. The strongest thing
 * anybody does towards a correspondent is WRITE TO THEM, so the first question is not "who do you
 * want to hear from" but "here are the people you have written to; shall we let them through?" —
 * the list is shown BEFORE anything acts on it, and confirming it is the consent event. Three
 * narrowings: ADDRESS-LEVEL ONLY, never domain (writing to one person at a provider says nothing
 * about the rest; domain-wide consent stays an explicit user rule); TO AND CC both count (copying
 * somebody in is addressing them); NO RETRO — a seeded rule routes future mail and moves nothing
 * that exists: one confirmation must never turn into thousands of moves.
 */

/**
 * How many of the user's own messages the seed reads.
 *
 * A bound rather than a promise: the review list says how many were scanned, and a mailbox
 * with more than this many sent messages gets its most recent ones. Recency is the right end
 * to keep — the people someone wrote to this year matter more than the ones they wrote to
 * once, a decade ago, and those old correspondents are exactly who the dormancy cutline is
 * designed to leave alone.
 */
export const SEED_SCAN_LIMIT = 5000;

/**
 * How many addresses one confirmation may name. A COARSE ceiling, on purpose: its job is to stop
 * an unbounded list being lowercased and folded into a Set before the intersection bounds the
 * writes — nothing more. Deliberately NOT derived from {@link SEED_SCAN_LIMIT}: that counts
 * MESSAGES, and one sent message contributes every distinct recipient on it, so a review this
 * product built can offer more addresses than it scanned messages — a ceiling derived that way
 * refuses the product's own review. 50 000 is ten recipients per scanned message, past any real
 * address book. The number that decides what gets WRITTEN is the review's own candidate list,
 * which this endpoint intersects against.
 */
export const SEED_MAX_ADDRESSES = 50_000;

export type SeedExclusionReason =
  /** The recipient address is a machine: bounces, daemons, no-reply, calendar servers. */
  | "robot-recipient"
  /** The message it was harvested from was itself automatic — an out-of-office, a bulk send. */
  | "machine-sent"
  /** One of the account's own addresses. */
  | "own-address";

export interface SeedCandidate {
  address: string;
  /**
   * How the user most recently addressed them, when it was readable.
   *
   * Most recent rather than first-seen or longest: a person's name in somebody's address book
   * changes, and the newest spelling is the one they will recognise. The scan runs newest
   * first, so the first readable name encountered is that one.
   */
  name: string | null;
  /** How many of the user's own messages named this person. */
  messages: number;
  /** The most recent time the user wrote to them. */
  lastWrittenAt: string | null;
  /** True when a rule for this sender already exists — shown, but not written again. */
  alreadyDecided: boolean;
}

export interface SeedReview {
  candidates: SeedCandidate[];
  /** What the robot filter removed, so the review list can disclose it rather than hide it. */
  excluded: Array<{ address: string; reason: SeedExclusionReason }>;
  /** How many of the user's own messages were read. */
  scannedMessages: number;
  /** True when this account has more sent mail than {@link SEED_SCAN_LIMIT}. */
  truncated: boolean;
}

export interface SeedConfirmResult {
  rulesCreated: number;
  contactsCreated: number;
  /** Candidates the user unchecked. Recorded because the seed acts on the user's behalf. */
  declined: number;
  /** Already had a rule, so nothing was written for them. */
  skipped: number;
  lastSeq: number | null;
}

/* ── the robot filter ─────────────────────────────────────────────────────────────────── */

/**
 * Local parts that are a machine talking, not a person.
 *
 * Matched after stripping punctuation, so one entry covers `no-reply`, `no_reply` and
 * `noreply` — the same normalisation the routing engine uses for the same family.
 */
const ROBOT_LOCAL_PREFIXES = [
  "noreply", "donotreply", "nreply", "mailerdaemon", "postmaster", "bounce",
  "unsubscribe", "notification", "notifications", "automailer", "autoreply",
  "calendarserver", "nopreply",
];

/** Domains whose entire purpose is automated delivery. */
const ROBOT_DOMAIN_HINTS = ["bounce", "bounces", "mailer", "sendgrid.net", "amazonses.com"];

/** `no-reply@`, `bounces+tag@`, `calendar-server@` — punctuation-insensitive, like the router. */
export function isRobotAddress(address: string): boolean {
  const addr = address.trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at < 0) return true;
  const local = addr.slice(0, at).replace(/[^a-z0-9]/g, "");
  const domain = addr.slice(at + 1);
  if (ROBOT_LOCAL_PREFIXES.some((p) => local.startsWith(p))) return true;
  // VERP: `bounces+user=example.com@…` and the `+bounce`/`+unsub` tag family.
  if (/\+(bounce|unsub|remove|reject)/.test(addr.slice(0, at))) return true;
  return ROBOT_DOMAIN_HINTS.some((d) => domain === d || domain.endsWith(`.${d}`) || domain.startsWith(`${d}.`));
}

/** Subject shapes an auto-responder writes. Deliberately conservative — a false positive drops a real person. */
const OUT_OF_OFFICE = /^\s*(re:\s*)?(out of (the )?office|automatic(al)? reply|auto(matic)?[- ]?reply|abwesenheit|absence du bureau|autoreply|ferienabwesenheit)/i;

/**
 * Did a machine write this — the three HEADER arms, the half two subsystems share. Harvesting
 * recipients out of the user's own out-of-office replies would read a machine's address book as
 * the user's; `Auto-Submitted: no` is RFC 3834's way of saying a human wrote it, so presence
 * alone is the wrong test. Split out of {@link isMachineSent} so the Ohbox rule can share the
 * headers WITHOUT the subject arm. `packages/db/src/auto-reply-by-us.ts#machineSentHeadersWhere`
 * is these same three arms in SQL, and `auto-reply-by-us-parity.test.ts` asserts the two agree
 * row by row: neither is the definition, the pair is.
 */
export function hasMachineSentHeaders(headers: Readonly<Record<string, unknown>>): boolean {
  const values = (name: string): string[] => {
    if (!Object.prototype.hasOwnProperty.call(headers, name)) return [];
    const v = headers[name];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  };
  if (values("auto-submitted").some((v) => !/^no$/i.test(v.trim()))) return true;
  if (values("precedence").some((v) => /bulk|auto_?reply|junk|list/i.test(v))) return true;
  return values("x-auto-response-suppress").length > 0;
}

/**
 * The seed's question: the headers PLUS the subject — and the split above is why the split
 * exists. The subject arm is deliberately NOT part of {@link hasMachineSentHeaders} because the
 * two callers pay opposite prices for a false positive: HERE it costs one un-harvested contact;
 * in the Ohbox a message wrongly called an auto-reply DISAPPEARS from the pile the person reads.
 * Not hypothetical: `Re: Out of office` is an ordinary thing to type and {@link OUT_OF_OFFICE}
 * matches it with no `Auto-Submitted` header in sight. Reusing the whole function for the Ohbox
 * rule would hide mail the person wrote, every test green — `dto-auto-reply-flag.test.ts` carries
 * the case by name.
 */
export function isMachineSent(headers: Readonly<Record<string, unknown>>, subject: string): boolean {
  return hasMachineSentHeaders(headers) || OUT_OF_OFFICE.test(subject);
}

/* ── header address parsing ───────────────────────────────────────────────────────────── */

const EMAIL_SHAPE = /^[^\s@<>,"]+@[^\s@<>,"]+\.[^\s@<>,".]+$/;

/**
 * Addresses out of a raw `To:`/`Cc:` header line.
 *
 * Split on commas that are outside quotes and angle brackets — a display name is allowed to
 * contain both a comma and an at-sign (`"Roth, Lena" <lena@example.com>`), and a naive
 * `match(/\S+@\S+/g)` reads the quoted part as a second recipient.
 */
export function parseAddressList(line: string): Array<{ address: string; name: string | null }> {
  const parts: string[] = [];
  let buf = "";
  let inQuote = false;
  let inAngle = false;
  for (const ch of line) {
    if (ch === '"' && !inAngle) inQuote = !inQuote;
    else if (ch === "<" && !inQuote) inAngle = true;
    else if (ch === ">" && !inQuote) inAngle = false;
    if (ch === "," && !inQuote && !inAngle) { parts.push(buf); buf = ""; continue; }
    buf += ch;
  }
  parts.push(buf);

  const out: Array<{ address: string; name: string | null }> = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const lt = part.lastIndexOf("<");
    const gt = part.lastIndexOf(">");
    let address: string;
    let name: string | null = null;
    if (lt >= 0 && gt > lt) {
      address = part.slice(lt + 1, gt).trim();
      name = displayName(part.slice(0, lt));
    } else {
      address = part.replace(/^<|>$/g, "").trim();
    }
    address = address.toLowerCase();
    if (!EMAIL_SHAPE.test(address)) continue;
    out.push({ address, name });
  }
  return out;
}

/**
 * A readable display name, or nothing. It DECODES rather than drops: returning `null` for
 * anything starting `=?` dropped the display name of every correspondent whose name carries an
 * accent — a non-ASCII display name travels as an RFC 2047 encoded-word (`=?utf-8?Q?...?=`),
 * ASCII on the wire, so the drop-rule turned "Sébastien" into a bare address on the screen whose
 * job is recognising who you wrote to. Encoded-words are the COMMON case for a non-English
 * address book. It also repairs mojibake: a name stored as raw UTF-8 folded through Latin-1 (`ø`
 * stored as `Ã¸`) is reversed by `repairLatin1Mojibake`, whose round-trip guard leaves a
 * correctly-decoded name untouched.
 */
function displayName(raw: string): string | null {
  const decoded = repairLatin1Mojibake(decodeEncodedWords(raw.trim()));
  const s = decoded.trim().replace(/^"|"$/g, "").trim();
  return s || null;
}

/**
 * RFC 2047 encoded-words → text. Handles `B` (base64) and `Q` (quoted-printable-ish) with any
 * charset, decoding UTF-8 exactly and treating everything else as Latin-1 — the only other
 * charset seen in practice, and a safe superset of US-ASCII. Adjacent encoded-words separated by
 * whitespace are joined with the whitespace removed, per §6.2: that is how a long name splits
 * across two words, and printing the fold as a space would insert one that was never in the name.
 * A `=?` that is not a well-formed encoded-word is left exactly as it was — the whole difference
 * from the predecessor that treated the prefix alone as a reason to give up.
 */
export function decodeEncodedWords(input: string): string {
  const WORD = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
  let out = "";
  let last = 0;
  let prevWasWord = false;
  let m: RegExpExecArray | null;
  while ((m = WORD.exec(input)) !== null) {
    const between = input.slice(last, m.index);
    // Whitespace between two encoded-words is a fold, not part of the name (RFC 2047 §6.2).
    if (!(prevWasWord && /^\s*$/.test(between))) out += between;
    out += decodeWord(m[1]!, m[2]!.toUpperCase(), m[3]!);
    last = m.index + m[0].length;
    prevWasWord = true;
  }
  out += input.slice(last);
  return out;
}

function decodeWord(charset: string, enc: string, text: string): string {
  let bytes: Buffer;
  if (enc === "B") {
    bytes = Buffer.from(text, "base64");
  } else {
    // Q: `_` is a space, `=XX` is a byte, everything else is itself. `latin1` turns the
    // resulting code points back into the bytes they stand for before the charset decode.
    const q = text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16)));
    bytes = Buffer.from(q, "latin1");
  }
  const cs = charset.toLowerCase();
  return cs === "utf-8" || cs === "utf8" ? bytes.toString("utf8") : bytes.toString("latin1");
}

/**
 * Reverse a UTF-8 string that was mis-decoded as Latin-1, and NOTHING else.
 *
 * The signature of that corruption is that every code point is ≤ 0xFF (so the string is a
 * sequence of bytes pretending to be characters) and those bytes are themselves valid UTF-8.
 * A correctly-decoded name fails the test: `Sébastien` read as Latin-1 bytes is `53 e9 62…`,
 * and `0xE9` alone is not a legal UTF-8 lead, so the re-decode introduces a replacement
 * character and the lossless round-trip check below rejects it. Only genuine mojibake survives.
 */
export function repairLatin1Mojibake(s: string): string {
  // Cheap reject: no plausible UTF-8 lead byte in the Latin-1 range means nothing to repair.
  if (!/[Â-ô]/.test(s)) return s;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0xff) return s;
  const bytes = Buffer.from(s, "latin1");
  const decoded = bytes.toString("utf8");
  // Accept only when re-encoding reproduces the exact bytes — i.e. the re-decode was clean,
  // with no U+FFFD manufactured. That is what keeps a legitimately Latin-1 name intact.
  if (decoded !== s && Buffer.from(decoded, "utf8").equals(bytes)) return decoded;
  return s;
}

/* ── the review list ──────────────────────────────────────────────────────────────────── */

/**
 * Everyone this account has written to, robot-filtered, newest correspondence first. "Written by
 * the user" is `from_address` matching one of the account's own mailbox addresses, NOT "sits in a
 * folder called Sent": Sent folders are named a dozen ways, and a folder-shaped test would also
 * sweep an Archive folder, whose messages were RECEIVED — harvesting their `To`/`Cc` would seed
 * consent for everyone the user was once copied alongside. The known limitation: mail sent from
 * an alias the account does not list is not read — the safe direction: a missing candidate is one
 * row the user does not see, an extra one is consent nobody gave.
 */
export async function buildSeedReview(ctx: ServiceContext, limit = SEED_SCAN_LIMIT): Promise<SeedReview> {
  const own = await ownAddresses(ctx);
  if (own.size === 0) return { candidates: [], excluded: [], scannedMessages: 0, truncated: false };

  const rows = await ctx.db
    .select({
      id: messages.id,
      date: messages.date,
      subject: messages.subject,
      // FIVE KEYS, NOT THE WHOLE HEADER BLOB.
      //
      // The scan reads `To`/`Cc` and the three headers that mark a message as machine-written,
      // and nothing else. Selecting `headers` whole ships every stored header of up to
      // SEED_SCAN_LIMIT messages — Received chains included — across the wire and into memory
      // for a function that discards all of it. Projecting server-side turns the dominant cost
      // of this read into a few kilobytes. `jsonb_strip_nulls` keeps the shape a caller would
      // have got from the real column: a header that is absent stays absent, rather than
      // arriving as an explicit null that `hasOwnProperty` would answer yes to.
      headers: sql<Record<string, unknown> | null>`jsonb_strip_nulls(jsonb_build_object(
        'to', ${messageBodies.headers} -> 'to',
        'cc', ${messageBodies.headers} -> 'cc',
        'auto-submitted', ${messageBodies.headers} -> 'auto-submitted',
        'precedence', ${messageBodies.headers} -> 'precedence',
        'x-auto-response-suppress', ${messageBodies.headers} -> 'x-auto-response-suppress'
      ))`,
    })
    .from(messages)
    .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
    .where(and(
      eq(messages.accountId, ctx.accountId),
      sql`lower(${messages.fromAddress}) in ${ownList(own)}`,
    ))
    .orderBy(desc(messages.date))
    .limit(limit + 1);

  const truncated = rows.length > limit;
  const scanned = truncated ? rows.slice(0, limit) : rows;

  const found = new Map<string, SeedCandidate>();
  const excluded = new Map<string, SeedExclusionReason>();

  for (const r of scanned) {
    const headers = (r.headers as Record<string, unknown> | null) ?? {};
    if (isMachineSent(headers, r.subject ?? "")) {
      for (const rec of recipientsOf(headers)) {
        if (!found.has(rec.address)) excluded.set(rec.address, excluded.get(rec.address) ?? "machine-sent");
      }
      continue;
    }
    for (const rec of recipientsOf(headers)) {
      if (own.has(rec.address)) { excluded.set(rec.address, "own-address"); continue; }
      if (isRobotAddress(rec.address)) { excluded.set(rec.address, "robot-recipient"); continue; }
      excluded.delete(rec.address);
      const held = found.get(rec.address);
      const when = r.date ? r.date.toISOString() : null;
      if (held) {
        held.messages += 1;
        if (!held.name && rec.name) held.name = rec.name;
        if (when && (!held.lastWrittenAt || when > held.lastWrittenAt)) held.lastWrittenAt = when;
      } else {
        found.set(rec.address, {
          address: rec.address, name: rec.name, messages: 1, lastWrittenAt: when, alreadyDecided: false,
        });
      }
    }
  }

  const decided = await decidedSenders(ctx.db, ctx.accountId, [...found.keys()]);
  for (const c of found.values()) c.alreadyDecided = decided.has(c.address);

  const candidates = [...found.values()].sort((a, b) =>
    b.messages - a.messages || (b.lastWrittenAt ?? "").localeCompare(a.lastWrittenAt ?? "") || a.address.localeCompare(b.address));

  return {
    candidates,
    excluded: [...excluded.entries()].map(([address, reason]) => ({ address, reason })).sort((a, b) => a.address.localeCompare(b.address)),
    scannedMessages: scanned.length,
    truncated,
  };
}

function recipientsOf(headers: Record<string, unknown>): Array<{ address: string; name: string | null }> {
  const out: Array<{ address: string; name: string | null }> = [];
  for (const field of ["to", "cc"]) {
    if (!Object.prototype.hasOwnProperty.call(headers, field)) continue;
    const v = headers[field];
    const lines = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
    for (const line of lines) if (typeof line === "string") out.push(...parseAddressList(line));
  }
  return out;
}

async function ownAddresses(ctx: ServiceContext): Promise<Set<string>> {
  const rows = await ctx.db.select({ address: mailboxes.address }).from(mailboxes)
    .where(eq(mailboxes.accountId, ctx.accountId));
  return new Set(rows.map((r) => r.address.trim().toLowerCase()));
}

const ownList = (own: Set<string>) => sql`(${sql.join([...own].map((a) => sql`${a}`), sql`, `)})`;

/**
 * Addresses that already carry an enabled sender rule — a decision the seed must not overwrite.
 *
 * Takes a query runner rather than a `ServiceContext` because it is asked twice and the second
 * time it MUST run on the confirmation's own transaction handle: the answer it gives outside a
 * transaction is a snapshot that a concurrent confirm can invalidate before either commits.
 */
async function decidedSenders(
  db: ServiceContext["db"] | Tx, accountId: string, addresses: string[],
): Promise<Set<string>> {
  if (addresses.length === 0) return new Set();
  /**
   * Chunked, for the reason the WRITES below already are. This put the whole address set into one
   * `IN`, and the set is not bounded by what anybody assumed: the review is built from at most
   * `SEED_SCAN_LIMIT` MESSAGES, and one sent message contributes every distinct recipient — past
   * Postgres's 65 535 bind parameters the statement is refused, a 500 on `GET /consent/seed` for
   * an account that is merely large. The same false premise was corrected twice elsewhere in this
   * file, which is the argument for chunking rather than another ceiling: {@link WRITE_CHUNK}
   * already carries the parameter-limit reasoning, so there is one place where "how many values
   * fit in a statement" is decided.
   */
  const out = new Set<string>();
  for (const part of chunked(addresses, WRITE_CHUNK)) {
    const rows = await db.select({ match: rules.match }).from(rules)
      .where(and(
        eq(rules.accountId, accountId),
        eq(rules.kind, "sender"),
        eq(rules.enabled, true),
        inArray(sql`lower(${rules.match})`, part),
      ));
    for (const r of rows) out.add(r.match.trim().toLowerCase());
  }
  return out;
}

/**
 * How many rows one INSERT carries.
 *
 * Postgres refuses a statement with more than 65 535 bind parameters, and a `rules` row binds
 * eight columns, so the ceiling is real rather than theoretical for an account with thousands
 * of correspondents. Five hundred keeps every statement an order of magnitude clear of it and
 * bounds the memory one round trip has to hold, while still collapsing a two-thousand-person
 * confirmation from ten thousand round trips into a dozen.
 */
const WRITE_CHUNK = 500;

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/* ── the confirmation ─────────────────────────────────────────────────────────────────── */

/**
 * Write the consent the user just gave. One transaction, no mail moved. The addresses are
 * INTERSECTED with a freshly computed review list, never trusted: the list is the offer, and a
 * confirmation can only be a subset of it. `retroRequestedAt` stays NULL and no `folder_state`
 * row is touched — a bulk import of consent must not become thousands of moves. One effect per
 * person is enforced by a ROW LOCK and a re-read (two concurrent submits used to both insert
 * duplicates): the transaction opens by locking `account_settings`, THEN asks which addresses
 * already carry a rule — a concurrent confirm's rules are visible and drop out. The stamp records
 * WHEN the review was last confirmed: re-running writes rules for whoever is new.
 */
export async function confirmSeed(
  ctx: ServiceContext, addresses: readonly string[],
): Promise<SeedConfirmResult> {
  /**
   * The list is bounded BEFORE anything is done with it. The WRITE set was always bounded (the
   * intersection with the review); what was unbounded is the list on the way IN — every entry
   * trimmed, lowercased and folded into a Set before the bound applied. The ceiling is NOT
   * `SEED_SCAN_LIMIT`, a message count: one sent message contributes every distinct recipient, so
   * a review can offer several times that many addresses — and confirming a review this product
   * produced would have been a 413. So the ceiling is {@link SEED_MAX_ADDRESSES}, coarse and far
   * above any review's fan-out. In the SERVICE, not the route: the route is not the only door,
   * and a route-level check would guard the hosted door and not the desktop one.
   */
  if (addresses.length > SEED_MAX_ADDRESSES) {
    throw new ServiceError(
      "payload_too_large", 413,
      `addresses names ${addresses.length} senders; at most ${SEED_MAX_ADDRESSES} may be confirmed at once`,
    );
  }
  const review = await buildSeedReview(ctx);
  const own = await ownAddresses(ctx);
  const offered = new Map(review.candidates.map((c) => [c.address, c]));
  const asked = new Set(addresses.map((a) => a.trim().toLowerCase()).filter((a) => a.length > 0));

  const accept: SeedCandidate[] = [];
  for (const address of asked) {
    const c = offered.get(address);
    if (!c) continue;            // never offered, or already decided — not this endpoint's business
    if (c.alreadyDecided) continue;
    accept.push(c);
  }
  const declined = review.candidates.filter((c) => !c.alreadyDecided && !asked.has(c.address)).length;
  const skippedOffered = review.candidates.filter((c) => c.alreadyDecided && asked.has(c.address)).length;

  return asTx(ctx).transaction(async (tx) => {
    // ── ERASURE FENCE, FIRST — before any settings lock. `deleteAccount` stamps
    // `accounts.erased_at` at the top of its transaction; reading it FOR SHARE here is what
    // stops this write recreating erased rows, and taking it FIRST is what keeps the lock
    // order a single chain (accounts → settings → sequence row). `erasure-fence.ts` carries
    // the two-sided argument.
    await fenceErasedAccount(tx, dialect(ctx.db), ctx.accountId);
    // ── THE LOCK. FIRST STATEMENT, AND THE ONLY THING STANDING BETWEEN A DOUBLE-CLICK AND
    //    TWO RULES PER PERSON. See the note above.
    //
    // An upsert with no `setWhere`, so it always fires and therefore always locks: on a virgin
    // account the INSERT takes the primary key, on an established one the DO UPDATE takes the
    // row. Either way a concurrent confirmation blocks here rather than racing past, and reads
    // the winner's rules when it is let through.
    await tx.insert(accountSettings)
      .values({ accountId: ctx.accountId })
      .onConflictDoUpdate({
        target: accountSettings.accountId,
        set: { updatedAt: ctx.now() },
      });

    // The question the lock was taken for. `alreadyDecided` above was computed BEFORE the
    // transaction opened and is stale by definition; this is the same question asked where the
    // answer cannot change under us.
    const decidedNow = await decidedSenders(tx, ctx.accountId, accept.map((c) => c.address));
    const write = accept.filter((c) => !decidedNow.has(c.address));
    const skipped = skippedOffered + (accept.length - write.length);

    // THE USER'S OWN ADDRESSES ARE CONTACTS, and so is everyone consented to here. `contacts`
    // is what the routing layer reads as "senders this account knows", and mail somebody sends
    // to themselves — a note, a forward from another account — is not a first contact. The
    // connect-time pass this seed replaces wrote the own-address rows on every attach; the seed
    // is now their only writer, so dropping the line would look like nothing at all until
    // somebody mailed themselves and found it screened.
    const contactAddresses = [...new Set([...own, ...write.map((c) => c.address)])];
    let contactsCreated = 0;
    for (const part of chunked(contactAddresses, WRITE_CHUNK)) {
      const inserted = await tx.insert(contacts)
        .values(part.map((address) => ({ accountId: ctx.accountId, address })))
        .onConflictDoNothing()
        .returning({ id: contacts.id });
      contactsCreated += inserted.length;
    }

    let lastSeq: bigint | null = null;
    for (const part of chunked(write, WRITE_CHUNK)) {
      const rows = await tx.insert(rules).values(part.map((c) => ({
        accountId: ctx.accountId,
        kind: "sender",
        match: c.address,
        destination: "INBOX",
        priority: 0,
        enabled: true,
        provenance: "seeded-from-sent",
        // NULL, always. See the note above: consent granted in bulk must not move the past.
        retroRequestedAt: null,
      }))).returning({ id: rules.id });
      const seqs = await recordChanges(tx, rows.map((r) => ({
        accountId: ctx.accountId, entityType: "rule" as const, entityId: r.id, op: "create" as const, meta: null,
      })));
      lastSeq = seqs[seqs.length - 1] ?? lastSeq;
    }

    // The stamp, written LAST and describing the run that just happened rather than the first
    // one that ever did. `seed_confirmed_at` is a date the client reads to decide whether the
    // review is still owed; the two counters beside it are diagnostics, and they describe THIS
    // confirmation so that they cannot disagree with the timestamp they sit next to.
    await tx.insert(accountSettings).values({
      accountId: ctx.accountId,
      seedConfirmedAt: ctx.now(),
      seedConfirmedCount: write.length,
      seedDeclinedCount: declined,
    }).onConflictDoUpdate({
      target: accountSettings.accountId,
      set: {
        seedConfirmedAt: ctx.now(),
        seedConfirmedCount: write.length,
        seedDeclinedCount: declined,
        updatedAt: ctx.now(),
      },
    });

    return {
      rulesCreated: write.length,
      contactsCreated,
      declined,
      skipped,
      lastSeq: lastSeq === null ? null : Number(lastSeq),
    };
  });
}

/** Whether this account has been through the seed review, and the window it uses. */
export async function consentSettings(
  ctx: ServiceContext,
): Promise<{
  seedConfirmedAt: string | null;
  dormancyDays: number | null;
  screeningResetAt: string | null;
  /** mail 0056 — the instant the cutline is measured back from. NULL ⇒ measure from `now`. */
  screeningBaselineAt: string | null;
  autoSuggestAt: string | null;
  blockRemoteImagesAt: string | null;
  /** mail 0072 — the instant this account asked for tracking pixels to load. NULL ⇒ blocked. */
  loadTrackingPixelsAt: string | null;
  blockAutoUnsubscribeAt: string | null;
  foldersEnabledAt: string | null;
  locale: string | null;
  themeFace: string | null;
  /**
   * mail 0083 — WHEN the first-run flow was last left, by finishing it or by cancelling it.
   *
   * It is the LAST of the onboarding truth-conditions and the only one the flow writes about
   * itself; every other step reads a fact the product already stored (consent, baseline, import,
   * AI). Cancel and finish both stamp it because the question it answers is "should the flow
   * open by itself again", and both answers to that are no. NULL is "never been through it",
   * which is what makes a fresh install open the flow.
   */
  onboardingCompletedAt: string | null;
  /**
   * mail 0083 — `'window'` (the cutline is `screening_baseline_at − dormancy_days`) or
   * `'all_time'` (no cutline at all, so nothing is filed to History unscreened).
   *
   * A MODE beside the dial rather than a magic value inside it: `dormancy_days` is bounded 1–365
   * by its own writer, so "all time" has no number to be. Read together with `dormancyDays` by
   * both cutlines (`consent-cutline.ts` server-side, the client's parity test).
   */
  screeningScope: "window" | "all_time";
}> {
  const [row] = await ctx.db.select().from(accountSettings)
    .where(eq(accountSettings.accountId, ctx.accountId)).limit(1);
  // An absent row is every account that has never changed anything. Defaults, not an error.
  return {
    seedConfirmedAt: row?.seedConfirmedAt ? row.seedConfirmedAt.toISOString() : null,
    dormancyDays: row?.dormancyDays ?? null,
    screeningResetAt: row?.screeningResetAt ? row.screeningResetAt.toISOString() : null,
    // NULL and an absent row both mean "this account has never decided anything, so measure the
    // window from now" — the pre-0056 behaviour at every layer. Unlike its neighbours this field
    // is not a switch: readers use the VALUE, and the only thing null selects is the old
    // arithmetic. There is deliberately no fallback that invents one, because a baseline nobody
    // established would re-partition a live mailbox with no user action behind it.
    screeningBaselineAt: row?.screeningBaselineAt ? row.screeningBaselineAt.toISOString() : null,
    // NULL is OFF, and so is an absent row. This `?? null` is the whole default: there is no
    // branch anywhere that turns a missing value into ON, because ON authorises spending.
    autoSuggestAt: row?.autoSuggestAt ? row.autoSuggestAt.toISOString() : null,
    // NULL and an absent row both mean "images load automatically" — the product default, and
    // the opposite direction from every other flag on this row. That is safe HERE because this
    // is a server that read the row and found no opt-out. The unsafe case is a client that could
    // not ask at all, and the defaulting for it lives on the client (`consent-state.ts`), where
    // the difference between "no opt-out" and "no answer" is actually visible.
    blockRemoteImagesAt: row?.blockRemoteImagesAt
      ? row.blockRemoteImagesAt.toISOString()
      : null,
    // NULL and an absent row both mean "tracking pixels are blocked" — the product default, and
    // the PROTECTIVE posture, which is the opposite sign from the column directly above. The
    // client collapses a failed read into the same answer (`consent-state.ts`), so here there is
    // no unknown to resolve and nothing to defend: a server that read the row and found no opt-out
    // says blocked, and so does one whose reader could not ask.
    loadTrackingPixelsAt: row?.loadTrackingPixelsAt
      ? row.loadTrackingPixelsAt.toISOString()
      : null,
    // NULL and an absent row both mean "a screen-out still unsubscribes" — the product default,
    // and the same direction as `blockRemoteImagesAt` above rather than as the two flags before
    // it. What the CLIENT does with an unknown differs from that neighbour (see
    // `consent-state.ts`), but nothing about that reaches here: this is a server that read the
    // row, so it has no unknown to resolve.
    blockAutoUnsubscribeAt: row?.blockAutoUnsubscribeAt
      ? row.blockAutoUnsubscribeAt.toISOString()
      : null,
    // NULL is OFF, and so is an absent row — `autoSuggestAt`'s spelling. OFF is the pre-feature
    // interface byte for byte, which is the safe direction (FOLDERS-SPEC.md §10).
    foldersEnabledAt: row?.foldersEnabledAt ? row.foldersEnabledAt.toISOString() : null,
    // NULL, an absent row and — unlike every other field here — an UNSUPPORTED value all answer
    // null, which the client reads as "this account has no preference, keep the device's language".
    // The `??` is what makes the third case true: `LOCALES` is closed by a CHECK, so an unsupported
    // string is unreachable through any writer, and if one ever arrives (a hand-run UPDATE, a
    // restore from a database that predates the constraint) sending it on would put a locale the
    // client cannot load into the boot path. Refusing it here is the read-side half of the same
    // closed set the constraint enforces on the write side.
    locale: SUPPORTED_LOCALES.includes(row?.locale ?? "") ? row!.locale : null,
    // NULL, an absent row and an UNSUPPORTED value all answer null — `locale`'s spelling, for
    // `locale`'s reason: the CHECK closes the set, so an unsupported string is unreachable
    // through any writer, and if one arrives anyway (a hand-run UPDATE, a pre-constraint
    // restore) sending it on would stamp a face nothing renders onto every boot. Null means
    // "no account-wide choice" and each device resolves its own default (consent-state.ts).
    themeFace: SUPPORTED_THEME_FACES.includes(row?.themeFace ?? "") ? row!.themeFace : null,
    // NULL and an absent row both mean "this account has never left the first-run flow", which is
    // the state that OPENS it. That is the safe direction here in the sense that matters: the
    // worst case of a wrongly-null read is a flow that offers itself again to somebody who has
    // already been through it — a screen with a Cancel on it — whereas a wrongly-stamped read
    // hides the flow from an account that has never seen it. No default invents a stamp.
    onboardingCompletedAt: row?.onboardingCompletedAt
      ? row.onboardingCompletedAt.toISOString()
      : null,
    // The column is NOT NULL DEFAULT 'window', so an absent ROW is the only null this can see and
    // it resolves to the same default the column carries. An UNSUPPORTED value answers 'window'
    // too — `locale`'s rule, for `locale`'s reason (the CHECK closes the set, so a value outside
    // it can only come from a hand-run UPDATE) with the direction chosen deliberately: 'window'
    // is the posture in which OLD mail is filed rather than screened, which is what every account
    // that has never touched this has been getting.
    screeningScope: row?.screeningScope === "all_time" ? "all_time" : "window",
  };
}

/**
 * One `settings` change row per settings write — the doorbell that makes a consent knob travel.
 * Every writer appends this in the SAME transaction as its column: `recordChanges` NOTIFYs the
 * wake channel at commit, so every signed-in surface's next drain carries the `settings` entity
 * and re-asks `GET /consent`. Measured before this existed: disabling folders in a browser left
 * the desktop drawing the folders group over tombstoned entities until restart. `entity_id` is
 * the ACCOUNT id and the op is always `"update"`: one row per account, never deleted —
 * `materializeSettings` answers a default-shaped DTO before the first write, so this can never
 * drain as a tombstone.
 */
/**
 * The global lock order: `account_settings` FIRST, the sequence row second. `recordChanges`
 * serializes on the account's `account_sync_state` row; the settings upsert locks
 * `account_settings`. Every transaction touching BOTH takes them in ONE order — settings first —
 * because opposite orders are the textbook Postgres deadlock (40P01), and both directions were
 * reproduced on real Postgres. The order is the one `confirmSeed` designed around and
 * `ScreenerService.decide` follows; `resetScreeningState` was conformed in the same change. Every
 * writer below touches its settings column FIRST and rings the doorbell second; both land or
 * neither does.
 */
// Every writer's INSERT path sets `updatedAt: ctx.now()` explicitly rather than taking the
// column's `defaultNow()`: the row's stamp is the settings ENTITY's `updatedAt` on the wire, and
// a stamp whose first write came from the database clock while every later write comes from the
// context clock is two clocks on one column — the exact thing these writers' own comments refuse
// for the consent instants beside it.
async function recordSettingsChange(tx: LedgerTx, accountId: string): Promise<void> {
  await recordChanges(tx, [
    { accountId, entityType: "settings" as const, entityId: accountId, op: "update" as const },
  ]);
}

/**
 * Turn auto-suggest on or off — a column-scoped write on the shared `account_settings` row. ON
 * lets the Screener surface buy a classifier suggestion for the queue's front without a per-batch
 * click — a METERED spend, and the ONLY thing the flag does: `POST /screener/suggest` writes
 * `status = 'suggestion'` with no `change_log` entry, so nothing it produces moves a message or
 * writes a rule. `onConflictDoUpdate`, not select-then-insert: rows are created lazily, so this
 * races `confirmSeed` and `resetScreeningState` on one primary key — touching only this column
 * plus `updated_at` keeps a concurrent seed confirmation intact
 * (`consent-auto-suggest.concurrency.pg.test.ts`). Returns the stored instant.
 */
export async function setAutoSuggest(
  ctx: ServiceContext, enabled: boolean,
): Promise<{ autoSuggestAt: string | null }> {
  // `now()` from the context clock, not the database's: every other consent timestamp is
  // written this way, and a settings row whose columns come from two clocks cannot be ordered.
  const at = enabled ? ctx.now() : null;
  // The upsert is unchanged and still column-scoped; the transaction exists for the settings
  // change row beside it — see {@link recordSettingsChange}. Both land or neither does.
  await (ctx.db as unknown as Tx).transaction(async (tx) => {
    // ── ERASURE FENCE, FIRST — before any settings lock. `deleteAccount` stamps
    // `accounts.erased_at` at the top of its transaction; reading it FOR SHARE here is what
    // stops this write recreating erased rows, and taking it FIRST is what keeps the lock
    // order a single chain (accounts → settings → sequence row). `erasure-fence.ts` carries
    // the two-sided argument.
    await fenceErasedAccount(tx, dialect(ctx.db), ctx.accountId);
    await tx.insert(accountSettings)
      .values({ accountId: ctx.accountId, autoSuggestAt: at, updatedAt: ctx.now() })
      .onConflictDoUpdate({
        target: accountSettings.accountId,
        set: { autoSuggestAt: at, updatedAt: ctx.now() },
      });
    await recordSettingsChange(tx, ctx.accountId); // AFTER the settings row — the global lock order above
  });
  return { autoSuggestAt: at ? at.toISOString() : null };
}

/**
 * Turn "use folders" on or off — the folders master toggle (FOLDERS-SPEC.md §6), a column-scoped
 * upsert PLUS the one thing no other consent knob does: the transition RIDES THE DELTA FEED.
 * `/sync` emits `folder` entities only while the flag is on, and the delta is strictly
 * `change_log`-driven. So, in the SAME transaction: ON appends one `folder` CREATE per existing
 * user folder; OFF appends one DELETE per folder. Re-enabling re-emits creates; the client's
 * apply is an upsert, so replay is idempotent. Folders discovered WHILE on do not stream yet —
 * the worker's discovery writes no change rows — so a brand-new external folder appears at the
 * next re-bootstrap or re-toggle.
 */
export async function setFoldersEnabled(
  ctx: ServiceContext, enabled: boolean,
): Promise<{ foldersEnabledAt: string | null }> {
  const at = enabled ? ctx.now() : null;
  await (ctx.db as unknown as Tx).transaction(async (tx) => {
    // ── ERASURE FENCE, FIRST — before any settings lock. `deleteAccount` stamps
    // `accounts.erased_at` at the top of its transaction; reading it FOR SHARE here is what
    // stops this write recreating erased rows, and taking it FIRST is what keeps the lock
    // order a single chain (accounts → settings → sequence row). `erasure-fence.ts` carries
    // the two-sided argument.
    await fenceErasedAccount(tx, dialect(ctx.db), ctx.accountId);
    await tx.insert(accountSettings)
      .values({ accountId: ctx.accountId, foldersEnabledAt: at, updatedAt: ctx.now() })
      .onConflictDoUpdate({
        target: accountSettings.accountId,
        set: { foldersEnabledAt: at, updatedAt: ctx.now() },
      });
    // THE FLAG ITSELF travels too — see {@link recordSettingsChange} (and its global lock
    // order, which is why the settings row above comes first). The folder creates/deletes below
    // move the ENTITIES; without this row a client whose consent answer was read at boot kept
    // drawing (or withholding) the GROUP around them — the measured desktop husk. It also
    // covers the case the entity rows cannot: an account with zero user folders appends nothing
    // below, so this is the only thing that rings the wake at all for its flip.
    await recordSettingsChange(tx, ctx.accountId);
    const rows = await listUserFolders(tx as unknown as typeof ctx.db, ctx.accountId);
    if (rows.length > 0) {
      await recordChanges(tx, rows.map((r) => ({
        accountId: ctx.accountId,
        entityType: "folder" as const,
        entityId: r.id,
        op: enabled ? ("create" as const) : ("delete" as const),
      })));
    }
  });
  return { foldersEnabledAt: at ? at.toISOString() : null };
}

/**
 * Switch one mailbox's folders on or off — the per-mailbox dial under the master toggle
 * (FOLDERS-SPEC.md §17). The column stores the EXCEPTION: `folders_disabled_at` NULL means the
 * mailbox participates. The transition rides the delta, scoped to one mailbox: with the master
 * on, OFF appends one `folder` DELETE per user folder and ON appends the CREATEs back — from
 * {@link listMailboxUserFolders}, the UNFILTERED read, because the filtered inventory refuses to
 * answer for the mailbox being switched off, exactly when its tombstones must be written. With
 * the master OFF no change rows are appended, so the dials compose. Column flip and change rows
 * in ONE transaction; the mailbox must belong to the account (404 first).
 */
export async function setMailboxFoldersEnabled(
  ctx: ServiceContext, mailboxId: string, enabled: boolean,
): Promise<{ mailboxId: string; foldersDisabledAt: string | null }> {
  const at = enabled ? null : ctx.now();
  await (ctx.db as unknown as Tx).transaction(async (tx) => {
    // ── ERASURE FENCE, FIRST — before any settings lock. `deleteAccount` stamps
    // `accounts.erased_at` at the top of its transaction; reading it FOR SHARE here is what
    // stops this write recreating erased rows, and taking it FIRST is what keeps the lock
    // order a single chain (accounts → settings → sequence row). `erasure-fence.ts` carries
    // the two-sided argument.
    await fenceErasedAccount(tx, dialect(ctx.db), ctx.accountId);
    const [mb] = await tx.select({ id: mailboxes.id })
      .from(mailboxes)
      .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, ctx.accountId)))
      .limit(1);
    if (!mb) throw new ServiceError("not_found", 404, "no such mailbox on this account");
    // THE STAMP MOVES — AND IT MOVES BEFORE THE MAILBOX ROW. Two reasons, one per line of the
    // global lock chain (settings → mailboxes → sequence row; see {@link recordSettingsChange}
    // and the erasure's note in account-deletion-service.ts, which deletes in exactly that
    // order): the settings ENTITY's `updatedAt` is the `account_settings` row's own — a client
    // that already holds the entity compares stamps and ignores a re-apply whose stamp did not
    // move, so a per-mailbox flip that left the row untouched was a doorbell nobody heard
    // (review-caught staleness) — and taking the mailbox row FIRST put this writer into a
    // 40P01 cycle with erasure, which holds the settings row while deleting toward
    // `mailboxes` (the next round caught that one). The 404-check SELECT above locks nothing,
    // so it may stay first.
    await tx.insert(accountSettings)
      .values({ accountId: ctx.accountId, updatedAt: ctx.now() })
      .onConflictDoUpdate({
        target: accountSettings.accountId,
        set: { updatedAt: ctx.now() },
      });
    await tx.update(mailboxes)
      .set({ foldersDisabledAt: at })
      .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, ctx.accountId)));
    // The dial's own change row, master on or off — the per-mailbox exception is settings state
    // whatever the master says, and a surface holding a stale exceptions map is the same
    // staleness the master's row exists to end.
    await recordSettingsChange(tx, ctx.accountId);
    const [master] = await tx.select({ at: accountSettings.foldersEnabledAt })
      .from(accountSettings)
      .where(eq(accountSettings.accountId, ctx.accountId))
      .limit(1);
    if ((master?.at ?? null) === null) return;   // master off ⇒ nothing on the wire to move
    const rows = await listMailboxUserFolders(
      tx as unknown as typeof ctx.db, ctx.accountId, mailboxId,
    );
    if (rows.length > 0) {
      await recordChanges(tx, rows.map((r) => ({
        accountId: ctx.accountId,
        entityType: "folder" as const,
        entityId: r.id,
        op: enabled ? ("create" as const) : ("delete" as const),
      })));
    }
  });
  return { mailboxId, foldersDisabledAt: at ? at.toISOString() : null };
}

/**
 * The signature's length ceiling, in characters — enforced HERE, as a 400 in words, rather than
 * as a CHECK: free text closes no set, and a database byte bound would answer a person typing
 * with a raw 23514. Ten thousand characters is roomier than any signature anybody signs with
 * and small enough that the consent read carrying every mailbox's text stays a settings
 * payload rather than a document store.
 */
export const MAILBOX_SIGNATURE_MAX_CHARS = 10_000;

/**
 * Set one mailbox's signature (mail 0075). `null` and a value empty after trimming CLEAR it; a
 * non-empty value is stored AS TYPED, bounded by {@link MAILBOX_SIGNATURE_MAX_CHARS}. The
 * transaction is {@link setMailboxFoldersEnabled}'s: the mailbox must belong to the account, the
 * `account_settings` stamp must MOVE, and it moves BEFORE the mailbox row — the settings →
 * mailboxes → sequence lock chain. The markup half (mail 0098): `signatureHtml` carries the
 * editor's markup and `signature` is COMPUTED from it by {@link prepareOutboundBody} — two
 * columns, one value. Supplying BOTH is refused: markup saying `Anna` beside text saying `Bob`. A
 * PLAIN write clears the markup; emptiness is decided on the TEXT.
 */
export async function setMailboxSignature(
  ctx: ServiceContext, mailboxId: string, signature: string | null,
  signatureHtml?: string | null,
): Promise<MailboxSignatureResult> {
  if (signature !== null && typeof signature !== "string") {
    throw new ServiceError("validation_failed", 400, "signature must be a string or null");
  }
  if (signatureHtml !== undefined && signatureHtml !== null && typeof signatureHtml !== "string") {
    throw new ServiceError("validation_failed", 400, "signatureHtml must be a string or null");
  }
  // Is there MARKUP in this write at all? Blank-after-trimming is not markup — see the header.
  const hasMarkup = typeof signatureHtml === "string" && signatureHtml.trim().length > 0;
  if (hasMarkup && signature !== null) {
    throw new ServiceError(
      "validation_failed", 400,
      "a signature is stored as text or as markup, never both",
    );
  }
  // The bound is on whichever value ARRIVED, in the same characters and with the same words. The
  // markup is the longer of the two shapes for one signature, so bounding it is what bounds what
  // the `GET /consent` read carries.
  if (hasMarkup && signatureHtml!.length > MAILBOX_SIGNATURE_MAX_CHARS) {
    throw new ServiceError(
      "validation_failed", 400,
      `signature must be at most ${MAILBOX_SIGNATURE_MAX_CHARS} characters`,
    );
  }
  // A NUL in the markup, for the text half's reason below and with the same refusal.
  if (hasMarkup && signatureHtml!.includes("\u0000")) {
    throw new ServiceError("validation_failed", 400, "signature must not contain a NUL character");
  }
  if (signature !== null && signature.length > MAILBOX_SIGNATURE_MAX_CHARS) {
    throw new ServiceError(
      "validation_failed", 400,
      `signature must be at most ${MAILBOX_SIGNATURE_MAX_CHARS} characters`,
    );
  }
  // A NUL is legal in a JSON string and illegal in a PostgreSQL `text` value — unrejected, it
  // reaches the driver as an encoding error, which surfaces as a 500 and rolls back the whole
  // batch (review round 1). Refused HERE, before the transaction opens, in words: no signature
  // anybody typed contains one, so the only senders are callers probing the wire.
  if (signature !== null && signature.includes("\u0000")) {
    throw new ServiceError("validation_failed", 400, "signature must not contain a NUL character");
  }
  /**
   * THE TWO SHAPES, DERIVED TOGETHER OR NEITHER.
   *
   * In the markup branch `prepareOutboundBody` runs the compose allow-list and then renders the
   * text FROM WHAT SURVIVED IT, so nothing the sanitizer removed can reach the text half — the
   * property that makes the pair honest rather than merely consistent.
   */
  let stored: string | null;
  let storedHtml: string | null;
  if (hasMarkup) {
    const prepared = prepareOutboundBody(signatureHtml!);
    // Decided on the TEXT: markup that renders to nothing is no signature. See the header.
    const empty = prepared.text.trim().length === 0;
    stored = empty ? null : prepared.text;
    storedHtml = empty ? null : prepared.html;
  } else {
    stored = signature !== null && signature.trim().length > 0 ? signature : null;
    // A plain write clears the markup — saving text is saving the whole value.
    storedHtml = null;
  }
  let travel: { pending: true; holder: OrganizedBy; requestId: string } | undefined;
  await (ctx.db as unknown as Tx).transaction(async (tx) => {
    // ── ERASURE FENCE, FIRST — before any settings lock. `deleteAccount` stamps
    // `accounts.erased_at` at the top of its transaction; reading it FOR SHARE here is what
    // stops this write recreating erased rows, and taking it FIRST is what keeps the lock
    // order a single chain (accounts → settings → sequence row). `erasure-fence.ts` carries
    // the two-sided argument.
    await fenceErasedAccount(tx, dialect(ctx.db), ctx.accountId);
    const [mb] = await tx.select({ id: mailboxes.id })
      .from(mailboxes)
      .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, ctx.accountId)))
      .limit(1);
    if (!mb) throw new ServiceError("not_found", 404, "no such mailbox on this account");

    /**
     * The signature is per mailbox, so it takes the per-mailbox dispatch (mail 0094). The other
     * three settings in this family are account-scoped and fan out; `mailboxes.signature` is not:
     * a person with two addresses has two sign-offs, and the account-wide question would publish
     * one mailbox's into the other's document. On a mailbox this install only reads, the
     * signature is appended by the install that HOLDS it, from the published document — so this
     * write used to land in a column nothing reads while the pane showed the new sign-off. The
     * request travels instead; the local column is left alone, never both.
     */
    const route = await routeMailboxWrite(tx, ctx.accountId, mailboxId, "profile.update");
    if (route.route === "request") {
      /* THE TRAVELLING BOUND, and it is in CHARACTERS so the sentence is about the signature.
         `MAILBOX_SIGNATURE_MAX_CHARS` (10 000) still governs a LOCAL write — that text never
         crosses a wire. A travelling one does, and 10 000 characters exceeds the record's own
         encoded ceiling, which would be refused later with a sentence about bytes. */
      if (stored !== null && stored.length > TRAVELLING_SIGNATURE_MAX_CHARS) {
        throw new ServiceError(
          "validation_failed", 400,
          `a signature that has to travel to the install organizing this mailbox must be at most `
          + `${TRAVELLING_SIGNATURE_MAX_CHARS} characters`,
        );
      }
      /* BOTH SHAPES TRAVEL (ruling of 2026-09-10) — the SAME pair written above, so the holder
         stores what a local save would have stored. Sending the text alone left the holder's
         markup as it was: a formatted sign-off arrived with the formatting stripped, and a plain
         save left stale markup for the holder's composer to ship in place of the words just
         saved. `storedHtml` is `null` in the plain branch, and that null is the instruction to
         clear it. The record's own byte ceiling is asked at the door by `writeReaderRequest`. */
      const sent = await writeReaderRequest(tx, ctx, {
        mailboxId, kind: "profile.update", holder: route.holder,
        payload: profileRequestPayload({ signature: stored, signatureHtml: storedHtml }),
      });
      travel = { pending: true, holder: route.holder, requestId: sent.requestId };
      return;
    }

    // The stamp moves, and it moves BEFORE the mailbox row — see the header and
    // {@link setMailboxFoldersEnabled}'s identical block for the two measured reasons.
    await tx.insert(accountSettings)
      .values({ accountId: ctx.accountId, updatedAt: ctx.now() })
      .onConflictDoUpdate({
        target: accountSettings.accountId,
        set: { updatedAt: ctx.now() },
      });
    // BOTH columns in ONE statement, always — including the plain branch, where the markup is
    // set to NULL rather than left alone. Writing only the column that changed is what would
    // let the two halves drift.
    await tx.update(mailboxes)
      .set({ signature: stored, signatureHtml: storedHtml })
      .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, ctx.accountId)));
    await recordSettingsChange(tx, ctx.accountId);
  });
  /* THE UNCHANGED COLUMNS when the edit travelled — the person is looking at them and neither
     changed here. Read both back rather than echoing `stored`/`storedHtml`, which would be the
     values they typed for a write that happened on the install holding this mailbox. */
  if (travel !== undefined) {
    const [row] = await (ctx.db as unknown as Tx)
      .select({ signature: mailboxes.signature, signatureHtml: mailboxes.signatureHtml })
      .from(mailboxes).where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, ctx.accountId)))
      .limit(1);
    return {
      mailboxId, signature: row?.signature ?? null, signatureHtml: row?.signatureHtml ?? null,
      ...travel,
    };
  }
  return { mailboxId, signature: stored, signatureHtml: storedHtml };
}

/**
 * EVERY STORED SIGNATURE ON THE ACCOUNT — `{ mailboxId: text }`, only the mailboxes that have
 * one. The `GET /consent` read and the write echo; {@link mailboxFoldersOff}'s shape for the
 * same reason (an absent key IS the resting state, so nothing invents an empty string for a
 * mailbox that never had a signature).
 */
export async function mailboxSignatures(
  db: ServiceContext["db"], accountId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({ id: mailboxes.id, signature: mailboxes.signature })
    .from(mailboxes)
    .where(eq(mailboxes.accountId, accountId));
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (r.signature !== null) out[r.id] = r.signature;
  }
  return out;
}

/**
 * EVERY STORED SIGNATURE'S MARKUP — `{ mailboxId: html }`, only the mailboxes whose signature has
 * formatting in it. {@link mailboxSignatures}' shape and rule, one question over.
 *
 * AN ABSENT KEY HERE IS "NO FORMATTING", NEVER "NO SIGNATURE" — the text map answers that, and
 * the two are read together. A mailbox with a plain signature appears in `signatures` and not
 * here, which is exactly the state every mailbox was in before mail 0098.
 */
export async function mailboxSignatureHtmls(
  db: ServiceContext["db"], accountId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({ id: mailboxes.id, signatureHtml: mailboxes.signatureHtml })
    .from(mailboxes)
    .where(eq(mailboxes.accountId, accountId));
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (r.signatureHtml !== null) out[r.id] = r.signatureHtml;
  }
  return out;
}

/**
 * Set the dormancy window — the cutline dial: how long a sender may be quiet before the Screener
 * stops asking. PURE VISIBILITY — it changes which undecided senders are SHOWN, never where mail
 * lives (the pg test reddens on any rule, contact or `folder_state` write); the one change row is
 * the `settings` doorbell. The 1–365 refusal restates the column CHECK as a 400 — load-bearing:
 * 2e8 makes `toISOString()` throw, a permanent 500 on `GET /consent`. NEVER store the default:
 * `null` and `DEFAULT_DORMANCY_DAYS` both persist NULL. `screening_scope` (mail 0083) is the same
 * question's other answer, written HERE by the one writer; absent means UNTOUCHED, both absent a
 * 400. Returns the EFFECTIVE window and mode.
 */
export async function setDormancyDays(
  ctx: ServiceContext, days: number | null | undefined, scope?: "window" | "all_time",
): Promise<DormancyResult> {
  if (days === undefined && scope === undefined) {
    throw new ServiceError(
      "validation_failed", 400, "one of dormancyDays or screeningScope must be given",
    );
  }
  if (days !== null && days !== undefined && (!Number.isInteger(days) || days < 1 || days > 365)) {
    throw new ServiceError(
      "validation_failed", 400,
      "dormancyDays must be an integer between 1 and 365, or null",
    );
  }
  if (scope !== undefined && scope !== "window" && scope !== "all_time") {
    throw new ServiceError("validation_failed", 400, "screeningScope must be window or all_time");
  }
  // NEVER STORE THE DEFAULT — see the note above. `null` and the default both mean "use the product
  // default", so both persist NULL and let the read side substitute it.
  const stored = days === null || days === DEFAULT_DORMANCY_DAYS ? null : days;
  /** Did the caller NAME the window? `undefined` leaves the column exactly as it is. */
  const setsWindow = days !== undefined;
  let effective: { dormancyDays: number | null; screeningScope: string } | undefined;
  let travel: ProfileTravel | undefined;
  let pending = false;
  // Column-scoped upsert unchanged; the transaction adds the settings change row — see
  // {@link recordSettingsChange}.
  await (ctx.db as unknown as Tx).transaction(async (tx) => {
    // ── ERASURE FENCE, FIRST — before any settings lock. `deleteAccount` stamps
    // `accounts.erased_at` at the top of its transaction; reading it FOR SHARE here is what
    // stops this write recreating erased rows, and taking it FIRST is what keeps the lock
    // order a single chain (accounts → settings → sequence row). `erasure-fence.ts` carries
    // the two-sided argument.
    await fenceErasedAccount(tx, dialect(ctx.db), ctx.accountId);

    /**
     * The window is applied by the install that ORGANIZES (mail 0094). `dormancy_days` is the
     * cutline the screening pass does arithmetic on, in the organizer's own cycle — written where
     * nothing organizes, it is a dial wired to nothing, which is exactly why the answer is a
     * REQUEST rather than a refusal: the setting is not dangerous, just ineffective where it
     * lands, and it can travel to the install where it is not. What survives of the old census
     * exemption is the ONBOARDING case: 0 mailboxes held and 0 organized ADMITS the local write,
     * because that is consent time and refusing there makes the flow that offers this dial
     * unfinishable. `planAccountFanOut` carries that state by name.
     */
    const plan = await planAccountFanOut(tx, ctx.accountId, "profile.update");
    const travelling = {
      // Only what this request named — absence is load-bearing in the partial. `screeningScope`
      // is deliberately NOT in the payload: it is not one of ruling 6's four fields, and adding
      // a member is a ruling rather than a commit. Named here so the omission is a decision
      // somebody can find rather than a field that was forgotten.
      ...(setsWindow ? { dormancyDays: stored } : {}),
    };
    if (!plan.writeLocally && setsWindow) {
      travel = await fanOutProfileEdit(tx, ctx, plan, travelling);
      pending = true;
      const [current] = await tx.select({
        dormancyDays: accountSettings.dormancyDays,
        screeningScope: accountSettings.screeningScope,
      }).from(accountSettings).where(eq(accountSettings.accountId, ctx.accountId)).limit(1);
      effective = current;
      return;
    }

    /* ── UPSERT, NEVER UPDATE, AND THAT IS NOT A STYLE CHOICE ────────────────────────────
       A fresh STANDALONE install has NO `account_settings` row at all — driven against a
       live local engine, where the table came back empty over a fully-imported mailbox. An
       UPDATE would match zero rows, report success and store nothing, so the ladder anybody
       just chose would be silently discarded on exactly the door where the flow that offers
       it is the funnel. Rows here are created lazily by whichever feature writes first,
       which is why every writer of this table upserts. */
    const [row] = await tx.insert(accountSettings)
      .values({
        accountId: ctx.accountId,
        // Both fields are ABSENT-MEANS-UNTOUCHED, symmetrically. On a fresh row an omitted
        // window is NULL ("track the product default") and an omitted mode takes the
        // column's own `NOT NULL DEFAULT 'window'` — both the honest answers for a row
        // nobody has written yet.
        ...(setsWindow ? { dormancyDays: stored } : {}),
        ...(scope !== undefined ? { screeningScope: scope } : {}),
        updatedAt: ctx.now(),
      })
      .onConflictDoUpdate({
        target: accountSettings.accountId,
        set: {
          // ABSENT MEANS UNTOUCHED, the route's own field-present-⇒-acted-on rule carried
          // into the writer, and it has to hold in BOTH directions: a caller that names only
          // the mode must not re-assert a window it never read, and a caller that names only
          // the window must not silently drag an `all_time` account back into a window
          // nobody chose. Re-asserting either one would also clobber a concurrent writer of
          // the other, which is the whole reason this table's writers are column-scoped.
          ...(setsWindow ? { dormancyDays: stored } : {}),
          ...(scope !== undefined ? { screeningScope: scope } : {}),
          updatedAt: ctx.now(),
        },
      })
      // Both columns read back from the row the write produced, rather than inferred: when
      // `scope` is absent the stored mode is whatever it already was, and this is the only
      // way to echo it without a second read racing the same transaction.
      .returning({
        dormancyDays: accountSettings.dormancyDays,
        screeningScope: accountSettings.screeningScope,
      });
    effective = row;
    await recordSettingsChange(tx, ctx.accountId); // AFTER the settings row — the global lock order above
    if (profileTravelled(plan) && setsWindow) {
      travel = await fanOutProfileEdit(tx, ctx, plan, travelling);
    }
  });
  return {
    dormancyDays: effective?.dormancyDays ?? DEFAULT_DORMANCY_DAYS,
    // Narrowed, never projected verbatim: the column is `text` with a CHECK, and anything
    // outside the closed set must read as the safe mode rather than reach a client as a
    // third state no surface has copy for.
    screeningScope: effective?.screeningScope === "all_time" ? "all_time" : "window",
    ...(pending ? { pending: true as const } : {}),
    ...(travel === undefined ? {} : { travel }),
  };
}

/**
 * Keep the per-message "show images" flow, or let remote images load — the only knob storing an
 * OPT-OUT of the default. `blocked === true` stamps the instant: keep the consent flow. `false`
 * NULLs the column — the default: remote images load through `GET /img` without a press
 * (`0048_remote_images_default.sql`: an opt-in leaves every existing account on a default nobody
 * is on). It spends nothing and moves no mail; it changes only whether the pane offers "Show
 * images" per message. Beacons are unaffected — the sanitizer refuses pixel-shaped urls the proxy
 * in BOTH modes — and the reader's address is protected by the proxy's url-only signature, not by
 * the flag. Column-scoped upsert; returns the stored instant.
 */
export async function setBlockRemoteImages(
  ctx: ServiceContext, blocked: boolean,
): Promise<{ blockRemoteImagesAt: string | null }> {
  // The context clock, not the database's — every other consent timestamp is written this way,
  // and a settings row whose columns come from two clocks cannot be ordered.
  const at = blocked ? ctx.now() : null;
  // Column-scoped upsert unchanged; the transaction adds the settings change row — see
  // {@link recordSettingsChange}. This is one of the two knobs the cross-surface staleness was
  // measured on: an image posture changed in a browser must reach an open desktop pane without
  // a restart.
  await (ctx.db as unknown as Tx).transaction(async (tx) => {
    // ── ERASURE FENCE, FIRST — before any settings lock. `deleteAccount` stamps
    // `accounts.erased_at` at the top of its transaction; reading it FOR SHARE here is what
    // stops this write recreating erased rows, and taking it FIRST is what keeps the lock
    // order a single chain (accounts → settings → sequence row). `erasure-fence.ts` carries
    // the two-sided argument.
    await fenceErasedAccount(tx, dialect(ctx.db), ctx.accountId);
    await tx.insert(accountSettings)
      .values({ accountId: ctx.accountId, blockRemoteImagesAt: at, updatedAt: ctx.now() })
      .onConflictDoUpdate({
        target: accountSettings.accountId,
        set: { blockRemoteImagesAt: at, updatedAt: ctx.now() },
      });
    await recordSettingsChange(tx, ctx.accountId); // AFTER the settings row — the global lock order above
  });
  return { blockRemoteImagesAt: at ? at.toISOString() : null };
}

/**
 * Block tracking pixels, or let them load — storing the opt-out of a PROTECTION (mail 0072).
 * `blocked === true` is the default and NULLs the column; `false` stamps the instant: beacons
 * load with the pictures, through the same proxy. The sender then learns the open — usually which
 * recipient, via the per-recipient token — while the reader's network stays hidden: the proxy's
 * port takes a url and nothing else. The sign is the reverse of the neighbour's: there NULL is
 * permissive, here NULL is protective — an opt-out so the default reaches every account that
 * never finds the setting. It changes one thing: whether the sanitizer's pixel override refuses
 * the proxy; in manual-images mode a pixel still waits. Returns the stored instant.
 */
export async function setBlockTrackingPixels(
  ctx: ServiceContext, blocked: boolean,
): Promise<{ loadTrackingPixelsAt: string | null }> {
  const at = blocked ? null : ctx.now();
  // Column-scoped upsert unchanged; the transaction adds the settings change row — see
  // {@link recordSettingsChange}.
  await (ctx.db as unknown as Tx).transaction(async (tx) => {
    // ── ERASURE FENCE, FIRST — before any settings lock. `deleteAccount` stamps
    // `accounts.erased_at` at the top of its transaction; reading it FOR SHARE here is what
    // stops this write recreating erased rows, and taking it FIRST is what keeps the lock
    // order a single chain (accounts → settings → sequence row). `erasure-fence.ts` carries
    // the two-sided argument.
    await fenceErasedAccount(tx, dialect(ctx.db), ctx.accountId);
    await tx.insert(accountSettings)
      .values({ accountId: ctx.accountId, loadTrackingPixelsAt: at, updatedAt: ctx.now() })
      .onConflictDoUpdate({
        target: accountSettings.accountId,
        set: { loadTrackingPixelsAt: at, updatedAt: ctx.now() },
      });
    await recordSettingsChange(tx, ctx.accountId); // AFTER the settings row — the global lock order above
  });
  return { loadTrackingPixelsAt: at ? at.toISOString() : null };
}

/**
 * Keep auto-unsubscribe, or stop it. `blocked === true` stamps the instant: screening a sender
 * out stops sending a one-click unsubscribe on the account's behalf; `false` NULLs the column,
 * the default. The spelling is not arguable: the behaviour is ALREADY RUNNING for every existing
 * account, so an opt-in without a backfill would switch it off silently, and with one would write
 * a preference nobody expressed (`0054_auto_unsubscribe_optout.sql`). It gates exactly one seam:
 * {@link UnsubscribeService.onScreenOut} (and `sweepScreenedOut` through it) — NOT the
 * per-message button: a switch labelled "auto" may not quietly disable a manual control. Returns
 * the stored instant.
 */
export async function setBlockAutoUnsubscribe(
  ctx: ServiceContext, blocked: boolean,
): Promise<{ blockAutoUnsubscribeAt: string | null }> {
  // The context clock, not the database's — every other consent timestamp is written this way,
  // and a settings row whose columns come from two clocks cannot be ordered.
  const at = blocked ? ctx.now() : null;
  // Column-scoped upsert unchanged; the transaction adds the settings change row — see
  // {@link recordSettingsChange}.
  await (ctx.db as unknown as Tx).transaction(async (tx) => {
    // ── ERASURE FENCE, FIRST — before any settings lock. `deleteAccount` stamps
    // `accounts.erased_at` at the top of its transaction; reading it FOR SHARE here is what
    // stops this write recreating erased rows, and taking it FIRST is what keeps the lock
    // order a single chain (accounts → settings → sequence row). `erasure-fence.ts` carries
    // the two-sided argument.
    await fenceErasedAccount(tx, dialect(ctx.db), ctx.accountId);
    await tx.insert(accountSettings)
      .values({ accountId: ctx.accountId, blockAutoUnsubscribeAt: at, updatedAt: ctx.now() })
      .onConflictDoUpdate({
        target: accountSettings.accountId,
        set: { blockAutoUnsubscribeAt: at, updatedAt: ctx.now() },
      });
    await recordSettingsChange(tx, ctx.accountId); // AFTER the settings row — the global lock order above
  });
  return { blockAutoUnsubscribeAt: at ? at.toISOString() : null };
}

/**
 * THE INTERFACE LANGUAGES THIS SERVICE WILL STORE — the same closed set as the CHECK on
 * `account_settings.locale` (mail 0053) and as `LOCALES` in `apps/webapp/app/shell/locale.ts`.
 *
 * Restated here rather than imported, because `packages/services` may not depend on an app: the
 * constraint is the layer that actually holds the two together, and `consent-locale.test.ts`
 * asserts this array and the catalogue files on disk agree so the restatement cannot drift.
 */
export const SUPPORTED_LOCALES: readonly string[] = ["en", "de"];

/**
 * THE DEFAULT, which is never stored. See {@link setLocale} and the migration's header.
 */
const DEFAULT_LOCALE = "en";

/**
 * Set the interface language — the only string-valued knob. `null` — and `'en'`, which means the
 * same — persist NULL: the default is never stored, and the client reads the difference: NULL
 * means "no account preference — the device's language stands"; `'de'` OVERRIDES the device, on
 * every machine. Storing `'en'` for an account that never opened the selector would reset a
 * German-set browser to English at every boot. Asking for English is how an account gives its
 * devices their choice back. It authorises NOTHING. Column-scoped upsert; returns the STORED
 * value — a client that asked for English reads back `null`, exactly what it needs to stop
 * overriding its own device.
 */
export async function setLocale(
  ctx: ServiceContext, locale: string | null,
): Promise<{ locale: string | null }> {
  if (locale !== null && !SUPPORTED_LOCALES.includes(locale)) {
    throw new ServiceError(
      "validation_failed", 400,
      `locale must be one of ${SUPPORTED_LOCALES.join(", ")}, or null`,
    );
  }
  // NEVER STORE THE DEFAULT — see the note above. The two spellings of "use the default" collapse
  // to one stored representation so no reader has to handle both.
  const stored = locale === null || locale === DEFAULT_LOCALE ? null : locale;
  // Column-scoped upsert unchanged; the transaction adds the settings change row — see
  // {@link recordSettingsChange}.
  await (ctx.db as unknown as Tx).transaction(async (tx) => {
    // ── ERASURE FENCE, FIRST — before any settings lock. `deleteAccount` stamps
    // `accounts.erased_at` at the top of its transaction; reading it FOR SHARE here is what
    // stops this write recreating erased rows, and taking it FIRST is what keeps the lock
    // order a single chain (accounts → settings → sequence row). `erasure-fence.ts` carries
    // the two-sided argument.
    await fenceErasedAccount(tx, dialect(ctx.db), ctx.accountId);
    await tx.insert(accountSettings)
      .values({ accountId: ctx.accountId, locale: stored, updatedAt: ctx.now() })
      .onConflictDoUpdate({
        target: accountSettings.accountId,
        set: { locale: stored, updatedAt: ctx.now() },
      });
    await recordSettingsChange(tx, ctx.accountId); // AFTER the settings row — the global lock order above
  });
  return { locale: stored };
}

/**
 * The closed set of appearance faces — mirrored by the migration's CHECK (mail 0082), the wire
 * validation in `PATCH /consent/settings`, and the Settings control.
 */
export const SUPPORTED_THEME_FACES: readonly string[] = ["paper", "ohmarchy"];

/**
 * Set the account-wide appearance face — `locale`'s twin with ONE deliberate inversion: the
 * default IS stored. `setLocale` maps a request for English back to NULL because "asked for the
 * default" and "never chose" resolve identically on every device. The face cannot collapse the
 * two: a Linux device with no choice defaults to the ohmarchy face for that device only, so an
 * explicit account-wide `'paper'` is a real instruction — exactly what overrides that detection —
 * and storing NULL would make it unsayable on the one class of device it targets. `null` remains
 * sendable: "drop the account-wide choice, let each device resolve its own default". It
 * authorises nothing. Column-scoped upsert in the same lock order; returns the STORED value.
 */
export async function setThemeFace(
  ctx: ServiceContext, themeFace: string | null,
): Promise<{ themeFace: string | null }> {
  if (themeFace !== null && !SUPPORTED_THEME_FACES.includes(themeFace)) {
    throw new ServiceError(
      "validation_failed", 400,
      `themeFace must be one of ${SUPPORTED_THEME_FACES.join(", ")}, or null`,
    );
  }
  await (ctx.db as unknown as Tx).transaction(async (tx) => {
    // Erasure fence FIRST — the single lock chain (accounts → settings → sequence row) that
    // every settings writer keeps; `erasure-fence.ts` carries the two-sided argument.
    await fenceErasedAccount(tx, dialect(ctx.db), ctx.accountId);
    await tx.insert(accountSettings)
      .values({ accountId: ctx.accountId, themeFace, updatedAt: ctx.now() })
      .onConflictDoUpdate({
        target: accountSettings.accountId,
        set: { themeFace, updatedAt: ctx.now() },
      });
    await recordSettingsChange(tx, ctx.accountId); // AFTER the settings row — the global lock order
  });
  return { themeFace };
}

/**
 * Stamp `account_settings.onboarding_completed_at` — the first-run flow has been LEFT (mail
 * 0083). A stamp, not a step counter: onboarding state is derived from truth-conditions the
 * product stores, and exactly one fact is not derivable — whether the person was offered the flow
 * and left it. Without it, a finished account re-opens the flow every boot. Cancel and finish
 * write the SAME thing: both answer "should this open by itself again" with no; what was
 * completed stays legible in the truth-conditions. It RE-STAMPS rather than coalescing — "Run
 * setup again" re-runs deliberately, and nothing reads it as an age. It authorises nothing:
 * consent, window and scope are written by `organizeHere` in ITS transaction.
 */
export async function setOnboardingCompleted(
  ctx: ServiceContext,
): Promise<{ onboardingCompletedAt: string }> {
  const at = ctx.now();
  await (ctx.db as unknown as Tx).transaction(async (tx) => {
    // Erasure fence FIRST — the single lock chain (accounts → settings → sequence row) every
    // settings writer keeps; `erasure-fence.ts` carries the two-sided argument.
    await fenceErasedAccount(tx, dialect(ctx.db), ctx.accountId);
    await tx.insert(accountSettings)
      .values({ accountId: ctx.accountId, onboardingCompletedAt: at, updatedAt: at })
      .onConflictDoUpdate({
        target: accountSettings.accountId,
        set: { onboardingCompletedAt: at, updatedAt: at },
      });
    await recordSettingsChange(tx, ctx.accountId); // AFTER the settings row — the global lock order
  });
  return { onboardingCompletedAt: at.toISOString() };
}

/* `assertNotConfirmed` used to live here: a helper that turned a non-null `seed_confirmed_at`
   into a 409. It is gone because the fact it asserted is no longer a refusal — a confirmed
   account may be shown the review again, and `confirmSeed` writes only what is new. A guard
   whose condition has stopped meaning "refuse" is worse than no guard: the next caller to
   reach for it would reintroduce the wall by name. */
