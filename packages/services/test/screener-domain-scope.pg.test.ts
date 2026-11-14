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
import { ScreenerService, type ServiceContext } from "@trafficflow/services";

/**
 * A DOMAIN DECISION IS A BULK WRITE, AND THIS IS THE ONLY PLACE THAT SHOWS.
 *
 * `POST /screener/:id` with `scope: "domain"` re-routes every held message at a domain in ONE
 * transaction: N `folder_state` upserts, N `change_log` rows, one promoted rule. Before that change it
 * moved one address's mail and the rule it wrote covered the whole domain, so the blast radius
 * was invisible — the unit suite seeded a single sender and could not see it.
 *
 * ── WHY REAL POSTGRES AND NOT PGLITE ──────────────────────────────────────────────────────
 *
 * PGlite is single-connection and serializes everything, so "two concurrent decisions on one
 * domain" there is just two sequential ones and every interleaving that could strand a message
 * is unreachable. `recordChange` takes the account's `account_sync_state` row lock for the
 * length of its transaction, which is the thing that actually orders these two writers —
 * and a lock that is never contended is a lock nobody has watched work. `max: 8`, deliberately:
 * `max: 1` would queue the statements in the client and reintroduce exactly the blind spot this
 * file exists to remove (the mistake an earlier change already made once in `admin`).
 *
 * NO IMAP. The service is constructed with no adapter, so this writes desired state and change
 * rows and stops — the same shape the serverless API runs in production.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId,
  userId: null,
  now: () => new Date(),
  requestId: `o19-pg-${randomUUID().slice(0, 8)}`,
});

interface World {
  accountId: string;
  /** Held ids at the ruled-on domain, in insertion order. */
  atDomain: string[];
  /** Held ids at OTHER domains — the blast-radius control. */
  elsewhere: string[];
}

/** `senders` distinct addresses at `corp.test`, `each` held messages apiece, plus controls. */
async function newWorld(senders: number, each: number): Promise<World> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `o19-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `o19-${accountId.slice(0, 8)}@example.test`,
  }).returning();

  const held = async (from: string, i: number): Promise<string> => {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `h${i}`, dedupKey: `o19:${randomUUID()}`,
      subject: `Note ${i}`, fromAddress: from,
      nativeLocator: { folder: "ohmail/Screener", ref: `1:${i}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  };

  const atDomain: string[] = [];
  let n = 0;
  for (let s = 0; s < senders; s += 1) {
    for (let k = 0; k < each; k += 1) {
      // Mixed capitalisation on both sides of the `@`: the predicate lower-cases the whole
      // address, and a domain bag that missed these would strand mail under an "allow" rule.
      const from = s % 3 === 0 ? `No-Reply-${s}@CORP.test` : `no-reply-${s}@corp.test`;
      atDomain.push(await held(from, n++));
    }
  }
  const elsewhere = [
    // The three shapes the predicate must NOT sweep in.
    await held("someone@other.test", n++),        // a different domain
    await held("someone@mail.corp.test", n++),    // a SUBDOMAIN — core has no subdomain match
    await held("someone@evil-corp.test", n++),    // a lookalike an attacker picks
  ];
  return { accountId, atDomain, elsewhere };
}

const desiredOf = async (ids: string[]) =>
  db.select({ id: folderState.messageId, desired: folderState.desiredFolder })
    .from(folderState).where(inArray(folderState.messageId, ids));

describe.skipIf(!PG_UP)("domain scope — the bulk write, on real Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 8, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  /**
   * A domain's senders, each with several held messages. One decision, one rule, a move for each,
   * and three controls untouched. Its own budget: the seed and the decide are thousands of statements,
   * which a busy host takes past vitest's 5 s default; the case asserts the write, not its speed.
   */
  it("moves every held message at the domain, and only those, in one decision", async () => {
    const w = await newWorld(40, 5);
    const svc = new ScreenerService({});

    await svc.decide(ctx(w.accountId), w.atDomain[0]!, { decision: "no", scope: "domain" });

    const moved = await desiredOf(w.atDomain);
    expect(moved).toHaveLength(200);
    expect(moved.every((r) => r.desired === "ohmail/Screened")).toBe(true);

    // The blast radius stops at the domain — including at the subdomain and the lookalike.
    const untouched = await desiredOf(w.elsewhere);
    expect(untouched.map((r) => r.desired)).toEqual([
      "ohmail/Screener", "ohmail/Screener", "ohmail/Screener",
    ]);

    // ONE rule, for the DOMAIN. Two rules would mean the decision ran twice.
    const ruleRows = await db.select().from(rules).where(eq(rules.accountId, w.accountId));
    expect(ruleRows).toHaveLength(1);
    expect(ruleRows[0]).toMatchObject({ kind: "domain", match: "corp.test", destination: "ohmail/Screened" });
  }, 60_000);

  /**
   * ── THE CHANGE LOG IS THE CLIENT'S ONLY VIEW OF THIS, SO IT HAS TO BE COMPLETE ─────────
   *
   * Every moved message needs its own `move` row at its own seq: the mirror applies deltas by
   * id, so a batch that emitted one row for a batch of messages would leave all but one of them sitting in
   * the Screener on every client for ever. `recordChange` allocates from a counter row locked
   * inside the transaction, so the seqs must be gap-free and strictly increasing — the
   * property a second concurrent writer is most likely to break.
   */
  it("emits one move per message plus one rule create, at distinct gap-free seqs", async () => {
    const w = await newWorld(10, 3);
    const svc = new ScreenerService({});
    await svc.decide(ctx(w.accountId), w.atDomain[0]!, { decision: "yes", scope: "domain" });

    const rows = await db.select().from(changeLog)
      .where(eq(changeLog.accountId, w.accountId)).orderBy(asc(changeLog.seq));

    const moves = rows.filter((r) => r.entityType === "message" && r.op === "move");
    expect(moves).toHaveLength(30);
    expect(new Set(moves.map((r) => r.entityId)).size).toBe(30);
    expect(rows.filter((r) => r.entityType === "rule" && r.op === "create")).toHaveLength(1);

    const seqs = rows.map((r) => Number(r.seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[seqs.length - 1]! - seqs[0]!).toBe(seqs.length - 1);
  });

  /**
   * ── TWO PEOPLE (OR TWO TABS) DECIDING ON ONE DOMAIN AT ONCE ────────────────────────────
   *
   * The held-set is read OUTSIDE the transaction that writes it, so both callers can see the
   * same 60 rows and both will try to move them. That is safe by construction — the writes are
   * idempotent upserts to the SAME desired folder — but "safe by construction" is the kind of
   * claim that is true until somebody widens the bag, which is exactly what rule creation just did.
   *
   * What must hold: nothing is stranded in the Screener, everything lands in ONE folder, and
   * the change log stays gap-free under contention on the account's `recordChange` lock.
   */
  it("two concurrent domain decisions leave nothing stranded and no gap in the log", async () => {
    const w = await newWorld(20, 3);
    const svc = new ScreenerService({});
    const c = ctx(w.accountId);

    await Promise.all([
      svc.decide(c, w.atDomain[0]!, { decision: "no", scope: "domain" }),
      svc.decide(c, w.atDomain[59]!, { decision: "no", scope: "domain" }),
    ]);

    const after = await desiredOf(w.atDomain);
    expect(after).toHaveLength(60);
    expect(new Set(after.map((r) => r.desired))).toEqual(new Set(["ohmail/Screened"]));

    const seqs = (await db.select({ seq: changeLog.seq }).from(changeLog)
      .where(eq(changeLog.accountId, w.accountId)).orderBy(asc(changeLog.seq)))
      .map((r) => Number(r.seq));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[seqs.length - 1]! - seqs[0]!).toBe(seqs.length - 1);
  });

  /**
   * the second coupling, on the real bag: `onScreenOut` receives every held message the
   * decision re-routed, so a domain reject hands the whole domain to auto-unsubscribe. The
   * sheet states this before it runs; this asserts the number the sheet is promising about.
   */
  it("hands the whole domain's held mail to the unsubscribe trigger — and nothing else", async () => {
    const w = await newWorld(12, 2);
    const seen: string[] = [];
    const svc = new ScreenerService({
      // The double answers the SHAPE production answers — a sweep, not `null`. A double that
      // answers differently hides the defect twice, and this port's return is now read by the
      // caller to report how much of the fan-out one request finished.
      unsubscribe: {
        async onScreenOut(_c, ids) { seen.push(...ids); return { considered: ids.length }; },
      },
    });
    await svc.decide(ctx(w.accountId), w.atDomain[0]!, { decision: "no", scope: "domain" });

    expect(new Set(seen)).toEqual(new Set(w.atDomain));
    expect(seen).toHaveLength(24);
    for (const id of w.elsewhere) expect(seen).not.toContain(id);
  });

  /** The default scope is unchanged: one address moves, its domain siblings keep waiting. */
  it("the default scope still moves one address only", async () => {
    const w = await newWorld(5, 4);
    const svc = new ScreenerService({});
    await svc.decide(ctx(w.accountId), w.atDomain[0]!, { decision: "yes" });

    const rows = await desiredOf(w.atDomain);
    const inbox = rows.filter((r) => r.desired === "INBOX");
    const waiting = rows.filter((r) => r.desired === "ohmail/Screener");
    expect(inbox).toHaveLength(4);   // the four messages of the FIRST address
    expect(waiting).toHaveLength(16);

    const ruleRows = await db.select().from(rules)
      .where(and(eq(rules.accountId, w.accountId), eq(rules.kind, "sender")));
    expect(ruleRows).toHaveLength(1);
  });
});
