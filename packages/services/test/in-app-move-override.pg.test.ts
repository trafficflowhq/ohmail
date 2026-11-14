import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, sql } from "drizzle-orm";
import {
  accounts, changeLog, folderState, graduations, learningSignals, mailboxes, messages, rules,
  routeOverrideActionId,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import {
  MIGRATED_DB_SETUP_BUDGET_MS, MIGRATED_DB_TEARDOWN_BUDGET_MS, realPgAvailable, throwawayDb,
} from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { brandDialect } from "@trafficflow/db/dialect";
import { MessageService, type ServiceContext } from "../src/index.js";

/**
 * ═══ A MOVE MADE INSIDE OHMAIL IS THE SAME OVERRIDE AS A MOVE MADE ANYWHERE ELSE ═════════════
 *
 * `recordRouteOverride` is the one definition of "this move contradicts a route", and until this
 * lane only the EXTERNAL move reached it: a move pressed in ohmail wrote `last_set_by='us'` and
 * recorded nothing, so the commonest way a person corrects a rule taught that rule nothing.
 *
 * Both doors now call `@trafficflow/db#recordMoveOverride`. What this file proves is that they
 * arrive at the SAME ROW from one act — same kind, same label, same pattern, same action id —
 * and that the row's identity is strong enough that the two doors observing one move cannot
 * count it twice.
 *
 * ── WHY REAL POSTGRES, ON A PRIVATE DATABASE ────────────────────────────────────────────────
 *
 * The predicate is a read: a window bound against a `timestamptz` and three-column matching with
 * two `IS NULL` arms, which is the shape PGlite and postgres@3 have disagreed about before. And
 * the demotion is an UPDATE ... RETURNING whose WHERE decides whether a row is in the answer.
 * PRIVATE rather than the shared box: this file writes `graduations` and `rules` for an account
 * of its own, and a co-tenant counting either would measure this file's fixtures.
 */
const PG_UP = await realPgAvailable();

const privateDb = throwawayDb("trafficflow_inappmove");

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ACCOUNT = randomUUID();
const SENDER = "digest@anchor.example";
/** Where the route filed it — the placement the person's move contradicts. */
const READS = "ohmail/News";
const OHBOX = "INBOX";
const NOW = new Date("2026-09-22T12:00:00.000Z");

function ctx(): ServiceContext {
  return {
    db: db as never, accountId: ACCOUNT, userId: null, now: () => NOW,
    requestId: `inappmove-${randomUUID().slice(0, 8)}`,
  };
}

describe.skipIf(!PG_UP)("the in-app move feeds the route that filed it", () => {
  let mb: string;
  const svc = () => new MessageService();

  /** A message from SENDER that a route filed into `desired`, sitting in `observed`. */
  async function filed(desired: string, observed = desired): Promise<string> {
    const id = randomUUID();
    await db.insert(messages).values({
      id, accountId: ACCOUNT, mailboxId: mb, fromAddress: SENDER,
      subject: `s-${id.slice(0, 8)}`, bodyHash: `h-${id.slice(0, 8)}`, dedupKey: `d-${id}`,
      nativeLocator: { folder: observed, ref: `7:${Math.floor(Math.random() * 100000)}` },
      date: new Date("2026-09-01T00:00:00.000Z"),
    });
    await db.insert(folderState).values({
      messageId: id, accountId: ACCOUNT, desiredFolder: desired, observedFolder: observed, lastSetBy: "us",
    });
    return id;
  }

  /** A message NOTHING has ever filed — no `folder_state` row at all. */
  async function unfiled(): Promise<string> {
    const id = randomUUID();
    await db.insert(messages).values({
      id, accountId: ACCOUNT, mailboxId: mb, fromAddress: SENDER,
      subject: `u-${id.slice(0, 8)}`, bodyHash: `hu-${id.slice(0, 8)}`, dedupKey: `du-${id}`,
      nativeLocator: { folder: OHBOX, ref: `8:${Math.floor(Math.random() * 100000)}` },
      date: new Date("2026-09-01T00:00:00.000Z"),
    });
    return id;
  }

  async function graduate(): Promise<string> {
    await db.insert(graduations).values({
      accountId: ACCOUNT, patternKey: `sender:${SENDER}→${READS}`, action: "route",
      positives: 3, negatives: 0, graduated: true,
      graduatedAt: new Date(NOW.getTime() - 90 * 24 * 3600_000),
    });
    const [row] = await db.insert(rules).values({
      accountId: ACCOUNT, kind: "sender", match: SENDER, destination: READS,
      provenance: "promoted", enabled: true,
    }).returning({ id: rules.id });
    return row!.id;
  }

  const signals = async () =>
    db.select().from(learningSignals).where(eq(learningSignals.accountId, ACCOUNT));

  beforeAll(async () => {
    await privateDb.createFromTemplate();
    client = postgres(privateDb.url, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
    await db.insert(accounts).values({ id: ACCOUNT, name: `inappmove-${ACCOUNT.slice(0, 8)}` });
    const [box] = await db.insert(mailboxes).values({
      id: randomUUID(), accountId: ACCOUNT, provider: "imap",
      address: `move-${ACCOUNT.slice(0, 8)}@x.test`,
      organizerRole: "organizer", organizeConsentedAt: NOW,
    }).returning();
    mb = box!.id;
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  beforeEach(async () => {
    await db.delete(learningSignals).where(eq(learningSignals.accountId, ACCOUNT));
    await db.delete(graduations).where(eq(graduations.accountId, ACCOUNT));
    await db.delete(rules).where(eq(rules.accountId, ACCOUNT));
    await db.delete(changeLog).where(eq(changeLog.accountId, ACCOUNT));
    await db.execute(
      sql`delete from folder_state where message_id in (select id from messages where account_id = ${ACCOUNT})`,
    );
    await db.delete(messages).where(eq(messages.accountId, ACCOUNT));
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await privateDb.drop();
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  it("writes the signal the external move writes — same kind, label, pattern and action id", async () => {
    await graduate();
    const id = await filed(READS);

    await svc().move(ctx(), id, { folder: OHBOX });

    const rows = await signals();
    expect(rows, "one act of the person's, one signal").toHaveLength(1);
    const s = rows[0]!;
    expect(s.kind, "the predicate's own kind — one vocabulary, not a second for this door").toBe("external_move");
    expect(s.label).toBe("negative");
    expect(s.senderAddress).toBe(SENDER);
    expect(s.destination, "the folder the ROUTE chose, not the one the person picked").toBe(READS);

    // The action id is `move:<messageId>:<the seq this move allocated>` — the external arm's own
    // shape, so a replay of THIS move counts once whichever door observed it.
    const [moveRow] = await db.select({ seq: changeLog.seq }).from(changeLog)
      .where(and(eq(changeLog.accountId, ACCOUNT), eq(changeLog.entityId, id), eq(changeLog.op, "move")));
    expect(s.triggeringActionId).toBe(routeOverrideActionId(id, String(moveRow!.seq)));
  });

  it("POSITIVE CONTROL — the external door still writes it, and the two doors are one row", async () => {
    await graduate();
    const id = await filed(READS);

    await svc().move(ctx(), id, { folder: OHBOX });
    const afterInApp = await signals();
    expect(afterInApp).toHaveLength(1);
    const seq = afterInApp[0]!.triggeringActionId.split(":").at(-1)!;

    // The SAME move, observed a second time by the ingest's adopt arm: the mailbox is the master
    // and the server's own report of this move arrives on the next cycle. It must not spend a
    // second override on one act.
    const repo = makeDrizzleRepo(db as never);
    const again = await repo.recordExternalOverride!({
      accountId: ACCOUNT, messageId: id, filedTo: READS, movedTo: OHBOX, seq: BigInt(seq),
    });
    expect(again, "a replay inserts nothing and answers silence").toBeNull();
    expect(await signals(), "still one row").toHaveLength(1);

    // And on its own, with no in-app press before it, the external door writes the same row.
    await db.delete(learningSignals).where(eq(learningSignals.accountId, ACCOUNT));
    const other = await filed(READS);
    const outcome = await repo.recordExternalOverride!({
      accountId: ACCOUNT, messageId: other, filedTo: READS, movedTo: OHBOX, seq: 4242n,
    });
    expect(outcome?.patternKey).toBe(`sender:${SENDER}→${READS}`);
    const ext = await signals();
    expect(ext).toHaveLength(1);
    expect({ kind: ext[0]!.kind, label: ext[0]!.label, destination: ext[0]!.destination })
      .toEqual({ kind: "external_move", label: "negative", destination: READS });
  });

  it("two in-app moves demote the route AND tell every client the rule went off", async () => {
    const ruleId = await graduate();
    await svc().move(ctx(), await filed(READS), { folder: OHBOX });

    const [midway] = await db.select({ enabled: rules.enabled }).from(rules).where(eq(rules.id, ruleId));
    expect(midway!.enabled, "one override is not enough — the counter's arithmetic is untouched").toBe(true);

    await svc().move(ctx(), await filed(READS), { folder: OHBOX });

    const [after] = await db.select({ enabled: rules.enabled, demotions: rules.demotions })
      .from(rules).where(eq(rules.id, ruleId));
    expect(after!.enabled, "the second override demotes it").toBe(false);
    expect(after!.demotions).toBe(1);
    const [g] = await db.select({ graduated: graduations.graduated }).from(graduations)
      .where(and(eq(graduations.accountId, ACCOUNT), eq(graduations.patternKey, `sender:${SENDER}→${READS}`)));
    expect(g!.graduated, "and the pipeline goes back to proposing").toBe(false);

    // THE FAILURE THAT LOOKS LIKE HEALTH: a rule switched off in the database that no client is
    // told about keeps rendering ON, so the person's own correction reads as having done nothing.
    const deltas = await db.select({ id: changeLog.entityId }).from(changeLog)
      .where(and(eq(changeLog.accountId, ACCOUNT), eq(changeLog.entityType, "rule"), eq(changeLog.op, "update")));
    expect(deltas.map((d) => d.id), "the demotion is announced").toEqual([ruleId]);
  });

  it("CONTROL — a move that contradicts no route writes nothing", async () => {
    await graduate();

    // Nothing ever filed this message: there is no placement for the move to contradict, and the
    // arrival folder is not a decision anybody made.
    await svc().move(ctx(), await unfiled(), { folder: OHBOX });
    expect(await signals(), "no folder_state, no override").toHaveLength(0);

    // Filed by the route and moved back to where it already is: not a correction.
    await svc().move(ctx(), await filed(READS), { folder: READS });
    expect(await signals(), "a move to the folder it is already desired into").toHaveLength(0);

    // Filed somewhere no route graduated on.
    await svc().move(ctx(), await filed("ohmail/Receipts"), { folder: OHBOX });
    expect(await signals(), "no graduated route filed it there").toHaveLength(0);
  });
});
