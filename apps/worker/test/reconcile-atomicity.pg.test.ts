import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, asc, eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, mailboxes, messages, messageInstances, folderState, flagState, auditLog,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { NativeLocator } from "@trafficflow/core";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { reconcileMailbox } from "../src/sync.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * ═══ THE TORN MOVE COMPLETION, AND THE ONE MUTATION THAT POISONED THE QUEUE ═════════
 *
 * Two failure shapes, one file, because they are the two halves of the same finding and each
 * one's fix is only safe in the presence of the other's.
 *
 * ── SHAPE B: THE COMPLETION WAS THREE SEPARATE STATEMENTS ───────────────────────────────────
 *
 * A successful IMAP move is followed by three database writes — the new locator (itself two
 * statements: `messages.native_locator` and the primary `message_instances` row), the converged
 * `folder_state`, and the audit row carrying the inverse. Under the leader fence those already
 * committed together, because the fence IS a transaction. Everywhere else — the reconcile cron,
 * and the desktop engine, which is every LOCAL install of this product — they were three top-level
 * awaits, and a crash or a failed statement between any two of them left a state that is neither
 * before nor after:
 *
 *   · locator written, `folder_state` not ⇒ the row still says `observed = INBOX`, `pending`,
 *     while `native_locator` already names the DESTINATION. The next pass reads that row and asks
 *     the server to move a message from the folder it is already in. A host that refuses a
 *     same-folder MOVE turns it into a permanently stuck row — feeding shape A — and one that
 *     accepts it churns the UID for nothing.
 *   · `folder_state` written, audit row not ⇒ the mail moved and the account's history does not
 *     say so; the inverse the admin surface offers to undo it is that row's `inverse`, so there is
 *     no undo and no record the message ever left.
 *
 * **Neither half is visible afterwards.** Both are individually valid rows: nothing throws, no
 * constraint fires, the mailbox reports healthy. That is exactly why this file exists and why it
 * cannot be a unit test — a stub repo answers `listPendingFolderStates` from a literal and would
 * report the same rows after the crash as before it, whatever the writes did. The question is what
 * is ON DISK, and PGlite is not evidence for it either (CLAUDE.md: three production defects were
 * invisible to PGlite, and every one of them was transactional).
 *
 * ── SHAPE A: ONE REFUSED MUTATION POISONED EVERYTHING BEHIND IT ─────────────────────────────
 *
 * The flag pass rethrew every refusal, which failed the whole cycle. The folder pass isolated the
 * item but retried it on every cycle for ever — and because `listPendingFolderStates` is ordered
 * OLDEST FIRST under a fixed per-cycle budget, a permanently refused row is by construction one of
 * the oldest and sits at the head of that budget every cycle. Accumulate enough and the reconciler
 * spends its whole allowance re-refusing old rows while today's filing never reaches the server.
 * That is head-of-line blocking by BUDGET, invisible in the control flow, and unreachable from any
 * `try`/`catch` — the pending QUERY has to be able to skip the row.
 *
 * ── HOW THE CRASH IS INJECTED, AND WHY BOTH INSTRUMENTS ARE HERE ────────────────────────────
 *
 * {@link diesAfter} throws immediately after a chosen statement, inside the group. The database
 * cannot tell that from a caller that failed, so it rolls back — which is the property under test:
 * BEFORE the fix, the same throw left the preceding statements committed, because there was no
 * transaction to roll back.
 *
 * That instrument alone would be a claim about our own control flow, so a second one answers the
 * question from OUTSIDE: {@link observedMidGroup} reads the row from an independent session while
 * the group is still open. A `try`/`catch` can be made to look atomic to the caller that threw; it
 * cannot hide an already-committed statement from another connection. With the pre-fix shape that
 * look returns the DESTINATION locator beside an INBOX `folder_state` — the torn state caught in
 * the act rather than inferred afterwards.
 *
 * A third instrument was tried and removed: `pg_terminate_backend` on the group's own backend
 * mid-transaction. The database behaves correctly (an un-committed transaction dies with its
 * session, which is Postgres's guarantee and not this code's), but postgres.js@3.4.9 never settles
 * the promise for the statement in flight — it faults internally with `Cannot read properties of
 * null (reading 'write')` and the test hangs to its timeout. A guard that cannot report its own
 * result is not a guard, and the two instruments above answer the question that is actually about
 * this repository's code.
 *
 * ── THE DISTINCTION THE FIRST VERSION OF THE FIX GOT WRONG ──────────────────────────────────
 *
 * A refused MUTATION and a failed COMPLETION arrive at the same catch and mean opposite things. A
 * refusal means nothing happened and we still owe it — that earns the deferral. A failed
 * completion means the server ALREADY MOVED THE MAIL and only our record of it failed, so the
 * database and the mailbox disagree at that instant; deferring would hold the disagreement open
 * for the length of the backoff, and recording `reconcile.move.failed` would assert that a move
 * which succeeded was refused. So the completion is never deferred, and the tests below assert
 * `attempts = 0` and a NULL `next_attempt_at` after every crash.
 *
 * ── MUTATIONS WATCHED (each restored) ───────────────────────────────────────────────────────
 *
 *  · `fencedGroup` → `fencedWrite` in `fileOne` (the pre-fix shape) ⇒ every "nothing was written"
 *    test red, with the locator or the folder-state row committed on its own;
 *  · restore the `throw err` in `reconcileFlags`'s catch ⇒ the flag-queue test red, the two
 *    healthy flags unwritten, and `reconcileMailbox` rejecting;
 *  · drop `deferFolderReconcile` from the failure arm ⇒ the budget test red, because the refused
 *    row is offered again on the next cycle;
 *  · drop the `dueNow` predicate from `listPendingFolderStates` ⇒ same test red for the same
 *    reason, one layer down;
 *  · drop `attempts: 0, nextAttemptAt: null` from `completeFolderState` ⇒ the fresh-intent test red,
 *    with the user's new move still asleep.
 */

const AVAILABLE = await realPgAvailable();
const LOC = (folder: string, ref: string): NativeLocator => ({ folder, ref });
const DEST = "ohmail/News";

/** The three seams inside the post-MOVE write group, named as the repo methods that close them. */
type Seam = "updateLocator" | "completeFolderState" | "recordAudit";

describe.skipIf(!AVAILABLE)("the move completion is atomic and one refusal is contained", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 60_000);

  afterAll(async () => { await sql?.end({ timeout: 5 }); });

  /**
   * An account with `n` messages in INBOX, each filed by us into {@link DEST} and awaiting the
   * physical move — what a screening session leaves behind.
   */
  async function seed(n: number, opts: { flags?: boolean } = {}): Promise<{
    accountId: string; mailboxId: string; ids: string[];
  }> {
    const accountId = randomUUID();
    const tag = accountId.slice(0, 8);
    await db.insert(accounts).values({ id: accountId, name: `at-${tag}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `at-${tag}@example.test`, status: "connected",
    }).returning();
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const [m] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id,
        dedupKey: `mid:<at-${tag}-${i}@example.test>`,
        messageIdHeader: `at-${tag}-${i}@example.test`,
        fromAddress: "stranger@example.test", subject: `s${i}`,
        date: new Date("2026-08-13T12:00:00.000Z"),
        bodyHash: `at-hash-${tag}-${i}`,
        nativeLocator: LOC("INBOX", `1:${200 + i}`),
      }).returning();
      ids.push(m!.id);
      // The PRIMARY instance — the physical copy in the source folder, and what a duplicate would
      // appear beside. Without `isPrimary`, `setPrimaryInstance` finds no primary to move and
      // INSERTS one, which looks exactly like a duplicate produced by the code under test.
      await db.insert(messageInstances).values({
        accountId, messageId: m!.id, mailboxId: mb!.id, folder: "INBOX", uid: 200 + i,
        uidvalidity: 1n, isPrimary: true,
      });
      await db.insert(folderState).values({
        messageId: m!.id, accountId: m!.accountId, desiredFolder: DEST, observedFolder: "INBOX",
        reconcileStatus: "pending", lastSetBy: "us",
        // Oldest-first ordering is the queue, so the fixture pins it rather than relying on
        // insertion order: message 0 is the head, and it is the one the poison tests refuse.
        updatedAt: new Date(Date.UTC(2026, 7, 13, 0, i)),
      });
      if (opts.flags) {
        await db.insert(flagState).values({
          messageId: m!.id, accountId: m!.accountId, desiredSeen: true, observedSeen: false,
          reconcileStatus: "pending", lastSetBy: "us",
        });
      }
    }
    return { accountId, mailboxId: mb!.id, ids };
  }

  /** A host that performs every move it is asked for, recording each one. */
  function healthyHost(): { adapter: MailboxAdapter; moves: string[] } {
    const moves: string[] = [];
    const adapter = {
      move: async (locator: NativeLocator, toFolder: string): Promise<NativeLocator> => {
        moves.push(`${locator.folder}/${locator.ref}→${toFolder}`);
        return LOC(toFolder, locator.ref.replace(/^\d+:/, "7:"));
      },
      setFlags: async () => {},
    } as unknown as MailboxAdapter;
    return { adapter, moves };
  }

  /**
   * A host that REFUSES one specific locator and performs every other mutation.
   *
   * The refusal is a plain `Error` with no `code`, which is what a server-side `NO` reaches us as:
   * deterministic, about this one mutation, and — critically — NOT the transport class, which is
   * left due on purpose so an outage never defers a whole queue.
   */
  function hostRefusing(ref: string): { adapter: MailboxAdapter; moves: string[]; stores: string[] } {
    const moves: string[] = [];
    const stores: string[] = [];
    const adapter = {
      move: async (locator: NativeLocator, toFolder: string): Promise<NativeLocator> => {
        if (locator.ref === ref) throw new Error("NO [CANNOT] EXPUNGE refused for this message");
        moves.push(`${locator.folder}/${locator.ref}→${toFolder}`);
        return LOC(toFolder, locator.ref.replace(/^\d+:/, "7:"));
      },
      setFlags: async (locator: NativeLocator) => {
        if (locator.ref === ref) throw new Error("NO [CANNOT] mailbox is read-only");
        stores.push(locator.ref);
      },
    } as unknown as MailboxAdapter;
    return { adapter, moves, stores };
  }

  /**
   * The real repo, wrapped so the write group dies immediately AFTER `seam` completes.
   *
   * The interception is on `transaction` alone: that is the only door into the group, so a wrapper
   * here cannot accidentally change what happens outside it. Inside, the tx-scoped repo the group
   * receives is proxied — every method passes through untouched except `seam`, which performs its
   * real statement and then throws, standing in for the process dying one instruction later.
   */
  function diesAfter(seam: Seam): WorkerRepo {
    const real = makeDrizzleRepo(db as never) as unknown as WorkerRepo;
    return new Proxy(real, {
      get(target, prop, recv) {
        if (prop !== "transaction") return Reflect.get(target, prop, recv);
        return async <T>(fn: (r: WorkerRepo) => Promise<T>): Promise<T> =>
          real.transaction(async (tx) => {
            const killer = new Proxy(tx as unknown as WorkerRepo, {
              get(t, p, r) {
                const v = Reflect.get(t, p, r);
                if (p !== seam || typeof v !== "function") return v;
                return async (...args: unknown[]) => {
                  await (v as (...a: unknown[]) => Promise<unknown>).apply(t, args);
                  throw new Error(`crash immediately after ${seam}`);
                };
              },
            });
            return fn(killer);
          }) as Promise<T>;
      },
    }) as WorkerRepo;
  }

  /**
   * The real repo, wrapped so that after `seam` a SECOND, independent session reads the row and
   * hands back what it can see while the group is still open.
   *
   * This is the instrument that cannot be satisfied by anything except a real transaction. A
   * `try`/`catch` can be made to look atomic to the caller that threw; it cannot make its
   * already-committed statements invisible to somebody else's connection. Under READ COMMITTED an
   * outside reader sees the PRE-group values until the group commits — and with the pre-fix
   * three-top-level-awaits shape it would see the new locator immediately, because that statement
   * had already committed on its own.
   */
  function observedMidGroup(seam: Seam, seen: Array<{ locator: string; observed: string }>): WorkerRepo {
    const real = makeDrizzleRepo(db as never) as unknown as WorkerRepo;
    return new Proxy(real, {
      get(target, prop, recv) {
        if (prop !== "transaction") return Reflect.get(target, prop, recv);
        return async <T>(fn: (r: WorkerRepo) => Promise<T>): Promise<T> =>
          real.transaction(async (tx) => {
            const watcher = new Proxy(tx as unknown as WorkerRepo, {
              get(t, p, r) {
                const v = Reflect.get(t, p, r);
                if (p !== seam || typeof v !== "function") return v;
                return async (...args: unknown[]) => {
                  const out = await (v as (...a: unknown[]) => Promise<unknown>).apply(t, args);
                  // THE OUTSIDE LOOK — a different session on the shared pool, mid-transaction.
                  const rows = await sql`
                    SELECT m.native_locator ->> 'folder' AS locator, fs.observed_folder AS observed
                    FROM folder_state fs JOIN messages m ON m.id = fs.message_id
                    WHERE fs.message_id = ${args[0] as string}`;
                  seen.push({ locator: String(rows[0]!.locator), observed: String(rows[0]!.observed) });
                  return out;
                };
              },
            });
            return fn(watcher);
          }) as Promise<T>;
      },
    }) as WorkerRepo;
  }

  // ── Readers, all from the SHARED connection, so nothing is read out of the crashed session ──

  const pendingOf = async (mailboxId: string) =>
    db.select({ messageId: folderState.messageId, observed: folderState.observedFolder, attempts: folderState.attempts, nextAttemptAt: folderState.nextAttemptAt })
      .from(folderState).innerJoin(messages, eq(messages.id, folderState.messageId))
      .where(and(eq(messages.mailboxId, mailboxId), eq(folderState.reconcileStatus, "pending")))
      .orderBy(asc(folderState.updatedAt));

  const stateOf = async (messageId: string) =>
    (await db.select().from(folderState).where(eq(folderState.messageId, messageId)))[0]!;

  const locatorOf = async (messageId: string) =>
    (await db.select({ loc: messages.nativeLocator }).from(messages).where(eq(messages.id, messageId)))[0]!.loc as NativeLocator;

  const instancesOf = async (messageId: string) =>
    db.select().from(messageInstances).where(eq(messageInstances.messageId, messageId));

  const auditsOf = async (accountId: string, action: string) =>
    db.select().from(auditLog).where(and(eq(auditLog.accountId, accountId), eq(auditLog.action, action)));

  // ══ SHAPE B — the completion is one fact ═══════════════════════════════════════════════════

  // THE SEAM NAMES ARE THE METHODS THE COMPLETION ACTUALLY CALLS, and keeping them so is not
  // housekeeping. This list read `upsertFolderState` until the completion moved to the
  // conditional write (`WorkerRepo.completeFolderState`, the compare-and-set that cannot
  // overwrite a desire committed during the IMAP move). A seam name that no longer matches any
  // call does not fail — `diesAfter` simply never fires, the group commits, and the test reddens
  // on the WRONG assertion or, worse for a differently-shaped case, passes while guarding
  // nothing. Caught here because these two went red; the general form is this repository's
  // recorded failure family of guards aimed at things that are not there.
  for (const seam of ["updateLocator", "completeFolderState"] as const) {
    it(`a crash immediately after ${seam} leaves NOTHING of the completion written`, async () => {
      const { accountId, mailboxId, ids } = await seed(1);
      const { adapter, moves } = healthyHost();

      await reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo: diesAfter(seam), adapter, accountId, mailboxId } as never);

      // The MOVE happened — the server is the master and it led, which is the direction that
      // converges. Everything the database was going to say about it is absent.
      expect(moves, "the server performed the move before the crash").toHaveLength(1);

      const st = await stateOf(ids[0]!);
      expect(st.observedFolder, "the state row must be untouched, not half-updated").toBe("INBOX");
      expect(st.reconcileStatus).toBe("pending");
      expect(await locatorOf(ids[0]!), "the locator must not name the destination on its own")
        .toMatchObject({ folder: "INBOX" });
      expect(await auditsOf(accountId, "reconcile.move"), "no audit for a completion that did not commit")
        .toHaveLength(0);
      // The one row this is really about: the torn state is `observed=INBOX, pending` beside a
      // locator that already says the destination. Neither exists here.
      expect((await pendingOf(mailboxId)).map((r) => r.observed)).toEqual(["INBOX"]);

      // ── AND IT IS NOT DEFERRED, WHICH IS THE OTHER HALF OF GETTING THIS RIGHT ──────────
      //
      // A refused MUTATION and a failed COMPLETION reach the same function and mean opposite
      // things. Here the server already moved the mail: the database and the mailbox disagree
      // right now, and deferring would hold that disagreement open for the length of the backoff
      // — a minute, then five, in which the client shows the message in a folder it is not in.
      // The first version of this fix had one `try` around both seams and did exactly that, while
      // also writing a `reconcile.move.failed` row asserting that a move which HAD succeeded was
      // refused. Two separate `try`s is what the distinction costs.
      expect(st.attempts, "a bookkeeping failure is not the message's failure").toBe(0);
      expect(st.nextAttemptAt, "the correction must be due NOW").toBeNull();
      expect(await auditsOf(accountId, "reconcile.move.failed"), "and it is not a refusal")
        .toHaveLength(0);
    }, 60_000);
  }

  it("a crash after the audit row leaves nothing either — the whole group is one fact", async () => {
    const { accountId, mailboxId, ids } = await seed(1);
    const { adapter } = healthyHost();

    await reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo: diesAfter("recordAudit"), adapter, accountId, mailboxId } as never);

    const st = await stateOf(ids[0]!);
    expect(st.observedFolder).toBe("INBOX");
    expect(st.reconcileStatus).toBe("pending");
    expect(await locatorOf(ids[0]!)).toMatchObject({ folder: "INBOX" });
    expect(await auditsOf(accountId, "reconcile.move")).toHaveLength(0);
  }, 60_000);

  it("MID-GROUP, another session sees NONE of it — the completion is invisible until it is one", async () => {
    // The assertion no `try`/`catch` can satisfy. A caller can be made to believe its own writes
    // vanished; it cannot hide a committed statement from somebody else's connection. Before the
    // fix the locator write had already committed on its own by this point, so the outside look
    // returned the DESTINATION while `folder_state` still said INBOX — the torn state itself,
    // caught in the act rather than inferred from the wreckage.
    const { accountId, mailboxId, ids } = await seed(1);
    const { adapter } = healthyHost();
    const seen: Array<{ locator: string; observed: string }> = [];

    await reconcileMailbox({ writeAuthority: FIXTURE_LEASE,
      repo: observedMidGroup("completeFolderState", seen), adapter, accountId, mailboxId,
    } as never);

    expect(seen, "the seam was reached").toHaveLength(1);
    expect(seen[0], "an outside reader must see the whole PRE-move state, or none of it")
      .toEqual({ locator: "INBOX", observed: "INBOX" });

    // …and once the group commits, all of it is visible at once.
    expect(await locatorOf(ids[0]!)).toMatchObject({ folder: DEST });
    expect((await stateOf(ids[0]!)).observedFolder).toBe(DEST);
    expect(await auditsOf(accountId, "reconcile.move")).toHaveLength(1);
  }, 60_000);

  it("the RE-RUN after a torn crash converges exactly once — one move, one instance, one audit", async () => {
    const { accountId, mailboxId, ids } = await seed(1);

    // Pass 1 dies after the locator write. Pass 2 is an ordinary healthy pass.
    const first = healthyHost();
    await reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo: diesAfter("updateLocator"), adapter: first.adapter, accountId, mailboxId } as never);

    const second = healthyHost();
    await reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo: makeDrizzleRepo(db as never), adapter: second.adapter, accountId, mailboxId } as never);

    expect(second.moves, "the row was still owed, so the re-run moves it").toHaveLength(1);
    expect(await pendingOf(mailboxId), "converged").toEqual([]);
    expect((await stateOf(ids[0]!)).observedFolder).toBe(DEST);
    expect(await auditsOf(accountId, "reconcile.move")).toHaveLength(1);

    // THE PHYSICAL CONSEQUENCE. A completion that had half-committed would leave the row claiming
    // the destination while a second instance was written beside the first.
    const inst = await instancesOf(ids[0]!);
    expect(inst, `message has ${inst.length} instances`).toHaveLength(1);
    expect(inst[0]!.folder).toBe(DEST);

    // A third pass is a no-op, which is what "converged" means.
    const third = healthyHost();
    await reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo: makeDrizzleRepo(db as never), adapter: third.adapter, accountId, mailboxId } as never);
    expect(third.moves).toEqual([]);
  }, 60_000);

  // ══ SHAPE A — one refusal is contained, deferred, and never dropped ════════════════════════

  it("ONE REFUSED MOVE AT THE HEAD OF THE QUEUE: the four behind it all complete this cycle", async () => {
    const { accountId, mailboxId, ids } = await seed(5);
    const repo = makeDrizzleRepo(db as never);
    // Message 0 is the OLDEST pending row, so the ordering puts it first: this is head-of-line,
    // not "one of five happened to fail".
    const host = hostRefusing("1:200");

    await reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo, adapter: host.adapter, accountId, mailboxId } as never);

    expect(host.moves, "every message behind the refusal must reach the server").toHaveLength(4);
    const pending = await pendingOf(mailboxId);
    expect(pending.map((r) => r.messageId), "only the refused one is still owed").toEqual([ids[0]]);
    for (const id of ids.slice(1)) expect((await stateOf(id)).observedFolder).toBe(DEST);

    // Recorded, with the count, so a stuck message is a value somebody can select.
    const failures = await auditsOf(accountId, "reconcile.move.failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.payload).toMatchObject({ messageId: ids[0], to: DEST, attempts: 1 });

    // …and DEFERRED, not dropped: the intent is intact and the row is still pending.
    const st = await stateOf(ids[0]!);
    expect(st.attempts).toBe(1);
    expect(st.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(st.desiredFolder, "the user's instruction is untouched").toBe(DEST);
    expect(st.observedFolder).toBe("INBOX");
    expect(st.reconcileStatus, "still owed — deferral is about how often we ask").toBe("pending");
  }, 60_000);

  it("the deferred row does not spend the NEXT cycle's budget", async () => {
    const { accountId, mailboxId } = await seed(3);
    const repo = makeDrizzleRepo(db as never);

    await reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo, adapter: hostRefusing("1:200").adapter, accountId, mailboxId } as never);

    // Second cycle, immediately: a host that would now accept everything.
    const again = healthyHost();
    await reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo, adapter: again.adapter, accountId, mailboxId } as never);

    // BEFORE: the refused row was offered again here, costing an IMAP round trip, and — being the
    // oldest — it took the head of the budget every cycle for ever.
    expect(again.moves, "the sleeping row must not be asked for at all").toEqual([]);
  }, 60_000);

  it("A DEFERRAL IS NOT A DROP: when it comes due the mutation is retried and converges", async () => {
    const { accountId, mailboxId, ids } = await seed(2);
    const repo = makeDrizzleRepo(db as never);

    await reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo, adapter: hostRefusing("1:200").adapter, accountId, mailboxId } as never);
    expect((await stateOf(ids[0]!)).attempts).toBe(1);

    // Time passes. The schedule is data, so the test moves the clock the honest way — by making
    // the row due — rather than by waiting a minute.
    await db.update(folderState).set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(folderState.messageId, ids[0]!));

    // The host relents, which is the whole reason there is no give-up state.
    const relented = healthyHost();
    await reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo, adapter: relented.adapter, accountId, mailboxId } as never);

    expect(relented.moves, "the user's move survived and was performed").toHaveLength(1);
    expect(await pendingOf(mailboxId)).toEqual([]);
    expect((await stateOf(ids[0]!)).observedFolder).toBe(DEST);
    const inst = await instancesOf(ids[0]!);
    expect(inst, "and exactly once").toHaveLength(1);
  }, 60_000);

  it("the backoff WIDENS across refusals rather than resetting each cycle", async () => {
    const { accountId, mailboxId, ids } = await seed(1);
    const repo = makeDrizzleRepo(db as never);
    const host = hostRefusing("1:200");

    for (let i = 0; i < 3; i++) {
      await reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo, adapter: host.adapter, accountId, mailboxId } as never);
      // Wake it for the next pass; the schedule under test is `attempts`, not the wait.
      await db.update(folderState).set({ nextAttemptAt: new Date(Date.now() - 1000) })
        .where(eq(folderState.messageId, ids[0]!));
    }

    // Three refusals on the DURABLE row — a per-process counter would have been reset by any of
    // the three passes, and a worker restart resets it to nothing at all.
    const st = await stateOf(ids[0]!);
    expect(st.attempts).toBe(3);
    expect(await auditsOf(accountId, "reconcile.move.failed")).toHaveLength(3);
    expect(st.reconcileStatus, "and it is STILL owed after three refusals").toBe("pending");
  }, 60_000);

  it("FRESH USER INTENT clears the deferral — a new move is not asleep behind an old one", async () => {
    const { accountId, mailboxId, ids } = await seed(1);
    const repo = makeDrizzleRepo(db as never);

    await reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo, adapter: hostRefusing("1:200").adapter, accountId, mailboxId } as never);
    expect((await stateOf(ids[0]!)).nextAttemptAt).not.toBeNull();

    // The user moves it somewhere else in the client — a DIFFERENT mutation, quite possibly one
    // this server is perfectly happy with. It must be attempted on the next cycle, not in an hour.
    await repo.upsertFolderState(ids[0]!, {
      desiredFolder: "ohmail/Paper Trail", observedFolder: "INBOX", lastSetBy: "us",
    });
    const reset = await stateOf(ids[0]!);
    expect(reset.attempts).toBe(0);
    expect(reset.nextAttemptAt).toBeNull();

    const now = healthyHost();
    await reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo, adapter: now.adapter, accountId, mailboxId } as never);
    expect(now.moves, "the new instruction is acted on immediately").toHaveLength(1);
    expect((await stateOf(ids[0]!)).observedFolder).toBe("ohmail/Paper Trail");
  }, 60_000);

  // ══ SHAPE A, the flag half — the loop that used to fail the whole cycle ════════════════════

  it("ONE REFUSED \\Seen does not fail the cycle, and the flags behind it are written", async () => {
    const { accountId, mailboxId, ids } = await seed(3, { flags: true });
    const repo = makeDrizzleRepo(db as never);
    // Refuse the STORE for message 0's locator and let its move succeed, so the only thing under
    // test is the flag pass. (`reconcileFolders` runs first and rewrites the locators, so the
    // refusal keys on the DESTINATION ref the move produces.)
    const host = hostRefusing("7:200");

    // BEFORE: this rejected, `index.ts` counted a mailbox failure, and no other pending `\Seen`
    // was written — this cycle or any other, because restart reconciliation hit the same row.
    await expect(
      reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo, adapter: host.adapter, accountId, mailboxId } as never),
    ).resolves.toBeDefined();

    const flags = await db.select().from(flagState)
      .innerJoin(messages, eq(messages.id, flagState.messageId))
      .where(eq(messages.mailboxId, mailboxId));
    const byId = new Map(flags.map((r) => [r.flag_state.messageId, r.flag_state]));

    expect(byId.get(ids[1]!)!.reconcileStatus, "the queue behind the refusal must drain").toBe("reconciled");
    expect(byId.get(ids[2]!)!.reconcileStatus).toBe("reconciled");

    const stuck = byId.get(ids[0]!)!;
    expect(stuck.reconcileStatus, "the refused one is still owed").toBe("pending");
    expect(stuck.desiredSeen, "and the user's intent is untouched").toBe(true);
    expect(stuck.attempts).toBe(1);
    expect(stuck.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    const failures = await auditsOf(accountId, "reconcile.flags.failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.payload).toMatchObject({ messageId: ids[0], seen: true, attempts: 1 });
  }, 60_000);
});
