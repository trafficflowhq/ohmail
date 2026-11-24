import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAILBOX_DISABLED_REASONS } from "../src/mailbox-errors.js";
import { ORGANIZER_KINDS } from "../src/organizer-role.js";
import { closedSetValue, ClosedSetViolation } from "../src/closed-sets.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * `mailboxes_disabled_reason_shape` — WATCHED REFUSING (mail 0202; a member list from mail 0027 until then).
 *
 * The CHECK is a the "Account isolation is absolute, and it binds staff too" invariant boundary and this is the only thing that proves it exists on a real
 * database. It cannot be a PGlite test: PGlite would answer the same and has answered the same
 * while three production bugs were invisible to it, and — more to the point — this file's whole
 * question is "did the migration's DDL actually take", which is a question about the catalog of a
 * database built by the real migrator.
 *
 * ── WHY THE COLUMN NEEDS A CONSTRAINT AT ALL, GIVEN THE WRITE SITE ALREADY CHECKS ──────────
 *
 * `markMailboxFailed`'s sibling column `error_detail` had exactly one guard — a regex at the
 * write site — and a review finding walked through it: imapflow derives `err.serverResponseCode` from the
 * SERVER's own bracket atom, so `* NO [SECRETPASSWORD123] authentication failed` chose a value
 * that passed the shape test and landed in a column the account owner and the admin console both
 * read. The fix there was membership, applied at the write.
 *
 * This column is held at BOTH ends. The write door holds the MEMBERS (`closedSetValue`), on every
 * store. The constraint holds the SHAPE, one lower-case word: it is the end that survives a call
 * site nobody has written yet, and it refuses exactly what a mail server could choose — the token
 * above, an address, a sentence. A new member fits it without altering the table.
 */

const DB_URL = PG_TEST_URL;
const HAVE_PG = await realPgAvailable(DB_URL);

describe.skipIf(!HAVE_PG)("mailboxes.disabled_reason is closed at rest", () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let accountId: string;

  beforeAll(async () => {
    client = postgres(DB_URL, { max: 1 });
    db = brandDialect(drizzle(client), "pg");
    accountId = randomUUID();
    await db.execute(sql`insert into accounts (id, name) values (${accountId}, 'lease-check')`);
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    await db.execute(sql`delete from mailboxes where account_id = ${accountId}`).catch(() => undefined);
    await db.execute(sql`delete from accounts where id = ${accountId}`).catch(() => undefined);
    await client.end({ timeout: 5 });
  });

  /** Insert a disabled mailbox carrying `reason`. Resolves to the driver's SQLSTATE, or null. */
  async function insertReason(reason: string | null): Promise<string | null> {
    const id = randomUUID();
    try {
      await db.execute(sql`
        insert into mailboxes (id, account_id, provider, address, status, disabled_reason)
        values (${id}, ${accountId}, 'imap', ${`${id}@lease.test`}, 'disabled', ${reason})`);
      return null;
    } catch (err) {
      return String((err as { code?: unknown }).code ?? "unknown");
    }
  }

  it("accepts every member of MAILBOX_DISABLED_REASONS, and NULL", async () => {
    // Derived from the TypeScript constant rather than re-typed, so the SQL and the code cannot
    // drift into disagreeing about which three strings the set contains. A member added to the
    // constant without being added to the migration fails HERE, with the value named.
    for (const reason of MAILBOX_DISABLED_REASONS) {
      expect(await insertReason(reason), `${reason} must be storable`).toBeNull();
    }
    // NULL is the ordinary case: a mailbox disabled by its own user, or by a plan downgrade.
    // A constraint that refused it would make every non-lease disable impossible.
    expect(await insertReason(null)).toBeNull();
  }, 30_000);

  it("REFUSES what is no reason word — 23514, watched", async () => {
    // The direction that matters: a value a mail server could choose. A case variant, the token
    // itself, an address, a sentence, a word past the bound, and nothing at all.
    for (const bad of [
      "ORGANIZED_ELSEWHERE:CLOUD", "SECRETPASSWORD123", "postmaster@provider.test",
      "organized elsewhere", `o${"x".repeat(48)}`, "",
    ]) {
      expect(await insertReason(bad), `${JSON.stringify(bad)} must be refused`).toBe("23514");
    }
  }, 30_000);

  it("leaves a word that is no member to the write door: the catalog admits it, the door refuses it", async () => {
    // A plausible organizer kind and a bare prefix: each has the shape, neither is a member.
    for (const word of ["organized_elsewhere:desktop", "organized_elsewhere"]) {
      expect(await insertReason(word), `${word} fits the shape`).toBeNull();
      expect(() => closedSetValue("mailboxes_disabled_reason_shape", word), word).toThrow(ClosedSetViolation);
    }
  }, 30_000);

  it("names itself in the refusal, so an operator can find the migration", async () => {
    const id = randomUUID();
    let constraint = "";
    try {
      await db.execute(sql`
        insert into mailboxes (id, account_id, provider, address, status, disabled_reason)
        values (${id}, ${accountId}, 'imap', ${`${id}@lease.test`}, 'disabled', 'NOPE')`);
    } catch (err) {
      constraint = String((err as { constraint_name?: unknown; constraint?: unknown }).constraint_name
        ?? (err as { constraint?: unknown }).constraint ?? "");
    }
    expect(constraint).toBe("mailboxes_disabled_reason_shape");
  }, 30_000);
});


/**
 * `mailboxes_organized_by_kind_shape` — WATCHED REFUSING (mail 0202; a member list from mail 0083, widened by mail 0103, until then).
 *
 * The second half of the same vocabulary: `disabled_reason` carries the kind as a suffix and this
 * column carries it bare, and mail 0103 had to widen BOTH — a slice that widened one alone leaves
 * the other refusing the write on a mailbox somebody is using, which is how the phone lane found
 * `organizer_stand_down_write_failed` beside every measured stand-down.
 *
 * Derived from `ORGANIZER_KINDS` rather than re-typed, so a member added to the constant without
 * a migration fails here with the value named.
 */
describe.skipIf(!HAVE_PG)("mailboxes.organized_by_kind is closed at rest", () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let accountId: string;

  beforeAll(async () => {
    client = postgres(DB_URL, { max: 1 });
    db = brandDialect(drizzle(client), "pg");
    accountId = randomUUID();
    await db.execute(sql`insert into accounts (id, name) values (${accountId}, 'kind-check')`);
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    await db.execute(sql`delete from mailboxes where account_id = ${accountId}`).catch(() => undefined);
    await db.execute(sql`delete from accounts where id = ${accountId}`).catch(() => undefined);
    await client.end({ timeout: 5 });
  });

  /** Insert a mailbox whose holder is of `kind`. Resolves to the driver's SQLSTATE, or null. */
  async function insertKind(kind: string | null): Promise<string | null> {
    const id = randomUUID();
    try {
      await db.execute(sql`
        insert into mailboxes (id, account_id, provider, address, organized_by_kind)
        values (${id}, ${accountId}, 'imap', ${`${id}@kind.test`}, ${kind})`);
      return null;
    } catch (err) {
      return String((err as { code?: unknown }).code ?? "unknown");
    }
  }

  it("accepts every member of ORGANIZER_KINDS, and NULL", async () => {
    for (const kind of ORGANIZER_KINDS) {
      expect(await insertKind(kind), `${kind} must be storable`).toBeNull();
    }
    // NULL is "we cannot say who holds it", which is every row until its first reader cycle.
    expect(await insertKind(null)).toBeNull();
  }, 30_000);

  it("REFUSES what is no kind word — 23514, watched", async () => {
    for (const bad of ["MOBILE", "mobile ", "the phone", "phone@device.test", ""]) {
      expect(await insertKind(bad), `${JSON.stringify(bad)} must be refused`).toBe("23514");
    }
  }, 30_000);

  it("leaves a word that is no member to the write door: the catalog admits it, the door refuses it", async () => {
    // `phone` is the word a person would reach for and it is NOT the kind; `desktop` is the one a
    // reader of the copy would guess. Both have the shape.
    for (const word of ["phone", "desktop"]) {
      expect(await insertKind(word), `${word} fits the shape`).toBeNull();
      expect(() => closedSetValue("mailboxes_organized_by_kind_shape", word), word).toThrow(ClosedSetViolation);
    }
  }, 30_000);

  it("names itself in the refusal, so an operator can find the migration", async () => {
    const id = randomUUID();
    let constraint = "";
    try {
      await db.execute(sql`
        insert into mailboxes (id, account_id, provider, address, organized_by_kind)
        values (${id}, ${accountId}, 'imap', ${`${id}@kind.test`}, 'NOPE')`);
    } catch (err) {
      constraint = String((err as { constraint_name?: unknown; constraint?: unknown }).constraint_name
        ?? (err as { constraint?: unknown }).constraint ?? "");
    }
    expect(constraint).toBe("mailboxes_organized_by_kind_shape");
  }, 30_000);
});
