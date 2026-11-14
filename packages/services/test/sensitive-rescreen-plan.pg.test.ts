
/** The explicit empty trust set - an unlisted provider's mailbox; the auth demotion never fires. */
const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accountSyncState, accounts, auditLog, changeLog, contacts, folderState, mailboxes, messageBodies, messages, passProgress, rules } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runSensitiveRescreen } from "../src/sensitive-rescreen.js";
import type { Db } from "../src/context.js";

/**
 * `plan` IS THE APPLY WITH ITS PAGE WRITES ROLLED BACK, AND THAT IS TESTED HERE.
 *
 * The COMPLETION writes are a different mechanism and the distinction is load-bearing: the
 * completion transaction RUNS for a plan (it holds the mailbox row and asks whether a
 * candidate became eligible again behind the walk — the question that decides whether an apply
 * would stamp), and its durable statements are SKIPPED rather than rolled back. Not reaching
 * the marker is the only shape with no sentinel to get wrong; see `sensitive-rescreen.ts`.
 *
 * ── WHY THIS FILE CANNOT BE A PGLITE TEST ──────────────────────────────────────────────────
 *
 * The whole slice is transactional behaviour, and CLAUDE.md's rule is not a style preference:
 * three production bugs in this repository were invisible to PGlite and appeared only on :5433.
 * What is being claimed — that a real pass runs, writes, and leaves NOTHING durable behind —
 * is a claim about `BEGIN`/`ROLLBACK` under the real driver, the real planner and the real
 * `SELECT … FOR UPDATE`. A green PGlite run would say nothing about any of it.
 *
 * ── THE THREE CLAIMS, IN ASCENDING STRENGTH ────────────────────────────────────────────────
 *
 *  1. **Nothing durable.** An account-scoped digest of every table the pass writes — including
 *     `account_sync_state.next_seq`, because the gap-free sequence is what `/sync` rests on and
 *     a rolled-back `allocateSeq` must leak no gap — is byte-for-byte identical before and after.
 *  2. **The plan PREDICTS the apply.** Stronger than "unchanged", and the actual contract of the
 *     slice: the plan's `{examined, rescreened, kept, truncated, destinations}` must equal the
 *     apply's, run afterwards on the same mailbox. A plan that changes nothing but reports the
 *     wrong numbers is exactly the defect this slice exists to fix.
 *  3. **Idempotency, measured through the plan path.** After an apply, `plan --force` reports
 *     `examined === kept` and zero movers, and the digest is again unchanged.
 *
 * ── EVERY WRITE IS SCOPED TO THIS FILE'S OWN ACCOUNT ───────────────────────────────────────
 *
 * The pg tests share one Postgres. A table-wide `UPDATE` in another test broke the suite by
 * resurrecting dead rows, so every statement below is filtered by an account or mailbox id this
 * file minted, and the digest reads are too — a digest over a whole table would be a flake the
 * moment another file writes concurrently.
 */

const AVAILABLE = await realPgAvailable();
const OHBOX = "INBOX";
const SCREENER = "ohmail/Screener";

interface World { accountId: string; mailboxId: string; address: string }

describe.skipIf(!AVAILABLE)("the plan runs the real pass and rolls it back", () => {
  let db: Db;
  let sql_: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql_ = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql_, { schema }), "pg") as unknown as Db;
  }, 120_000);

  async function newWorld(): Promise<World> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `w1p-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `w1p-${accountId.slice(0, 8)}@example.test`,
    }).returning();
    return { accountId, mailboxId: mb!.id, address: mb!.address };
  }

  async function seedOhbox(w: World, o: {
    from: string; sensitivity?: string | null; headers?: Record<string, string[]>;
    /** An EXPLICIT `messages.id` — the candidate walk orders by it, so a cursor claim needs it. */
    id?: string;
  }): Promise<string> {
    const [m] = await db.insert(messages).values({
      ...(o.id ? { id: o.id } : {}),
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h", dedupKey: `w1p:${randomUUID()}`,
      subject: "Your verification code", fromAddress: o.from,
      sensitivityCategory: o.sensitivity === undefined ? "otp" : o.sensitivity,
      nativeLocator: { folder: OHBOX, ref: `1:${Math.floor(Math.random() * 1e6)}` },
    }).returning();
    await db.insert(messageBodies).values({
      messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: o.headers ?? {},
    });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: OHBOX, observedFolder: OHBOX,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  }

  /**
   * EVERY ROW OF EVERY TABLE THE PASS WRITES, AS TEXT, SCOPED TO ONE ACCOUNT.
   *
   * `to_jsonb(t.*)` and not a column list: the point is byte-for-byte, so a column the pass
   * starts writing later — `updated_at`, a new flag — is compared automatically instead of
   * silently escaping a hand-maintained list. Ordered, because `array_agg` over an unordered
   * scan would make this digest itself a flake.
   */
  async function digest(w: World): Promise<Record<string, string>> {
    const ids = (await db.select({ id: messages.id }).from(messages)
      .where(eq(messages.mailboxId, w.mailboxId))).map((r) => r.id);
    const idList = ids.length
      ? sql`(${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`
      : sql`(null::uuid)`;

    const one = async (label: string, q: ReturnType<typeof sql>): Promise<[string, string]> => {
      const rows = await db.execute(q);
      const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? []) as
        { d: string | null }[];
      return [label, list[0]?.d ?? "∅"];
    };

    return Object.fromEntries(await Promise.all([
      one("folder_state", sql`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as d
        from (select to_jsonb(f.*) from folder_state f where f.message_id in ${idList}) s(t)`),
      one("change_log", sql`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as d
        from (select to_jsonb(c.*) from change_log c where c.account_id = ${w.accountId}::uuid) s(t)`),
      one("audit_log", sql`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as d
        from (select to_jsonb(a.*) from audit_log a where a.account_id = ${w.accountId}::uuid) s(t)`),
      one("mailboxes", sql`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as d
        from (select to_jsonb(m.*) from mailboxes m where m.id = ${w.mailboxId}::uuid) s(t)`),
      one("messages", sql`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as d
        from (select to_jsonb(m.*) from messages m where m.mailbox_id = ${w.mailboxId}::uuid) s(t)`),
      // Where the pass stands: its position, its walk's start and its done mark.
      one("pass_progress", sql`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as d
        from (select to_jsonb(p.*) from pass_progress p where p.account_id = ${w.accountId}::uuid) s(t)`),
      // Named separately AND digested above, because the gap-free `seq` is load-bearing for
      // `/sync` and "the counter did not move" deserves its own assertion rather than being
      // one hash among five.
      one("account_sync_state", sql`select coalesce(max(next_seq)::text, '∅') as d
        from account_sync_state where account_id = ${w.accountId}::uuid`),
    ]));
  }

  /** Where the pass stands for the mailbox; no row reads as every mark empty. */
  async function marksOf(mailboxId: string): Promise<{ at: Date | null; cursor: string | null }> {
    const [r] = await db.select({ at: passProgress.doneAt, cursor: passProgress.cursor }).from(passProgress)
      .where(and(eq(passProgress.job, "sensitive_rescreen"), eq(passProgress.subjectId, mailboxId))).limit(1);
    return r ?? { at: null, cursor: null };
  }

  /** Four movers, two stayers — so neither count can be right by accident. */
  async function seedMixed(w: World): Promise<{ movers: string[]; stayers: string[] }> {
    const movers: string[] = [];
    for (let i = 0; i < 4; i++) movers.push(await seedOhbox(w, { from: `p${i}@stranger.test` }));

    // A known sender's login code STAYS in the Ohbox — the case an "invert the sensitivity rule"
    // implementation gets wrong, and the one a plan reporting zero STAYs would hide.
    await db.insert(contacts).values({ accountId: w.accountId, address: "anna@work.example" });
    const known = await seedOhbox(w, { from: "anna@work.example" });

    // A header rule answers `rule`, not `screener`. `kind: 'header'` names no principal, so it is
    // the one rule shape not already filtered out in SQL and therefore the only one that reaches
    // `evaluateRules`.
    await db.insert(rules).values({
      accountId: w.accountId, kind: "header", match: "x-mailer-tag",
      destination: OHBOX, priority: 10, provenance: "manual", enabled: true,
    });
    const ruled = await seedOhbox(w, {
      from: "bank@allowed.test", headers: { "x-mailer-tag": ["keep"] },
    });

    return { movers, stayers: [known, ruled] };
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  1. NOTHING DURABLE
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("runs the real pass, decides real moves, and leaves the database byte-for-byte unchanged", async () => {
    const w = await newWorld();
    const { movers, stayers } = await seedMixed(w);

    const before = await digest(w);
    const plan = await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, dryRun: true });
    const after = await digest(w);

    // THE PASS DID THE WORK. A "nothing changed" assertion that passes because nothing ran is
    // not a test of anything, so the decision is asserted first and in detail.
    expect(plan).toMatchObject({
      ran: true, examined: 6, rescreened: 4, kept: 2, truncated: false,
    });
    // …and it reports where the movers WOULD go, read back from the `move` changes it wrote
    // inside the transaction — not restated from the SCREENER constant.
    expect(plan.destinations).toEqual({ [SCREENER]: 4 });

    // THE CLAIM. Every table the pass writes, digested per account, identical.
    expect(after).toEqual(before);

    // Spelled out as well as digested, because a digest that silently became '∅' on both sides
    // would compare equal while proving nothing.
    for (const id of [...movers, ...stayers]) {
      const [fs] = await db.select().from(folderState)
        .where(eq(folderState.messageId, id)).limit(1);
      expect(fs!.desiredFolder, `${id} was moved by a PLAN`).toBe(OHBOX);
      expect(fs!.reconcileStatus).toBe("reconciled");
    }
    const moves = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.op, "move")));
    expect(moves, "a plan wrote a durable change_log row").toEqual([]);
    const audits = await db.select().from(auditLog)
      .where(eq(auditLog.accountId, w.accountId));
    expect(audits, "a plan wrote a durable audit_log row").toEqual([]);

    // THE MARKER IS NOT STAMPED AND NOT ATTEMPTED. A plan that marked the mailbox corrected
    // would mean the apply never runs and the misrouted mail stays for ever.
    const mb = await marksOf(w.mailboxId);
    expect(mb!.at).toBeNull();

    // `allocateSeq` ran four times inside rolled-back transactions and left NO gap. A
    // sequence that advanced here would punch a hole every client's `/sync` cursor walks over.
    const [seq] = await db.select().from(accountSyncState)
      .where(eq(accountSyncState.accountId, w.accountId)).limit(1);
    expect(seq?.nextSeq ?? 0n, "a rolled-back allocateSeq leaked a seq gap").toBe(0n);
  });

  it("holds across MORE THAN ONE PAGE — the rollback is per page, so paging is where it could leak", async () => {
    // Six candidates at two rows a page is three pages plus the terminating empty one. The
    // per-page rollback means the cursor is the ONLY thing carrying state between pages, and a
    // pass that re-read a rolled-back row would loop or double-count here rather than silently.
    const w = await newWorld();
    for (let i = 0; i < 6; i++) await seedOhbox(w, { from: `pg${i}@stranger.test` });

    const before = await digest(w);
    const plan = await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, dryRun: true, batch: 2 });

    expect(plan).toMatchObject({ ran: true, examined: 6, rescreened: 6, kept: 0, truncated: false });
    expect(plan.destinations).toEqual({ [SCREENER]: 6 });
    expect(await digest(w)).toEqual(before);
  });

  it("rehearses from the STORED resume point, and leaves it exactly where it found it", async () => {
    // A plan is a rehearsal of the apply that would run NEXT, and after a truncated apply that
    // is a resumed apply. Two ways to get this wrong, and each is a plan that lies:
    //
    //  · start at the beginning ⇒ the plan reports candidates the apply will never look at, and
    //    the operator authorises a number the apply cannot produce;
    //  · advance the stored position ⇒ the REHEARSAL consumes the mailbox. The apply that
    //    follows starts where the plan stopped and the intervening mail is skipped for ever —
    //    a read-only command silently losing mail, which is the worst shape in the file.
    const w = await newWorld();
    const ids = Array.from({ length: 6 }, () => randomUUID()).sort();
    await db.insert(contacts).values({ accountId: w.accountId, address: "known@friend.test" });
    for (let i = 0; i < 4; i++) await seedOhbox(w, { id: ids[i], from: "known@friend.test" });
    for (let i = 4; i < 6; i++) {
      await seedOhbox(w, { id: ids[i], from: `p-${ids[i]!.slice(0, 8)}@stranger.test` });
    }

    // A truncated APPLY over the stayer prefix — this is what stores a resume point.
    const partial = await runSensitiveRescreen({
      db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, batch: 2, maxPages: 2,
    });
    expect(partial).toMatchObject({ examined: 4, rescreened: 0, truncated: true });

    const before = await digest(w);
    const plan = await runSensitiveRescreen({
      db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, dryRun: true,
    });

    // It rehearsed the REMAINDER — two strangers — and said so.
    expect(plan).toMatchObject({
      ran: true, examined: 2, rescreened: 2, kept: 0, truncated: false, resumedFrom: ids[3],
    });
    // …and the mailbox row and the stored position are byte-for-byte what they were.
    expect(await digest(w)).toEqual(before);
    const mb = await marksOf(w.mailboxId);
    expect(mb!.cursor).toBe(ids[3]);
  });

  it("reports a DISTURBED walk exactly as the apply would, and clears nothing", async () => {
    // THE CONTRACT, AT THE ONE POINT IT IS EASIEST TO BREAK. The apply refuses its completion
    // marker when a candidate has become eligible again behind the walk. A plan that skipped that
    // check would report a clean finish for a walk the apply is going to refuse — the operator
    // authorises on numbers the apply cannot produce, which is the single failure the plan exists
    // to make impossible. And a plan that RAN the check and also ran its cleanup would consume
    // the mailbox: the apply that follows would start from the beginning because the rehearsal
    // threw the position away.
    const w = await newWorld();
    const ids = Array.from({ length: 4 }, () => randomUUID()).sort();
    for (const id of ids) await seedOhbox(w, { id, from: `d-${id.slice(0, 8)}@stranger.test` });

    // A truncated APPLY stores a position and an epoch…
    const partial = await runSensitiveRescreen({
      db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, batch: 2, maxPages: 1,
    });
    expect(partial).toMatchObject({ examined: 2, truncated: true });

    // …then the reconciler completes a move it began earlier, restoring an older intent behind
    // the walk.
    // `db.execute(sql\`…\`)` and NOT a bare tagged template: in THIS file `sql` is drizzle's
    // fragment builder, not a database client, so `await sql\`update …\`` builds a fragment,
    // executes nothing, resolves, and leaves the mailbox untouched — a restoration that never
    // happened, and a case that passes for the wrong reason. It did exactly that on the first
    // draft here.
    await db.execute(sql`update folder_state
                 set desired_folder = 'INBOX', last_set_by = 'us',
                     reconcile_status = 'reconciled', updated_at = now()
               where message_id = ${ids[0]!}::uuid`);

    const before = await digest(w);
    const plan = await runSensitiveRescreen({
      db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, dryRun: true,
    });
    expect(plan).toMatchObject({ ran: true, truncated: true, stoppedBecause: "disturbed" });
    // NOTHING durable — the position and the epoch are exactly where the plan found them.
    expect(await digest(w)).toEqual(before);

    // …and the apply it rehearsed says the same thing, then acts on it.
    const apply = await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId });
    // EVERY REPORTED FIELD, not just the reason: a plan that got the reason right and the counts
    // wrong is still a plan the operator cannot authorise on, which is this file's whole subject.
    expect(apply).toEqual(plan);
    const mb = await marksOf(w.mailboxId);
    expect(mb!.at, "a disturbed apply stamped the marker").toBeNull();
    expect(mb!.cursor, "a disturbed apply kept its position").toBeNull();
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  2. THE PLAN PREDICTS THE APPLY — the contract of the slice
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("reports exactly what the apply then does", async () => {
    const w = await newWorld();
    const { movers, stayers } = await seedMixed(w);

    const plan = await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, dryRun: true });
    const apply = await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId });

    // THE WHOLE POINT. Not "the plan is plausible" — the plan's numbers ARE the apply's.
    expect({
      examined: plan.examined, rescreened: plan.rescreened, kept: plan.kept,
      truncated: plan.truncated, destinations: plan.destinations,
    }).toEqual({
      examined: apply.examined, rescreened: apply.rescreened, kept: apply.kept,
      truncated: apply.truncated, destinations: apply.destinations,
    });

    // …and the apply's writes match the destination the plan named, on the rows themselves.
    for (const id of movers) {
      const [fs] = await db.select().from(folderState)
        .where(eq(folderState.messageId, id)).limit(1);
      expect(fs!.desiredFolder).toBe(SCREENER);
      expect(fs!.reconcileStatus).toBe("pending");
    }
    for (const id of stayers) {
      const [fs] = await db.select().from(folderState)
        .where(eq(folderState.messageId, id)).limit(1);
      expect(fs!.desiredFolder).toBe(OHBOX);
    }
    const moved = await db.select().from(changeLog).where(and(
      eq(changeLog.accountId, w.accountId), eq(changeLog.op, "move"),
    )).orderBy(asc(changeLog.seq));
    expect(moved.map((m) => m.entityId).sort()).toEqual([...movers].sort());

    // The sequence is contiguous from 1 — the plan's four rolled-back allocations left no hole
    // for the apply's to start after.
    expect(moved.map((m) => Number(m.seq))).toEqual([1, 2, 3, 4]);
  });

  it("the destination breakdown comes from the rows, not from a constant", async () => {
    // If `destinations` were derived from the SCREENER constant it would be right here by
    // construction and could never be wrong. Read it back independently from `change_log` after
    // an APPLY and require the two to agree — that is what makes the plan's copy evidence.
    const w = await newWorld();
    const { movers } = await seedMixed(w);

    const plan = await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, dryRun: true });
    await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId });

    const rows = await db.select({ meta: changeLog.meta }).from(changeLog).where(and(
      eq(changeLog.accountId, w.accountId), eq(changeLog.op, "move"),
      inArray(changeLog.entityId, movers),
    ));
    const fromDb: Record<string, number> = {};
    for (const r of rows) {
      const to = (r.meta as { to?: string } | null)?.to ?? "(none)";
      fromDb[to] = (fromDb[to] ?? 0) + 1;
    }
    expect(plan.destinations).toEqual(fromDb);
    // The sum the CLI cross-checks against, asserted here so the CLI's warning has a meaning.
    expect(Object.values(plan.destinations).reduce((a, n) => a + n, 0)).toBe(plan.rescreened);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  3. IDEMPOTENCY, THROUGH THE PLAN PATH
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("a plan over a mailbox already applied reports every candidate STAYING, and still writes nothing", async () => {
    const w = await newWorld();
    await seedMixed(w);
    await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId });

    // Without `--force` the marker short-circuits, exactly as it does for an apply — so the
    // plan tells the operator "this would be skipped" rather than "there is nothing to move".
    const skipped = await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: w.mailboxId, dryRun: true });
    expect(skipped).toEqual({
      ran: false, examined: 0, rescreened: 0, kept: 0, truncated: false, destinations: {},
      resumedFrom: null, stoppedBecause: null,
    });

    const before = await digest(w);
    const forced = await runSensitiveRescreen({ trustedAuthservIdsFor: NONE,      db, mailboxId: w.mailboxId, dryRun: true, force: true,
    });
    // The moved rows are no longer candidates; the two stayers still are, and still stay.
    expect(forced).toMatchObject({ ran: true, rescreened: 0, truncated: false });
    expect(forced.examined).toBe(forced.kept);
    expect(forced.destinations).toEqual({});
    expect(await digest(w)).toEqual(before);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  4. SCOPE
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("a plan touches no other mailbox and no other account", async () => {
    const mine = await newWorld();
    const theirs = await newWorld();
    await seedOhbox(mine, { from: "x@stranger.test" });
    await seedOhbox(theirs, { from: "x@stranger.test" });

    const before = await digest(theirs);
    await runSensitiveRescreen({ db, trustedAuthservIdsFor: NONE, mailboxId: mine.mailboxId, dryRun: true });
    expect(await digest(theirs)).toEqual(before);
  });
});
