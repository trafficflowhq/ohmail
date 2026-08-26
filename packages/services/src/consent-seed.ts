import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  accountSettings, contacts, mailboxes, messageBodies, messages, recordChanges, rules,
  type LedgerTx, type Tx,
} from "@trafficflow/db";
import { listMailboxUserFolders, listUserFolders } from "./folders.js";
import type { ServiceContext } from "./context.js";
import { DEFAULT_DORMANCY_DAYS } from "./consent-cutline.js";
import { ServiceError } from "./errors.js";

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE SENT-MAIL SEED — consent, read off what the user has already done.

   The strongest thing anybody does towards a correspondent is WRITE TO THEM. So the first
   question a new mailbox is asked is not "who do you want to hear from" — an impossible
   question against fifteen thousand messages — but "here are the people you have written to;
   shall we let them through?". The list is shown BEFORE anything acts on it, and confirming it
   is the consent event.

   Three deliberate narrowings, each of which was easy to get wrong:

     · ADDRESS-LEVEL ONLY, NEVER DOMAIN. Writing to one person at a large mail provider says
       nothing about the rest of it, and writing to one colleague is indistinguishable from
       that without knowing which domains are companies. Domain-wide consent stays available
       where it belongs — as an explicit rule the user writes themselves.
     · TO AND CC BOTH COUNT. Copying somebody in is addressing them.
     · NO RETRO. A seeded rule routes future mail and moves nothing that already exists. One
       confirmation must never turn into thousands of moves inside somebody's mailbox.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

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
 * Was this message generated rather than typed?
 *
 * Harvesting recipients out of the user's own out-of-office replies would read a machine's
 * address book as the user's. `Auto-Submitted: no` is RFC 3834's way of saying a human wrote
 * it, so presence alone is the wrong test.
 */
export function isMachineSent(headers: Readonly<Record<string, unknown>>, subject: string): boolean {
  const values = (name: string): string[] => {
    if (!Object.prototype.hasOwnProperty.call(headers, name)) return [];
    const v = headers[name];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  };
  if (values("auto-submitted").some((v) => !/^no$/i.test(v.trim()))) return true;
  if (values("precedence").some((v) => /bulk|auto_?reply|junk|list/i.test(v))) return true;
  if (values("x-auto-response-suppress").length > 0) return true;
  return OUT_OF_OFFICE.test(subject);
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
 * A readable display name, or nothing.
 *
 * ── WHY THIS DECODES RATHER THAN DROPS ────────────────────────────────────────────────────
 *
 * It used to return `null` for anything starting with `=?`, on the theory that "a half-decoded
 * name is worse than none". In real mail that theory dropped the display name of every
 * correspondent whose name carries an accent: a `To:`/`Cc:` display name with any non-ASCII
 * letter is transmitted as an RFC 2047 encoded-word (an `=?utf-8?Q?...?=` token that spells the
 * accented bytes back in ASCII), which is ASCII on the wire, so the drop-rule turned a name like
 * "Sébastien" into a bare address on the screen whose whole job is to help someone recognise who
 * they wrote to. Encoded-words are the COMMON case for a non-English address book, not an edge
 * one, and decoding them is the fix.
 *
 * ── AND WHY IT ALSO REPAIRS MOJIBAKE ──────────────────────────────────────────────────────
 *
 * A second, rarer corruption is a display name that reached storage as raw 8-bit UTF-8 in a
 * header (non-conformant, but real senders do it) and was folded through Latin-1 somewhere on
 * the way in, so `ø` (`0xC3 0xB8`) is stored as `Ã¸`. `repairLatin1Mojibake` reverses exactly
 * that, and only that — its round-trip guard leaves a correctly-decoded name untouched.
 */
function displayName(raw: string): string | null {
  const decoded = repairLatin1Mojibake(decodeEncodedWords(raw.trim()));
  const s = decoded.trim().replace(/^"|"$/g, "").trim();
  return s || null;
}

/**
 * RFC 2047 encoded-words → text. Handles `B` (base64) and `Q` (quoted-printable-ish) with any
 * charset, decoding UTF-8 exactly and treating everything else as Latin-1 (the only other
 * charset that appears in practice, and a safe superset of US-ASCII for the rest).
 *
 * Adjacent encoded-words separated by only whitespace are joined with the whitespace removed,
 * per §6.2 — that is how a long name is split across two words, and printing the fold as a space
 * would insert one that was never in the name. A `=?` that is not a well-formed encoded-word is
 * left exactly as it was, which is the whole difference from the predecessor that treated the
 * prefix alone as a reason to give up.
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
 * Everyone this account has written to, robot-filtered, newest correspondence first.
 *
 * "Written by the user" is `from_address` matching one of the account's own mailbox
 * addresses, NOT "sits in a folder called Sent". Sent folders are named a dozen different ways
 * across providers, and — more importantly — a folder-shaped test would also sweep up an
 * Archive folder, whose messages were RECEIVED. Harvesting their `To`/`Cc` would seed consent
 * for everyone the user was once copied alongside, which is not consent at all.
 *
 * The known limitation of that choice: mail sent from an alias the account does not list as a
 * mailbox address is not read. It is the safe direction to be wrong in — a missing candidate
 * is one row the user does not see, an extra one is consent nobody gave.
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
  const rows = await db.select({ match: rules.match }).from(rules)
    .where(and(
      eq(rules.accountId, accountId),
      eq(rules.kind, "sender"),
      eq(rules.enabled, true),
      inArray(sql`lower(${rules.match})`, addresses),
    ));
  return new Set(rows.map((r) => r.match.trim().toLowerCase()));
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
 * Write the consent the user just gave. One transaction, no mail moved.
 *
 * The addresses the caller asks for are INTERSECTED with a freshly computed review list rather
 * than trusted. The list is the offer; a confirmation can only ever be a subset of it. Without
 * the intersection this endpoint would write a rule for any address a caller cared to name.
 *
 * `retroRequestedAt` stays NULL and no `folder_state` row is touched, which is the whole
 * difference between this and a Screener decision. A Screener decision is about one sender the
 * user is looking at; this is a bulk import of consent they gave by writing, and turning it
 * into thousands of server-side moves is precisely what the model exists to avoid.
 *
 * ── ONE EFFECT PER PERSON, ENFORCED BY A ROW LOCK AND A RE-READ — NOT BY A ONE-SHOT CLAIM ──
 *
 * Sequentially, running this twice is already harmless: the second `buildSeedReview` marks
 * every rule the first run wrote `alreadyDecided`, and those are skipped. CONCURRENTLY it was
 * not. Two submits of the same review — a double-click, a retry on a slow link — both computed
 * their list before either committed, so both saw `alreadyDecided: false` and both inserted a
 * rule per candidate. `rules` has no unique constraint on `(account_id, kind, match)`, and
 * deliberately so (two rules may legitimately name one sender; `consentIndex` resolves them),
 * which means nothing downstream would have rejected the duplicates either.
 *
 * The transaction therefore opens by taking the account's `account_settings` row — an upsert
 * that always fires, so it locks whether or not the row existed — and only THEN asks which of
 * the accepted addresses already carry a rule. That second question is the one that matters: a
 * concurrent confirm that got there first has committed by the time this one holds the lock,
 * so its rules are visible and every one of them drops out of the write set. Two simultaneous
 * confirmations produce one rule per person and two honest answers, the second reporting its
 * work as `skipped`.
 *
 * ── AND THE REVIEW CAN BE RUN AGAIN, WHICH IS WHY THE CLAIM HAD TO GO ──────────────────────
 *
 * The earlier design guarded the stamp — the upsert only fired while `seed_confirmed_at` was
 * NULL — so the second confirmation of an account's life was a 409 no matter how far apart the
 * two were. That made "the seed has been offered" and "the seed may never be offered again"
 * the same fact, and it is wrong in the ordinary case rather than an edge one: connecting a
 * second mailbox brings a second address book of people the user has written to, and the only
 * way to consent to them was to reset every screening decision on the account. The stamp now
 * records WHEN the review was last confirmed and nothing more. Re-running it writes rules for
 * whoever is new and skips whoever already has one, which is the same guarantee the race above
 * needs and is why one mechanism serves both.
 */
export async function confirmSeed(
  ctx: ServiceContext, addresses: readonly string[],
): Promise<SeedConfirmResult> {
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
  };
}

/**
 * ONE `settings` CHANGE ROW PER SETTINGS WRITE — the doorbell that makes a consent knob travel.
 *
 * Every writer below appends this in the SAME transaction as its column: `recordChanges` NOTIFYs
 * the wake channel at commit, so every signed-in surface's next drain — which the wake makes
 * immediate — carries the `settings` entity, and each surface re-asks `GET /consent` instead of
 * holding its boot-time answer for the life of the process. Measured before this existed:
 * disabling folders in a browser left the desktop drawing the folders group (over tombstoned
 * entities — an empty husk) until the app was restarted, and the reading-pane image/tracker
 * postures went equally stale in every other open surface.
 *
 * `entity_id` is the ACCOUNT id and the op is always `"update"`: one row per account, created
 * lazily, never deleted — `materializeSettings` answers a default-shaped DTO even before the
 * first write, so this can never drain as a tombstone.
 */
/**
 * ── THE GLOBAL LOCK ORDER: `account_settings` FIRST, THE SEQUENCE ROW SECOND ─────────────────
 *
 * `recordChanges` serializes on the account's `account_sync_state` row; the settings upsert
 * locks `account_settings`. Every transaction that touches BOTH rows takes them in ONE order —
 * settings first — because two transactions taking the same two row locks in opposite orders is
 * the textbook Postgres deadlock (40P01), and both directions of it were reproduced on real
 * Postgres during this entity's review rounds. The order is the one `confirmSeed` DESIGNED
 * around ("the transaction opens by taking the account's `account_settings` row") and
 * `ScreenerService.decide` already follows; `resetScreeningState` — the one long-standing
 * writer that rang first — was conformed in the same change (`consent-reset.ts` names it at its
 * own seam). So every writer below touches its settings column FIRST and rings the doorbell
 * second; both land or neither does, exactly as before.
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
 * TURN AUTO-SUGGEST ON OR OFF — a column-scoped write on the shared `account_settings` row.
 *
 * `dormancy_days` sat in the schema from 0035 with no writer at all — a column with no knob is a
 * setting nobody can change — until {@link setDormancyDays} below gave it one. Both follow the same
 * shape: a lazy upsert touching only its own column plus `updated_at`, so neither clobbers the other
 * when onboarding runs them on the same primary key within a minute.
 *
 * ── WHAT THE FLAG AUTHORISES, STATED HERE BECAUSE THIS IS WHERE IT IS GRANTED ─────────────
 *
 * ON lets the Screener surface buy a classifier suggestion for the senders at the front of the
 * queue without a per-batch click. That is a METERED spend against the account's credits, so
 * this write is the moment the account said yes to it — and it is the ONLY thing the flag does.
 * It grants no authority to decide: `POST /screener/suggest` writes a `routing_decisions` row
 * with `status = 'suggestion'` and deliberately no `change_log` entry, so nothing it produces
 * reaches the delta feed, moves a message, or writes a rule. A stranger still waits for a human.
 *
 * ── THE UPSERT, AND WHY IT IS `onConflictDoUpdate` AND NOT A SELECT-THEN-INSERT ───────────
 *
 * `account_settings` rows are created lazily by whichever feature writes first, so this races
 * `confirmSeed` and `resetScreeningState` — three writers, one primary key, and onboarding runs
 * all of them within a minute. A read-then-write would lose one of the two settings under
 * concurrency; the conflict target makes the outcome the same whichever arrives second, and
 * touching only this column plus `updated_at` means a concurrent seed confirmation is not
 * clobbered by a stale snapshot of the row. Proven under real Postgres in
 * `consent-auto-suggest.concurrency.pg.test.ts`, because PGlite serialises this by construction
 * and would report green for the losing implementation.
 *
 * Returns the stored instant so the caller echoes what the database holds rather than what it
 * hoped to write — the flag's whole purpose is to be readable back later.
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
 * TURN "USE FOLDERS" ON OR OFF — the folders foundation's master toggle (FOLDERS-SPEC.md §6),
 * a column-scoped upsert in {@link setAutoSuggest}'s shape PLUS the one thing no other consent
 * knob does: THE TRANSITION RIDES THE DELTA FEED.
 *
 * `/sync` emits `folder` entities only while the flag is on, and the delta is strictly
 * `change_log`-driven — so without change rows a live client would learn about the flip only on
 * its next re-bootstrap, and the settings switch would appear to do nothing to the rail beside
 * it. This writer therefore appends, in the SAME transaction as the column:
 *
 *   · ON  → one `folder` CREATE per user folder the account already has (the passive-presence
 *           inventory, post-exclusion) — the rail fills on the next drain;
 *   · OFF → one `folder` DELETE per user folder — the mirror forgets them, and the interface
 *           returns to the pre-feature rail with nothing to migrate.
 *
 * Re-enabling re-emits creates; the client's apply is an upsert, so a replay is idempotent.
 * Folders DISCOVERED WHILE ON do not stream yet — the worker's discovery writes no change rows
 * (that hook is the sync lane's seam; see `folders.ts`'s hand-off comment) — so a brand-new
 * external folder appears on the next re-bootstrap or re-toggle. Everything the account had
 * when it flipped the switch is live immediately, which is the case that matters: first render
 * of the feature is the fifteen-year-old mailbox, read-only (spec §10).
 *
 * One transaction for the same reason the route wraps its knobs in one: the column and the
 * change rows must land together, or a crash between them leaves a flag whose rail never
 * arrives. `recordChanges` requires a transaction anyway and this is it.
 */
export async function setFoldersEnabled(
  ctx: ServiceContext, enabled: boolean,
): Promise<{ foldersEnabledAt: string | null }> {
  const at = enabled ? ctx.now() : null;
  await (ctx.db as unknown as Tx).transaction(async (tx) => {
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
 * SWITCH ONE MAILBOX'S FOLDERS ON OR OFF — the per-mailbox dial under the master toggle
 * (FOLDERS-SPEC.md §17; owner ruling 2026-08-25: *"folders should be possible to be enabled on
 * a per mailbox level"*). The column stores the EXCEPTION: `mailboxes.folders_disabled_at` NULL
 * means the mailbox participates, which is the default the ruling asks for — enabling the
 * master on a six-mailbox account shows all six trees, and this writer only ever records the
 * opt-outs.
 *
 * THE TRANSITION RIDES THE DELTA, {@link setFoldersEnabled}'s reason scoped to one mailbox:
 * while the MASTER flag is on, OFF appends one `folder` DELETE per user folder of this mailbox
 * (the rail drops the tree without a re-bootstrap) and ON appends the CREATEs back. The rows
 * come from {@link listMailboxUserFolders} — deliberately the UNFILTERED per-mailbox read,
 * because the filtered inventory already refuses to answer for the mailbox being switched off,
 * which is exactly when its tombstones must still be written. With the master OFF no change
 * rows are appended: nothing about this account is on the wire to retract, and the master's
 * own enable later emits creates for participating mailboxes only ({@link listUserFolders}
 * carries the participation filter), so the two dials compose without a special case.
 *
 * The column flip and the change rows land in ONE transaction, or a crash between them leaves
 * a rail that disagrees with the switch for ever — the master toggle's argument verbatim. The
 * mailbox must BELONG to the account: a foreign or unknown id is a 404 before anything writes,
 * measured against the same join every folder read scopes by.
 *
 * Returns the stored instant (`null` = participating) so the caller echoes what the database
 * holds — and the mailbox id, so a batched route can answer per entry.
 */
export async function setMailboxFoldersEnabled(
  ctx: ServiceContext, mailboxId: string, enabled: boolean,
): Promise<{ mailboxId: string; foldersDisabledAt: string | null }> {
  const at = enabled ? null : ctx.now();
  await (ctx.db as unknown as Tx).transaction(async (tx) => {
    const [mb] = await tx.select({ id: mailboxes.id })
      .from(mailboxes)
      .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, ctx.accountId)))
      .limit(1);
    if (!mb) throw new ServiceError("not_found", 404, "no such mailbox on this account");
    await tx.update(mailboxes)
      .set({ foldersDisabledAt: at })
      .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, ctx.accountId)));
    // THE STAMP MOVES. The exception lives on `mailboxes`, but the settings ENTITY's
    // `updatedAt` is the `account_settings` row's own — a client that already holds the entity
    // compares stamps and ignores a re-apply whose stamp did not move, so a per-mailbox flip
    // that left the row untouched re-delivered the same instant and no surface re-asked —
    // a review-caught staleness. Touch the row in the same transaction, creating it if the
    // account has never written a knob before — and touch it FIRST: the global lock order
    // ({@link recordSettingsChange}) puts the settings row ahead of the sequence row.
    await tx.insert(accountSettings)
      .values({ accountId: ctx.accountId, updatedAt: ctx.now() })
      .onConflictDoUpdate({
        target: accountSettings.accountId,
        set: { updatedAt: ctx.now() },
      });
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
 * SET THE DORMANCY WINDOW — the cutline dial, the second knob on `account_settings`.
 *
 * The dial decides how long a sender may be quiet before the Screener stops asking about them: a
 * sender with no recent mail and no decision waits in History rather than the queue. It is PURE
 * VISIBILITY — it changes which UNDECIDED senders are SHOWN, never where any mail lives. Nothing
 * here writes a rule, a contact, a `folder_state` row or any MAIL-typed `change_log` entry, and
 * the pg test proves all three by making a stamp of any of them turn the assertion red. The one
 * change row it does append is the `settings` doorbell ({@link recordSettingsChange}) — a row
 * ABOUT the dial, so every other signed-in surface re-asks its consent answer and re-partitions
 * with the new window instead of holding the old one until reload. Recompute is READ-TIME
 * on both sides — `cutlineCounts` takes the window per request and the client re-partitions its own
 * mirror — so this writer moves no mail and arms no pass. It must NEVER travel through a writer that
 * can arm the tidy (`setScreeningPreference` stamps `ohbox_tidy_requested_at`); that is why the dial
 * lands on `PATCH /consent/settings` and not on `PATCH /account/screening`.
 *
 * ── THE 1–365 REFUSAL, AND WHY THE SERVICE RESTATES THE CHECK ──────────────────────────────
 *
 * The column's CHECK is `dormancy_days > 0 AND dormancy_days <= 365` (0035 + 0044). The service
 * refuses the same band with a 400 so a caller gets a readable answer rather than the raw 23514 —
 * the pattern `OHBOX_BAR_MAX_BYTES` uses one file over. The ceiling is load-bearing, not cosmetic: a
 * value like 2e8 is legal under the old floor alone and makes `cutlineCounts`' `toISOString()` throw
 * a `RangeError`, so `GET /consent` 500s for that account for ever. A non-integer (60.5) is refused
 * too — the column is `integer`, and a rounded float is a window nobody chose.
 *
 * ── NEVER STORE THE DEFAULT ────────────────────────────────────────────────────────────────
 *
 * `null` reverts to the product default, and so does passing the default value itself: storing 60
 * would freeze this account at 60 even after the product default moves — exactly what
 * `0035_account_settings.sql` calls "a constant wearing a dial's name". So both `null` and
 * `DEFAULT_DORMANCY_DAYS` persist NULL, and the read side substitutes the default unchanged
 * (`consent.ts`'s `?? DEFAULT_DORMANCY_DAYS`).
 *
 * ── THE UPSERT, COLUMN-SCOPED ──────────────────────────────────────────────────────────────
 *
 * Same shape and reason as {@link setAutoSuggest}: rows are created lazily by whichever feature
 * writes first, so this races `confirmSeed`, `resetScreeningState`, `setAutoSuggest` and
 * `setScreeningPreference` — five writers on one primary key. Touching only `dormancy_days` +
 * `updated_at` means a concurrent seed confirmation keeps its `seed_confirmed_at`. Proven under real
 * Postgres because PGlite serialises the race by construction.
 *
 * Returns the EFFECTIVE window — always a number — so the caller echoes what the account will be
 * counted with, which is what the open tab re-partitions on.
 */
export async function setDormancyDays(
  ctx: ServiceContext, days: number | null,
): Promise<{ dormancyDays: number }> {
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) {
    throw new ServiceError(
      "validation_failed", 400,
      "dormancyDays must be an integer between 1 and 365, or null",
    );
  }
  // NEVER STORE THE DEFAULT — see the note above. `null` and the default both mean "use the product
  // default", so both persist NULL and let the read side substitute it.
  const stored = days === null || days === DEFAULT_DORMANCY_DAYS ? null : days;
  // Column-scoped upsert unchanged; the transaction adds the settings change row — see
  // {@link recordSettingsChange}.
  await (ctx.db as unknown as Tx).transaction(async (tx) => {
    await tx.insert(accountSettings)
      .values({ accountId: ctx.accountId, dormancyDays: stored, updatedAt: ctx.now() })
      .onConflictDoUpdate({
        target: accountSettings.accountId,
        set: { dormancyDays: stored, updatedAt: ctx.now() },
      });
    await recordSettingsChange(tx, ctx.accountId); // AFTER the settings row — the global lock order above
  });
  return { dormancyDays: stored ?? DEFAULT_DORMANCY_DAYS };
}

/**
 * KEEP THE PER-MESSAGE "SHOW IMAGES" FLOW, OR LET REMOTE IMAGES LOAD — the third knob on
 * `account_settings`, and the only one on the row that stores an OPT-OUT.
 *
 * `blocked === true` stamps the instant: this account asked to keep the consent flow. `false`
 * NULLs the column: the product default, which is that a message's remote images load through
 * `GET /img` without a press. See `0048_remote_images_default.sql` for why the column is spelled
 * as the opt-out rather than as an opt-in — an opt-in leaves every existing account on the old
 * behaviour, which is a default nobody is on.
 *
 * ── WHAT THIS FLAG DOES NOT AUTHORISE ──────────────────────────────────────────────────────
 *
 * It spends nothing and moves no mail. It changes exactly one thing: whether the reading pane
 * offers "Show images" per message or renders the pictures. Beacons are unaffected — the
 * sanitizer classifies a 1×1 or a beacon-shaped url as a pixel and refuses it the proxy in BOTH
 * modes — and so are remote stylesheets, which cannot travel through an image proxy at all. The
 * reader's address is protected by the proxy's url-only signature, not by the flag, which is why
 * turning the flag off is affordable in the first place.
 *
 * ── THE UPSERT, COLUMN-SCOPED ──────────────────────────────────────────────────────────────
 *
 * Same shape and reason as {@link setAutoSuggest} and {@link setDormancyDays}: rows are created
 * lazily by whichever feature writes first, so this races `confirmSeed`, `resetScreeningState` and
 * both other knobs on one primary key. Touching only `block_remote_images_at` + `updated_at` means
 * a concurrent seed confirmation keeps its `seed_confirmed_at`.
 *
 * Returns the stored instant so the caller echoes the database rather than the argument — the same
 * rule the other two follow, and the one that stops a refused write from being drawn as a move.
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
 * BLOCK TRACKING PIXELS, OR LET THEM LOAD — the knob beside {@link setBlockRemoteImages}, storing
 * the opt-out of a PROTECTION (mail 0072).
 *
 * `blocked === true` is the product default and NULLs the column. `false` stamps the instant: this
 * account asked for a beacon to load along with the pictures, through the same proxy. The sender
 * then learns the open — and, since a bulk sender's pixel url usually carries a per-recipient
 * token, which recipient opened it; what stays hidden is the reader's network (IP, location,
 * device), because the proxy's port takes a url and nothing else.
 *
 * The argument's sign is the reverse of the neighbour's and the column's own migration states it:
 * there, NULL is permissive and the row stores a request for more protection; here, NULL is
 * protective and the row stores a request for less. Spelled as an opt-out for the same reason —
 * the default must reach every account that never finds the setting.
 *
 * ── WHAT THIS FLAG DOES NOT AUTHORISE ──────────────────────────────────────────────────────
 *
 * It spends nothing, moves no mail, and sends no byte from the reader's machine: a pixel can load
 * only through `GET /img`, whose port takes a url and nothing else. It changes exactly one thing —
 * whether the sanitizer's pixel override refuses the proxy — and only where a proxy exists and
 * pictures load at all. In the manual images mode a pixel still waits behind "Show images".
 *
 * ── THE UPSERT, COLUMN-SCOPED ──────────────────────────────────────────────────────────────
 *
 * Same shape and reason as every sibling on this row: touching only `load_tracking_pixels_at` +
 * `updated_at`, so a concurrent write to any other knob keeps its column. Returns the stored
 * instant so the caller echoes the database rather than the argument.
 */
export async function setBlockTrackingPixels(
  ctx: ServiceContext, blocked: boolean,
): Promise<{ loadTrackingPixelsAt: string | null }> {
  const at = blocked ? null : ctx.now();
  // Column-scoped upsert unchanged; the transaction adds the settings change row — see
  // {@link recordSettingsChange}.
  await (ctx.db as unknown as Tx).transaction(async (tx) => {
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
 * KEEP AUTO-UNSUBSCRIBE, OR STOP IT — the fifth knob on `account_settings`, and the second one on
 * the row that stores an OPT-OUT.
 *
 * `blocked === true` stamps the instant: this account asked that screening a sender out stop
 * sending a one-click unsubscribe on their behalf. `false` NULLs the column and returns them to
 * the product default, which is that it does.
 *
 * ── WHY THE OPT-OUT SPELLING IS NOT ARGUABLE HERE ──────────────────────────────────────────
 *
 * `setBlockRemoteImages` makes the "a default nobody is on" argument for its own direction. This
 * column has a stronger version of it: the behaviour is ALREADY RUNNING for every account that
 * exists, so an opt-in column shipped without a backfill would have switched it off for all of
 * them silently, and shipped WITH one would have written a preference nobody expressed. See
 * `0054_auto_unsubscribe_optout.sql`.
 *
 * ── WHAT THIS FLAG DOES AND DOES NOT REACH ─────────────────────────────────────────────────
 *
 * It gates exactly one seam: {@link UnsubscribeService.onScreenOut}, the automatic entry point the
 * screen-out calls after its commit — and therefore `sweepScreenedOut` too, which goes through it.
 * It does NOT gate `UnsubscribeService.unsubscribe`, the per-message button: that is a person
 * pressing unsubscribe on mail in front of them, and a switch labelled "auto" may not quietly
 * disable a manual control. It spends nothing and moves no mail; both positions are reversible,
 * except for requests already sent, which is what makes the switch worth having.
 *
 * ── THE UPSERT, COLUMN-SCOPED ──────────────────────────────────────────────────────────────
 *
 * Same shape and reason as {@link setAutoSuggest}, {@link setDormancyDays} and
 * {@link setBlockRemoteImages}: rows are created lazily by whichever feature writes first, so this
 * races `confirmSeed`, `resetScreeningState` and every other knob on one primary key. Touching
 * only `block_auto_unsubscribe_at` + `updated_at` means a concurrent seed confirmation keeps its
 * `seed_confirmed_at`.
 *
 * Returns the stored instant so the caller echoes the database rather than the argument — a
 * refused write must never be drawn as a move, and here the move drawn wrongly would tell somebody
 * their lists are being left alone while the server goes on leaving them.
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
 * SET THE INTERFACE LANGUAGE — the fourth knob on `account_settings`, and the only one whose value
 * is a string rather than an instant or a flag.
 *
 * `null` — and `'en'`, which means the same thing — persist NULL: **the default is never stored.**
 * That is the `dormancyDays` rule ("a dial, not a constant to hard-code") carrying a second,
 * sharper consequence here, because the client reads the difference:
 *
 *   · NULL  ⇒ "this account has no preference" ⇒ the DEVICE's remembered language stands.
 *   · 'de'  ⇒ "this account is in German"      ⇒ it OVERRIDES the device, on every machine.
 *
 * Storing `'en'` for an account that merely never opened the selector would silently move it from
 * the first state to the second, and would reset a German-set browser to English at every boot — a
 * setting acting on a decision nobody made. So English is expressed as absence, and asking for
 * English is how an account gives its devices their choice back.
 *
 * ── WHAT THIS WRITE AUTHORISES: NOTHING ────────────────────────────────────────────────────────
 *
 * It spends nothing, moves no mail, and files nothing differently. It changes which words are drawn.
 * That is worth stating because it shares a route with `autoSuggest`, which authorises metered
 * spend, and the route's `cost: "work"` is inherited from that neighbour rather than earned here.
 *
 * ── THE UPSERT, COLUMN-SCOPED ──────────────────────────────────────────────────────────────────
 *
 * Same shape and reason as {@link setAutoSuggest}, {@link setDormancyDays} and
 * {@link setBlockRemoteImages}: the row is created lazily by whichever feature writes first, so this
 * races `confirmSeed`, `resetScreeningState` and the three other knobs on one primary key. Touching
 * only `locale` + `updated_at` means a concurrent seed confirmation keeps its `seed_confirmed_at`.
 *
 * Returns the STORED value, so the caller echoes the database rather than the argument — the rule the
 * other three follow. A client that asked for English reads back `null`, which is exactly what it
 * needs in order to stop overriding its own device.
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

/* `assertNotConfirmed` used to live here: a helper that turned a non-null `seed_confirmed_at`
   into a 409. It is gone because the fact it asserted is no longer a refusal — a confirmed
   account may be shown the review again, and `confirmSeed` writes only what is new. A guard
   whose condition has stopped meaning "refuse" is worse than no guard: the next caller to
   reach for it would reintroduce the wall by name. */
