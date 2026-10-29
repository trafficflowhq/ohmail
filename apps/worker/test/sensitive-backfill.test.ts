import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, auditLog, changeLog, folderState, mailboxes, messageBodies, messages,
  routingDecisions, type Tx,
} from "@trafficflow/db";
import {
  classifySensitivity, fingerprintDedupKey, messageFingerprint, normalizeMime, prepareHtmlForStorage,
} from "@trafficflow/core";
import {
  MessageGoneError, RawMessageTooLargeError, type MailboxAdapter,
} from "@trafficflow/core/adapters/imap";
import {
  resetSensitiveBackfillProgress, sensitiveBackfillPass, __fromStoredRow, __snippetOf,
} from "../src/sensitive-backfill.js";

/**
 * REPAIRING THE BODIES A CLASSIFIER FALSE POSITIVE STORED REDACTED.
 *
 * A green run over an empty database would be worth nothing here, so every case seeds a real
 * damaged row and asserts what came back. The anti-vacuity case is the FIRST one: a pass whose
 * candidate query found nothing would satisfy every "it did not touch X" assertion in this file
 * for entirely the wrong reason, so "there is something to repair at all" is established before
 * anything else is claimed about it.
 *
 * The transactional claims are NOT here. `FOR UPDATE`, two concurrent drivers, and "one repair
 * writes exactly one delta" are green-by-construction under PGlite, which is single-connection.
 * They live in `sensitive-backfill.pg.test.ts` against real Postgres on :5433, per CLAUDE.md.
 *
 * ── MUTATIONS WATCHED FOR THE MARKER-HONESTY RULING (2026-09-01, each restored, suite green) ──
 *
 * The rule this pass now holds: the durable completion marker may certify over messages the
 * classifier ANSWERED about, and never over messages it could not READ. Four mutations, because
 * the fix has four moving parts and a guard that only reddens on one of them is not watching the
 * property.
 *
 *  · the fetch-failure arm records a DECIDED refusal (`decided.add`) instead of an undecided one —
 *    which is exactly the shelf the defect used
 *      ⇒ 4 RED: "does NOT certify over it", "a TRANSIENT failure is repaired on the next walk",
 *        "the bound", "a RESTART resets the bound".
 *  · the withhold branch disabled, so any completed walk stamps
 *      ⇒ 5 RED: the four above plus "an IDENTITY MISMATCH is undecided too".
 *  · `undecided.clear()` removed, so the next walk SKIPS the message off the shelf instead of
 *    re-reading it — the mutation that proves the retry is genuine and not bookkeeping
 *      ⇒ RED on "a TRANSIENT failure is repaired on the next walk" (`fetched: 0, skipped: 1`)
 *        and on "the bound" (one fetch recorded, not three).
 *  · the audit row drops `undecidedMessageIds`
 *      ⇒ RED on "the bound" — the certificate stops naming what it does not cover, which is the
 *        only thing separating the bounded stamp from the defect.
 *  · the bound counted per MAILBOX instead of per MESSAGE (`anyFresh` ignored) — what this file's
 *    own first round shipped, and what the review found
 *      ⇒ RED on "a message that becomes undecided LATE gets the whole bound". Three walks over a
 *        mailbox is not three attempts at a message, and the marker is durable.
 */

/**
 * The mail that started this: a usage notice whose click tracker contains `-2Fa`.
 *
 * The escape sequence is the whole point and must stay exactly as it is — `-2F` is how a bulk
 * sender writes `/`, and `-` is not a word character, so the three characters `2Fa` sat between
 * word boundaries and were read as the acronym `2fa`. Under the fixed classifier the token is
 * masked as machine text and this is ordinary mail.
 */
const TRACKER = "https://url8792.example.com/ls/click?upn=mPban-2Fa-2BEQG-2FRgn8842";

const NEWSLETTER_TEXT = [
  "Your organization is approaching its usage credit limit.",
  `Manage billing: ${TRACKER}`,
  "Sent from 1 Elm Street, Springfield 12345.",
].join("\n");

const NEWSLETTER_RAW = [
  "From: no-reply-qldx6@mail.example.com",
  "To: someone@ohmail.test",
  "Subject: Your organization is approaching its usage credit limit",
  "Message-ID: <usage-notice-1@mail.example.com>",
  "Date: Tue, 21 Jul 2026 11:46:23 +0000",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="bnd"',
  "",
  "--bnd",
  "Content-Type: text/plain; charset=utf-8",
  "",
  NEWSLETTER_TEXT,
  "",
  "--bnd",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><body><p>Your organization is approaching its usage credit limit.</p>",
  `<a href="${TRACKER}">Manage billing</a>`,
  "</body></html>",
  "",
  "--bnd--",
  "",
].join("\r\n");

/**
 * What was STORED for it: the html thrown away, and the digit runs the redactor could REACH
 * replaced. Derived from the original rather than typed out, because the difference between the
 * two is the entire subject of this file and a hand-written "redacted" string is a guess.
 *
 * The postcode goes. The tracker does NOT, and that is not an oversight in the fixture — the
 * redaction pattern is word-bounded, and `8842` sits immediately after `n` inside
 * `…-2FRgn8842`, so there is no boundary for it to match at. That is why a message damaged this
 * way is still recognisable as ordinary from its stored text, which is what the pre-filter
 * depends on. The case where the redactor CAN reach into a machine token is a real and different
 * outcome, and it has its own test below.
 */
const NEWSLETTER_STORED_TEXT = NEWSLETTER_TEXT.replace(/\b12345\b/, "[REDACTED]");

/** A real one-time code. Its ORIGINAL must stay redacted, and its stored text says so already. */
const OTP_STORED_TEXT = "Your verification code is [REDACTED]. Enter it to sign in.";

/**
 * The case the pre-filter cannot decide: nothing in the stored TEXT flags, because the code was
 * only ever in the html — which redaction deleted. It clears the pre-filter, costs one fetch, and
 * is then correctly refused on the original.
 */
const HTML_ONLY_OTP_RAW = [
  "From: security@bank.example.com",
  "To: someone@ohmail.test",
  "Subject: Message from your bank",
  "Message-ID: <html-only-otp@bank.example.com>",
  "Date: Tue, 21 Jul 2026 09:00:00 +0000",
  "MIME-Version: 1.0",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><body><p>Your one-time passcode is 918273.</p></body></html>",
  "",
].join("\r\n");

const HTML_ONLY_OTP_STORED_TEXT = "Message from your bank.";

/* ── THE SECOND DAMAGE CLASS: withheld with no category ────────────────────────────────────── */

/** Prose with no authentication vocabulary anywhere in it. The subject matters as much as the body. */
const DIGEST_PROSE = "Here are the stories we picked for you this week, we hope you enjoy reading them.";

/**
 * A magic link: an authentication-shaped URL carrying an opaque token.
 *
 * The fixed classifier calls this INDETERMINATE `[auth_url_token]` — no vocabulary match, so no
 * category and no `no_forward`, but `no_ai` set and `storeRedactedBody` TRUE. That combination is
 * the entire subject of the widened predicate: it is invisible to `sensitivity_category IS NOT
 * NULL`, and it is the one verdict where `sensitive` and `storeRedactedBody` disagree.
 */
const MAGIC_LINK = "https://app.example.com/verify?token=Xj9kQm2LpZ7vRt4WcN8sYbH3dF6gU0aE";

const MAGIC_LINK_RAW = [
  "From: hello@digest.example.com",
  "To: someone@ohmail.test",
  "Subject: Your weekly digest",
  "Message-ID: <magic-link-1@digest.example.com>",
  "Date: Tue, 21 Jul 2026 08:00:00 +0000",
  "MIME-Version: 1.0",
  "Content-Type: text/html; charset=utf-8",
  "",
  `<html><body><p>${DIGEST_PROSE}</p><a href="${MAGIC_LINK}">Read</a></body></html>`,
  "",
].join("\r\n");

/** A sign-in letter of pictures with no text part; its verdict hangs on the 40-word prose bound. */
const SIGN_IN_RELATED_RAW = [
  "From: App <no-reply@app.example>", "To: someone@ohmail.test", "Subject: Your workspace",
  "Message-ID: <sign-in-1@app.example>", "Date: Tue, 21 Jul 2026 08:00:00 +0000", "MIME-Version: 1.0",
  'Content-Type: multipart/related; boundary="R"', "", "--R", "Content-Type: text/html; charset=utf-8", "",
  "<table><tr><td><p>Hello Mila,</p><p>We noticed you asked to sign in to your workspace from a new browser this morning. "
    + "Use the button below to continue where you left off today.</p>"
    + '<p><a href="https://app.example/login?t=Xk29fLq83PzR7mWqZ">Sign in</a></p></td></tr></table><img src="cid:logo@x">',
  "--R", "Content-Type: image/png", "Content-ID: <logo@x>", "Content-Transfer-Encoding: base64", "", "iVBORw0KGgo=", "--R--", "",
].join("\r\n");

/** Ordinary marketing mail — no token anywhere. Its original is `ordinary`. */
const DIGEST_RAW = [
  "From: hello@digest.example.com",
  "To: someone@ohmail.test",
  "Subject: Your weekly digest",
  "Message-ID: <digest-1@digest.example.com>",
  "Date: Tue, 21 Jul 2026 08:00:00 +0000",
  "MIME-Version: 1.0",
  "Content-Type: text/html; charset=utf-8",
  "",
  `<html><body><p>${DIGEST_PROSE}</p><a href="https://example.com/blog">Read</a></body></html>`,
  "",
].join("\r\n");

interface World {
  db: Tx;
  accountId: string;
  mailboxId: string;
  /** Locator ref → raw bytes the fake server will hand back. */
  server: Map<string, string>;
  /** Every adapter method that would WRITE to the mailbox, counted. */
  writes: { move: number; setFlags: number; send: number; fetchPart: number };
  fetches: string[];
}

async function newWorld(): Promise<World> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `fp-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
  }).returning();
  return {
    db: db as unknown as Tx, accountId, mailboxId: mb!.id,
    server: new Map(), writes: { move: 0, setFlags: 0, send: 0, fetchPart: 0 }, fetches: [],
  };
}

/**
 * A damaged row: categorised, every sensitivity flag set, redacted text, NO html — which is
 * exactly the shape the ingest path writes for a message it judges sensitive.
 */
async function seedDamaged(
  w: World,
  opts: {
    raw?: string; storedText: string; subject?: string; ref?: string;
    /** `fingerprint` seeds the fp1 dedup key; `legacy` seeds the old `mid:` one. */
    identity?: "fingerprint" | "legacy" | "wrong";
    category?: string;
    /**
     * Pin the row's id. The pass walks `order by messages.id`, and a `defaultRandom()` uuid makes
     * that order a coin toss — fine for every case that asserts a total, useless for one asserting
     * WHICH message a budget of one reaches first.
     */
    id?: string;
  },
): Promise<string> {
  const ref = opts.ref ?? `1:${Math.floor(Math.random() * 100000)}`;
  // A distinct Message-ID per seed. `messages` is UNIQUE on (mailbox_id, dedup_key), and the
  // dedup key is a digest over the message — so two seeds of the same fixture in one mailbox are
  // genuinely the same message and the database is right to refuse them.
  const raw = (opts.raw ?? NEWSLETTER_RAW).replace(
    /^Message-ID: <([^>]+)>$/m, `Message-ID: <${ref.replace(":", "-")}-$1>`,
  );
  const norm = await normalizeMime(Buffer.from(raw, "utf8"));
  const identity = opts.identity ?? "fingerprint";
  const dedupKey =
    identity === "fingerprint" ? fingerprintDedupKey(messageFingerprint(norm))
      : identity === "legacy" ? `mid:${norm.canonical.messageIdHeader}`
        : `mid:somebody-elses-message@example.com`;

  const [m] = await w.db.insert(messages).values({
    ...(opts.id ? { id: opts.id } : {}),
    accountId: w.accountId, mailboxId: w.mailboxId,
    messageIdHeader: identity === "wrong" ? "somebody-elses-message@example.com"
      : norm.canonical.messageIdHeader,
    bodyHash: norm.canonical.bodyHash, dedupKey,
    subject: opts.subject ?? norm.subject, fromAddress: norm.from.address,
    nativeLocator: { folder: "INBOX", ref },
    // The damage, as the pipeline writes it.
    sensitivityCategory: opts.category ?? "otp",
    noAi: true, noForward: true, noKb: true, priority: true,
    snippet: opts.storedText.slice(0, 200),
  }).returning();
  await w.db.insert(messageBodies).values({
    // `{ ...headers }` — `normalizeMime` builds this map with `Object.create(null)` and drizzle
    // 0.36.4 reflects on every insert value with `Object.getPrototypeOf(v).constructor`, which is
    // a TypeError on a prototype-less object. The production writer spreads for exactly this
    // reason; see `drizzle-repo.ts#insertMessageBody`.
    messageId: m!.id, text: opts.storedText, html: null, headers: { ...norm.headers },
  });
  w.server.set(ref, raw);
  return m!.id;
}

/**
 * THE SECOND DAMAGE CLASS: withheld with NO category — `no_ai` set, `sensitivity_category` NULL.
 *
 * This is what the classifier writes for an INDETERMINATE verdict, and it is the shape the pass's
 * original predicate could not see. The html is PRESENT and redacted rather than deleted, which is
 * the difference that matters twice over: it is why these rows are repairable at all, and it is the
 * evidence the pre-filter reads.
 */
async function seedWithheld(
  w: World,
  opts: { raw?: string; storedText: string; storedHtml?: string | null; ref?: string },
): Promise<string> {
  const ref = opts.ref ?? `2:${Math.floor(Math.random() * 100000)}`;
  const raw = (opts.raw ?? NEWSLETTER_RAW).replace(
    /^Message-ID: <([^>]+)>$/m, `Message-ID: <${ref.replace(":", "-")}-$1>`,
  );
  const norm = await normalizeMime(Buffer.from(raw, "utf8"));
  const [m] = await w.db.insert(messages).values({
    accountId: w.accountId, mailboxId: w.mailboxId,
    messageIdHeader: norm.canonical.messageIdHeader,
    bodyHash: norm.canonical.bodyHash,
    dedupKey: fingerprintDedupKey(messageFingerprint(norm)),
    subject: norm.subject, fromAddress: norm.from.address,
    nativeLocator: { folder: "INBOX", ref },
    // The damage: NO category, and the two flags that fail closed on indeterminate. `no_forward`
    // and `priority` follow the positive match only, so they are FALSE here — which is exactly
    // why `sensitivity_category IS NOT NULL` could not find these rows.
    sensitivityCategory: null,
    noAi: true, noKb: true, noForward: false, priority: false,
    snippet: opts.storedText.slice(0, 200),
  }).returning();
  await w.db.insert(messageBodies).values({
    messageId: m!.id, text: opts.storedText,
    html: opts.storedHtml ?? null, headers: { ...norm.headers },
  });
  w.server.set(ref, raw);
  return m!.id;
}

/** A message that was never damaged — nothing here may touch it. */
async function seedOrdinary(w: World): Promise<string> {
  const [m] = await w.db.insert(messages).values({
    accountId: w.accountId, mailboxId: w.mailboxId,
    messageIdHeader: `ordinary-${randomUUID()}@example.com`,
    bodyHash: randomUUID(), dedupKey: `mid:ordinary-${randomUUID()}`,
    subject: "hello", fromAddress: "friend@example.com",
    nativeLocator: { folder: "INBOX", ref: "1:999" },
  }).returning();
  await w.db.insert(messageBodies).values({
    messageId: m!.id, text: "hello there", html: "<p>hello there</p>", headers: {},
  });
  return m!.id;
}

/**
 * A mailbox that can be READ and nothing else. Every write verb counts its calls rather than
 * throwing, so a test can assert ZERO rather than assert that a throw happened to propagate.
 */
function fakeAdapter(w: World, opts: { fetchRaw?: boolean } = {}): MailboxAdapter {
  const a: Partial<MailboxAdapter> = {
    move: async () => { w.writes.move++; throw new Error("this pass must never move mail"); },
    setFlags: async () => { w.writes.setFlags++; throw new Error("this pass must never flag mail"); },
    send: async () => { w.writes.send++; throw new Error("this pass must never send mail"); },
    fetchPart: async () => { w.writes.fetchPart++; throw new Error("unused"); },
  };
  if (opts.fetchRaw !== false) {
    a.fetchRaw = async (locator, fetchOpts) => {
      w.fetches.push(locator.ref);
      const raw = w.server.get(locator.ref);
      if (!raw) throw new Error(`no message at ${locator.ref}`);
      const bytes = Buffer.from(raw, "utf8");
      // Faithful to the real adapter: a message over `maxBytes` is refused from RFC822.SIZE BEFORE
      // its bytes move, so `RawMessageTooLargeError` is thrown and the connection stays usable.
      if (fetchOpts?.maxBytes !== undefined && bytes.length > fetchOpts.maxBytes) {
        throw new RawMessageTooLargeError(locator, fetchOpts.maxBytes, bytes.length);
      }
      return new Uint8Array(bytes);
    };
  }
  return a as MailboxAdapter;
}

const run = (w: World, adapter?: MailboxAdapter, extra: Record<string, unknown> = {}) =>
  sensitiveBackfillPass({
    db: w.db, adapter: adapter ?? fakeAdapter(w),
    accountId: w.accountId, mailboxId: w.mailboxId, ...extra,
  });

describe("the fixture is not vacuous", () => {
  it("the damaged newsletter really does clear under the FIXED classifier", async () => {
    // If this were false the whole file would pass by repairing nothing, and every "it did not
    // touch X" assertion below would be true for the wrong reason.
    const norm = await normalizeMime(Buffer.from(NEWSLETTER_RAW, "utf8"));
    expect(classifySensitivity(norm).sensitive).toBe(false);
    // …and its STORED text clears too, or the pre-filter would never fetch it.
    expect(classifySensitivity({
      ...norm, htmlBody: null, textBody: NEWSLETTER_STORED_TEXT, attachments: [],
    }).sensitive).toBe(false);
  });

  it("the redaction leaves the tracker token INTACT — which is why the pre-filter works", async () => {
    // The whole pre-filter rests on this: the token that caused the false positive survives
    // redaction unchanged, so the stored text answers the same question the original would.
    expect(NEWSLETTER_STORED_TEXT).toContain(TRACKER);
    expect(NEWSLETTER_STORED_TEXT).toContain("[REDACTED]");
  });

  it("THE KNOWN GAP IS CLOSED: a token the redactor reached into is repairable after all", async () => {
    // This test used to assert the opposite, and the header paragraph it pinned said so: if the
    // digits that made a machine token look like machine text were themselves redacted, the
    // masking no longer blanked the token, the `2fa` inside it read as vocabulary, the stored
    // text flagged, and the pre-filter refused to re-read the message — a repair not attempted.
    //
    // `schemeNameNearCode` removed the gap rather than narrowing it. A bare scheme name is no
    // longer a positive on its own, so whether the mask blanks this token or not stops deciding
    // anything: with the digits redacted away there is no code-shaped run beside the acronym,
    // and the message clears the pre-filter and is fetched.
    //
    // The assertions below are deliberately BOTH halves — that the acronym really is exposed by
    // the over-redaction, and that it no longer flags. Without the first, this passes for the
    // trivial reason that the fixture stopped containing `2fa` at all.
    const norm = await normalizeMime(Buffer.from(NEWSLETTER_RAW, "utf8"));
    const overRedacted = NEWSLETTER_TEXT.replace("2FRgn8842", "2FRgn[REDACTED]");
    expect(/\b2fa\b/i.test(overRedacted), "the fixture must still expose a bounded 2fa").toBe(true);
    const verdict = classifySensitivity({
      ...norm, htmlBody: null, textBody: overRedacted, attachments: [],
    });
    expect(verdict.sensitive).toBe(false);
    expect(verdict.category).toBe(null);
  });

  it("the genuinely sensitive fixture still flags on its stored text", async () => {
    const norm = await normalizeMime(Buffer.from(NEWSLETTER_RAW, "utf8"));
    expect(classifySensitivity({
      ...norm, htmlBody: null, textBody: OTP_STORED_TEXT, attachments: [],
    }).sensitive).toBe(true);
  });

  it("the html-only code clears on the stored TEXT and flags on the ORIGINAL", async () => {
    const norm = await normalizeMime(Buffer.from(HTML_ONLY_OTP_RAW, "utf8"));
    expect(classifySensitivity({
      ...norm, htmlBody: null, textBody: HTML_ONLY_OTP_STORED_TEXT, attachments: [],
    }).sensitive).toBe(false);
    expect(classifySensitivity(norm).sensitive).toBe(true);
  });
});

describe("the repair", () => {
  it("restores the html, un-redacts the text and clears ALL FIVE sensitivity fields", async () => {
    const w = await newWorld();
    const id = await seedDamaged(w, { storedText: NEWSLETTER_STORED_TEXT });

    const r = await run(w);

    expect(r).toMatchObject({ ran: true, candidates: 1, fetched: 1, cleared: 1, marked: true });

    const [m] = await w.db.select().from(messages).where(eq(messages.id, id));
    const [b] = await w.db.select().from(messageBodies).where(eq(messageBodies.messageId, id));
    expect(b!.html).toContain("Manage billing");
    expect(b!.text).toContain("Springfield 12345");
    // ALL FIVE. The DTO computes `sensitive` as
    // `category !== null || no_ai || no_forward || no_kb || priority`, so clearing only the
    // category would restore the html and leave the message still marked sensitive on screen.
    expect(m!.sensitivityCategory).toBeNull();
    expect(m!.noAi).toBe(false);
    expect(m!.noForward).toBe(false);
    expect(m!.noKb).toBe(false);
    expect(m!.priority).toBe(false);
    // …and the preview, which was computed from the redacted text and would otherwise keep
    // showing `[REDACTED]` in every list the message appears in.
    expect(m!.snippet).not.toContain("[REDACTED]");
  });

  it("repairs a message withheld with NO CATEGORY — the class the predicate could not see", async () => {
    // THE WIDENING, and the whole reason this slice exists. `no_ai` set, `sensitivity_category`
    // NULL: the shape an INDETERMINATE verdict writes. The old predicate was
    // `sensitivity_category IS NOT NULL`, so this row was never a candidate and the pass reported
    // a clean, complete, marked run without ever having looked at it. Measured on the account this
    // was built for, the AI-ineligible senders damaged this way were mostly ones without a
    // category — so the predicate that shipped could not see most of the damage.
    const w = await newWorld();
    const id = await seedWithheld(w, {
      raw: DIGEST_RAW,
      storedText: DIGEST_PROSE,
      // The html a redacted-but-not-deleted row keeps. Ordinary, so the pre-filter admits it.
      storedHtml: `<p>${DIGEST_PROSE}</p>`,
    });

    const r = await run(w);

    expect(r).toMatchObject({ ran: true, candidates: 1, fetched: 1, cleared: 1, marked: true });

    const [m] = await w.db.select().from(messages).where(eq(messages.id, id));
    expect(m!.noAi).toBe(false);
    expect(m!.noKb).toBe(false);
    expect(m!.sensitivityCategory).toBeNull();
    // The link that was only ever in the html is back — the repair really re-read the original
    // rather than rewriting flags over the body it already had.
    const [b] = await w.db.select().from(messageBodies).where(eq(messageBodies.messageId, id));
    expect(b!.html).toContain("example.com/blog");
  });

  it("REFUSES an original the fixed classifier still withholds, and writes nothing", async () => {
    // `ordinary` is the only verdict that repairs. An INDETERMINATE original is the classifier
    // declining to say the message is clean, and this pass may only clear what it says IS clean.
    //
    // The stored text is the PROSE alone — the token lived in the html, which is why this costs a
    // fetch and cannot be decided from disk. On the original the token is there, the verdict is
    // `indeterminate [auth_url_token]`, and the row must come back untouched.
    const w = await newWorld();
    const id = await seedWithheld(w, {
      raw: MAGIC_LINK_RAW, storedText: DIGEST_PROSE, storedHtml: `<p>${DIGEST_PROSE}</p>`,
    });

    const r = await run(w);

    expect(r).toMatchObject({ fetched: 1, cleared: 0, stillSensitive: 0, stillWithheld: 1 });

    const [m] = await w.db.select().from(messages).where(eq(messages.id, id));
    const [b] = await w.db.select().from(messageBodies).where(eq(messageBodies.messageId, id));
    // Still withheld from the model…
    expect(m!.noAi).toBe(true);
    // …and — the invariant-#1 half — the token is NOT written back into storage in the clear.
    expect(b!.text).not.toContain("Xj9kQm2LpZ7vRt4WcN8sYbH3dF6gU0aE");
    expect(b!.html ?? "").not.toContain("Xj9kQm2LpZ7vRt4WcN8sYbH3dF6gU0aE");
    expect(m!.snippet ?? "").not.toContain("Xj9kQm2LpZ7vRt4WcN8sYbH3dF6gU0aE");
    // No delta: nothing changed, so no client may be told anything did.
    expect(await w.db.select().from(changeLog)).toHaveLength(0);
  });

  it("the PRE-FILTER reads the stored HTML, so a row it condemns costs no network read", async () => {
    // The cost filter, and the reason it had stopped filtering. A row in the second damage class
    // keeps its html, so hardcoding `htmlBody: null` in `fromStoredRow` threw away the only
    // evidence that could refuse it from disk — every damaged row then passed and was re-read off
    // the mail server. Here the prose is clean and the html carries the token: the verdict is
    // decidable WITHOUT a fetch, and the pass must decide it that way.
    const w = await newWorld();
    await seedWithheld(w, {
      raw: MAGIC_LINK_RAW,
      storedText: DIGEST_PROSE,
      storedHtml: `<p>${DIGEST_PROSE}</p><a href="${MAGIC_LINK}">Read</a>`,
    });

    const r = await run(w);

    expect(r).toMatchObject({ examined: 1, candidates: 0, fetched: 0, cleared: 0 });
    expect(w.fetches).toEqual([]);
  });

  it("tells the client, with an `update` and never a `move`", async () => {
    const w = await newWorld();
    const id = await seedDamaged(w, { storedText: NEWSLETTER_STORED_TEXT });

    await run(w);

    const rows = await w.db.select().from(changeLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: "message", entityId: id, op: "update" });
  });

  it("leaves a message the ORIGINAL still flags exactly as it was", async () => {
    const w = await newWorld();
    const id = await seedDamaged(w, {
      raw: HTML_ONLY_OTP_RAW, storedText: HTML_ONLY_OTP_STORED_TEXT, category: "otp",
    });

    const r = await run(w);

    // It cost a fetch — the stored text could not decide it — and was then refused on the
    // evidence that only the original carries.
    expect(r).toMatchObject({ candidates: 1, fetched: 1, cleared: 0, stillSensitive: 1 });
    const [m] = await w.db.select().from(messages).where(eq(messages.id, id));
    const [b] = await w.db.select().from(messageBodies).where(eq(messageBodies.messageId, id));
    expect(m!.sensitivityCategory).toBe("otp");
    expect(m!.noAi).toBe(true);
    expect(b!.html).toBeNull();
    expect(await w.db.select().from(changeLog)).toHaveLength(0);
  });

  it("never reads a message the STORED text already condemns", async () => {
    const w = await newWorld();
    await seedDamaged(w, { storedText: OTP_STORED_TEXT });

    const r = await run(w);

    // The pre-filter is the whole cost argument: of the categorised bodies on a live install, about one in twenty was worth
    // a network read. A pass that fetched them all would work and would be indefensible.
    expect(r).toMatchObject({ examined: 1, candidates: 0, fetched: 0, cleared: 0 });
    expect(w.fetches).toEqual([]);
  });

  it("REFUSES to write when the locator no longer holds this message", async () => {
    const w = await newWorld();
    const id = await seedDamaged(w, { storedText: NEWSLETTER_STORED_TEXT, identity: "wrong" });

    const r = await run(w);

    // Storing these bytes would put one person's mail into another message's row. That is the
    // worst outcome available to this pass, so it is checked rather than assumed.
    expect(r).toMatchObject({ fetched: 1, cleared: 0, mismatched: 1 });
    const [b] = await w.db.select().from(messageBodies).where(eq(messageBodies.messageId, id));
    expect(b!.html).toBeNull();
    expect(b!.text).toBe(NEWSLETTER_STORED_TEXT);
  });

  it("accepts a LEGACY dedup key on the Message-ID, which no fingerprint could match", async () => {
    const w = await newWorld();
    await seedDamaged(w, { storedText: NEWSLETTER_STORED_TEXT, identity: "legacy" });

    const r = await run(w);

    expect(r).toMatchObject({ cleared: 1 });
  });

  /**
   * ARM 3, VERIFIED RATHER THAN CLAIMED.
   *
   * The row filed this pass as one of the five consumers that read a gone locator as terminal: a
   * refusal joined the per-process refused set, and a completed walk holding one still stamped the
   * durable `sensitive_fp_backfill_at`, after which nothing looked at the mailbox again.
   *
   * That was already closed by the marker-honesty work below by the time this row was worked, and
   * closing it is not this lane's to claim. What WAS missing is this assertion: every case in this
   * file simulates an unreadable original by deleting it from the fake server, which throws a
   * plain `Error`. Nothing anywhere proved that the ACTUAL class the epoch guard raises reaches the
   * undecided arm rather than some other one — and "I read the code and it falls through" is the
   * kind of reasoning this repository has been wrong about before. So the real error is thrown
   * here, and the two properties that matter are checked against it directly.
   */
  it("a real MessageGoneError is UNDECIDED — the marker is withheld and the next walk re-reads it", async () => {
    const w = await newWorld();
    const id = await seedDamaged(w, { storedText: NEWSLETTER_STORED_TEXT, ref: "12:404" });
    const raw = w.server.get("12:404")!;
    const goneAdapter = {
      ...fakeAdapter(w),
      fetchRaw: async (locator: { folder: string; ref: string }) => {
        w.fetches.push(locator.ref);
        if (w.server.has(locator.ref)) return new Uint8Array(Buffer.from(w.server.get(locator.ref)!, "utf8"));
        throw new MessageGoneError(locator);
      },
    } as unknown as MailboxAdapter;

    // The folder was recycled: the locator names a UID this epoch does not have.
    w.server.delete("12:404");
    expect(await run(w, goneAdapter)).toMatchObject({ unreadable: 1, undecided: 1, marked: false });

    // Adoption repoints the row and the original is readable again — the RE-RESOLUTION this pass
    // gets for free by re-reading its candidates rather than caching a locator.
    w.server.set("12:404", raw);
    const second = await run(w, goneAdapter);
    expect(second).toMatchObject({ skipped: 0, fetched: 1, cleared: 1, undecided: 0, marked: true });
    const [b] = await w.db.select().from(messageBodies).where(eq(messageBodies.messageId, id));
    expect(b!.text).toContain("Springfield 12345");
  });

  it("survives a message that could not be read — and does NOT certify over it", async () => {
    // THE MARKER-HONESTY RULING (severe arm). This assertion used
    // to read `expect(r.marked).toBe(true)` with the comment *"the walk still finished, so the
    // marker is written — there is nothing here to come back for."* That comment was the defect
    // stated as a fact: `fetchRaw` throwing tells us NOTHING about whether the message is gone or
    // the connection blinked, and the marker is durable and final. So one dropped connection made
    // one message stay redacted for the rest of its life, with nothing recording that a decision
    // had been owed. The pass now finishes the walk, withholds the marker, and says so.
    const w = await newWorld();
    const id = await seedDamaged(w, { storedText: NEWSLETTER_STORED_TEXT, ref: "1:404" });
    w.server.delete("1:404");

    const r = await run(w);

    expect(r).toMatchObject({ unreadable: 1, cleared: 0, undecided: 1, blockedWalks: 1 });
    expect(r.marked).toBe(false);
    const [mb] = await w.db.select().from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    expect(mb!.sensitiveFpBackfillAt).toBeNull();
    // The body is untouched either way — the refusal costs a repair, never a corruption.
    const [b] = await w.db.select().from(messageBodies).where(eq(messageBodies.messageId, id));
    expect(b!.text).toBe(NEWSLETTER_STORED_TEXT);
  });

  it("a TRANSIENT failure is repaired on the next walk — the whole point of withholding", async () => {
    // The defect's cost, made concrete: before the fix this message was refused for the life of
    // the process AND the marker landed, so this second walk never happened and the repair below
    // was unreachable for ever. Nothing about the message changed; only the connection did.
    const w = await newWorld();
    const id = await seedDamaged(w, { storedText: NEWSLETTER_STORED_TEXT, ref: "1:404" });
    const raw = w.server.get("1:404")!;
    w.server.delete("1:404");

    expect(await run(w)).toMatchObject({ unreadable: 1, undecided: 1, marked: false });

    // The blip passes.
    w.server.set("1:404", raw);
    const second = await run(w);

    // RE-READ, not skipped off the shelf: an undecided refusal is cleared at the end of the walk
    // that recorded it, precisely so the next walk pays for it again.
    expect(second).toMatchObject({ skipped: 0, fetched: 1, cleared: 1, undecided: 0, marked: true });
    const [b] = await w.db.select().from(messageBodies).where(eq(messageBodies.messageId, id));
    // The un-redacted original is back: the postcode redaction removed is present again, and the
    // html the false positive deleted exists at all. (`toContain` rather than an equality on
    // NEWSLETTER_TEXT — `normalizeMime` keeps the part's trailing newline, and asserting on that
    // would be testing the MIME parser rather than the repair.)
    expect(b!.text).toContain("Springfield 12345");
    expect(b!.html).toContain("Manage billing");
  });

  it("the bound: three blocked walks then a marker that NAMES what it could not decide", async () => {
    // "Never stamp" is not survivable either — a permanently expunged row whose message never got
    // reaped would spend a fetch budget against somebody's mail host in perpetuity. So the pass
    // re-tries a bounded number of times and then certifies, with the gap on the record rather
    // than in a silence. That last clause is the assertion that matters: the difference between
    // this and the defect is not the stamp, it is that the stamp says what it does not cover.
    const w = await newWorld();
    const id = await seedDamaged(w, { storedText: NEWSLETTER_STORED_TEXT, ref: "1:404" });
    w.server.delete("1:404");

    expect(await run(w)).toMatchObject({ marked: false, blockedWalks: 1, undecided: 1 });
    expect(await run(w)).toMatchObject({ marked: false, blockedWalks: 2, undecided: 1 });
    const third = await run(w);
    expect(third).toMatchObject({ marked: true, undecided: 1 });
    // Three walks, three genuine re-reads — the shelf never let one of them be skipped.
    expect(w.fetches).toEqual(["1:404", "1:404", "1:404"]);

    const [audit] = await w.db.select().from(auditLog)
      .where(eq(auditLog.action, "sensitive_fp_backfill"));
    expect(audit!.payload).toMatchObject({ undecided: 1, undecidedMessageIds: [id] });
  });

  it("a message that becomes undecided LATE gets the whole bound, not the remainder of it", async () => {
    // The bound is per MESSAGE, and this is the case that tells that apart from per MAILBOX.
    // Two walks blocked by one unreadable message, then a SECOND message becomes eligible and
    // fails its first fetch. Counting per mailbox, walk three would stamp — and the newcomer,
    // tried once, would be certified over and stay redacted for ever behind a durable marker.
    const w = await newWorld();
    await seedDamaged(w, { storedText: NEWSLETTER_STORED_TEXT, ref: "1:404" });
    w.server.delete("1:404");

    expect(await run(w)).toMatchObject({ marked: false, undecided: 1, blockedWalks: 1 });
    expect(await run(w)).toMatchObject({ marked: false, undecided: 1, blockedWalks: 2 });

    // A second damaged message arrives — a restored husk, a late repair — and cannot be read.
    await seedDamaged(w, { storedText: NEWSLETTER_STORED_TEXT, ref: "1:405" });
    w.server.delete("1:405");
    const third = await run(w);

    // The count RESTARTED because the undecided set gained a member. Per mailbox this reads
    // `marked: true` and the newcomer is certified over after a single attempt.
    expect(third).toMatchObject({ marked: false, undecided: 2, blockedWalks: 1 });
    const [mb] = await w.db.select().from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    expect(mb!.sensitiveFpBackfillAt).toBeNull();
  });

  it("a RESTART resets the bound towards more looking, never towards a premature certificate", async () => {
    // The restart test the durability ledger asks for, and the direction is the whole claim: the
    // blocked-walk counter is process state, so losing it must cost re-reads and never a
    // certification. Two blocked walks, then the process "restarts", then two more — and the
    // marker is still not written, because the count started over.
    const w = await newWorld();
    await seedDamaged(w, { storedText: NEWSLETTER_STORED_TEXT, ref: "1:404" });
    w.server.delete("1:404");

    expect(await run(w)).toMatchObject({ marked: false, blockedWalks: 1 });
    expect(await run(w)).toMatchObject({ marked: false, blockedWalks: 2 });

    resetSensitiveBackfillProgress(w.mailboxId);

    expect(await run(w)).toMatchObject({ marked: false, blockedWalks: 1 });
    const [mb] = await w.db.select().from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    expect(mb!.sensitiveFpBackfillAt).toBeNull();
  });

  it("a DECIDED refusal is certified: the classifier answered, so the marker may stand", async () => {
    // The other half of the split, and it must stay green or the fix would have made every
    // correctly-refused message block the marker for ever. The classifier READ this original and
    // said no; that is an answer, and the pass has done its job on the row.
    const w = await newWorld();
    await seedDamaged(w, { raw: HTML_ONLY_OTP_RAW, storedText: HTML_ONLY_OTP_STORED_TEXT });

    const r = await run(w);

    expect(r).toMatchObject({
      fetched: 1, stillSensitive: 1, cleared: 0, undecided: 0, blockedWalks: 0, marked: true,
    });
  });

  it("an IDENTITY MISMATCH is undecided too — the original of THIS message was never read", async () => {
    const w = await newWorld();
    await seedDamaged(w, { storedText: NEWSLETTER_STORED_TEXT, identity: "wrong" });

    const r = await run(w);

    // The locator resolved to somebody else's message, so nothing was learned about this one. A
    // later sync repointing the locator makes it repairable, which a marker here would prevent.
    expect(r).toMatchObject({ mismatched: 1, undecided: 1, marked: false });
  });

  it("an oversized ORIGINAL is cleared FROM STORED, not left permanently withheld", async () => {
    // THE OVERSIZED RULING. A false-positive newsletter whose ORIGINAL is over the re-read ceiling
    // used to land in the `unreadable` bucket — refused, refused-set, and left `otp`/redacted for
    // ever, mis-withheld by a size limit rather than by any verdict. RED against that: the stored
    // text is `ordinary`, so the row is repaired FROM STORED and comes readable.
    const w = await newWorld();
    const id = await seedDamaged(w, { storedText: NEWSLETTER_STORED_TEXT });

    // A ceiling below the fixture's size, so `fetchRaw` refuses it exactly as the server would.
    const r = await run(w, undefined, { maxBytes: 8 });

    expect(r).toMatchObject({
      fetched: 1, cleared: 0, clearedFromStored: 1, unreadable: 0, marked: true,
    });
    const [m] = await w.db.select().from(messages).where(eq(messages.id, id));
    const [b] = await w.db.select().from(messageBodies).where(eq(messageBodies.messageId, id));
    // The sensitivity metadata comes clean — the row is readable and eligible again.
    expect(m!.sensitivityCategory).toBeNull();
    expect(m!.noAi).toBe(false);
    expect(m!.noForward).toBe(false);
    expect(m!.noKb).toBe(false);
    expect(m!.priority).toBe(false);
    // But the html the false positive DELETED is NOT restored — the bytes that held it are exactly
    // what the ceiling stopped us reading. This is the honest limit of a repair from stored, and
    // asserting it keeps the counter's promise (`clearedFromStored`, not `cleared`) truthful.
    expect(b!.html).toBeNull();
  });

  it("a genuinely-sensitive oversized row stays withheld — the pre-filter never fetches it", async () => {
    // The safety half of the ruling. An oversized message whose STORED text still condemns it
    // (a real code) is withheld by the pre-filter before any fetch, so an unreadable original can
    // never launder a sensitive row clean. It is examined, never a candidate, never cleared.
    const w = await newWorld();
    const id = await seedDamaged(w, { storedText: OTP_STORED_TEXT });

    const r = await run(w, undefined, { maxBytes: 8 });

    expect(r).toMatchObject({
      examined: 1, candidates: 0, fetched: 0, clearedFromStored: 0, cleared: 0,
    });
    expect(w.fetches).toEqual([]);
    const [m] = await w.db.select().from(messages).where(eq(messages.id, id));
    expect(m!.sensitivityCategory).toBe("otp");
    expect(m!.noAi).toBe(true);
  });
});

describe("an html-only letter, whose stored text is its html's words", () => {
  it("is judged on the stored row as ingest judged it, so an oversized original keeps its flags", async () => {
    const w = await newWorld();
    const norm = await normalizeMime(Buffer.from(SIGN_IN_RELATED_RAW, "utf8"));
    const storedText = norm.textBody;
    const storedHtml = prepareHtmlForStorage(norm.htmlBody);
    expect(storedText).toContain("asked to sign in");
    const stored = __fromStoredRow({
      messageId: "m", dedupKey: "k", messageIdHeader: null, subject: norm.subject, storedText, storedHtml, locator: null,
    });
    expect(classifySensitivity(stored)).toEqual(classifySensitivity(norm));
    expect(classifySensitivity(norm).flags).toMatchObject({ no_ai: true, no_kb: true });

    const id = await seedWithheld(w, { raw: SIGN_IN_RELATED_RAW, storedText, storedHtml });
    const r = await run(w, undefined, { maxBytes: 8 });
    expect(r).toMatchObject({ examined: 1, candidates: 0, fetched: 0, clearedFromStored: 0 });
    const [m] = await w.db.select().from(messages).where(eq(messages.id, id));
    expect([m!.noAi, m!.noKb]).toEqual([true, true]);
  });
});

describe("it repairs a record and re-routes nothing", () => {
  it("writes no folder_state, no routing decision and no move", async () => {
    const w = await newWorld();
    await seedDamaged(w, { storedText: NEWSLETTER_STORED_TEXT });

    await run(w);

    // Clearing a sensitivity category is display-only: the router reads the verdict computed in
    // memory at ingest, never this column, and the reconciler reads `folder_state`. Asserted
    // rather than inferred from what the pass happens not to import today.
    expect(await w.db.select().from(folderState)).toEqual([]);
    expect(await w.db.select().from(routingDecisions)).toEqual([]);
    const moves = (await w.db.select().from(changeLog)).filter((c) => c.op === "move");
    expect(moves).toEqual([]);
  });

  it("writes NOTHING to the mailbox — no move, no flag, no send", async () => {
    const w = await newWorld();
    await seedDamaged(w, { storedText: NEWSLETTER_STORED_TEXT });

    await run(w);

    expect(w.writes).toEqual({ move: 0, setFlags: 0, send: 0, fetchPart: 0 });
  });

  it("does not touch a message that was never damaged", async () => {
    const w = await newWorld();
    const untouched = await seedOrdinary(w);
    await seedDamaged(w, { storedText: NEWSLETTER_STORED_TEXT });

    const r = await run(w);

    // One examined, not two: an uncategorised message is not in the candidate set at all.
    expect(r.examined).toBe(1);
    const [m] = await w.db.select().from(messages).where(eq(messages.id, untouched));
    expect(m!.snippet).toBe("");
  });
});

describe("idempotency", () => {
  it("a second run reads nothing, fetches nothing and writes nothing", async () => {
    const w = await newWorld();
    await seedDamaged(w, { storedText: NEWSLETTER_STORED_TEXT });

    const first = await run(w);
    const second = await run(w);

    expect(first).toMatchObject({ ran: true, cleared: 1, marked: true });
    expect(second).toMatchObject({ ...second, ran: false, examined: 0, fetched: 0, cleared: 0 });
    expect(w.fetches).toHaveLength(1);
    expect(await w.db.select().from(changeLog)).toHaveLength(1);
  });

  it("is idempotent WITHOUT the marker too — the marker saves the reads, not the correctness", async () => {
    const w = await newWorld();
    await seedDamaged(w, { storedText: NEWSLETTER_STORED_TEXT });
    await run(w);

    // Clear the marker: this is also the supported way to ASK for the pass again, so the claim
    // and the operator's trigger are the same mechanism.
    await w.db.update(mailboxes).set({ sensitiveFpBackfillAt: null })
      .where(eq(mailboxes.id, w.mailboxId));
    const again = await run(w);

    // The repaired message no longer carries a category, so it is not a candidate. No second
    // delta, and no second fetch.
    expect(again).toMatchObject({ ran: true, examined: 0, fetched: 0, cleared: 0 });
    expect(await w.db.select().from(changeLog)).toHaveLength(1);
  });

  it("does NOT mark a run the fetch budget cut short", async () => {
    const w = await newWorld();
    await seedDamaged(w, { storedText: NEWSLETTER_STORED_TEXT, ref: "1:1" });
    await seedDamaged(w, { storedText: NEWSLETTER_STORED_TEXT, ref: "1:2" });

    const r = await run(w, undefined, { fetchesPerCycle: 1 });

    expect(r).toMatchObject({ fetched: 1, cleared: 1, capped: true, marked: false });
    // Marking here would strand the second message unreadable for ever.
    const [mb] = await w.db.select().from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    expect(mb!.sensitiveFpBackfillAt).toBeNull();

    const rest = await run(w, undefined, { fetchesPerCycle: 1 });
    expect(rest).toMatchObject({ cleared: 1, marked: true });
  });

  it("TERMINATES: a second cycle reads the messages the first one did NOT decide about", async () => {
    // THE DEFECT THIS PINS, found in production and not by a test. A message the pass fetches and
    // REFUSES stays categorised, stays without html, and still clears the pre-filter — so with no
    // memory of having tried it, every cycle restarts the walk and spends its whole budget
    // re-reading the same messages to reach the same answer. Progress is then whatever fraction
    // of one budget happens to be repairable, and once the earliest candidates are all refusals it
    // is ZERO: the walk never reaches the rest and the marker is never written.
    //
    // Two messages the ORIGINAL still flags, then one that is repairable, with a budget of one.
    // Without the refusal set, cycles two and three re-read message one for ever and the
    // repairable message is never reached.
    const w = await newWorld();
    const at = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
    await seedDamaged(w, {
      id: at(1), raw: HTML_ONLY_OTP_RAW, storedText: HTML_ONLY_OTP_STORED_TEXT, ref: "1:1",
    });
    await seedDamaged(w, {
      id: at(2), raw: HTML_ONLY_OTP_RAW, storedText: HTML_ONLY_OTP_STORED_TEXT, ref: "1:2",
    });
    await seedDamaged(w, { id: at(3), storedText: NEWSLETTER_STORED_TEXT, ref: "1:3" });

    const one = await run(w, undefined, { fetchesPerCycle: 1 });
    const two = await run(w, undefined, { fetchesPerCycle: 1 });
    const three = await run(w, undefined, { fetchesPerCycle: 1 });

    expect(one).toMatchObject({ fetched: 1, cleared: 0, stillSensitive: 1 });
    // The second cycle SKIPPED the first message rather than paying for it again.
    expect(two).toMatchObject({ fetched: 1, skipped: 1, cleared: 0, stillSensitive: 1 });
    expect(three).toMatchObject({ fetched: 1, skipped: 2, cleared: 1 });
    // Three cycles, three distinct reads — never the same message twice.
    expect(w.fetches).toHaveLength(3);
    expect(new Set(w.fetches).size).toBe(3);
    // …and having decided about every candidate, the walk is finished and says so.
    expect(three.marked).toBe(true);
  });

  it("forgets its refusals once the mailbox is marked — clearing the marker really does re-run", async () => {
    // The refusal set is an optimisation and must not outlive the walk it belongs to, or the
    // documented recovery route ("clear the marker and the pass runs again") would quietly do
    // nothing for every message the previous run declined.
    const w = await newWorld();
    await seedDamaged(w, { raw: HTML_ONLY_OTP_RAW, storedText: HTML_ONLY_OTP_STORED_TEXT });

    const first = await run(w);
    expect(first).toMatchObject({ fetched: 1, stillSensitive: 1, marked: true });

    await w.db.update(mailboxes).set({ sensitiveFpBackfillAt: null })
      .where(eq(mailboxes.id, w.mailboxId));
    const again = await run(w);

    expect(again).toMatchObject({ fetched: 1, skipped: 0, stillSensitive: 1 });
    expect(w.fetches).toHaveLength(2);
  });

  it("does nothing at all on a backend that cannot re-read a message", async () => {
    const w = await newWorld();
    await seedDamaged(w, { storedText: NEWSLETTER_STORED_TEXT });

    const r = await run(w, fakeAdapter(w, { fetchRaw: false }));

    expect(r.ran).toBe(false);
    // And crucially the marker stays NULL, so a deployment that CAN read still does the work.
    const [mb] = await w.db.select().from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    expect(mb!.sensitiveFpBackfillAt).toBeNull();
  });
});

describe("the operator's record", () => {
  it("writes ONE audit row for the pass, with counts and no inverse", async () => {
    const w = await newWorld();
    await seedDamaged(w, { storedText: NEWSLETTER_STORED_TEXT });
    await seedDamaged(w, { storedText: OTP_STORED_TEXT });

    await run(w);

    const rows = await w.db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("sensitive_fp_backfill");
    expect(rows[0]!.payload).toMatchObject({ examined: 2, candidates: 1, cleared: 1 });
    // No inverse: re-redacting a message the classifier has now read in full and cleared is not
    // an operation anybody would want performed.
    expect(rows[0]!.inverse).toBeNull();
  });
});

describe("the snippet mirror", () => {
  it("is the three operations the ingest path performs, and nothing else", async () => {
    // `pipeline.ts#bodySnippet` is private to that module, so this pass mirrors it rather than
    // widening another slice's export surface for three lines. The cost of a mirror is drift, so
    // the shape is pinned here: collapse whitespace, trim, take 200.
    const norm = await normalizeMime(Buffer.from(NEWSLETTER_RAW, "utf8"));
    const long = { ...norm, textBody: `  a\n\n\tb  ${"x".repeat(400)}  ` };

    expect(__snippetOf(long)).toBe(`a b ${"x".repeat(400)}`.slice(0, 200));
    expect(__snippetOf(long)).toHaveLength(200);
    expect(__snippetOf({ ...norm, textBody: "  hi  there  " })).toBe("hi there");
  });

  it("draws from the FULL text — body/snippet redaction is removed", async () => {
    // Body redaction at rest is removed, so the snippet is the FULL text — the same as the ingest
    // path (`pipeline.ts#bodySnippet`), which now reads `normalized.textBody` unconditionally. The
    // reader's list preview shows their own mail, credential and all. A message withheld from the
    // model (an indeterminate credential here) keeps that `no_ai` flag, but its snippet is not
    // redacted.
    const norm = await normalizeMime(Buffer.from(MAGIC_LINK_RAW, "utf8"));
    const verdict = classifySensitivity(norm);

    // The withholding still stands as a LABEL / AI gate — it just no longer redacts the preview.
    expect(verdict.verdict).toBe("indeterminate");
    expect(verdict.sensitive).toBe(false);
    expect(verdict.flags.no_ai).toBe(true);

    const snippet = __snippetOf({ ...norm, textBody: `Hello. ${MAGIC_LINK}` });
    expect(snippet).toContain("Xj9kQm2LpZ7vRt4WcN8sYbH3dF6gU0aE");
  });
});
