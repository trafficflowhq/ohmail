import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect, dialect } from "@trafficflow/db/dialect";
import { eq, sql } from "drizzle-orm";
import {
  accounts, folderState, mailboxes, messages, resolveCutline, rules, senderIsActiveSql,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  DEFAULT_DORMANCY_DAYS as CLIENT_DORMANCY_DAYS, MemoryMirrorStore, consentPartition,
  type EngineMessage, type RuleDTO, type SyncChange,
} from "@ohmail/client-engine";
import { DEFAULT_DORMANCY_DAYS, cutlineCounts, hasUndecidedActiveSenders } from "../src/consent-cutline.js";
import { messageRowToDTO } from "../src/dto/materialize.js";
import type { ServiceContext } from "../src/context.js";

/**
 * THE CUTLINE, AND THE AGREEMENT BETWEEN ITS TWO IMPLEMENTATIONS.
 *
 * The client partitions its own mirror in TypeScript; the server asks the database the same
 * question in SQL. Two implementations of one rule is two things that can disagree, and the
 * disagreement would be invisible: each is self-consistent, and the number they differ on is a
 * count nobody can check by eye.
 *
 * So this file builds ONE set of rows, runs both over it, and requires the same answer. The
 * fixture is deliberately made of the cases where a naive version of either would be wrong.
 */

const AVAILABLE = await realPgAvailable();
const client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
const db = brandDialect(drizzle(client, { schema }), "pg");

const NOW = new Date("2026-08-05T12:00:00.000Z");
const RECENT = new Date("2026-07-25T09:00:00.000Z");
const OLD = new Date("2023-01-05T09:00:00.000Z");
const ACCOUNT = randomUUID();
const OWN = `cut-own-${ACCOUNT.slice(0, 8)}@example.com`;
let mailboxId = "";

const ctx: ServiceContext = {
  db, accountId: ACCOUNT, userId: null, now: () => NOW, requestId: "consent-cutline",
};

/**
 * `arrivedAt` is `messages.created_at` — the moment the mailbox recorded the row, which is the
 * fact the cutline falls back to when the sender sent no `Date:` header. STATED per row rather
 * than left to `now()`, because a fixture whose arrival moves with the wall clock cannot pin a
 * cutoff comparison.
 */
interface Row { from: string; folder: string; date: Date | null; unread: boolean; arrivedAt?: Date; check?: "impersonation" }

/** After `BASELINE - 60d` and after `NOW - 60d`: inside the window on either resolution. */
const ARRIVED = new Date("2026-07-30T09:00:00.000Z");
/** A `Date:` header from the future — sender-written, so nobody can stop it arriving. */
const FUTURE = new Date("2099-01-01T09:00:00.000Z");
// A held claim counts only when it arrived inside the window (mail 0148): this one is inside the 5-day
// dial below, the default 60 days and the baselined window alike.
const CLAIMED_AT = new Date("2026-07-31T18:00:00.000Z");
/** And one from 1970, the other end of the same freedom. */
const EPOCHISH = new Date("1970-01-02T09:00:00.000Z");

const ROWS: Row[] = [
  // Old AND unread — active, because unread outranks age. The case that keeps History clean.
  { from: "stale@example.com", folder: "ohmail/Screener", date: OLD, unread: true },
  // Old and read — dormant.
  { from: "quiet@example.com", folder: "ohmail/Screener", date: OLD, unread: false },
  // Recent and read — active on recency alone.
  { from: "recent@example.com", folder: "INBOX", date: RECENT, unread: false },
  // Decided by an address rule.
  { from: "ben@studio.example", folder: "ohmail/Screener", date: OLD, unread: false },
  // Decided by a DOMAIN rule.
  { from: "anyone@corp.example", folder: "INBOX", date: OLD, unread: false },
  // A rule pointing AT the Screener is not a decision — this sender is dormant-undecided.
  { from: "held@example.com", folder: "ohmail/Screener", date: OLD, unread: false },
  // A disabled rule is not a decision either.
  { from: "off@example.com", folder: "INBOX", date: OLD, unread: false },
  // Two messages, one of them unread: the SENDER is active, counted once.
  { from: "mixed@example.com", folder: "INBOX", date: OLD, unread: false },
  { from: "mixed@example.com", folder: "INBOX", date: OLD, unread: true },
  // The user's own mail, in a Sent folder. Never a correspondent, never a place.
  { from: OWN, folder: "Sent Messages", date: RECENT, unread: false },
  // …and the case the Sent-folder test misses: the user's own mail sitting in the INBOX.
  // Mail sent to oneself, and providers that file a copy into both places, land here — measured
  // on a live account. Without an explicit exclusion the user shows
  // up in their own Screener queue.
  { from: OWN, folder: "INBOX", date: RECENT, unread: false },
  // ── THE THREE ROWS A SENDER'S OWN HEADER DECIDES, AND THE SERVER CAN PRODUCE EVERY ONE ──
  //
  // NO `Date:` HEADER, recorded days ago. Both implementations date it by the arrival now; on
  // the header alone it was dormant here and dormant on the client, and under `all_time` the
  // server's predicate called it active while the client retired it — a sender in no list at
  // all on a client with no History surface. Read, so no unread term can carry it.
  { from: "nodate@example.com", folder: "ohmail/Screener", date: null, unread: false, arrivedAt: ARRIVED },
  // NO HEADER, recorded in 2023: the arrival is READ, not ignored, so this one is dormant. The
  // arm that stops "undated" from meaning "active for ever" on a field the sender controls.
  { from: "nodateold@example.com", folder: "ohmail/Screener", date: null, unread: false, arrivedAt: OLD },
  // A HEADER FROM 2099 on mail recorded in 2023. Active on both sides, because both compare the
  // header first — a lie the sender told, and the cutline is not the place that catches it.
  { from: "future@example.com", folder: "ohmail/Screener", date: FUTURE, unread: false, arrivedAt: OLD },
  // A HEADER FROM 1970 on mail recorded days ago. Dormant on both sides, for the same reason in
  // the other direction: the header wins where there is one, and the arrival is a FALLBACK.
  { from: "epoch@example.com", folder: "ohmail/Screener", date: EPOCHISH, unread: false, arrivedAt: ARRIVED },
  // DECIDED by a promoted rule, and the gate holds a claim of theirs that arrived inside the window (mail
  // 0147, 0148): the claim outweighs the rule, so the queue lists them and both counts call them waiting.
  // A rule a person wrote would not: the gate holds nothing from an address a person consented to.
  { from: "claimed@example.com", folder: "ohmail/Screener", date: CLAIMED_AT, unread: false, check: "impersonation" },
];

const RULES: Array<{ kind: string; match: string; destination: string; enabled?: boolean; provenance?: string }> = [
  { kind: "sender", match: "ben@studio.example", destination: "ohmail/News" },
  { kind: "domain", match: "corp.example", destination: "INBOX" },
  { kind: "sender", match: "held@example.com", destination: "ohmail/Screener" },
  { kind: "sender", match: "off@example.com", destination: "INBOX", enabled: false },
  { kind: "sender", match: "claimed@example.com", destination: "INBOX", provenance: "promoted" },
];

/**
 * The same rows, as the client sees them in its mirror — THROUGH THE API'S OWN PROJECTION.
 *
 * This used to hand-build each entity field by field, which meant the parity it proved was
 * between the SQL and a fixture rather than between the SQL and the wire. `messageRowToDTO` is
 * the one function every route emits a message through (list, single, delta, snapshot), so a
 * field it stops projecting — `arrivedAt`, which the cutline dates an undated message by — now
 * reddens the agreement rather than passing because the fixture supplied it by hand.
 */
async function mirror(): Promise<MemoryMirrorStore> {
  const stored = await db.select({ m: messages, fs: folderState })
    .from(messages).innerJoin(folderState, eq(folderState.messageId, messages.id))
    .where(eq(messages.accountId, ACCOUNT));
  const storedRules = await db.select().from(rules).where(eq(rules.accountId, ACCOUNT));

  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  const changes: SyncChange[] = [
    ...stored.map(({ m, fs }) => ({
      type: "message", op: "create", id: m.id, seq: ++seq,
      updatedAt: NOW.toISOString(),
      entity: messageRowToDTO(m, fs, undefined, undefined) as unknown as EngineMessage,
    })),
    ...storedRules.map((r) => ({
      type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: NOW.toISOString(),
      entity: {
        id: r.id, kind: r.kind, match: r.match, destination: r.destination,
        priority: r.priority, provenance: r.provenance, enabled: r.enabled,
        stats: { hits: 0, lastHitAt: null, demotions: 0 },
        createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      } as unknown as RuleDTO,
    })),
  ] as SyncChange[];
  await store.applyChanges(changes);
  return store;
}

// Top level: both describe blocks below read the one client.
afterAll(async () => { await client.end({ timeout: 5 }); });

describe.skipIf(!AVAILABLE)("the cutline, and its two implementations", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    await db.insert(accounts).values({ id: ACCOUNT, name: `cut-${ACCOUNT.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId: ACCOUNT, provider: "imap", address: OWN,
    }).returning({ id: mailboxes.id });
    mailboxId = mb!.id;

    for (const r of ROWS) {
      const [m] = await db.insert(messages).values({
        accountId: ACCOUNT, mailboxId, bodyHash: randomUUID(), dedupKey: randomUUID(),
        fromAddress: r.from, subject: "s", date: r.date, unread: r.unread, snippet: "",
        ...(r.check === undefined ? {} : { senderCheck: r.check, senderCheckBrand: "PostFinance" }),
        ...(r.arrivedAt === undefined ? {} : { createdAt: r.arrivedAt }),
      }).returning({ id: messages.id });
      await db.insert(folderState).values({
        messageId: m!.id, desiredFolder: r.folder, observedFolder: r.folder,
        lastSetBy: "us", reconcileStatus: "reconciled",
      });
    }
    for (const r of RULES) {
      await db.insert(rules).values({
        accountId: ACCOUNT, kind: r.kind, match: r.match, destination: r.destination,
        enabled: r.enabled ?? true, provenance: r.provenance ?? "manual",
      });
    }
  }, 120_000);

  it("counts who is still owed a decision", async () => {
    const counts = await cutlineCounts(ctx);
    // ben (address rule) + anyone@corp (domain rule) = 2. `held` and `off` are NOT decided, and
    // neither is `claimed`, whose rule a claim at the gate outweighs.
    expect(counts.decidedSenders).toBe(2);
    // stale (old+unread), recent (recency), mixed (one unread), nodate (its ARRIVAL is inside
    // the window), future (a 2099 header, which the cutline compares and does not judge) and
    // claimed (a held claim) = 6.
    expect(counts.activeUndecidedSenders).toBe(6);
    // quiet, held (Screener rule is not a decision), off (disabled rule), nodateold (arrived in
    // 2023) and epoch (a 1970 header, which WINS over a fresh arrival) = 5.
    expect(counts.dormantUndecidedSenders).toBe(5);
    // The user is not one of their own correspondents.
    expect(counts.decidedSenders + counts.activeUndecidedSenders + counts.dormantUndecidedSenders).toBe(13);

    expect(await hasUndecidedActiveSenders(ctx)).toBe(true);
  });

  it("THE SERVER AND THE CLIENT AGREE, sender for sender", async () => {
    const server = await cutlineCounts(ctx);
    const clientSide = consentPartition(await mirror(), { now: NOW, ownAddresses: [OWN] });

    expect(DEFAULT_DORMANCY_DAYS).toBe(CLIENT_DORMANCY_DAYS);
    expect(clientSide.counts.activeUndecidedSenders).toBe(server.activeUndecidedSenders);
    expect(clientSide.counts.dormantUndecidedSenders).toBe(server.dormantUndecidedSenders);
  });

  /* ── THE BASELINE (mail 0056), ON BOTH IMPLEMENTATIONS ───────────────────────────────────
   *
   * The defect, in the fixture's own terms: `stale@example.com` is old (2023) AND unread, so it
   * is ACTIVE — "unread outranks age" — and it sits in the Screener queue today. That is right
   * for an account still working through its backlog and wrong afterwards, because old unread
   * mail keeps ARRIVING: a backfill pass reaching further back, a folder read for the first
   * time, a `\Seen` flag adopted late. Each such arrival resurrects a sender the account already
   * worked past, and the read-state sync or the sliding window drops them again.
   *
   * Under a baseline, `stale`'s message is older than `baseline - dormancyDays` and can no longer
   * make its sender active by ANY route. It presents in History instead of the queue.
   *
   * `mixed@example.com` is the same case with two messages and moves with it; `recent` is inside
   * the window measured from this baseline and stays active, which is what stops this test from
   * passing for the trivial reason that a baseline makes everybody dormant.
   */
  const BASELINE = new Date("2026-08-01T00:00:00.000Z");

  it("A 150-DAY-OLD UNREAD UNDECIDED SENDER WAITS TODAY, AND IS HISTORY UNDER A BASELINE", async () => {
    // Today: unread outranks age, so `stale` is in the queue however old its mail is.
    const before = consentPartition(await mirror(), { now: NOW, ownAddresses: [OWN] });
    expect(before.counts.activeUndecidedSenders).toBe(6);
    expect(before.activity.get("stale@example.com")).toBe("active");
    expect(before.history.some((m) => m.from.address === "stale@example.com")).toBe(false);

    // Under a baseline: its message is far older than `BASELINE - 60d`, so it cannot resurrect
    // the sender. History, not the queue — and History now holds UNREAD mail, which is the
    // property the badge note in `consent-cutline.ts` had to be rewritten for.
    const after = consentPartition(await mirror(), {
      now: NOW, baselineAt: BASELINE, ownAddresses: [OWN],
    });
    expect(after.activity.get("stale@example.com")).toBe("dormant");
    const staleHistory = after.history.filter((m) => m.from.address === "stale@example.com");
    expect(staleHistory).toHaveLength(1);
    expect(staleHistory[0]!.unread).toBe(true);

    // `stale` and `mixed` both leave the queue; `recent` is inside the window measured from the
    // baseline and stays, so this is the cutline moving and not everything going dormant. So do
    // `nodate` (arrival inside the baselined window), `future` and `claimed` (its held claim arrived
    // inside the window) — four, not one.
    expect(after.counts.activeUndecidedSenders).toBe(4);
    expect(after.activity.get("recent@example.com")).toBe("active");
    expect(after.activity.get("nodate@example.com")).toBe("active");

    // …AND THE SERVER AGREES, which is the half a client-only test would miss.
    const server = await cutlineCounts(ctx, { baselineAt: BASELINE });
    expect(server.activeUndecidedSenders).toBe(after.counts.activeUndecidedSenders);
    expect(server.dormantUndecidedSenders).toBe(after.counts.dormantUndecidedSenders);
    expect(await hasUndecidedActiveSenders(ctx, { baselineAt: BASELINE })).toBe(true);
  });

  it("A POST-BASELINE STRANGER NEVER GOES DORMANT — no window to age out of", async () => {
    // The cutoff stops sliding once a baseline is stamped, so mail newer than the baseline is
    // newer than the cutoff for ever. `recent` (2026-07-25) is post-`BASELINE - 60d` and stays
    // active at a `now` far past the point the sliding window would have dropped it.
    const muchLater = new Date("2027-06-01T00:00:00.000Z");

    const sliding = consentPartition(await mirror(), { now: muchLater, ownAddresses: [OWN] });
    expect(sliding.activity.get("recent@example.com")).toBe("dormant");

    const baselined = consentPartition(await mirror(), {
      now: muchLater, baselineAt: BASELINE, ownAddresses: [OWN],
    });
    expect(baselined.activity.get("recent@example.com")).toBe("active");

    // The server's `now` is `ctx.now()`, which the baseline makes irrelevant — that is the point.
    const server = await cutlineCounts(ctx, { baselineAt: BASELINE });
    expect(server.activeUndecidedSenders).toBe(baselined.counts.activeUndecidedSenders);
    expect(server.dormantUndecidedSenders).toBe(baselined.counts.dormantUndecidedSenders);
  });

  it("A NULL BASELINE IS EXACTLY TODAY'S BEHAVIOUR, on both sides", async () => {
    // The dangerous-default rule, asserted rather than assumed: passing `null` explicitly and
    // omitting the option must produce the same counts as each other AND as the pre-0056
    // expectations at the top of this file. If the narrowing were folded into a `?? now()`
    // default instead of gated on the baseline being present, this is what would go red — and it
    // is a live account's whole Screener queue.
    for (const opts of [{}, { baselineAt: null }] as const) {
      const server = await cutlineCounts(ctx, opts);
      expect(server.activeUndecidedSenders).toBe(6);
      expect(server.dormantUndecidedSenders).toBe(5);
      const clientSide = consentPartition(await mirror(), { now: NOW, ...opts, ownAddresses: [OWN] });
      expect(clientSide.counts.activeUndecidedSenders).toBe(6);
      expect(clientSide.counts.dormantUndecidedSenders).toBe(5);
    }
  });

  it("the window is a dial on both sides, and they move together", async () => {
    // A SHORT window, INSIDE the 1–365 the dial now permits (mail 0044 caps it at 365). This case
    // used to use 2 000 days — a value the ceiling now refuses to store — to reach past `OLD` and make
    // everybody active. That absolute is no longer a legal window; the dial's PROPERTY, that moving it
    // moves both implementations together, is what the test is for, so it is exercised with a value a
    // user could actually pick. Five days is below `RECENT`'s ~11-day age, so `recent` flips from
    // active (its state at the default 60) to DORMANT — the dial moving, demonstrated on both sides.
    const server = await cutlineCounts(ctx, { dormancyDays: 5 });
    const clientSide = consentPartition(await mirror(), { now: NOW, dormancyDays: 5, ownAddresses: [OWN] });

    // The dial genuinely moved a sender: at 60, `recent` is active; at 5 it is dormant. `stale` and
    // `mixed` stay active on their unread mail, which the window never overrides. `nodate` moves
    // with it too — its arrival is six days old, so the arrival is genuinely COMPARED and an
    // undated row is not silently "always recent"; `future` and `claimed` are the other survivors.
    expect(server.activeUndecidedSenders).toBe(4);
    expect(server.dormantUndecidedSenders).toBe(7);
    expect(clientSide.activity.get("nodate@example.com")).toBe("dormant");
    // …and the client agrees, sender for sender, at the moved window.
    expect(clientSide.counts.activeUndecidedSenders).toBe(server.activeUndecidedSenders);
    expect(clientSide.counts.dormantUndecidedSenders).toBe(server.dormantUndecidedSenders);
  });

  /* ── THE INSTANT, AND THE MODE — the two halves the sender's own header used to decide ────
   *
   * Measured on a device: the engine's `/consent` counted nine senders active and the phone eight,
   * one sender apart — the one who sent no `Date:` header. Their mail had been filed at the gate a
   * minute earlier and the phone rendered it under History, whose explainer says "haven't written
   * in a while". Two causes, both here:
   *
   *  1. THE INSTANT. Both sides read `date` alone, so a row the sender left undated was "not
   *     recent" — and the arrival the mailbox had already recorded sat unread beside it.
   *  2. THE MODE. Under `all_time` the server's `activeSenderExpr` returns `true` and reads no
   *     date at all, while the client spelled the same mode as `cutoff = -Infinity` — still a
   *     COMPARISON, so a row with no instant retired under the one setting that means
   *     "retire nobody".
   */
  it("`all_time` RETIRES NOBODY on either side — including the sender who sent no date", async () => {
    // `CutlineOptions.scope` on the server, `ConsentOptions.screeningScope` on the client — two
    // names for one stored column, and the server's excess-property check does not reach here.
    const server = await cutlineCounts(ctx, { scope: "all_time" });
    const clientSide = consentPartition(await mirror(), {
      now: NOW, screeningScope: "all_time", ownAddresses: [OWN],
    });

    expect(server.dormantUndecidedSenders).toBe(0);
    expect(clientSide.counts.dormantUndecidedSenders).toBe(0);
    expect(clientSide.counts.activeUndecidedSenders).toBe(server.activeUndecidedSenders);
    expect(clientSide.activity.get("nodate@example.com")).toBe("active");
    // Every undecided sender is in the queue and NOBODY is in History, which is the claim the
    // mode's copy makes ("their mail stays where it is").
    expect([...clientSide.history]).toEqual([]);
    // …and a baseline does not re-open the comparison: the mode is read above it on both sides.
    const both = await cutlineCounts(ctx, { baselineAt: BASELINE, scope: "all_time" });
    const clientBoth = consentPartition(await mirror(), {
      now: NOW, baselineAt: BASELINE, screeningScope: "all_time", ownAddresses: [OWN],
    });
    expect(clientBoth.counts.dormantUndecidedSenders).toBe(both.dormantUndecidedSenders);
    expect(clientBoth.counts.activeUndecidedSenders).toBe(both.activeUndecidedSenders);
  });

  it("THE TWO PARTITIONS AGREE SENDER FOR SENDER over the undated, future and 1970 rows", async () => {
    // Not only the counts: the counts can agree while two senders swap sides. `activity` is the
    // client's own verdict per sender; the server's is read one sender at a time through the
    // LIST reader's predicate, which is the same `activeSenderExpr` under a different caller.
    const clientSide = consentPartition(await mirror(), { now: NOW, ownAddresses: [OWN] });
    const expected: ReadonlyArray<readonly [string, "active" | "dormant"]> = [
      ["nodate@example.com", "active"],
      ["nodateold@example.com", "dormant"],
      ["future@example.com", "active"],
      ["epoch@example.com", "dormant"],
    ];
    for (const [who, verdict] of expected) {
      expect(clientSide.activity.get(who), who).toBe(verdict);
    }

    // The server half, per sender, through the shared predicate `GET /screener` pages with.
    const d = dialect(db);
    for (const [who, verdict] of expected) {
      const rows = await d.exec(db, sql`
        select 1 from messages m
          join folder_state fs on fs.message_id = m.id
         where m.account_id = ${d.castUuid(ACCOUNT)}
           and lower(m.from_address) = ${who}
           and ${senderIsActiveSql(d, ACCOUNT, sql`lower(m.from_address)`, resolveCutline({
             baselineAt: null, dormancyDays: null, scope: null, now: NOW,
           }))}
         limit 1
      `);
      expect(rows.length > 0, `${who} on the server`).toBe(verdict === "active");
    }
  });
});

/**
 * A LETTER HELD AT THE GATE IS DATED BY ITS ARRIVAL, as the gate dated it: `receivedAt` is
 * `messages.arrived_at` (the server's receipt, mail 0119), `arrivedAt` above stays `created_at`.
 * An old `Date:` that arrived inside the window waits, read or unread; one the server received
 * before it is History, read or unread. Its own account, so the totals above stay pinned.
 */
describe.skipIf(!AVAILABLE)("a held letter's arrival, on both implementations", () => {
  const ACCT = randomUUID();
  const actx: ServiceContext = { db, accountId: ACCT, userId: null, now: () => NOW, requestId: "consent-cutline-arrival" };
  const BASE = new Date("2026-08-01T00:00:00.000Z");
  const JUNE = new Date("2026-05-02T09:00:00.000Z");
  const mbs: string[] = [];
  const at = (id: number) => mbs[id]!;

  async function arrivalMirror(): Promise<MemoryMirrorStore> {
    const stored = await db.select({ m: messages, fs: folderState })
      .from(messages).innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(eq(messages.accountId, ACCT));
    const storedRules = await db.select().from(rules).where(eq(rules.accountId, ACCT));
    const store = new MemoryMirrorStore();
    await store.load();
    let seq = 0;
    await store.applyChanges([
      ...stored.map(({ m, fs }) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW.toISOString(),
        entity: messageRowToDTO(m, fs, undefined, undefined) as unknown as EngineMessage })),
      ...storedRules.map((r) => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: NOW.toISOString(),
        entity: { id: r.id, kind: r.kind, match: r.match, destination: r.destination, priority: r.priority,
          provenance: r.provenance, enabled: r.enabled, stats: { hits: 0, lastHitAt: null, demotions: 0 },
          createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() } as unknown as RuleDTO })),
    ] as SyncChange[]);
    return store;
  }

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    await db.insert(accounts).values({ id: ACCT, name: `arr-${ACCT.slice(0, 8)}` });
    for (const n of [0, 1]) {
      const [mb] = await db.insert(mailboxes).values({
        accountId: ACCT, provider: "imap", address: `arr-${n}-${ACCT.slice(0, 8)}@example.com`,
        initialImportCompletedAt: JUNE,
      }).returning({ id: mailboxes.id });
      mbs.push(mb!.id);
    }
    const rows: Array<{ from: string; folder: string; unread: boolean; receivedAt: Date; mb?: number }> = [
      { from: "udo@example.com", folder: "ohmail/Screener", unread: true, receivedAt: ARRIVED },
      { from: "olga@example.com", folder: "ohmail/Screener", unread: false, receivedAt: ARRIVED },
      { from: "june-unread@example.com", folder: "ohmail/Screener", unread: true, receivedAt: JUNE },
      { from: "june-read@example.com", folder: "ohmail/Screener", unread: false, receivedAt: JUNE },
      { from: "known@example.com", folder: "ohmail/Screener", unread: false, receivedAt: ARRIVED },
      { from: "inboxed@example.com", folder: "INBOX", unread: false, receivedAt: ARRIVED },
      { from: "bea@example.com", folder: "ohmail/Screener", unread: false, receivedAt: ARRIVED, mb: 1 },
    ];
    for (const r of rows) {
      const [m] = await db.insert(messages).values({
        accountId: ACCT, mailboxId: at(r.mb ?? 0), bodyHash: randomUUID(), dedupKey: randomUUID(),
        fromAddress: r.from, subject: "s", date: JUNE, unread: r.unread, snippet: "",
        createdAt: ARRIVED, arrivedAt: r.receivedAt,
      }).returning({ id: messages.id });
      await db.insert(folderState).values({
        messageId: m!.id, desiredFolder: r.folder, observedFolder: r.folder, lastSetBy: "us", reconcileStatus: "reconciled",
      });
    }
    await db.insert(rules).values({ accountId: ACCT, kind: "sender", match: "known@example.com", destination: "INBOX", provenance: "manual" });
  }, 120_000);

  it("under a baseline: the arrived-now letters wait, the June-received ones are History", async () => {
    const server = await cutlineCounts(actx, { baselineAt: BASE });
    const part = consentPartition(await arrivalMirror(), { now: NOW, baselineAt: BASE });
    // udo, olga and bea; the June pair and inboxed are dormant; known is decided.
    expect(server).toEqual({ decidedSenders: 1, activeUndecidedSenders: 3, dormantUndecidedSenders: 3 });
    expect(part.counts.activeUndecidedSenders).toBe(3);
    expect(part.counts.dormantUndecidedSenders).toBe(3);
    for (const who of ["udo", "olga", "bea"]) expect(part.activity.get(`${who}@example.com`), who).toBe("active");
    expect(part.history.map((m) => m.from.address).sort())
      .toEqual(["inboxed@example.com", "june-read@example.com", "june-unread@example.com"]);
  });

  it("per mailbox: each held letter meets its own mailbox's window", async () => {
    const win = (dormancyDays: number) => ({ baselineAt: BASE.toISOString(), dormancyDays, scope: "window" as const });
    // The second mailbox's one-day window ends after bea's arrival.
    const windows = new Map([[at(0), win(60)], [at(1), win(1)]].map(([id, w]) =>
      [id as string, { ...(w as ReturnType<typeof win>), source: "own" as const, holder: null, asOf: null }]));
    const server = await cutlineCounts(actx, { windows });
    const part = consentPartition(await arrivalMirror(), {
      now: NOW, byMailbox: { [at(0)]: win(60), [at(1)]: win(1) },
    });
    expect(server.activeUndecidedSenders).toBe(2);
    expect(part.activity.get("bea@example.com")).toBe("dormant");
    expect(part.counts.activeUndecidedSenders).toBe(server.activeUndecidedSenders);
    expect(part.counts.dormantUndecidedSenders).toBe(server.dormantUndecidedSenders);
  });
});
