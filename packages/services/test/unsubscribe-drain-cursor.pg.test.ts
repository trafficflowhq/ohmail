/* @postpush: alone — this file asserts the unsubscribe drain's OWN sweep totals, and that drain's
 * window is deployment-wide. One post-push run ran it beside 96 co-tenants on one lane database: they
 * seeded the window, the anti-vacuity guard refused by name, and each of the three passed when run
 * alone on a fresh one. The post-push driver reads this marker and runs the file by itself. */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { learningSignals,
  accounts, mailboxes, messages, messageBodies, folderState, rules,
  unsubscribeDrainState, unsubscribeExamined, unsubscribeRecords,
  readDrainCursor, writeDrainCursor, UNSUB_DRAIN_PASS,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  makeUnsubscribeService, UNSUB_DRAIN_SCAN_PAGE, UNSUB_DRAIN_WINDOW_MS,
  type DrainBudget, type HostResolver, type OneClickPost,
} from "@trafficflow/services";

/**
 * THE DRAIN'S TWO MEMORIES ON REAL POSTGRES — the three claims PGlite cannot make.
 *
 * The CHECK that keeps the cursor pair whole, the foreign key that makes the mark die with its
 * record, and the WINDOW: the walk's page is `UNSUB_DRAIN_SCAN_PAGE` rows, so a walk that crosses more than one
 * page needs more rows than that, and seeding those in PGlite is a different test about a
 * different machine. Everything about the drain's DECISIONS is measured in the PGlite twin;
 * what is here is what only a server can answer.
 *
 * `cursor_at` is a `timestamptz` bound through postgres@3, which is the other reason: PGlite and
 * postgres@3 disagree about parameter serialisation, and a cursor that round-trips on one store
 * and not the other is a pass that silently restarts at the head in production.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const PUBLIC_DNS: HostResolver = { async resolve() { return ["93.184.216.34"]; } };
/**
 * The position a Gmail-held mailbox trusts (`providerAuthservIds`). The eligible rows carry that
 * provider's confirmation of their sender: the drain asks a list only for a confirmed sender.
 */
const GMAIL: ReadonlySet<string> = new Set(["mx.google.com"]);

function spy(): OneClickPost & { calls: string[] } {
  const calls: string[] = [];
  return { calls, async post(url: string) { calls.push(url); return { status: 200 }; } };
}

const svcWith = (post: OneClickPost) =>
  makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => GMAIL });

/**
 * A budget whose POSTING allowance pays for exactly `asks` chunk reads and is then spent, with the
 * closing reserve left behind it — the shape a real budget has when a walk is cut mid-window.
 *
 * COUNTED, not timed: a wall-clock budget small enough to cut a full page is a race with the
 * machine. The work walk reads `postingLeftMs()` at the top of every chunk, so `asks = 1` pays for
 * the first and refuses the second; `leftMs()` stays positive throughout, which is exactly what
 * the posting boundary is for — the pass can still pay for its own closing write.
 */
function budgetFor(asks: number): DrainBudget {
  let asked = 0;
  return {
    leftMs: () => 60_000,
    postingLeftMs: () => (asked++ < asks ? 60_000 : 0),
    elapsedMs: () => 0,
  };
}

const NOW = new Date("2026-07-28T12:00:00Z");
/** Inside the drain's window, oldest first, one second apart. */
const at = (i: number): Date => new Date(NOW.getTime() - 3_600_000 + i * 1000);

const ONE_CLICK = {
  "list-unsubscribe": ["<https://sender.example/u?t=abc>"],
  "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
  "authentication-results": ["mx.google.com; dmarc=pass"],
};

interface World { accountId: string; mailboxId: string }

/**
 * THE DRAIN IS DEPLOYMENT-WIDE, so a case's world is only its own while the window holds nothing
 * else. Every world this file makes is torn down in `afterEach`, and `beforeEach` REFUSES a window
 * somebody else left rows in rather than reading them as this case's — the first version of this
 * file had neither, and the second case read the first's rows as its own page.
 */
const made: World[] = [];

async function newWorld(): Promise<World> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `uc-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `uc-${accountId.slice(0, 8)}@example.test`,
  }).returning();
  const w = { accountId, mailboxId: mb!.id };
  made.push(w);
  // A person screened `sender.example` out — the licence every row this file seeds acts under.
  await db.insert(rules).values({
    accountId, kind: "domain", match: "sender.example", destination: "ohmail/Screened",
    provenance: "promoted", personDecidedAt: NOW,
  });
  await db.insert(learningSignals).values({
    accountId, triggeringActionId: `screener:${randomUUID()}`, kind: "screener",
    senderDomain: "sender.example", destination: "ohmail/Screened", label: "positive",
  });
  return w;
}

/** How many rows the drain's window holds for ANYBODY, which is what the pass would walk. */
async function inWindow(): Promise<number> {
  const since = new Date(NOW.getTime() - UNSUB_DRAIN_WINDOW_MS);
  const [row] = await db.select({ n: sql<number>`count(*)::int` })
    .from(folderState)
    .where(and(inArray(folderState.desiredFolder, ["ohmail/Screened"]), gte(folderState.updatedAt, since)));
  return row?.n ?? 0;
}

async function tearDown(): Promise<void> {
  for (const w of made.splice(0)) {
    const own = db.select({ id: messages.id }).from(messages).where(eq(messages.mailboxId, w.mailboxId));
    await db.delete(unsubscribeExamined).where(inArray(unsubscribeExamined.messageId, own));
    await db.delete(unsubscribeRecords).where(eq(unsubscribeRecords.mailboxId, w.mailboxId));
    await db.delete(messageBodies).where(inArray(messageBodies.messageId, own));
    await db.delete(folderState).where(inArray(folderState.messageId, own));
    await db.delete(messages).where(eq(messages.mailboxId, w.mailboxId));
    await db.delete(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    await db.delete(rules).where(eq(rules.accountId, w.accountId));
    await db.delete(accounts).where(eq(accounts.id, w.accountId));
  }
  await db.delete(unsubscribeDrainState).where(eq(unsubscribeDrainState.pass, UNSUB_DRAIN_PASS));
}

/** N screened-out rows at consecutive positions; only those given headers are eligible. */
async function seedWindow(
  w: World, n: number, withHeaders: (i: number) => Record<string, string[]> | null,
): Promise<string[]> {
  const ids: string[] = [];
  for (let from = 0; from < n; from += 500) {
    const batch = Array.from({ length: Math.min(500, n - from) }, (_, k) => {
      const i = from + k;
      return {
        id: randomUUID(), accountId: w.accountId, mailboxId: w.mailboxId,
        bodyHash: `h${i}`, dedupKey: `uc:${randomUUID()}`, subject: `N ${i}`,
        fromAddress: `news-${i}-${randomUUID().slice(0, 8)}@sender.example`,
        nativeLocator: { folder: "ohmail/Screened", ref: `1:${i}` },
      };
    });
    await db.insert(messages).values(batch);
    await db.insert(folderState).values(batch.map((m, k) => ({
      messageId: m.id, desiredFolder: "ohmail/Screened", observedFolder: "ohmail/Screened",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false, updatedAt: at(from + k),
    })));
    const bodies = batch.flatMap((m, k) => {
      const h = withHeaders(from + k);
      return h === null ? [] : [{ messageId: m.id, text: "", headers: h }];
    });
    if (bodies.length > 0) await db.insert(messageBodies).values(bodies);
    ids.push(...batch.map((m) => m.id));
  }
  return ids;
}

const stateRow = async () => (await db.select().from(unsubscribeDrainState)
  .where(eq(unsubscribeDrainState.pass, UNSUB_DRAIN_PASS)))[0];

describe.skipIf(!PG_UP)("the drain's cursor and its mark, on real Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 180_000);
  afterAll(async () => { await tearDown(); await client?.end({ timeout: 5 }); });
  beforeEach(async () => {
    await tearDown();
    const held = await inWindow();
    // A case that read somebody else's rows as its own is a case measuring nothing — it refuses,
    // and it names the count so a reader can tell a co-tenant in this run from residue a previous
    // one left. Residue on a lane database is cleared by `scripts/lane-db.sh --drop` and a
    // re-create; a co-tenant is a scheduling fact and the run is repeated without it.
    expect(held, "the drain's window holds rows this case did not seed — it would walk them").toBe(0);
  }, 120_000);
  afterEach(async () => { await tearDown(); });

  it("refuses half a cursor — the pair is whole or it is absent", async () => {
    const tx = db as never;
    // Both absent: the position every store starts from.
    await writeDrainCursor(tx, "ck-probe", null, NOW);
    expect(await readDrainCursor(tx, "ck-probe")).toBeNull();
    // Both present: a position, and it survives the timestamptz round trip exactly.
    const id = randomUUID();
    await writeDrainCursor(tx, "ck-probe", { at: at(7), messageId: id }, NOW);
    const back = await readDrainCursor(tx, "ck-probe");
    expect(back!.messageId).toBe(id);
    expect(back!.at.getTime()).toBe(at(7).getTime());
    // One of the two: refused by the database, not by the program.
    await expect(db.execute(sql`
      update "unsubscribe_drain_state" set "cursor_message_id" = null where "pass" = ${"ck-probe"}
    `)).rejects.toThrow(/unsubscribe_drain_state_cursor_pair/);
    await db.delete(unsubscribeDrainState).where(eq(unsubscribeDrainState.pass, "ck-probe"));
  });

  it("a mark cannot outlive the record it was judged against", async () => {
    const w = await newWorld();
    const [id] = await seedWindow(w, 1, () => ONE_CLICK);
    const post = spy();
    await svcWith(post).drainScreenedOut(db as never, { now: () => NOW, requestId: "fk" });
    expect(post.calls).toHaveLength(1);
    const [record] = await db.select().from(unsubscribeRecords)
      .where(eq(unsubscribeRecords.accountId, w.accountId));
    const marks = await db.select().from(unsubscribeExamined)
      .where(eq(unsubscribeExamined.accountId, w.accountId));
    expect(marks.map((m) => m.messageId)).toEqual([id]);

    // THE REASON BOTH ERASURE SWEEPS DELETE THE CHILD FIRST. Without that line this is what the
    // sweep meets — a refusal, not a silent orphan.
    await expect(db.delete(unsubscribeRecords).where(eq(unsubscribeRecords.id, record!.id)))
      .rejects.toThrow(/unsubscribe_examined/);
  });

  it("a stored pass at a mailbox no provider entry names is posted for and kept", async () => {
    // The sender's own signature, checked at ingest: the request re-reads nothing that could
    // confirm it at this mailbox, so it keeps the stored pass rather than overwrite it.
    const w = await newWorld();
    const [id] = await seedWindow(w, 1, () => ({
      "list-unsubscribe": ["<https://sender.example/u?t=signed>"],
      "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
    }));
    await db.update(messages).set({ authVerdict: "pass" }).where(eq(messages.id, id!));
    const post = spy();
    const svc = makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => new Set<string>() });
    await svc.drainScreenedOut(db as never, { now: () => NOW, requestId: "signed" });
    expect(post.calls).toEqual(["https://sender.example/u?t=signed"]);
    const [row] = await db.select({ v: messages.authVerdict }).from(messages).where(eq(messages.id, id!));
    expect(row!.v).toBe("pass");
  });

  it("a walk cut mid-window says where it stopped, and the next run goes on from there", async () => {
    // ONE PAGE AND ONE ROW, at the shipped page size — the smallest window a walk cannot cross in
    // a single chunk, which is the only shape in which "where it stopped" means anything.
    const w = await newWorld();
    const n = UNSUB_DRAIN_SCAN_PAGE + 1;
    const ids = await seedWindow(w, n, (i) => (i === n - 1 ? ONE_CLICK : null));
    const post = spy();
    const svc = svcWith(post);

    // The walk's FIRST chunk, and nothing after it.
    const cut = await svc.drainScreenedOut(db as never, {
      now: () => NOW, requestId: "cut", accounts: 1, perAccount: 1, budget: budgetFor(1),
    });
    expect(cut.sweep.posted, "the eligible row is behind the cut").toBe(0);
    // AND THE TWO WALKS HAVE DIFFERENT ALLOWANCES, which is the posting boundary made visible: the
    // WORK walk stopped at the cut and posted nothing, while the COUNTING walk kept the whole
    // budget — it is closing work — reached the end of the window and answers the truth about it.
    expect(cut.remaining, "the counting walk reached the end of the window").toBe(1);

    const stopped = await stateRow();
    expect(stopped!.cursorMessageId, "the walk stopped mid-window and said so")
      .toBe(ids[UNSUB_DRAIN_SCAN_PAGE - 1]);
    expect((stopped!.cursorAt as Date).getTime()).toBe(at(UNSUB_DRAIN_SCAN_PAGE - 1).getTime());

    // …and the next run starts AFTER it: the one eligible row is the one past the page, and the run that
    // reaches it is this one. Before the cursor, every run re-read the page ahead of it first.
    const on = await svc.drainScreenedOut(db as never, {
      now: () => NOW, requestId: "on", accounts: 1, perAccount: 1,
    });
    expect(on.sweep.posted).toBe(1);
    expect(post.calls).toHaveLength(1);
    const took = await stateRow();
    expect(took!.cursorMessageId, "it stopped on the row it took").toBe(ids[n - 1]);

    // A lap that reaches the end of the window hands the next one the head.
    await svc.drainScreenedOut(db as never, {
      now: () => NOW, requestId: "lap", accounts: 1, perAccount: 1,
    });
    expect((await stateRow())!.cursorMessageId).toBeNull();
  }, 180_000);

  it("a run that dies BETWEEN chunks writes no cursor — the closing act never ran", async () => {
    /**
     * THE HALF THE SMALLER STORE CANNOT SEE. With one page there is no "between chunks", so a
     * cursor written per page and a cursor written once at the end are the same program. Here the
     * walk crosses two, the SECOND read is failed, and the two differ: the closing write never
     * runs, so a cursor that had been written per page would be holding the first page's last row
     * for a pass that posted for nothing.
     */
    const w = await newWorld();
    const n = UNSUB_DRAIN_SCAN_PAGE + 1;
    await seedWindow(w, n, () => null);
    const svc = svcWith(spy());

    let walkReads = 0;
    const realSelect = db.select.bind(db) as (...a: never[]) => unknown;
    const failing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "select") return Reflect.get(target, prop, receiver);
        return (...args: never[]) => {
          const fields = args[0] as Record<string, unknown> | undefined;
          if (fields !== undefined && "eligible" in fields && (walkReads += 1) === 2) {
            return { from: () => { throw new Error("the second chunk died"); } };
          }
          return realSelect(...args);
        };
      },
    }) as typeof db;

    await expect(svc.drainScreenedOut(failing as never, {
      now: () => NOW, requestId: "die", accounts: 1, perAccount: 1,
    })).rejects.toThrow("the second chunk died");
    expect(await stateRow(), "a pass that died mid-walk wrote nothing").toBeUndefined();
  }, 180_000);
});
