import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { awayReplies, messages } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import {
  consentPartition, ohboxView, presentationReader,
  type EngineMessage, type MemoryMirrorStore, type SyncChange,
} from "@ohmail/client-engine";
import { verbWorld, type VerbWorld } from "../../client-engine/test/verb-parity/world.js";
import {
  AWAY_REPLY_REDELIVER_BATCH, awayReplyFlagRedeliverPass,
} from "../../../apps/worker/src/away-reply-flag-redeliver.js";
import { makeAwayReplySweep } from "../../../apps/worker/src/away-reply-sweep.js";
import { changeLog, messages as messagesTbl } from "@trafficflow/db";
import { and, count as sqlCount } from "drizzle-orm";

/**
 * ═══ A WARM MIRROR THAT PREDATES THE FLAG REPAIRS ITSELF ═════════════════════════════════════
 *
 * THE HIGH this file answers, in one sentence: `MessageDTO.autoReplyByUs` is computed at
 * MATERIALIZE time, and a client only re-materializes a message when a `change_log` row for it
 * arrives — so every responder reply already sitting in somebody's Ohbox keeps `undefined` for
 * ever, the client filter reads that as "the person's" (correctly, for compatibility), and the
 * reported bug survives its own fix on exactly the mailboxes that reported it.
 *
 * Nothing about that is visible to a test that seeds a mailbox and reads it back, because a fresh
 * seed is materialized AFTER the flag exists and carries it. The state that matters is a mirror
 * holding a row the server would TODAY describe differently — and the way this file builds that
 * state is to warm the mirror first and then change the server's answer, by adding the
 * `away_replies` claim the responder writes. Nothing about the MESSAGE changes; only what the
 * server would say about it. The headline test carries the full argument, including the shape
 * that was tried first and why rewriting the mirror's own copy was the wrong instrument.
 *
 * ── THE SHAPE OF THE FIX THIS PROVES ────────────────────────────────────────────────────────
 *
 * A server-side one-time re-delivery: `awayReplyFlagRedeliverPass` emits one `change_log` update
 * per matching Sent copy, `/sync` re-materializes the current DTO for each, and the row arrives
 * carrying the flag. NO message is written, NO folder changes, and the person does nothing.
 *
 * Every assertion below is stated in that order — the defect first (the row IS in Earlier), then
 * the repair — so the file reads as the sequence a mailbox actually goes through across the
 * deploy.
 *
 * ── WHY IT LIVES IN `packages/services/test` ────────────────────────────────────────────────
 *
 * It needs three things at once: raw drizzle (to write the ledger row and to prove afterwards that
 * the message row did not move), the verb-parity world (PGlite + the real route table + a drained
 * engine and its mirror), and the client selectors. `packages/client-engine` has no `drizzle-orm`
 * dependency, so the harness's own directory cannot do the first — the world does every database
 * write it needs through purpose-built helpers for exactly that reason. Here, with services'
 * dependencies and the global `@ohmail/client-engine` alias, all three are in scope, and the
 * harness comes in by the same relative path its own files use for the API test helpers.
 */

const READS = "ohmail/News";

/**
 * The mirror's own copy of "Earlier", as the shell reads it.
 *
 * `ownAddresses` and `now` come from the WORLD, never literals. A hardcoded address makes every
 * own-sent assertion vacuous (the harness randomises it per world). `now` is the clock the
 * fixtures are dated by: the wall clock moved the seeded Sent row behind the 60-day cutline from
 * FIXED_NOW + 60 days on, and it left Earlier for History with nothing about the flag changed.
 */
function earlierIds(w: VerbWorld): string[] {
  const part = consentPartition(w.store, { now: w.clock.now(), ownAddresses: [w.ownAddress] });
  return ohboxView(presentationReader(w.store, part)).previouslySeen.map((m) => m.id);
}

/**
 * The mirror's stored row. The store IS the `EntityReader` — which is why `consentPartition(store,
 * …)` above takes it directly — so this reads the entity the client actually holds, not a
 * projection of it.
 */
function mirrorRow(store: MemoryMirrorStore, id: string): EngineMessage | undefined {
  return store.get<EngineMessage>("message", id);
}

/**
 * The bulk original in Reads, plus an own-sent reply in the same thread.
 *
 * `claim: "deferred"` withholds the `away_replies` row until after the first sync — see the
 * headline test for why that is the faithful way to reproduce a pre-deploy mirror.
 */
async function seedThread(
  w: VerbWorld, kind: "machine" | "human", claim: "now" | "deferred" = "now",
): Promise<{ original: string; reply: string; addClaim: () => Promise<void> }> {
  const original = await w.seedMail({ folder: READS, fromAddress: "news@sender.test", unread: false });
  const bare = `${randomUUID()}@lichtgrat.example`;
  const reply = await w.seedMail({
    folder: "Sent", fromAddress: w.ownAddress, subject: "Re: the roundup", unread: false,
  });
  // Thread them, and give the reply the bare Message-ID ingest would have written.
  const [orig] = await w.db.select().from(messages).where(eq(messages.id, original));
  await w.db.update(messages)
    .set({ messageIdHeader: bare, threadId: orig!.threadId })
    .where(eq(messages.id, reply));
  // A DEFERRED claim withholds BOTH arms of the predicate, not just the ledger: the header belt
  // alone would already answer true, so leaving `Auto-Submitted: auto-replied` on the row would
  // make the server say "responder reply" before the claim was added and there would be nothing
  // to observe changing. With human-looking headers the flip is driven by the LEDGER arm alone,
  // which is also the arm that matters — it is the one that identifies OUR responder's reply.
  await w.seedHeaders(reply, kind === "machine" && claim === "now"
    ? { "auto-submitted": ["auto-replied"] }
    : { "auto-submitted": ["no"] });
  // The ledger row the responder writes, with the angle brackets it mints.
  const addClaim = async (): Promise<void> => {
    await w.db.insert(awayReplies).values({
      accountId: w.accountId, mailboxId: w.mailboxId, messageId: original,
      sender: "news@sender.test", outcome: "sent", mintedMessageId: `<${bare}>`,
    });
  };
  if (kind === "machine" && claim === "now") await addClaim();
  await w.emit(reply, false);
  return { original, reply, addClaim };
}

/** How many `message` change rows exist for these ids — the database's own count. */
async function changeRowsFor(w: VerbWorld, ids: readonly string[]): Promise<number> {
  let n = 0;
  for (const id of ids) {
    const rows = await w.db.select({ c: sqlCount() }).from(changeLog)
      .where(and(eq(changeLog.entityId, id), eq(changeLog.entityType, "message")));
    n += Number(rows[0]?.c ?? 0);
  }
  return n;
}

/**
 * N own-sent responder replies, seeded WITHOUT the API round trip.
 *
 * `seedMail` + `emit` per row would be an HTTP request per row; these fixtures are about the
 * pass's walk, not about ingest, so the rows go in directly. Each carries the `Auto-Submitted`
 * marker, so the header belt matches them and no ledger row is needed — the arms are already
 * proven separately.
 */
async function seedManyMachineReplies(w: VerbWorld, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    const dedup = `mid:${id}`;
    await w.db.insert(messagesTbl).values({
      id, accountId: w.accountId, mailboxId: w.mailboxId,
      messageIdHeader: `${id}@lichtgrat.example`, bodyHash: id, dedupKey: dedup,
      subject: "Re: the roundup", fromAddress: w.ownAddress, date: new Date(),
      nativeLocator: { folder: "Sent", ref: `1:${i}` }, unread: false,
    });
    await w.seedHeaders(id, { "auto-submitted": ["auto-replied"] });
    ids.push(id);
  }
  return ids;
}

describe("the away-reply flag reaches a mirror that predates it", () => {
  /**
   * THE CONTROL THE FIX EXISTS FOR. Red before the pass, green after, with no message change and
   * no manual action — the row leaves Earlier because the SERVER re-sent it, and for no other
   * reason.
   */
  it("a pre-flag responder reply leaves Earlier after the pass, with no message change", async () => {
    const w = await verbWorld();
    const { reply, addClaim } = await seedThread(w, "machine", "deferred");
    // FIRST SYNC: the mirror warms while the server still answers "not a responder reply".
    await w.engine.syncOnce();
    expect(mirrorRow(w.store, reply)?.autoReplyByUs).not.toBe(true);

    /**
     * NOW THE SERVER'S ANSWER CHANGES — and this is the faithful reproduction of the deploy.
     *
     * A pre-deploy mirror holds a row the server would TODAY describe differently. The first
     * draft of this test manufactured that by rewriting the mirror's own copy with the key
     * deleted, which needed a made-up `seq`; the made-up seq outran the account's counter and the
     * real delta was then dropped as stale — the test failed for a reason that had nothing to do
     * with the product, and a smaller made-up number would have hidden that rather than fixed it.
     *
     * Adding the ledger row is the same situation reached through the server: nothing about the
     * MESSAGE changes, the server's answer for it changes, and the question under test is whether
     * a warm mirror ever finds out. It does not, until something emits a change for that row.
     *
     * (The other half — a stored row with the key genuinely ABSENT, as a pre-field build wrote
     * it — is covered where it belongs, in the client's own filter:
     * `away-reply-not-in-ohbox.test.ts` asserts an absent flag keeps the row in Earlier. The
     * client tests `!== true`, so absent and false are one case there.)
     */
    await addClaim();

    // ── THE DEFECT, asserted before the fix path runs ──────────────────────────────────────
    // An ordinary sync changes nothing: no change_log row for this message, so no re-materialize.
    await w.engine.syncOnce();
    expect(earlierIds(w), "the pre-flag row must start in Earlier, or this proves nothing")
      .toContain(reply);
    expect(mirrorRow(w.store, reply)?.autoReplyByUs).not.toBe(true);

    // The message row itself, recorded so we can prove the pass did not touch it.
    const [before] = await w.db.select().from(messages).where(eq(messages.id, reply));

    // ── THE FIX PATH: one pass, then an ordinary sync. Nobody presses anything. ────────────
    const r = await w.pass.awayReplyFlagRedeliver();
    expect(r.redelivered, "the pass re-delivered nothing — it considered no candidate").toBe(1);
    await w.engine.syncOnce();

    // ── THE REPAIR ────────────────────────────────────────────────────────────────────────
    expect(mirrorRow(w.store, reply)?.autoReplyByUs).toBe(true);
    expect(earlierIds(w)).not.toContain(reply);

    // NO MESSAGE CHANGE. The pass writes a change_log row and nothing else: same folder, same
    // read state, same updated_at. A fix that repaired the view by mutating the mail would pass
    // the assertion above and fail here.
    const [after] = await w.db.select().from(messages).where(eq(messages.id, reply));
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
    expect(after!.unread).toBe(before!.unread);
    expect(after!.deletedAt).toBe(before!.deletedAt);
  });

  /** THE POSITIVE CONTROL: a reply the PERSON wrote stays in Earlier across the whole sequence. */
  it("leaves a reply the person wrote in Earlier, before and after the pass", async () => {
    const w = await verbWorld();
    const { reply } = await seedThread(w, "human");
    await w.engine.syncOnce();

    expect(earlierIds(w)).toContain(reply);
    const r = await w.pass.awayReplyFlagRedeliver();
    // Nothing to re-deliver: the fragment does not match a human reply.
    expect(r.redelivered).toBe(0);
    await w.engine.syncOnce();
    expect(earlierIds(w)).toContain(reply);
    expect(mirrorRow(w.store, reply)?.autoReplyByUs).not.toBe(true);
  });

  /**
   * THE WALK TERMINATES, AND IT IS STABLE RATHER THAN IDEMPOTENT — the design, asserted so it
   * cannot be mistaken for an accident.
   *
   * The pass carries no durable marker (the pass's own header records the two shapes tried and why
   * both were rejected — the second for being silently wrong about exactly this population), so
   * running it twice re-delivers the same rows twice. That is intended and bounded: the CYCLE runs
   * it once per worker process.
   *
   * What must hold is that each run is finite and identical. A candidate the pass emits for still
   * matches the predicate afterwards, so a walk that re-read instead of advancing an id cursor
   * would loop on page one for ever — which in a worker is not a slow pass, it is a stuck cycle.
   */
  it("terminates and reports the same count on every run — the cursor advances", async () => {
    const w = await verbWorld();
    await seedThread(w, "machine");
    await seedThread(w, "machine");
    await w.engine.syncOnce();

    const first = await w.pass.awayReplyFlagRedeliver();
    expect(first.redelivered).toBe(2);
    expect(first.exhausted, "the walk did not reach the end of two rows — the cursor is stuck")
      .toBe(true);
    for (let i = 0; i < 3; i++) {
      const again = await w.pass.awayReplyFlagRedeliver();
      expect(again.redelivered, `run ${i + 2} disagreed with the first`).toBe(2);
      expect(again.exhausted).toBe(true);
    }
  });

  /**
   * THE CURSOR, PROVEN AT A PAGE BOUNDARY. With `batch` smaller than the candidate set, a walk
   * that did not advance would return the same page every time and cap; this asserts it reaches
   * every row instead. This is the arm that fails if `afterId` is ever dropped.
   */
  it("pages through more candidates than one batch holds", async () => {
    const w = await verbWorld();
    for (let i = 0; i < 5; i++) await seedThread(w, "machine");
    await w.engine.syncOnce();
    const r = await awayReplyFlagRedeliverPass(w.db as never, {
      accountId: w.accountId, batch: 2, maxPages: 10,
    });
    expect(r.redelivered).toBe(5);
    expect(r.exhausted).toBe(true);
    expect(r.cursor).toBe(null);
  });

  /* ═══ THE WALK REACHES THE END — round 2's first HIGH ══════════════════════════════════ */

  /**
   * MORE CANDIDATES THAN THE OLD PAGE BUDGET HELD, repaired COMPLETELY in one process.
   *
   * The shipped pass had a five-page budget, so an account with more matching replies than five pages
   * had its first five pages re-sent on every worker start and the rest re-sent
   * never — permanently stale rows on the largest mailboxes, with the pass reporting a full day's
   * work each time. This is that case, one row past the old ceiling.
   *
   * Counted from `change_log` rather than from the pass's own return, deliberately: the return is
   * the thing under test, so a pass that miscounted its own work would agree with itself.
   */
  it("repairs MORE rows than the old page budget held, in one process", async () => {
    const w = await verbWorld();
    const total = 1_001;
    const ids = await seedManyMachineReplies(w, total);
    expect(ids.length).toBe(total);

    const before = await changeRowsFor(w, ids);
    const sweep = makeAwayReplySweep();
    const r = await sweep.runOnce(w.db as never, [w.accountId]);

    expect(r.redelivered, "the sweep stopped short of the candidate set").toBe(total);
    expect(r.done, "the gate closed on an unfinished sweep").toBe(true);
    // The database's own count of what was written, for every seeded id.
    expect(await changeRowsFor(w, ids) - before).toBe(total);
    // 1001 rows seeded and swept in the in-process store, no wait of its own: up to 4.6 s on the CI
    // VMs, 140 s under 10% of a CPU.
  }, 240_000);

  /**
   * EXACTLY THE PAGE SIZE — the off-by-one either side of "a short page means the end".
   *
   * At exactly `batch` rows the first page is FULL, so the walk cannot conclude from its length
   * that the set is finished; it must take one more page, see it empty, and only then report
   * exhausted. A walk that treated a full first page as the end would leave nothing behind here
   * and everything behind at `batch + 1`.
   */
  it("exhausts a set of exactly one page", async () => {
    const w = await verbWorld();
    const ids = await seedManyMachineReplies(w, AWAY_REPLY_REDELIVER_BATCH);
    const r = await awayReplyFlagRedeliverPass(w.db as never, { accountId: w.accountId });
    expect(r.redelivered).toBe(AWAY_REPLY_REDELIVER_BATCH);
    expect(r.exhausted, "a full first page was mistaken for an unfinished walk").toBe(true);
    expect(r.cursor).toBe(null);
    expect(await changeRowsFor(w, ids)).toBe(ids.length);
  });

  /**
   * A WALK CUT SHORT KEEPS THE GATE OPEN AND RESUMES — the other half of the same HIGH.
   *
   * With the safety bound set to one page the first attempt cannot finish. What must NOT happen is
   * what the shipped version did: report success, close the gate, and start over from the top next
   * time. The cursor is kept, the gate stays open, and the second attempt finishes the set.
   */
  it("keeps the gate open on an unfinished walk and resumes from the cursor", async () => {
    const w = await verbWorld();
    const ids = await seedManyMachineReplies(w, 5);
    const sweep = makeAwayReplySweep();

    const first = await sweep.runOnce(w.db as never, [w.accountId], { batch: 2, maxPages: 1 });
    expect(first.redelivered).toBe(2);
    expect(first.done, "the gate closed although the walk was cut short").toBe(false);
    expect(sweep.done).toBe(false);

    // Resumes: the next attempts continue rather than repeating the first page.
    let seen = first.redelivered;
    for (let i = 0; i < 4 && !sweep.done; i++) {
      seen += (await sweep.runOnce(w.db as never, [w.accountId], { batch: 2, maxPages: 1 })).redelivered;
    }
    expect(sweep.done, "the sweep never finished").toBe(true);
    expect(seen).toBe(5);
    // Every row exactly once — a restarting walk would double-count the first page.
    expect(await changeRowsFor(w, ids)).toBe(5);
  });

  /* ═══ THE GATE — round 2's GUARD row, and the deploy-order half of its second HIGH ══════ */

  /**
   * ONCE PER PROCESS, AND RE-SWEPT BY THE NEXT PROCESS.
   *
   * Both halves in one test because they are one claim: the gate is the PROCESS. Review filed the
   * missing control for this as a GUARD row — the behaviour lived in two locals inside the worker
   * cycle and was reachable only by booting a worker, so it was never asserted at all.
   *
   * The second half is also the answer to the deploy-order HIGH: the train deploys API, then
   * worker, then web (`deploy-0150-apiworker.sh`), so the sweep first runs against an API that
   * knows the flag — and if a sweep is ever spent against one that does not, the NEXT worker start
   * redoes it. That is this assertion.
   */
  it("sweeps once per process, and a fresh process sweeps again", async () => {
    const w = await verbWorld();
    const ids = await seedManyMachineReplies(w, 3);

    const sweep = makeAwayReplySweep();
    const first = await sweep.runOnce(w.db as never, [w.accountId]);
    expect(first.redelivered).toBe(3);
    expect(sweep.done).toBe(true);

    // ONCE PER PROCESS: the same instance does nothing more, however often it is asked.
    for (let i = 0; i < 3; i++) {
      const again = await sweep.runOnce(w.db as never, [w.accountId]);
      expect(again.redelivered, `attempt ${i + 2} swept again inside one process`).toBe(0);
      expect(again.accounts).toBe(0);
    }
    expect(await changeRowsFor(w, ids)).toBe(3);

    // A RESTART: a new instance is a new process, and it re-sweeps. This is what makes a sweep
    // spent against a flag-less API self-correcting rather than lost.
    const restarted = makeAwayReplySweep();
    const second = await restarted.runOnce(w.db as never, [w.accountId]);
    expect(second.redelivered, "a restarted worker did not re-sweep").toBe(3);
    expect(await changeRowsFor(w, ids)).toBe(6);
  });

  /**
   * ONE ACCOUNT'S FAILURE DOES NOT RETIRE THE FLEET'S SWEEP.
   *
   * The first version of the gate was a boolean set BEFORE the account loop, so any single failure
   * closed it for the whole process and every other account went unrepaired until the next
   * restart. The gate now closes after the loop and only on a clean pass.
   */
  it("keeps the gate open when an account throws, and reports it", async () => {
    const w = await verbWorld();
    await seedManyMachineReplies(w, 2);
    const sweep = makeAwayReplySweep();
    const errs: string[] = [];
    // A syntactically valid uuid that owns nothing is not a failure; a malformed one throws in the
    // driver, which is the fault path under test.
    const r = await sweep.runOnce(w.db as never, ["not-a-uuid", w.accountId], {
      onError: (accountId) => { errs.push(accountId); },
    });
    expect(errs).toEqual(["not-a-uuid"]);
    expect(r.failed).toBe(1);
    expect(r.done, "one account's failure closed the whole sweep").toBe(false);
    expect(sweep.done).toBe(false);
    // The healthy account was still swept in the same attempt.
    expect(r.redelivered).toBe(2);
  });

  /** It never re-delivers a tombstoned row: /sync would ask every mirror to re-tombstone it. */
  it("skips a deleted reply", async () => {
    const w = await verbWorld();
    const { reply } = await seedThread(w, "machine");
    await w.engine.syncOnce();
    await w.db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, reply));
    const r = await w.pass.awayReplyFlagRedeliver();
    expect(r.redelivered).toBe(0);
  });
});
