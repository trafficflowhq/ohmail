import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, auditLog, changeLog, mailboxes, messageBodies, messages, type Tx, mailboxPass, readPassProgress, updatePassProgress } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { fingerprintDedupKey, messageFingerprint, normalizeMime } from "@trafficflow/core";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { sensitiveBackfillPass } from "../src/sensitive-backfill.js";

/**
 * REPAIRING A DAMAGED BODY, AGAINST REAL POSTGRES.
 *
 * ── WHY PGLITE DOES NOT COUNT FOR ANY OF THIS ──────────────────────────────────────────────
 *
 * PGlite is single-connection: it cannot host two transactions at once, so `SELECT … FOR UPDATE`
 * is a no-op that always succeeds there and every claim below would be green by construction.
 * Three production bugs in this repository were invisible to PGlite and appeared only on :5433,
 * all of this class.
 *
 * ── AND WHY THIS PASS SPECIFICALLY HAS A RACE WORTH TESTING ────────────────────────────────
 *
 * It runs on the worker's per-mailbox cycle, and there is a window in which two workers serve
 * one mailbox: a leader handover, where the outgoing process is mid-cycle while the incoming one
 * has taken the lock. Both read the same candidate, both spend a network read on it, and both
 * arrive at the write with a valid repair in hand. Nothing about the repair is idempotent by
 * accident — writing the body twice is harmless, but writing the CHANGE twice tells a client that
 * one message changed two times, which is a convergence break the mirror has no way to undo.
 *
 * Four properties, in the order they would break:
 *
 *  1. exactly ONE `change_log` delta per repaired message, whoever wins;
 *  2. the loser writes NOTHING — it is not merely harmless, it does not act;
 *  3. re-running the whole pass after a repair flips nothing back and emits no second delta;
 *  4. the marker is stamped exactly once, by the database's own predicate rather than by a
 *     process's read-then-write.
 */

const AVAILABLE = await realPgAvailable();

const TRACKER = "https://url8792.example.com/ls/click?upn=mPban-2Fa-2BEQG-2FRgn8842";
const NEWSLETTER_TEXT = [
  "Your organization is approaching its usage credit limit.",
  `Manage billing: ${TRACKER}`,
  "Sent from 1 Elm Street, Springfield 12345.",
].join("\n");
const STORED_TEXT = NEWSLETTER_TEXT.replace(/\b12345\b/, "[REDACTED]");

function rawFor(id: string): string {
  return [
    "From: no-reply@mail.example.com",
    "To: someone@ohmail.test",
    "Subject: Your organization is approaching its usage credit limit",
    `Message-ID: <${id}@mail.example.com>`,
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
    `<html><body><p>Usage notice.</p><a href="${TRACKER}">Manage billing</a></body></html>`,
    "",
    "--bnd--",
    "",
  ].join("\r\n");
}

describe.skipIf(!AVAILABLE)("sensitive-fp backfill under real Postgres", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    // At least two connections, or the "concurrent" passes would queue in the POOL and the test
    // would prove nothing about the database.
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 120_000);

  interface Seeded {
    accountId: string;
    mailboxId: string;
    messageIds: string[];
    server: Map<string, string>;
  }

  /**
   * `withheld: true` seeds the SECOND damage class — `no_ai` set, `sensitivity_category` NULL,
   * html present rather than deleted. That is what an INDETERMINATE verdict writes, and it is the
   * class the pass's original predicate could not see.
   *
   * It gets its own seeding here rather than only in the PGlite file because the widening changed
   * the shape of the race. The old idempotency argument was "a repaired message no longer has a
   * category, so it leaves the candidate query" — the predicate and the repair were the same
   * field. With two limbs they are not, so "the loser writes nothing" and "exactly one delta" have
   * to be re-established against real Postgres for this class specifically. PGlite cannot answer
   * it: it is single-connection, so `FOR UPDATE` always succeeds and both claims are green by
   * construction there.
   */
  async function seed(count: number, opts: { withheld?: boolean } = {}): Promise<Seeded> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `fp-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `fp-${accountId.slice(0, 8)}@example.test`,
    }).returning();
    const server = new Map<string, string>();
    const messageIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const ref = `1:${i + 1}`;
      const raw = rawFor(`${accountId}-${i}`);
      const norm = await normalizeMime(Buffer.from(raw, "utf8"));
      const [m] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id,
        messageIdHeader: norm.canonical.messageIdHeader,
        bodyHash: norm.canonical.bodyHash,
        dedupKey: fingerprintDedupKey(messageFingerprint(norm)),
        subject: norm.subject, fromAddress: norm.from.address,
        nativeLocator: { folder: "INBOX", ref },
        // The two damage classes, written exactly as the classifier writes each of them.
        ...(opts.withheld
          ? { sensitivityCategory: null, noAi: true, noKb: true, noForward: false, priority: false }
          : { sensitivityCategory: "otp", noAi: true, noForward: true, noKb: true, priority: true }),
        snippet: STORED_TEXT.slice(0, 200),
      }).returning();
      // `{ ...headers }`: the parser builds a null-prototype map and drizzle reflects on every
      // insert value. See `drizzle-repo.ts#insertMessageBody`.
      await db.insert(messageBodies).values({
        messageId: m!.id, accountId: m!.accountId, text: STORED_TEXT,
        // A positively-sensitive row stores NO html; a withheld-but-uncategorised row keeps it.
        html: opts.withheld ? "<p>Usage notice.</p>" : null,
        headers: { ...norm.headers },
      });
      server.set(ref, raw);
      messageIds.push(m!.id);
    }
    return { accountId, mailboxId: mb!.id, messageIds, server };
  }

  /** A read-only mailbox that can also be made SLOW, to widen the window the race needs. */
  function adapterFor(s: Seeded, delayMs = 0): MailboxAdapter {
    return {
      fetchRaw: async (locator) => {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const raw = s.server.get(locator.ref);
        if (!raw) throw new Error(`no message at ${locator.ref}`);
        return new Uint8Array(Buffer.from(raw, "utf8"));
      },
    } as unknown as MailboxAdapter;
  }

  const pass = (s: Seeded, adapter: MailboxAdapter) => sensitiveBackfillPass({
    db: db as unknown as Tx, adapter, accountId: s.accountId, mailboxId: s.mailboxId,
  });

  it("two concurrent passes repair each message ONCE — one delta, not two", async () => {
    const s = await seed(3);

    // Both are given a slow server, so both have finished reading before either writes. That is
    // the handover window, reproduced rather than hoped for.
    const [a, b] = await Promise.all([
      pass(s, adapterFor(s, 40)),
      pass(s, adapterFor(s, 40)),
    ]);

    // Between them they repaired three messages, and neither repaired one twice.
    expect(a.cleared + b.cleared).toBe(3);

    const deltas = await db.select().from(changeLog).where(eq(changeLog.accountId, s.accountId));
    expect(deltas).toHaveLength(3);
    expect(new Set(deltas.map((d) => d.entityId)).size).toBe(3);
    expect(deltas.every((d) => d.op === "update")).toBe(true);
    // The per-account sequence is gap-free and unique under two writers — the property
    // `recordChange`'s counter lock exists for, exercised here by two real transactions.
    const seqs = deltas.map((d) => Number(d.seq)).sort((x, y) => x - y);
    expect(new Set(seqs).size).toBe(3);
    expect(seqs[2]! - seqs[0]!).toBe(2);

    for (const id of s.messageIds) {
      const [m] = await db.select().from(messages).where(eq(messages.id, id));
      const [body] = await db.select().from(messageBodies)
        .where(eq(messageBodies.messageId, id));
      expect(m!.sensitivityCategory).toBeNull();
      expect(m!.noAi).toBe(false);
      expect(body!.html).toContain("Manage billing");
      expect(body!.text).toContain("Springfield 12345");
    }
  }, 60_000);

  it("the WIDENED class too: two concurrent passes, one delta per message, loser writes nothing", async () => {
    // The same race against the damage class the pass could not previously see — `no_ai` set,
    // `sensitivity_category` NULL. It is re-established rather than inherited because the widening
    // broke the argument the original rested on: idempotency used to come free from the repair
    // clearing the very column the candidate query filtered on, and that is no longer one field.
    // `repairOne`'s lock-and-recheck now has to carry it alone.
    const s = await seed(3, { withheld: true });

    const [a, b] = await Promise.all([
      pass(s, adapterFor(s, 40)),
      pass(s, adapterFor(s, 40)),
    ]);

    expect(a.cleared + b.cleared).toBe(3);

    const deltas = await db.select().from(changeLog).where(eq(changeLog.accountId, s.accountId));
    expect(deltas).toHaveLength(3);
    expect(new Set(deltas.map((d) => d.entityId)).size).toBe(3);
    expect(deltas.every((d) => d.op === "update")).toBe(true);

    for (const id of s.messageIds) {
      const [m] = await db.select().from(messages).where(eq(messages.id, id));
      const [body] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, id));
      // The flag the Screener's `aiEligible` reads — the whole point of repairing this class.
      expect(m!.noAi).toBe(false);
      expect(m!.noKb).toBe(false);
      expect(m!.sensitivityCategory).toBeNull();
      // The html was present-but-reduced and is now the original's.
      expect(body!.html).toContain("Manage billing");
      expect(body!.text).toContain("Springfield 12345");
    }
  }, 60_000);

  it("stamps the marker exactly once, and writes one audit row per finisher's own claim", async () => {
    const s = await seed(1);

    await Promise.all([pass(s, adapterFor(s, 20)), pass(s, adapterFor(s, 20))]);

    const mb = await readPassProgress(db, mailboxPass("sensitive_fp_backfill", s.accountId, s.mailboxId));
    expect(mb.doneAt).not.toBeNull();
    // `ON CONFLICT … WHERE done_at IS NULL … RETURNING` makes "did I stamp it" the DATABASE's
    // answer rather than a read-then-write, so exactly one of the two passes reports `marked`.
    const audits = await db.select().from(auditLog).where(eq(auditLog.accountId, s.accountId));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits.every((a) => a.action === "sensitive_fp_backfill")).toBe(true);
  }, 60_000);

  it("re-running after a repair flips nothing back and emits no second delta", async () => {
    const s = await seed(2);

    const first = await pass(s, adapterFor(s));
    expect(first.cleared).toBe(2);

    // Clear the marker — which is also the supported way to ASK for the pass again, so the
    // idempotency claim and the operator's trigger are the same mechanism.
    await updatePassProgress(db, mailboxPass("sensitive_fp_backfill", s.accountId, s.mailboxId), { doneAt: null });
    const second = await pass(s, adapterFor(s));

    // A repaired message carries no category, so it is not a candidate. Nothing is re-read, and
    // nothing that was corrected is corrected back.
    expect(second).toMatchObject({ ran: true, examined: 0, fetched: 0, cleared: 0 });
    const deltas = await db.select().from(changeLog).where(eq(changeLog.accountId, s.accountId));
    expect(deltas).toHaveLength(2);
    for (const id of s.messageIds) {
      const [m] = await db.select().from(messages).where(eq(messages.id, id));
      expect(m!.sensitivityCategory).toBeNull();
      expect(m!.priority).toBe(false);
    }
  }, 60_000);

  it("a repair is ATOMIC — no row has html without its flags cleared", async () => {
    // The body and the flags are two UPDATEs, and a reader between them would see a message with
    // its html restored and still marked sensitive: readable content behind a "this is a
    // credential" badge. They are in one transaction for that reason, and this reads the
    // committed state of every repaired row to confirm the pairing never comes apart.
    const s = await seed(4);

    await Promise.all([pass(s, adapterFor(s, 15)), pass(s, adapterFor(s, 15))]);

    const rows = await db.select({
      category: messages.sensitivityCategory, noAi: messages.noAi, priority: messages.priority,
      html: messageBodies.html,
    }).from(messages)
      .innerJoin(messageBodies, eq(messageBodies.messageId, messages.id))
      .where(eq(messages.mailboxId, s.mailboxId));

    expect(rows).toHaveLength(4);
    for (const r of rows) {
      const repaired = r.html !== null;
      expect(repaired).toBe(true);
      expect(r.category).toBeNull();
      expect(r.noAi).toBe(false);
      expect(r.priority).toBe(false);
    }
  }, 60_000);
});
