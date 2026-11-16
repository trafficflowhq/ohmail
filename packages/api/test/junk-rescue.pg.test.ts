import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  accounts, accountSettings, contacts, junkRescues, mailboxes, rules as rulesTbl,
} from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { dbFor } from "@trafficflow/services/mail";
import { dismissJunkRescue, rescueJunk } from "../src/junk-window.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * THE JUNK RESCUE'S COMMAND, ON REAL POSTGRES — the four things PGlite cannot answer for it.
 *
 *  1. THE ONE TRANSACTION. The allow, the `junk_rescues` row and the doorbell commit together
 *     through `withAccountTx`, which is `fencedAccountWrite` — a real `BEGIN` with a real row lock.
 *     PGlite is a single in-process store and greens a transactional claim by construction; three
 *     production defects at this seam were invisible to it.
 *  2. THE UNIQUE UPSERT UNDER A DOUBLE PRESS. `ON CONFLICT (mailbox_id, folder, uidvalidity, uid)`
 *     is resolved by the INDEX, and two presses racing meet on it: one inserts, the other blocks
 *     and then updates. One command per locator or two moves for one message.
 *  3. `bigint` BINDING. `uidvalidity` is a 64-bit column and postgres@3 and PGlite disagree about
 *     parameter serialization. A UIDVALIDITY at the protocol's ceiling must come back as the same
 *     decimal string the epoch guard compares, through postgres@3's own encoder — the column is
 *     64-bit to match `message_failures.uidvalidity` rather than because the value can exceed the
 *     range, so what is asserted here is the ROUND TRIP and not the low-bit property.
 *  4. THE DUE PREDICATE'S `timestamptz`. `dueNow` compares `next_attempt_at` against an instant the
 *     application clock chose, and a deferred row must be invisible to the pass until it passes.
 *  5. CLEARING A REFUSED COMMAND is a compare-and-set inside the fence: a re-press landing between
 *     the read and the delete keeps its command.
 *
 * Runs on the LANE DATABASE (`scripts/lane-db.sh`), never the shared box — `realPgAvailable`
 * refuses that one unless `OHMAIL_FREEZE=1`. Every row this file writes is scoped to its own
 * account, and the reads are scoped the same way, so a co-tenant suite cannot move a reading here.
 */

const AVAILABLE = await realPgAvailable();
const NOW = new Date("2026-08-24T12:00:00.000Z");
const JUNK_PATH = "INBOX/Spamverdacht";

describe.skipIf(!AVAILABLE)("the junk rescue's command on real Postgres", () => {
  let owned: OwnedDb;
  let db: OwnedDb["db"];

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
    db = owned.db;
  }, 180_000);

  afterAll(async () => { await owned?.close().catch(() => {}); });

  async function world(over: { junkFolder?: string } = {}) {
    const [acct] = await db.insert(accounts).values({ name: `jr-${randomUUID().slice(0, 8)}` }).returning();
    const accountId = acct!.id;
    await db.insert(accountSettings).values({ accountId, foldersEnabledAt: NOW });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `jr-${randomUUID().slice(0, 8)}@example.invalid`,
      junkFolder: over.junkFolder ?? JUNK_PATH,
    }).returning({ id: mailboxes.id });
    const deps = { db, now: () => NOW } as unknown as ApiDeps;
    const ctx = { accountId, db: dbFor(db, accountId), now: () => NOW } as unknown as Parameters<typeof rescueJunk>[1];
    return { deps, ctx, accountId, mailboxId: mb!.id };
  }

  const rowsOf = (accountId: string) =>
    db.select().from(junkRescues).where(eq(junkRescues.accountId, accountId));

  it("commits the allow, the command and the doorbell as ONE transaction", async () => {
    const w = await world();
    const out = await rescueJunk(w.deps, w.ctx, {
      mailboxId: w.mailboxId, uid: 42, uidValidity: "7",
      allow: { sender: "Spammer@Example.invalid" },
    });
    expect(out.status).toBe("queued");

    const rows = await rowsOf(w.accountId);
    expect(rows).toHaveLength(1);
    const [rule] = await db.select({ destination: rulesTbl.destination, enabled: rulesTbl.enabled })
      .from(rulesTbl).where(eq(rulesTbl.accountId, w.accountId));
    expect(rule).toEqual({ destination: "INBOX", enabled: true });
    const [known] = await db.select({ address: contacts.address }).from(contacts)
      .where(eq(contacts.accountId, w.accountId));
    expect(known!.address).toBe("spammer@example.invalid");
    const [mb] = await db.select({ at: mailboxes.syncRequestedAt }).from(mailboxes)
      .where(eq(mailboxes.id, w.mailboxId));
    expect(mb!.at?.toISOString()).toBe(NOW.toISOString());
  });

  it("a failure inside the transaction rolls BOTH halves back", async () => {
    // The interrupt is a real one and not a double: a trigger scoped to this case's account makes
    // the server raise 22003 at the `junk_rescues` INSERT — after the allow has written its rows —
    // which is the shape an interrupted request takes. (It used to be a uid above 2^31 overflowing
    // an `integer` column; mail 0131 made that uid storable.)
    const w = await world();
    const fn = `jr_interrupt_${w.accountId.replace(/-/g, "").slice(0, 12)}`;
    await db.execute(sql.raw(`create function ${fn}() returns trigger language plpgsql as $$
      begin raise exception 'interrupted after the allow' using errcode = '22003'; end $$`));
    await db.execute(sql.raw(`create trigger ${fn} before insert on junk_rescues for each row
      when (new.account_id = '${w.accountId}') execute function ${fn}()`));
    try {
      await expect(rescueJunk(w.deps, w.ctx, {
        mailboxId: w.mailboxId, uid: 9, uidValidity: "7",
        allow: { sender: "spammer@example.invalid" },
      })).rejects.toThrow(/interrupted after the allow/);
    } finally {
      await db.execute(sql.raw(`drop trigger if exists ${fn} on junk_rescues`));
      await db.execute(sql.raw(`drop function if exists ${fn}()`));
    }
    expect(await rowsOf(w.accountId)).toEqual([]);
    expect(await db.select().from(rulesTbl).where(eq(rulesTbl.accountId, w.accountId))).toEqual([]);
    expect(await db.select().from(contacts).where(eq(contacts.accountId, w.accountId))).toEqual([]);
  });

  it("a uid above 2^31 is recorded — the door admits the whole u32 range and so does the column", async () => {
    // RFC 3501 makes a UID an unsigned 32-bit integer and `requireImapUint32` admits exactly that
    // range; until mail 0131 the column was `integer` and this press answered 22003.
    const w = await world();
    await rescueJunk(w.deps, w.ctx, { mailboxId: w.mailboxId, uid: 2_147_483_648, uidValidity: "7" });
    await rescueJunk(w.deps, w.ctx, { mailboxId: w.mailboxId, uid: 4_294_967_295, uidValidity: "7" });
    const rows = await rowsOf(w.accountId);
    expect(rows.map((r) => r.uid).sort((a, b) => a - b)).toEqual([2_147_483_648, 4_294_967_295]);
    const pending = await makeDrizzleRepo(db as never).listPendingJunkRescues(w.mailboxId);
    expect(pending.map((p) => p.uid).sort((a, b) => a - b)).toEqual([2_147_483_648, 4_294_967_295]);
    await db.delete(junkRescues).where(eq(junkRescues.accountId, w.accountId));
  });

  it("TWO CONCURRENT PRESSES on one row meet on the UNIQUE — one command, never two moves", async () => {
    const w = await world();
    const press = () => rescueJunk(w.deps, w.ctx, { mailboxId: w.mailboxId, uid: 9, uidValidity: "7" });
    const [a, b] = await Promise.all([press(), press()]);
    expect(a.rescueId).toBe(b.rescueId);
    expect(await rowsOf(w.accountId)).toHaveLength(1);
  });

  it("a UIDVALIDITY at the protocol's ceiling survives the round trip exactly", async () => {
    // 4294967295 is the ceiling RFC 3501 sets and an ordinary value for a mail server. It is read
    // back through the WORKER's own projection as well, because that is where it is compared.
    const w = await world();
    const epoch = "4294967295";
    await rescueJunk(w.deps, w.ctx, { mailboxId: w.mailboxId, uid: 1, uidValidity: epoch });
    const [row] = await rowsOf(w.accountId);
    expect(String(row!.uidvalidity)).toBe(epoch);
    // …and read back through the WORKER's own projection, which is where it is compared.
    const repo = makeDrizzleRepo(db as never);
    const pending = await repo.listPendingJunkRescues(w.mailboxId);
    expect(pending.map((p) => p.uidValidity)).toEqual([epoch]);
  });

  it("a DEFERRED row is invisible to the pass until its instant passes", async () => {
    const w = await world();
    const out = await rescueJunk(w.deps, w.ctx, { mailboxId: w.mailboxId, uid: 5, uidValidity: "7" });
    const repo = makeDrizzleRepo(db as never);
    expect((await repo.listPendingJunkRescues(w.mailboxId)).map((p) => p.uid)).toEqual([5]);

    // Deferred an hour: `dueNow` is `next_attempt_at IS NULL OR <= now`, compared as timestamptz.
    await repo.deferJunkRescue(out.rescueId, 1, new Date(Date.now() + 3_600_000), "read_only");
    expect(await repo.listPendingJunkRescues(w.mailboxId)).toEqual([]);

    // …and it comes back when the instant has passed. Written as a past timestamptz through the
    // repo's own door, so the binding under test is the shipped one.
    await repo.deferJunkRescue(out.rescueId, 2, new Date(Date.now() - 60_000), "read_only");
    const due = await repo.listPendingJunkRescues(w.mailboxId);
    expect(due.map((p) => ({ uid: p.uid, attempts: p.attempts }))).toEqual([{ uid: 5, attempts: 2 }]);
  });

  it("a mailbox switched OFF under Use folders is carried on the pass's OWN read", async () => {
    // The pass must not need a second query for it — the join is already there. Postgres because
    // the predicate is a LEFT-of-NULL comparison on a column the join brings in.
    const w = await world();
    await rescueJunk(w.deps, w.ctx, { mailboxId: w.mailboxId, uid: 3, uidValidity: "7" });
    const repo = makeDrizzleRepo(db as never);
    expect((await repo.listPendingJunkRescues(w.mailboxId))[0]!.foldersOff).toBe(false);
    await db.update(mailboxes).set({ foldersDisabledAt: NOW }).where(eq(mailboxes.id, w.mailboxId));
    expect((await repo.listPendingJunkRescues(w.mailboxId))[0]!.foldersOff).toBe(true);
  });

  it("the partial index the migration created is the one the due read can use", async () => {
    // `drizzle`'s `index()` has no partial form, so this index exists ONLY in the migration — the
    // one shape a schema-twin comparison cannot see. Read from the catalog rather than assumed.
    const rows = await db.execute(sql`
      select indexdef from pg_indexes
       where schemaname = 'public' and tablename = 'junk_rescues'
         and indexname = 'junk_rescues_due_idx'`);
    const defs = (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows) as Array<{ indexdef: string }>;
    expect(defs).toHaveLength(1);
    expect(defs[0]!.indexdef).toContain("mailbox_id");
    expect(defs[0]!.indexdef).toContain("next_attempt_at");
    expect(defs[0]!.indexdef.toLowerCase()).toContain("where (status = 'pending'");
  });

  const refuse = async (w: Awaited<ReturnType<typeof world>>, uid: number): Promise<string> => {
    const out = await rescueJunk(w.deps, w.ctx, { mailboxId: w.mailboxId, uid, uidValidity: "7" });
    await db.update(junkRescues).set({ status: "refused", attempts: 5 })
      .where(and(eq(junkRescues.id, out.rescueId), eq(junkRescues.accountId, w.accountId)));
    return out.rescueId;
  };

  it("clears a refused command, and only that one", async () => {
    const w = await world();
    const cleared = await refuse(w, 21);
    const kept = await refuse(w, 22);
    expect(await dismissJunkRescue(w.deps, w.ctx, cleared)).toEqual({ dismissed: true });
    expect((await rowsOf(w.accountId)).map((r) => r.id)).toEqual([kept]);
  });

  it("a re-press between the read and the delete keeps its command", async () => {
    const w = await world();
    const id = await refuse(w, 23);
    // The re-press lands as the dismissal opens its transaction, after it read the row as refused.
    // The request's one handle is the context's, bound to the account: the transaction opens on it.
    const racing = new Proxy(w.ctx.db, {
      get(target, key, receiver) {
        if (key === "transaction") {
          return async (...args: unknown[]) => {
            await rescueJunk(w.deps, w.ctx, { mailboxId: w.mailboxId, uid: 23, uidValidity: "7" });
            return (target.transaction as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          };
        }
        const v = Reflect.get(target, key, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const deps = { db: racing, now: () => NOW } as unknown as ApiDeps;
    await expect(dismissJunkRescue(deps, { ...w.ctx, db: racing }, id)).rejects.toMatchObject({ httpStatus: 409 });
    const [row] = await rowsOf(w.accountId);
    expect(row!.status).toBe("pending");
  });

  it("the status CHECK refuses a word outside the closed set", async () => {
    const w = await world();
    const out = await rescueJunk(w.deps, w.ctx, { mailboxId: w.mailboxId, uid: 8, uidValidity: "7" });
    await expect(
      db.update(junkRescues).set({ status: "done" }).where(eq(junkRescues.id, out.rescueId)),
    ).rejects.toThrow();
    const [row] = await db.select({ status: junkRescues.status }).from(junkRescues)
      .where(and(eq(junkRescues.id, out.rescueId), eq(junkRescues.accountId, w.accountId)));
    expect(row!.status).toBe("pending");
  });
});
