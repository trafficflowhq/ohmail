import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, folderState, mailboxes, messageBodies, messageInstances, messages, type Tx,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { makeDrizzleRepo, type WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { MailboxAdapter, SpecialFolders } from "@trafficflow/core/adapters/imap";
import type { NativeLocator } from "@trafficflow/core";
import { junkSweepPass } from "../src/junk-sweep.js";
import {
  MIN_PERMIT_TTL_MS, OrganizerStandDownError, acquireLeasePermit,
} from "../src/lease.js";
import { FakeMetaFolder } from "./_fakeadapter.js";
import { PermitClock } from "./_permit-clock.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * ═══ A DECISION READ EARLIER MAY NOT BECOME A WRITE TO SOMEBODY'S REAL MAIL SERVER ═══════════
 *
 * at the seam its own ledger row calls the sharpest: the one-time
 * Quarantine→\Junk sweep. Two independent things can change between the moment this pass decides
 * and the moment it issues a MOVE against a live IMAP server, and until this file neither was
 * asked about again:
 *
 *  1. **THE ORGANIZER LEASE.** `run-junk-sweep.ts` performed destructive moves with NO LEASE
 *     ACQUIRED OR RECHECKED AT ALL. Exactly one active organizer per mailbox is the standing
 *     invariant, enforced in `ohmail/_meta` — the only medium a LOCAL install and Cloud share —
 *     so an operator sweeping a mailbox whose owner had moved it to their own machine put two
 *     organizers on one mailbox, which is the one thing the lease exists to make impossible. The
 *     pass registry made it worse by ANSWERING THE QUESTION WRONGLY: `junk_sweep`'s fence read
 *     "the CLI takes the mailbox's own lease", which it did not.
 *
 *  2. **THE USER'S OWN VERDICT.** The candidate set is read once; the moves run for as long as
 *     the pile takes. `desired_folder` has six writers serialized against this pass by nothing, so
 *     a user restoring a message out of the spam pile mid-sweep had it swept to `\Junk` anyway —
 *     `completeFolderState`'s witness then correctly declined the DATABASE write, which is exactly
 *     the point: the database was protected and the SERVER was not.
 *
 * ── HOW THIS COMPOSES WITH `folder-completion-cas.pg.test.ts` (hours older) ──────────────────
 *
 * That file proves the completion cannot write back a desire it read: the WITNESS travels with the
 * write. This file proves the two writes that happen BEFORE any witness can be consulted — the
 * IMAP move, and the mailbox it is issued against — are gated too. The witness stops the database
 * write; the permit and the re-read stop the server write. Neither subsumes the other.
 *
 * **This paragraph used to end by saying the third test below "pins that they are complementary
 * rather than redundant by watching the witness decline while asserting no move was issued at
 * all", and that was self-contradictory** — corrected 2026-09-01 by a review round. The two halves
 * cannot both be true of one test: `stillDesired` filters the withdrawn message, so no IMAP move is
 * issued, so `completeFiling`/`completeFolderState` are never reached FOR THAT ROW and the witness
 * has nothing to decline. Breaking the CAS leaves that test green. What the third test proves is the
 * re-read, on its own, which is worth proving and is all it proves. **The composition claim is
 * carried by `folder-completion-cas.pg.test.ts` for the witness half and by this file for the
 * re-read half; no single test here demonstrates the pair.**
 *
 * ── REAL POSTGRES (:5433), AND IT HAS TO BE ─────────────────────────────────────────────────
 *
 * The claim is that a SECOND SESSION's committed `desired_folder` is seen by this pass's re-read
 * under READ COMMITTED, mid-pass. PGlite is single-connection: the interleave cannot exist there
 * and every assertion would pass vacuously — the blindness CLAUDE.md records for transactional
 * code, and the reason three production bugs were invisible until they met real Postgres.
 *
 * ── THE TAKEOVER IS DRIVEN FOR REAL ──────────────────────────────────────────────────────────
 *
 * Not a stubbed `guard` that throws. `acquireLeasePermit` runs the production `runLeaseGate`
 * against a `FakeMetaFolder` — the same in-memory `ohmail/_meta` the worker's own lease tests use
 * — and the takeover is a genuine foreign claim appended to that folder mid-pass, decided by
 * `decideLease` on its real freshness rules. A test that faked the refusal would prove the pass
 * aborts on a throw, which was never in doubt; what needed proving is that the lease SAYS to.
 *
 * ── MUTATIONS WATCHED (each restored) ────────────────────────────────────────────────────────
 *
 *  1.  drop the `guard` argument from the `junkSweepPass` calls **in this file**
 *      ⇒ "a takeover mid-sweep stops the sweep" RED: 2 moves issued against a mailbox held by
 *        another organizer, and the pass returns success.
 *
 *      **This note used to read "drop `guard: () => permit.check()` from `run-junk-sweep.ts`'s
 *      `junkSweepPass` call", and that was false** — corrected 2026-09-01 by a review round over the
 *      commit that wrote it. This file imports `junkSweepPass` directly (line 15) and never loads
 *      `run-junk-sweep.ts` at all; it wires its own permit at the three call sites below. So the
 *      stated mutation could not redden anything here, and the property it actually proves is that
 *      **`junkSweepPass` honours a guard it is given** — worth proving, and not the same claim.
 *      The CLI's own wiring is covered structurally in `cli-lease-wiring.test.ts`, which exists
 *      because this was the gap: the most important production seam had no mutation that could see
 *      it regress.
 *  2.  make the permit's TTL comparison `>` instead of `>=`
 *      ⇒ **the two TAKEOVER tests here RED**, plus the boundary test in `lease-permit.test.ts`. The
 *        interleave hook advances the driven clock by exactly one TTL, so the write boundary lands
 *        ON the deadline — the one instant at which `>` and `>=` disagree — and under `>` the permit
 *        serves that instant from its stale receipt and the takeover goes unseen.
 *
 *        **This note used to claim "ALL FOUR tests here RED" and that overstated it** (corrected in
 *        the same round). The withdrawal test stays green because `stillDesired`, not the lease
 *        re-read, is what stops the restored message; and the dry-run test never acquires a permit,
 *        so it has no TTL to compare. Two green tests were being counted as evidence for a boundary
 *        neither of them reaches.
 *  3.  delete the `stillDesired` filter (`const chunk = wholeChunk`)
 *      ⇒ "a verdict withdrawn mid-sweep is not carried out" RED: the restored message is moved to
 *        \Junk on the server, and the completion declines afterwards — the database is right and
 *        the user's mail is in their spam folder.
 *  4.  have `stillDesired` ignore `folder_state.desired_folder` (locator predicate only)
 *      ⇒ same test RED: the withdrawal is invisible because it is a DESIRE change, not a move.
 *  5.  catch `OrganizerStandDownError` inside the chunk loop and `continue`
 *      ⇒ "the refusal is the honest kind" RED: the pass reports success over a mailbox it lost.
 */

const AVAILABLE = await realPgAvailable();
const LOC = (folder: string, ref: string): NativeLocator => ({ folder, ref });
const PILE = "ohmail/Quarantine";
const JUNK = "[Gmail]/Spam";

/**
 * THE OWNER MOVES THEIR MAILBOX TO THEIR OWN MACHINE — the handover, performed the way the engine
 * actually performs it, because a shortcut here would have tested nothing.
 *
 * The first attempt at this test appended a foreign `local` claim BESIDE ours and expected a
 * stand-down. It did not get one, and the engine was right: `compareStrength` ranks `cloud` above
 * `local` (§4 — "a fresh cloud lease outranks local for CONTINUING coverage"), so our own live
 * claim still won the election and rule 3 answered `organize`. A desktop cannot take a mailbox
 * from a live Cloud by writing a claim next to it, and that is the design.
 *
 * What a desktop takeover actually is: the human authorizes it, `decideLease` arm 6 returns
 * `organize` with EVERY beaten claim in `displace`, and `runLeaseGate` expunges them before
 * appending its own. So the folder afterwards holds the laptop's claim and NOT ours — which is
 * what this function reproduces, and which lands the Cloud worker's next read on arm 7: a fresh
 * winner that is not ours, in a folder that is not quiet.
 */
function takeoverByTheOwnersLaptop(meta: FakeMetaFolder, at: Date): void {
  meta.messages.length = 0;                                   // arm 6`s `displace`
  // `at` is the DRIVEN clock, not the wall clock. A claim heartbeat far in the reader`s future is
  // clamped and judged implausible, which lands the gate on `available` ("somebody stopped") rather
  // than `stand_down` ("somebody is still there") — two different verdicts wanting two different
  // sentences, and the assertion below is about the second one.
  meta.messages.push({ ref: 9_999, raw: foreignClaim(at) });
}

/** A live claim from somebody else's install, as `ohmail/_meta` actually holds one. */
const foreignClaim = (at: Date): string => [
  "X-Ohmail-Lease: 1",
  "X-Ohmail-Organizer-Kind: local",
  "X-Ohmail-Install-Id: ohmail-desktop:the-owners-laptop",
  "X-Ohmail-Protocol: 1",
  `X-Ohmail-Heartbeat: ${at.toISOString()}`,
  `X-Ohmail-Claimed-At: ${at.toISOString()}`,
  "X-Ohmail-Display-Name: ohmail on Mila's laptop",
  `X-Ohmail-Nonce: ${randomUUID()}`,
  "", "",
].join("\r\n");

describe.skipIf(!AVAILABLE)("the junk sweep asks again before it writes to the server", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;
  /** A SECOND connection: the competing writer must be a different session, not the same one. */
  let otherSql: ReturnType<typeof postgres>;
  let otherDb: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
    otherSql = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    otherDb = brandDialect(drizzle(otherSql, { schema }), "pg");
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await otherSql?.end({ timeout: 5 });
  });

  /** Two messages sitting in the pile under a standing spam verdict — the sweep's whole input. */
  async function seed(): Promise<{ accountId: string; mailboxId: string; ids: string[] }> {
    const accountId = randomUUID();
    const tag = accountId.slice(0, 8);
    await db.insert(accounts).values({ id: accountId, name: `swl-${tag}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `swl-${tag}@example.test`, status: "connected",
      junkFolder: JUNK,
    }).returning();
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const [m] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id,
        dedupKey: `mid:<swl-${tag}-${i}@x>`, bodyHash: `swl-h-${tag}-${i}`,
        subject: `old spam ${i}`, fromAddress: "spammer@example.test",
        nativeLocator: LOC(PILE, `1:${50 + i}`),
      }).returning();
      await db.insert(messageInstances).values({
        accountId, messageId: m!.id, mailboxId: mb!.id, folder: PILE,
        uid: 50 + i, uidvalidity: 1n, isPrimary: true,
      });
      await db.insert(folderState).values({
        messageId: m!.id, accountId: m!.accountId, desiredFolder: PILE, observedFolder: PILE,
        lastSetBy: "us", reconcileStatus: "reconciled",
      });
      await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: `buy things ${i}` });
      ids.push(m!.id);
    }
    return { accountId, mailboxId: mb!.id, ids };
  }

  const repoOf = () => makeDrizzleRepo(db as unknown as Tx) as unknown as WorkerRepo & {
    transaction: <T>(fn: (r: WorkerRepo) => Promise<T>) => Promise<T>;
  };

  /**
   * The adapter, with `onScan` fired from `findSpecialFolders` — which the pass calls AFTER it has
   * read its candidate set and BEFORE the first chunk's write boundary. That is precisely the
   * window this row is about, so the interleave is planted there rather than by racing a timer.
   */
  function adapterOf(meta: FakeMetaFolder, onScan?: () => Promise<void>) {
    const moves: Array<{ from: string; to: string }> = [];
    const adapter = {
      leaseIo: () => meta,
      findSpecialFolders: async (): Promise<SpecialFolders> => {
        if (onScan) await onScan();
        return { junk: JUNK, trash: null };
      },
      move: async (loc: NativeLocator, toFolder: string) => {
        moves.push({ from: loc.folder, to: toFolder });
        return { folder: toFolder, ref: `9:${900 + moves.length}` };
      },
      setFlags: async () => {},
    } as unknown as MailboxAdapter;
    return { adapter, moves };
  }

  /**
   * A permit over this mailbox's `_meta`, on a clock the test drives.
   *
   * The clock is INJECTED rather than real, and the interleave hook advances it past the TTL — so
   * the re-read at the write boundary is provoked deterministically instead of being waited for.
   * `ttlMs: 0` would be the obvious way to force a look every time and it is the wrong one: the
   * permit clamps to {@link MIN_PERMIT_TTL_MS} precisely because two gate runs in one millisecond
   * make the engine stand an organizer down against its own claim (measured — see that constant).
   * A test that leaned on the disallowed setting would have been testing a configuration the
   * product refuses to run in.
   */
  const permitFor = (adapter: MailboxAdapter, clock: PermitClock) => acquireLeasePermit({
    adapter,
    self: {
      installId: "ohmail-cloud:test", kind: "cloud",
      displayName: "ohmail Cloud", lastNonce: null,
    },
    takeover: null,
    ...clock.pair,
    ttlMs: MIN_PERMIT_TTL_MS,
  });

  const stateOf = async (messageId: string) => {
    const [row] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
    return row!;
  };

  it("a TAKEOVER mid-sweep stops the sweep before the first move, and says so honestly", async () => {
    const { accountId, mailboxId, ids } = await seed();
    const meta = new FakeMetaFolder();

    // The takeover lands AFTER the candidate set is read and BEFORE the first write boundary —
    // the user's laptop claims the mailbox while this sweep is between its read and its write.
    const clock = new PermitClock(1_000_000);
    const { adapter, moves } = adapterOf(meta, async () => {
      takeoverByTheOwnersLaptop(meta, new Date(clock.ms));
      clock.advance(MIN_PERMIT_TTL_MS);   // the permit is now due for a fresh look
    });

    // The permit is taken while the mailbox is still ours: the gate says organize and writes our
    // claim. Everything after this is about the RE-check, not about the first one.
    const permit = await permitFor(adapter, clock);
    expect(permit.reads).toBe(1);
    expect(meta.appends, "the gate renewed our claim, so this is a real organize verdict").toBe(1);

    await expect(junkSweepPass({
      db: db as unknown as Tx, repo: repoOf(), adapter, accountId, mailboxId,
      execute: true, writeAuthority: { lease: permit },
    })).rejects.toBeInstanceOf(OrganizerStandDownError);

    // THE WHOLE POINT: not one MOVE reached the server.
    expect(moves, "a stood-down organizer moves no mail").toEqual([]);
    // And nothing was half-applied in the database either.
    for (const id of ids) {
      const row = await stateOf(id);
      expect(row.desiredFolder).toBe(PILE);
      expect(row.observedFolder).toBe(PILE);
    }
  }, 60_000);

  it("the refusal names the holder and the reason — `organizer_stand_down`'s own vocabulary", async () => {
    const { accountId, mailboxId } = await seed();
    const meta = new FakeMetaFolder();
    const clock = new PermitClock(1_000_000);
    const { adapter, moves } = adapterOf(meta, async () => {
      takeoverByTheOwnersLaptop(meta, new Date(clock.ms));
      clock.advance(MIN_PERMIT_TTL_MS);   // the permit is now due for a fresh look
    });
    const permit = await permitFor(adapter, clock);

    const err = await junkSweepPass({
      db: db as unknown as Tx, repo: repoOf(), adapter, accountId, mailboxId,
      execute: true, writeAuthority: { lease: permit },
    }).then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(OrganizerStandDownError);
    const stand = err as OrganizerStandDownError;
    // A LIVE foreign claim is `held` — somebody is still renewing — and it is not the same
    // statement as `stopped`. The two want opposite sentences offered to the user, which is why
    // `LeaseOccupancyState` exists rather than one `organized_elsewhere` boolean.
    expect(stand.state).toBe("held");
    expect(stand.reason).toBe("organized_elsewhere:local");
    expect(stand.heldBy).toBe("ohmail on Mila's laptop");
    expect(moves).toEqual([]);
  }, 60_000);

  it("a verdict WITHDRAWN mid-sweep is not carried out — the server write is the one prevented", async () => {
    const { accountId, mailboxId, ids } = await seed();
    const meta = new FakeMetaFolder();
    const restored = ids[0]!;
    const stillSpam = ids[1]!;
    const clock = new PermitClock(1_000_000);

    // The user restores one message out of the spam pile from another session, after this pass
    // has read its candidate set. This is the API's move — it takes no mailbox row, so nothing in
    // the worker's fence excludes it, and under READ COMMITTED the pass's re-read sees it.
    const { adapter, moves } = adapterOf(meta, async () => {
      await otherDb.update(folderState)
        .set({ desiredFolder: "INBOX", reconcileStatus: "pending", updatedAt: new Date() })
        .where(eq(folderState.messageId, restored));
      clock.advance(MIN_PERMIT_TTL_MS);
    });
    const permit = await permitFor(adapter, clock);

    const res = await junkSweepPass({
      db: db as unknown as Tx, repo: repoOf(), adapter, accountId, mailboxId,
      execute: true, writeAuthority: { lease: permit },
    });

    // The candidate set this pass started from held BOTH — the withdrawal is genuinely an
    // interleave and not a narrower initial read.
    expect(res.candidates.map((c) => c.messageId).sort()).toEqual([...ids].sort());
    // Exactly ONE move reached the server, and it was not the restored message.
    expect(moves).toHaveLength(1);
    expect(res.moved).toEqual([stillSpam]);
    expect(res.skipped.map((s) => s.messageId)).toEqual([restored]);
    expect(res.skipped[0]!.reason).toContain("withdrawn");

    // The restored message still wants the Ohbox and was never observed into \Junk. A withdrawal
    // that had been swept anyway would show `observed_folder` at the junk folder here — which is
    // what the database would say after the completion's witness declined, and is exactly the
    // state this test exists to say is NOT good enough.
    const back = await stateOf(restored);
    expect(back.desiredFolder).toBe("INBOX");
    expect(back.observedFolder).toBe(PILE);

    // …and the one that was still spam completed normally: the fix narrows the window, it does
    // not stop the sweep doing its job.
    const swept = await stateOf(stillSpam);
    expect(swept.observedFolder).toBe(JUNK);
  }, 60_000);

  it("the permit is not consulted at all on a DRY RUN — a preview writes nothing, `_meta` included", async () => {
    const { accountId, mailboxId } = await seed();
    const meta = new FakeMetaFolder();
    const { adapter, moves } = adapterOf(meta);

    // No permit acquired, exactly as `run-junk-sweep.ts` does it without `--execute`: taking the
    // lease is a WRITE (`runLeaseGate` appends our claim), and a dry run promises to write nothing
    // anywhere. A preview that announced this process as the mailbox's organizer would be a
    // side effect nobody asked for — and on a mailbox held elsewhere it would refuse, failing the
    // read-only preview for a reason that has nothing to do with the preview.
    //
    // WHAT THIS TEST DOES AND DOES NOT PROVE, because the distinction was overstated once already.
    // It proves `junkSweepPass` needs no permit to preview and touches `_meta` on nobody's behalf.
    // It does NOT prove the CLI keeps its `--execute` condition: acquisition is skipped HERE by
    // simply not passing one, so a CLI changed to acquire unconditionally would leave every
    // assertion below green. That conditional is asserted in `cli-lease-wiring.test.ts`.
    const res = await junkSweepPass({
      db: db as unknown as Tx, repo: repoOf(), adapter, accountId, mailboxId, execute: false,
      // A dry run holds neither half and says so — it must not even READ the lease.
      writeAuthority: { lease: FIXTURE_LEASE },
    });

    expect(res.dryRun).toBe(true);
    expect(res.candidates).toHaveLength(2);
    expect(moves).toEqual([]);
    expect(meta.appends, "a dry run appends no claim to ohmail/_meta").toBe(0);
    expect(meta.removals).toBe(0);
  }, 60_000);
});
