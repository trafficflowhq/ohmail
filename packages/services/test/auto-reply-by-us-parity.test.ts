import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { autoReplyByUsWhere, awayReplies, mailboxes, messageBodies, messages } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { dialect } from "@trafficflow/db/dialect";
import { hasMachineSentHeaders } from "../src/consent-seed.js";

/**
 * THE PARITY CONTROL — the TypeScript predicate and the SQL fragment answer the same question.
 *
 * `hasMachineSentHeaders` (`packages/services/src/consent-seed.ts`) and
 * `machineSentHeadersWhere` (`packages/db/src/auto-reply-by-us.ts`) are the same three RFC 3834
 * header arms written twice, in two languages, because two runtimes have to ask the question: the
 * consent seed asks it in Node over headers it already holds, and the Ohbox rule asks it in SQL
 * inside a `NOT EXISTS` it cannot pull rows out of. Neither copy is the definition. THE PAIR IS,
 * and this file is the only thing that makes that a fact rather than an intention.
 *
 * Every shape below is asserted BOTH WAYS on the same input: the TS verdict, the SQL verdict, and
 * that they are equal. An expectation is written per row, so a row that is wrong in the same
 * direction on both sides is still caught — a test that only compared the two would pass happily
 * if both arms were deleted.
 *
 * The two translation traps this exists to hold shut, both of which a naive port gets wrong and
 * neither of which any product test would notice:
 *
 *   · NON-STRING ARRAY MEMBERS. The TS filters to strings; `jsonb_array_elements_text` would
 *     stringify a number and fire the arm. See `[5]` below.
 *   · THE TRIM. `String.prototype.trim` strips the ASCII whitespace set; `btrim(v)` strips only
 *     spaces. See the tab- and newline-padded `no` rows.
 *
 * IT LIVES IN `packages/services` AND NOT `packages/db`, which is where the SQL half lives,
 * because the TS half lives here and `services` already depends on `db`. The other direction is a
 * package cycle — a test reaching from `db` up into `services` would either fail to resolve or,
 * worse, resolve through a vitest alias and hide a dependency the build graph forbids.
 *
 * PGlite is the right runtime for this and the pg twin re-runs it anyway: the predicate is pure,
 * so PGlite's "green means nothing for transactional code" caveat does not bite — but POSIX
 * character-class behaviour is a property of the SERVER, so
 * `apps/worker/test/auto-reply-not-engagement.pg.test.ts` asserts the same table on real Postgres
 * rather than trusting the WASM build's collation to stand in for it.
 */

const OWN = "me@example.test";

/** Every header shape, with the verdict BOTH sides must reach. */
const SHAPES: ReadonlyArray<{ what: string; headers: Record<string, unknown>; machine: boolean }> = [
  // ── auto-submitted ──────────────────────────────────────────────────────────────────────────
  { what: "no headers at all", headers: {}, machine: false },
  { what: "auto-submitted absent, other headers present", headers: { subject: ["hi"] }, machine: false },
  { what: "auto-submitted: no — RFC 3834's way of saying a human wrote it", headers: { "auto-submitted": ["no"] }, machine: false },
  { what: "auto-submitted: NO — case-insensitive", headers: { "auto-submitted": ["NO"] }, machine: false },
  { what: "auto-submitted: ' no ' — space padded", headers: { "auto-submitted": [" no "] }, machine: false },
  { what: "auto-submitted: TAB-padded no — btrim(v) alone would diverge here", headers: { "auto-submitted": ["\tno\t"] }, machine: false },
  { what: "auto-submitted: NEWLINE-padded no", headers: { "auto-submitted": ["\nno\n"] }, machine: false },
  { what: "auto-submitted: auto-replied — the responder's own marker", headers: { "auto-submitted": ["auto-replied"] }, machine: true },
  { what: "auto-submitted: AUTO-GENERATED", headers: { "auto-submitted": ["AUTO-GENERATED"] }, machine: true },
  { what: "auto-submitted: 'none' — not 'no', so a marker", headers: { "auto-submitted": ["none"] }, machine: true },
  { what: "auto-submitted: '' — empty is not 'no', so a marker", headers: { "auto-submitted": [""] }, machine: true },
  { what: "auto-submitted: [] — present but empty, no members to test", headers: { "auto-submitted": [] }, machine: false },
  { what: "auto-submitted: a STRING not an array — not an array, so no members", headers: { "auto-submitted": "auto-replied" }, machine: false },
  { what: "auto-submitted: [5] — a non-string member is filtered out on BOTH sides", headers: { "auto-submitted": [5] }, machine: false },
  { what: "auto-submitted: ['no','auto-replied'] — some(), so one marker is enough", headers: { "auto-submitted": ["no", "auto-replied"] }, machine: true },

  // ── precedence ──────────────────────────────────────────────────────────────────────────────
  { what: "precedence: bulk", headers: { precedence: ["bulk"] }, machine: true },
  { what: "precedence: BULK", headers: { precedence: ["BULK"] }, machine: true },
  { what: "precedence: list", headers: { precedence: ["list"] }, machine: true },
  { what: "precedence: junk", headers: { precedence: ["junk"] }, machine: true },
  { what: "precedence: auto_reply — the optional underscore", headers: { precedence: ["auto_reply"] }, machine: true },
  { what: "precedence: autoreply — the same arm without it", headers: { precedence: ["autoreply"] }, machine: true },
  { what: "precedence: first-class — a real header value that is NOT a marker", headers: { precedence: ["first-class"] }, machine: false },
  { what: "precedence: normal", headers: { precedence: ["normal"] }, machine: false },
  { what: "precedence: ' bulk ' — NOT trimmed on either side; substring match", headers: { precedence: [" bulk "] }, machine: true },
  { what: "precedence: [7] — non-string filtered", headers: { precedence: [7] }, machine: false },

  // ── x-auto-response-suppress ────────────────────────────────────────────────────────────────
  { what: "x-auto-response-suppress: All — presence alone", headers: { "x-auto-response-suppress": ["All"] }, machine: true },
  { what: "x-auto-response-suppress: '' — a present empty string still counts", headers: { "x-auto-response-suppress": [""] }, machine: true },
  { what: "x-auto-response-suppress: [] — no members, so absent", headers: { "x-auto-response-suppress": [] }, machine: false },
  { what: "x-auto-response-suppress: [1] — non-string filtered, so absent", headers: { "x-auto-response-suppress": [1] }, machine: false },

  // ── the subject arm is NOT part of this predicate ───────────────────────────────────────────
  {
    what: "an out-of-office SUBJECT with no machine header is NOT machine-sent here",
    headers: { subject: ["Out of office"] },
    machine: false,
  },
];

/**
 * THROUGH THE QUERY BUILDER AND THE SEAM, so this file can run on both stores.
 *
 * Every insert here was a raw `db.execute(sql`… ::uuid …`)`, which the device store's handle
 * answers with `TypeError: db.execute is not a function` — the fixture, not the predicate, and it
 * is why this file could not join the second run before the fragment was ported.
 */
async function seed() {
  const db = await makeTestDb();
  const accountId = crypto.randomUUID();
  const mailboxId = crypto.randomUUID();
  await db.insert(mailboxes).values({
    id: mailboxId, accountId, provider: "imap", address: OWN, status: "connected",
  });
  return { db, accountId, mailboxId };
}

type TestDb = Awaited<ReturnType<typeof makeTestDb>>;

/** The fragment's answer for one message, read positionally so both drivers agree. */
async function verdictFor(db: TestDb, id: string): Promise<boolean> {
  const d = dialect(db);
  const where = autoReplyByUsWhere(d, {
    accountId: sql`m.account_id`,
    id: sql`m.id`,
    fromAddress: sql`m.from_address`,
    messageIdHeader: sql`m.message_id_header`,
  });
  const rows = await d.exec(db, sql`
    select ${where} from ${messages} m where m.id = ${d.castUuid(sql`${id}`)}`);
  expect(rows.length).toBe(1);
  // One store answers a boolean and the other a 0/1 integer, which is a driver difference and
  // not a dialect one — the QUESTION is the same, so the answer is normalised here.
  return rows[0]![0] === true || rows[0]![0] === 1;
}

/** Insert one own-sent message carrying `headers`, and answer the SQL verdict for it. */
async function sqlVerdict(
  db: TestDb, accountId: string, mailboxId: string, headers: Record<string, unknown>,
): Promise<boolean> {
  const id = crypto.randomUUID();
  await db.insert(messages).values({
    id, accountId, mailboxId, bodyHash: "h", dedupKey: id, subject: "",
    fromAddress: OWN, date: new Date(),
  });
  await db.insert(messageBodies).values({ messageId: id, accountId, text: "", headers });
  return verdictFor(db, id);
}

describe("auto-reply-by-us: the TS predicate and the SQL fragment agree", () => {
  it(`agrees on all ${SHAPES.length} header shapes, and each verdict is asserted outright`, async () => {
    const { db, accountId, mailboxId } = await seed();
    const disagreed: string[] = [];
    const wrong: string[] = [];
    for (const shape of SHAPES) {
      const ts = hasMachineSentHeaders(shape.headers);
      const pg = await sqlVerdict(db, accountId, mailboxId, shape.headers);
      // The verdict itself, so deleting an arm on BOTH sides cannot pass.
      if (ts !== shape.machine) wrong.push(`TS ${shape.what}: expected ${shape.machine}, got ${ts}`);
      if (pg !== shape.machine) wrong.push(`SQL ${shape.what}: expected ${shape.machine}, got ${pg}`);
      // And the parity, so an arm deleted on ONE side cannot pass either.
      if (ts !== pg) disagreed.push(`${shape.what}: TS ${ts} vs SQL ${pg}`);
    }
    expect(wrong).toEqual([]);
    expect(disagreed).toEqual([]);
  });

  /**
   * THE NAMED DIVERGENCE, pinned rather than claimed away.
   *
   * `trim()` strips Unicode whitespace; POSIX `[[:space:]]` does not. So a NBSP-padded `no` is
   * "no" to the TS and a marker to the SQL. No mail system produces that shape, and the honest
   * thing is to write down where the pair stops agreeing instead of letting a docblock claim
   * total parity. If this ever needs closing, close it in the SQL — the TS half is `isMachineSent`
   * and must not change for the consent seed.
   */
  it("diverges ONLY on Unicode-whitespace padding, and that is the documented residual", async () => {
    const { db, accountId, mailboxId } = await seed();
    // Written as an ESCAPE, never as a literal byte. Writing this file planted a real U+00A0
    // here on the first attempt and nothing showed it, which is the whole argument for
    // `test/no-control-bytes.test.ts` and for never trusting the eye on invisible characters.
    const nbsp = { "auto-submitted": ["\u00a0no\u00a0"] };
    expect(hasMachineSentHeaders(nbsp)).toBe(false);
    expect(await sqlVerdict(db, accountId, mailboxId, nbsp)).toBe(true);
  });

  /** The own-address arm is part of the predicate, not the caller's job. */
  it("answers FALSE for an inbound auto-reply — 'by us' is half the claim", async () => {
    const { db, accountId, mailboxId } = await seed();
    const id = crypto.randomUUID();
    await db.insert(messages).values({
      id, accountId, mailboxId, bodyHash: "h", dedupKey: id, subject: "",
      fromAddress: "stranger@elsewhere.test", date: new Date(),
    });
    await db.insert(messageBodies).values({
      messageId: id, accountId, text: "", headers: { "auto-submitted": ["auto-replied"] },
    });
    expect(await verdictFor(db, id)).toBe(false);
  });

  /**
   * THE LEDGER ARM, and the bracket shape that made the brief's `=` match nothing in production.
   * `minted_message_id` keeps `<…>`; ingest strips them. Measured before this landed: 0 rows on
   * `=`, 25 once trimmed.
   */
  it("correlates a Sent copy to its ledger row ACROSS the bracket shapes", async () => {
    const { db, accountId, mailboxId } = await seed();
    const d = dialect(db);
    const id = crypto.randomUUID();
    const bare = `${crypto.randomUUID()}@example.test`;
    await db.insert(messages).values({
      id, accountId, mailboxId, bodyHash: "h", dedupKey: id, subject: "",
      fromAddress: OWN, date: new Date(), messageIdHeader: bare,
    });
    // No body row at all: the ledger arm must stand on its own.
    /* The ledger names the message it ANSWERED — a real incoming row, because mail 0118 keys
       `away_replies` to `(message_id, account_id)`. The Sent copy above is a different message. */
    const answered = crypto.randomUUID();
    await db.insert(messages).values({
      id: answered, accountId, mailboxId, bodyHash: "h", dedupKey: answered, subject: "",
      fromAddress: "them@elsewhere.test", date: new Date(),
    });
    await db.insert(awayReplies).values({
      accountId, mailboxId, messageId: answered,
      sender: "them@elsewhere.test", outcome: "sent", mintedMessageId: `<${bare}>`,
    });
    expect(await verdictFor(db, id)).toBe(true);

    // THE CONTROL that makes the trim load-bearing: a bare `=` would answer false here.
    const exact = await d.exec(db, sql`
      select exists (
        select 1 from ${awayReplies} ar
         where ar.account_id = m.account_id and ar.minted_message_id = m.message_id_header
      ) from ${messages} m where m.id = ${d.castUuid(sql`${id}`)}`);
    expect(exact[0]![0] === true || exact[0]![0] === 1).toBe(false);
  });
});
