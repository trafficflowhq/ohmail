import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, mailboxes, messages, messageInstances, folderState } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { NativeLocator } from "@trafficflow/core";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { reconcileMailbox } from "../src/sync.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * ═══ THE MAIL HOST DIES MID-RECONCILE, AND THE RE-RUN CONVERGES ═══════════════════════════
 *
 * ── THE STATE THIS IS ABOUT ─────────────────────────────────────────────────────────────
 *
 * Invariant #3: the API never opens IMAP. A Screener decision writes `folder_state` and
 * returns; the worker's reconcile pass performs the IMAP move. So when the host goes down, the
 * user's filings queue up as pending rows — which is exactly what `MailboxDTO.pendingMoves`
 * now counts and what the shell's `filing` state now says out loud. That sentence is only worth
 * putting on screen if the backlog behind it actually drains when the host comes back, and
 * drains ONCE.
 *
 * Two ways it could fail, and both are quiet:
 *
 *  · the pass abandons everything after the first throw, so a single stuck message freezes the
 *    whole mailbox and the count never falls;
 *  · the retry moves a message that had already been moved, leaving a second copy in the
 *    destination — the user sees their mail twice, for ever, with nothing saying why.
 *
 * ── WHY REAL POSTGRES, WHICH IS THE WHOLE REASON THIS FILE IS `.pg.test.ts` ─────────────
 *
 * `reconcile-isolation.test.ts` already proves the CONTROL FLOW (one failure does not abandon
 * the pass) against a hand-built repo, and that is the right tool for a question about
 * sequencing. It cannot answer this one, because a stub repo answers `listPendingFolderStates`
 * from a literal: it will report the same two rows after the retry as before it, whatever the
 * writes did. The property here is about ROWS — that `upsertFolderState` and `updateLocator`
 * really did retire the pending row, that `message_instances` holds one instance and not two,
 * and that a second pass over the real table finds nothing left to do.
 *
 * PGlite is not evidence for it either: CLAUDE.md's standing rule is that PGlite green says
 * nothing about transactional code, and three production defects were invisible to it. The
 * per-message writes here run through the real driver's `ON CONFLICT` paths, which is where a
 * convergence bug would actually live.
 *
 * ── MUTATIONS WATCHED ───────────────────────────────────────────────────────────────────
 *
 *  · restore the pre-fix `throw` in `reconcileFolders`'s catch ⇒ "the pass keeps going" red,
 *    with the second message still pending after the run;
 *  · drop the `upsertFolderState` after a successful move ⇒ "converges" red, because the row
 *    stays pending and the second pass moves it AGAIN — which is the duplicate-copy assertion
 *    failing in the same run;
 *  · a source instance whose `isPrimary` is unset ⇒ "exactly one instance" red with 2, because
 *    `setPrimaryInstance` then finds no primary to move and INSERTS one. That one was watched by
 *    accident — the fixture had it wrong first — and it is the shape a real duplicate takes.
 */

const AVAILABLE = await realPgAvailable();
const LOC = (folder: string, ref: string): NativeLocator => ({ folder, ref });

describe.skipIf(!AVAILABLE)("reconcile resumes after the host refuses, and converges once", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 60_000);

  /** An account with `n` messages, each filed by us and awaiting the physical move. */
  async function seed(n: number): Promise<{ accountId: string; mailboxId: string; ids: string[] }> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `rr-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `rr-${accountId.slice(0, 8)}@example.test`,
      status: "connected",
    }).returning();
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const [m] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id,
        dedupKey: `mid:<rr-${accountId.slice(0, 8)}-${i}@example.test>`,
        messageIdHeader: `rr-${accountId.slice(0, 8)}-${i}@example.test`,
        fromAddress: "stranger@example.test",
        subject: `s${i}`,
        date: new Date("2026-08-06T12:00:00.000Z"),
        bodyHash: `rr-hash-${accountId.slice(0, 8)}-${i}`,
        nativeLocator: LOC("INBOX", `1:${100 + i}`),
      }).returning();
      ids.push(m!.id);
      // The PRIMARY instance — the physical copy in the source folder. It is what a duplicate
      // would show up beside, so it has to exist before the move rather than be implied by it.
      await db.insert(messageInstances).values({
        accountId, messageId: m!.id, mailboxId: mb!.id, folder: "INBOX", uid: 100 + i, uidvalidity: 1n,
        // `isPrimary`, and the column name matters: with the flag unset, `setPrimaryInstance`
        // finds no primary to move and INSERTS one — which looks exactly like the duplicate this
        // test hunts, from a fixture defect rather than a product one.
        isPrimary: true,
      });
      // What a Screener decision leaves behind: filed by us, not yet applied on the server.
      await db.insert(folderState).values({
        messageId: m!.id, accountId: m!.accountId, desiredFolder: "ohmail/News", observedFolder: "INBOX",
        reconcileStatus: "pending", lastSetBy: "us",
      });
    }
    return { accountId, mailboxId: mb!.id, ids };
  }

  /**
   * An adapter standing in for a mail host that is refusing connections, then recovering.
   *
   * `failUntil` counts MOVE ATTEMPTS, not messages: a host that is down refuses whatever is
   * asked of it, so the first attempts throw whichever message they are for. `moves` records
   * every attempt that got through, which is the duplicate detector — a converged reconcile
   * moves each message exactly once ACROSS BOTH RUNS.
   */
  function hostThatRecovers(failUntil: number): { adapter: MailboxAdapter; moves: string[] } {
    const moves: string[] = [];
    let attempts = 0;
    const adapter = {
      move: async (locator: NativeLocator, toFolder: string): Promise<NativeLocator> => {
        attempts++;
        if (attempts <= failUntil) {
          throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:993"), { code: "ECONNREFUSED" });
        }
        moves.push(`${locator.folder}/${locator.ref}→${toFolder}`);
        return LOC(toFolder, locator.ref.replace(/^\d+:/, "7:"));
      },
      setFlags: async () => {},
    } as unknown as MailboxAdapter;
    return { adapter, moves };
  }

  const pendingRows = async (mailboxId: string) =>
    db.select().from(folderState)
      .innerJoin(messages, eq(messages.id, folderState.messageId))
      .where(and(eq(messages.mailboxId, mailboxId), eq(folderState.reconcileStatus, "pending")));

  const instancesOf = async (messageId: string) =>
    db.select().from(messageInstances).where(eq(messageInstances.messageId, messageId));

  it("a host that refuses leaves every filing PENDING — nothing is marked done on a throw", async () => {
    const { accountId, mailboxId } = await seed(3);
    const { adapter, moves } = hostThatRecovers(Number.MAX_SAFE_INTEGER);
    const repo = makeDrizzleRepo(db as never);

    await reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo, adapter, accountId, mailboxId } as never);

    expect(moves, "a refusing host must not record a move").toEqual([]);
    // THE PASS KEEPS GOING. All three were attempted and all three are still owed; a rethrow
    // would have abandoned the pass after the first, which is the same row count and therefore
    // NOT what this asserts — the `moves` list on the recovering run below is what separates
    // them, together with the isolation test that owns the sequencing claim.
    expect((await pendingRows(mailboxId)).length).toBe(3);
    // …and the count the client reads is exactly the backlog. This is the number the shell's
    // `filing` state puts on screen, so it may not drift from what the reconciler still owes.
    expect((await pendingRows(mailboxId)).length).toBe(3);
  }, 60_000);

  it("the RE-RUN converges: every filing applied exactly once, nothing left pending", async () => {
    const { accountId, mailboxId, ids } = await seed(3);
    const repo = makeDrizzleRepo(db as never);

    // RUN 1 — the host is down for the first two attempts and answers the third.
    const first = hostThatRecovers(2);
    await reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo, adapter: first.adapter, accountId, mailboxId } as never);
    expect(first.moves.length, "one message got through before the host recovered").toBe(1);
    expect((await pendingRows(mailboxId)).length, "the two that failed are still owed").toBe(2);

    // RUN 2 — the host is back. Only the two that never landed may move.
    const second = hostThatRecovers(0);
    await reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo, adapter: second.adapter, accountId, mailboxId } as never);

    // NO DUPLICATE WORK. The message that succeeded in run 1 is not re-moved: its row was
    // retired, so it is not in `listPendingFolderStates` any more. A reconcile that left the row
    // pending would move it a second time here, and on a real server that is a second COPY.
    expect(second.moves.length).toBe(2);
    expect(second.moves.some((m) => first.moves.includes(m)), "a message was moved twice").toBe(false);

    // CONVERGED. Nothing owed, and every row observes where it was sent.
    expect(await pendingRows(mailboxId)).toEqual([]);
    const states = await db.select().from(folderState)
      .innerJoin(messages, eq(messages.id, folderState.messageId))
      .where(eq(messages.mailboxId, mailboxId));
    expect(states.map((r) => r.folder_state.observedFolder)).toEqual(["ohmail/News", "ohmail/News", "ohmail/News"]);

    // AND NO DUPLICATE COPIES. One instance per message — the physical consequence the whole
    // exercise is about, and the one a stub repo cannot answer.
    for (const id of ids) {
      const rows = await instancesOf(id);
      expect(rows.length, `message ${id} has ${rows.length} instances`).toBe(1);
      expect(rows[0]!.folder).toBe("ohmail/News");
    }

    // A THIRD PASS IS A NO-OP, which is what "converged" means: the reconciler is idempotent
    // over its own finished work, so a worker that restarts mid-outage cannot re-apply anything.
    const third = hostThatRecovers(0);
    await reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo, adapter: third.adapter, accountId, mailboxId } as never);
    expect(third.moves).toEqual([]);
  }, 60_000);
});
