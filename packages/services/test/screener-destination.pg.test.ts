import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, asc, eq, inArray } from "drizzle-orm";
import { accounts, mailboxes, messages, folderState, changeLog, rules } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { ScreenerService, ServiceError, type ServiceContext } from "@trafficflow/services";

/**
 * SCR-READ — THE FIVE DESTINATIONS, END TO END, AGAINST REAL POSTGRES.
 *
 * ## What was wrong
 *
 * The DecisionBar has offered five destinations since it shipped. `POST /screener/:id` carried
 * none of them: it took `{decision, scope}` and answered with `INBOX` for a yes and
 * `ohmail/Screened` for a no, so pressing **Reads** on a waiting sender produced a
 * `provenance:'promoted'` rule at `destination:'INBOX'` and a `folder_state.desired_folder` of
 * `INBOX`, under a toast reading *"Reads — filed. Future mail from … files there
 * automatically."* Both halves of that sentence were false.
 *
 * Both clients composed the difference with a follow-up `move` per held message, and that is the
 * half PGlite could never see. `decide` reads its held rows OUTSIDE the transaction that writes
 * them, so a `move` committing in that window was silently stamped back by the decide's own
 * upsert. Measured on the hosted service: `promoted → INBOX` rules for bulletin senders
 * admitted with Reads, their messages sitting in the Ohbox, and `ohmail/Reads` holding almost
 * none of its mail.
 *
 * ## Why this file is `*.pg.test.ts` and not a unit test
 *
 * Two of the four properties below are only observable on real Postgres:
 *
 *  · the CLOBBER GUARD is `ON CONFLICT … DO UPDATE SET … WHERE desired_folder = 'ohmail/Screener'`.
 *    PGlite runs it, but the interleaving that makes it matter needs a SECOND CONNECTION
 *    committing between this service's read and its write, and PGlite is single-connection —
 *    every schedule there is a sequential one, so the window cannot be entered at all.
 *  · the `change_log` completeness under that guard: a skipped row must emit NO move change, and
 *    the seqs must stay gap-free. `recordChange` allocates from a row lock, which is not a lock
 *    anybody has watched work until two connections contend for it.
 *
 * `max: 4` deliberately — `max: 1` would queue the statements in the client and reintroduce
 * exactly the blind spot this file exists to remove.
 *
 * NO IMAP: the service is constructed with no adapter, so this writes desired state and change
 * rows and stops — the shape the serverless API runs in production.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId,
  userId: null,
  now: () => new Date(),
  requestId: `scr-read-${randomUUID().slice(0, 8)}`,
});

interface World {
  accountId: string;
  /** Held ids for the sender under test, newest last. */
  held: string[];
  address: string;
}

/** One waiting first-contact sender with `each` held messages. */
async function newWorld(each = 3): Promise<World> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `scr-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `scr-${accountId.slice(0, 8)}@example.test`,
  }).returning();

  const address = `post@ledgerandloom.test`;
  const held: string[] = [];
  for (let i = 0; i < each; i += 1) {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `h${i}`, dedupKey: `scr:${randomUUID()}`,
      subject: `Bulletin ${i}`, fromAddress: address,
      nativeLocator: { folder: "ohmail/Screener", ref: `1:${i}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    held.push(m!.id);
  }
  return { accountId, held, address };
}

const stateOf = async (ids: string[]) =>
  db.select({
    id: folderState.messageId,
    desired: folderState.desiredFolder,
    status: folderState.reconcileStatus,
  }).from(folderState).where(inArray(folderState.messageId, ids));

/**
 * THE FIVE BUTTONS AND WHAT EACH ONE MUST PRODUCE.
 *
 * `decision` is the consent and `dest` is the filing address; the server refuses a body where
 * they disagree, so this table is also the list of the only five pairs that are legal.
 */
const DESTINATIONS = [
  { dest: "INBOX", decision: "yes" },
  { dest: "ohmail/News", decision: "yes" },
  { dest: "ohmail/Receipts", decision: "yes" },
  { dest: "ohmail/Screened", decision: "no" },
  { dest: "ohmail/Quarantine", decision: "no" },
] as const;

describe.skipIf(!PG_UP)("SCR-READ — every destination produces its own rule and folder state", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  /**
   * THE ROW THIS SLICE EXISTS FOR. One case per button, and the two assertions are the two
   * halves of the toast: *"filed"* (the `folder_state`) and *"future mail files there
   * automatically"* (the promoted rule's `destination`).
   *
   * MUTATION-WATCHED by deleting `dest ??` from `appliedFolder` in `screener-service.ts`: four
   * of the five cases go red, naming the folder they got instead.
   */
  for (const { dest, decision } of DESTINATIONS) {
    it(`${decision} + dest ${dest} files the held mail there AND promotes a rule there`, async () => {
      const w = await newWorld(3);
      const svc = new ScreenerService({});

      const result = await svc.decide(ctx(w.accountId), w.held[0]!, { decision, dest });

      expect(result.appliedFolder).toBe(dest);

      const state = await stateOf(w.held);
      expect(state).toHaveLength(3);
      expect(state.every((r) => r.desired === dest)).toBe(true);
      // `pending` is what hands the physical move to the worker's reconciler — the API host has
      // no IMAP adapter, so a row left `reconciled` would never leave the Screener on the server.
      expect(state.every((r) => r.status === "pending")).toBe(true);

      const ruleRows = await db.select().from(rules).where(eq(rules.accountId, w.accountId));
      expect(ruleRows).toHaveLength(1);
      expect(ruleRows[0]).toMatchObject({
        kind: "sender", match: w.address, destination: dest, provenance: "promoted", enabled: true,
      });
    });
  }

  /**
   * THE BACK-COMPAT HALF. A client that predates `dest` — a shipped desktop mirror, or the
   * API's own contract tests — posts `{decision}` alone and must get exactly what it always got.
   * Widening a wire field is only safe while its absence still means what it meant.
   */
  it("no dest is byte-identical to the two-folder default it has always had", async () => {
    for (const [decision, folder] of [["yes", "INBOX"], ["no", "ohmail/Screened"]] as const) {
      const w = await newWorld(2);
      const result = await new ScreenerService({}).decide(ctx(w.accountId), w.held[0]!, { decision });
      expect(result.appliedFolder).toBe(folder);
      expect((await stateOf(w.held)).every((r) => r.desired === folder)).toBe(true);
      const ruleRows = await db.select().from(rules).where(eq(rules.accountId, w.accountId));
      expect(ruleRows[0]!.destination).toBe(folder);
    }
  });

  /**
   * ── A DESTINATION ON THE WRONG SIDE OF THE GATE IS REFUSED, NOT COERCED ─────────────────
   *
   * `{decision:"yes", dest:"ohmail/Quarantine"}` is the shape a "yes unless screened" mapping
   * produces, and it has been shipped once before — it filed a SPAM press into the Ohbox and
   * promoted a rule sending that sender's future mail there. Coercing it either way files mail
   * under a consent the user did not give, and which half to trust is invisible to the caller.
   *
   * `ohmail/Screener` gets its own case because it is the one that the effect check ALONE
   * would wave through: it is a `deny` folder, so it agrees with any `no`. A promoted rule
   * pointing at the gate re-screens that sender for ever, with no way out but revoking it.
   *
   * MUTATION-WATCHED: drop the `DECIDABLE_FOLDERS.has(dest)` membership test and the
   * `ohmail/Screener` case goes green-with-a-rule — the rule row assertion at the end is what
   * catches it, not the status code.
   */
  it.each([
    ["a keep folder under a no", { decision: "no", dest: "INBOX" }],
    ["a reject folder under a yes", { decision: "yes", dest: "ohmail/Quarantine" }],
    ["the gate itself", { decision: "no", dest: "ohmail/Screener" }],
    ["a folder that does not exist", { decision: "yes", dest: "ohmail/Nowhere" }],
    ["a non-string", { decision: "yes", dest: 7 }],
  ])("refuses %s with a 400 and writes nothing", async (_name, body) => {
    const w = await newWorld(2);
    const svc = new ScreenerService({});

    // `httpStatus`, and it is asserted rather than `.rejects.toThrow(/…/)` on the message: a
    // message match would pass for a 500 that happened to mention the same words, and the
    // difference between "refused" and "crashed on the way to the same place" is the whole
    // point of a validation test.
    const err = await svc.decide(ctx(w.accountId), w.held[0]!, body as never).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, "the decide RESOLVED — nothing was refused").toBeInstanceOf(ServiceError);
    expect((err as ServiceError).httpStatus).toBe(400);

    // The refusal is worth nothing if it happened after the write.
    expect((await stateOf(w.held)).every((r) => r.desired === "ohmail/Screener")).toBe(true);
    expect(await db.select().from(rules).where(eq(rules.accountId, w.accountId))).toHaveLength(0);
  });

  /**
   * `decision` ITSELF WAS NEVER CHECKED, AND ABSENT EVIDENCE SELECTED THE WIDER ACTION.
   *
   * The expression was a bare `b.decision === "yes" ? … : …`, so `"Yes"`, `1`, or a missing
   * field all fell through to the REJECT branch — which files a stranger's mail to
   * `ohmail/Screened` and hands their messages to auto-unsubscribe, i.e. sends real HTTP
   * requests to a third party on the strength of a malformed body.
   */
  it.each([["Yes"], [1], [null], [undefined]])(
    "refuses decision %p rather than reading it as a screen-out", async (decision) => {
      const w = await newWorld(2);
      await expect(
        new ScreenerService({}).decide(ctx(w.accountId), w.held[0]!, { decision } as never),
      ).rejects.toBeInstanceOf(ServiceError);
      expect((await stateOf(w.held)).every((r) => r.desired === "ohmail/Screener")).toBe(true);
    },
  );

  /**
   * ══ THE CLOBBER, AND IT IS THE PRODUCTION DEFECT ITSELF ═══════════════════════════════════
   *
   * `decide` reads its held rows outside the transaction that writes them. A rival writer
   * committing in that window used to lose: the upsert had no `where`, so it stamped
   * `appliedFolder` over whatever had landed. That is exactly how the client's own follow-up
   * `move` to `ohmail/Reads` was reverted to `INBOX` again and again on a live account.
   *
   * The webapp no longer composes that `move` — but a SHIPPED DESKTOP MIRROR still does, and
   * will until it updates, so removing the composition does not remove the race from the fleet.
   * The guard therefore lives in the service, where every writer passes.
   *
   * ── THE SEAM IS A REAL SECOND CONNECTION, NOT A STUB ────────────────────────────────────
   *
   * `db.transaction` is wrapped so a rival `UPDATE` commits on ANOTHER pooled connection after
   * the service's read and before its write. On PGlite this is unreachable — one connection,
   * one schedule — which is the whole reason this assertion lives in a `*.pg.test.ts`.
   *
   * MUTATION-WATCHED: delete `setWhere: eq(folderState.desiredFolder, SCREENER_FOLDER)` from
   * the upsert and this goes red with `desired` reading `INBOX` — the production state, exactly.
   */
  it("a rival write landing mid-decide is NOT clobbered back to the decide's folder", async () => {
    const w = await newWorld(3);
    const victim = w.held[1]!;

    const raced = ctx(w.accountId);
    const realTransaction = db.transaction.bind(db);
    let fired = false;
    (raced.db as unknown as { transaction: typeof realTransaction }).transaction = (async (
      cb: Parameters<typeof realTransaction>[0],
    ) => {
      if (!fired) {
        fired = true;
        // A different connection out of the same pool, committed before the tx body runs —
        // the client's own `move`, or a second device, landing in the read/write window.
        await db.update(folderState)
          .set({ desiredFolder: "ohmail/News", lastSetBy: "us", reconcileStatus: "pending" })
          .where(eq(folderState.messageId, victim));
      }
      return realTransaction(cb);
    }) as typeof realTransaction;

    await new ScreenerService({}).decide(raced, w.held[0]!, { decision: "yes", dest: "INBOX" });
    expect(fired, "the rival write never ran — this test proved nothing").toBe(true);

    const state = await stateOf(w.held);
    const byId = new Map(state.map((r) => [r.id, r.desired]));
    // The row that moved on keeps where it went. "User always wins."
    expect(byId.get(victim)).toBe("ohmail/News");
    // …and the two still at the gate are re-routed normally, so the guard is not a blanket skip.
    for (const id of w.held.filter((x) => x !== victim)) expect(byId.get(id)).toBe("INBOX");

    /**
     * AND THE CHANGE LOG MUST NOT CLAIM THE SKIPPED ROW MOVED. Every client applies deltas by
     * id, so a `move` change for a row this decision declined to re-route would paint it into
     * the wrong pile on every device until the next full reconcile contradicted it.
     */
    const moves = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.op, "move")))
      .orderBy(asc(changeLog.seq));
    expect(moves.map((r) => r.entityId).sort()).toEqual(w.held.filter((x) => x !== victim).sort());
  });
});
