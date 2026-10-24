import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import {
  accounts, contacts, folderState, mailboxes, messages, organizerRequests, rules,
  activeSenderExpr, anyOf, cutlineArms, cutlineInstant, perMailboxSql, resolveCutline, ruleNamesSenderSql,
  senderHasHeldArrivalSql, senderHasHeldClaimSql, senderIsActiveSql, senderIsDecidedSql, senderIsOwnSql,
  CUTLINE_PRESENTED_FOLDERS, type CutlineSet, type ResolvedCutline,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { makeTestDb } from "@trafficflow/db/testing";
import { SCREENING_AUTH_VERDICTS } from "@trafficflow/core/mail";
import { ScreenerService, type ServiceContext } from "../src/index.js";

/**
 * THE OLD AND THE NEW SCREENER READS, SIDE BY SIDE, over one seeded account — the fixture and the two
 * comparisons `screener-reads-same-answer.test.ts` (PGlite, and the device store under
 * `pnpm test:sqlite`) and `screener-reads-same-answer.pg.test.ts` (the server's Postgres) both run.
 */
const GATE = "ohmail/Screener";
const NOW = new Date("2026-10-10T12:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY);

export type Db = Awaited<ReturnType<typeof makeTestDb>>;
export interface World { db: Db; accountId: string; mailboxIds: string[]; own: string }

/** A seeded PRNG, so a red names a fixture that can be rebuilt. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function seed(given?: Db): Promise<World> {
  const db = given ?? await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `same-${accountId.slice(0, 8)}` });
  const own = `own-${accountId.slice(0, 8)}@ex.test`;
  const mailboxIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: i === 0 ? own : `box${i}-${accountId.slice(0, 8)}@ex.test`,
      organizerRole: "organizer", initialImportCompletedAt: daysAgo(300),
    }).returning();
    mailboxIds.push(mb!.id);
  }
  const rand = prng(20261016);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const instants = [1, 3, 25, 45, 250, 480].map(daysAgo);
  let n = 0;
  const message = async (from: string, folder: string, o: {
    date?: Date | null; createdAt?: Date; arrivedAt?: Date | null; unread?: boolean; deleted?: boolean;
    marked?: boolean; by?: string | null; brand?: string | null; mailbox?: string;
  } = {}): Promise<void> => {
    const i = n++;
    const createdAt = o.createdAt ?? pick(instants);
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: o.mailbox ?? pick(mailboxIds), bodyHash: `h${i}`, dedupKey: `same:${randomUUID()}`,
      subject: `Note ${i}`, snippet: `snippet ${i}`, fromAddress: from,
      date: o.date === undefined ? pick([...instants, null]) : o.date, createdAt,
      arrivedAt: o.arrivedAt === undefined ? pick([null, createdAt]) : o.arrivedAt,
      unread: o.unread ?? rand() < 0.5, deletedAt: o.deleted ? daysAgo(2) : null,
      senderCheck: o.marked ? "impersonation" : pick([null, "none"]),
      senderCheckBy: o.by === undefined ? pick([null, "ingest", "backfill"]) : o.by,
      senderCheckBrand: o.marked ? (o.brand ?? pick(["Acme", "Globex"])) : null,
      nativeLocator: { folder, ref: `1:${i}` },
    } as never).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: folder, observedFolder: folder,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    } as never);
  };

  // Forty senders over five domains, held and not, every instant, read and unread, a few marked.
  const folders = [GATE, GATE, GATE, "INBOX", "ohmail/News", "ohmail/Receipts", "Archive", "Projects"];
  for (let s = 0; s < 40; s++) {
    const from = `${s % 3 === 0 ? "P" : "p"}${s}@d${s % 5}.test`;
    const k = 1 + Math.floor(rand() * 5);
    for (let j = 0; j < k; j++) {
      await message(from, j === 0 && s % 8 !== 7 ? GATE : pick(folders), {
        deleted: rand() < 0.08, marked: rand() < 0.1,
      });
    }
  }
  // Two held messages at one instant: the id breaks the tie.
  await message("tie@d9.test", GATE, { date: daysAgo(2), createdAt: daysAgo(2) });
  await message("tie@d9.test", GATE, { date: daysAgo(2), createdAt: daysAgo(2) });
  // A claim old by its Date but recorded at ingest inside every window: waiting through the claim alone.
  await message("claim@d9.test", GATE, {
    date: daysAgo(480), createdAt: daysAgo(1), arrivedAt: daysAgo(480), unread: false,
    marked: true, by: "ingest", brand: "Acme",
  });
  // An old Date the server received yesterday, read: waiting by its arrival alone, as the gate dated it.
  await message("arrival@d9.test", GATE, { date: daysAgo(480), createdAt: daysAgo(1), arrivedAt: daysAgo(1), unread: false, marked: false });
  // Decided AND claimed: the claim keeps them waiting.
  await message("p3@d3.test", GATE, { date: daysAgo(480), createdAt: daysAgo(1), marked: true, by: "ingest" });
  // The account's own address, held: never a decision.
  await message(own, GATE, { date: daysAgo(1), createdAt: daysAgo(1) });
  // The two in-flight decisions below name senders waiting under every window.
  await message("p1@d1.test", GATE, { date: daysAgo(1), createdAt: daysAgo(1), mailbox: mailboxIds[1] });
  await message("q@d2.test", GATE, { date: daysAgo(1), createdAt: daysAgo(1), mailbox: mailboxIds[1] });
  // Undated and unread, recorded long ago: only the no-baseline unread arm keeps it.
  await message("undated@d9.test", GATE, { date: null, createdAt: daysAgo(480), arrivedAt: null, unread: true });

  await db.insert(rules).values([
    { accountId, kind: "sender", match: "p3@d3.test", destination: "INBOX", provenance: "manual", enabled: true, priority: 0 },
    { accountId, kind: "domain", match: "d4.test", destination: "ohmail/News", provenance: "manual", enabled: true, priority: 0 },
    { accountId, kind: "sender", match: "p5@d0.test", destination: GATE, provenance: "manual", enabled: true, priority: 0 },
  ] as never);
  await db.insert(contacts).values([
    { accountId, address: "p5@d0.test" }, { accountId, address: "p6@d1.test" },
  ] as never);
  await db.insert(organizerRequests).values([
    { accountId, mailboxId: mailboxIds[1]!, kind: "screener.decide", payload: { scope: "sender", match: "p1@d1.test" }, decidedAt: NOW, state: "pending" },
    { accountId, mailboxId: mailboxIds[1]!, kind: "screener.decide", payload: { scope: "domain", match: "d2.test" }, decidedAt: NOW, state: "sent" },
  ] as never);
  return { db, accountId, mailboxIds, own };
}

export const ctxOf = (w: World): ServiceContext => ({
  db: w.db as unknown as ServiceContext["db"], accountId: w.accountId, userId: null,
  now: () => NOW, requestId: `same-${randomUUID().slice(0, 8)}`,
});

/** Every cutline form `list` can hand the page. */
function cutlines(w: World): Array<[string, CutlineSet | undefined]> {
  const window = resolveCutline({ baselineAt: null, dormancyDays: 30, now: NOW });
  const baselined = resolveCutline({ baselineAt: daysAgo(10), dormancyDays: 30, now: NOW });
  const allTime = resolveCutline({ baselineAt: null, dormancyDays: 30, scope: "all_time", now: NOW });
  // Two mailboxes with two windows, and the third named by neither: listed whole.
  const perMailbox = new Map<string, ResolvedCutline>([
    [w.mailboxIds[0]!, baselined], [w.mailboxIds[1]!, resolveCutline({ baselineAt: null, dormancyDays: 200, now: NOW })],
  ]);
  return [["none", undefined], ["window", window], ["baselined", baselined], ["all time", allTime], ["per mailbox", perMailbox]];
}

/** THE OLD CUTLINE, verbatim: one group per sender (per sender and mailbox for several windows). */
function groupedActiveSql(d: ReturnType<typeof dialect>, accountId: string, senderExpr: SQL, set: CutlineSet): SQL {
  const folders = sql`(${sql.join(CUTLINE_PRESENTED_FOLDERS.map((f) => sql`${f}`), sql`, `)})`;
  const at = cutlineInstant({ date: sql`mc.date`, arrivedAt: sql`mc.created_at` });
  const activeAt = (c: ResolvedCutline): SQL => activeSenderExpr(d, c, {
    anyUnread: anyOf(sql`mc.unread`),
    anyUnreadInWindow: anyOf(sql`mc.unread and ${at} is not null and ${at} >= ${d.ts(c.cutoff)}`),
    newest: sql`max(${at})`,
  });
  const split = cutlineArms(set);
  const groupBy = "one" in split ? sql`lower(mc.from_address)` : sql`lower(mc.from_address), mc.mailbox_id`;
  const active = "one" in split ? activeAt(split.one) : perMailboxSql(d, split.arms, sql`mc.mailbox_id`, activeAt);
  return sql`exists (
    select 1 from messages mc
      join folder_state fsc on fsc.message_id = mc.id
     where mc.account_id = ${d.castUuid(accountId)}
       and fsc.desired_folder in ${folders}
       and lower(mc.from_address) = ${senderExpr}
     group by ${groupBy}
    having ${active}
  )`;
}

interface Row {
  messageId: string; fromAddress: string; sortAt: number; markedBrand: string | null; mailboxId: string;
  subject: string; snippet: string; observedFolder: string; unread: boolean; date: number | null;
}
type Rowish = {
  messageId: string; fromAddress: string; mailboxId: string; subject: string; snippet: string;
  observedFolder: string; unread: boolean | number; date: Date | null;
};
const asRow = (r: Rowish & { sortAt: Date; markedBrand: string | null }): Row => ({
  messageId: r.messageId, fromAddress: r.fromAddress, sortAt: r.sortAt.getTime(), markedBrand: r.markedBrand,
  mailboxId: r.mailboxId, subject: r.subject, snippet: r.snippet, observedFolder: r.observedFolder,
  unread: Boolean(r.unread), date: r.date === null ? null : new Date(r.date).getTime(),
});

/** The page and its total, the old way and the new way, through the service's own window. */
export class Probe extends ScreenerService {
  async newPage(ctx: ServiceContext, after: { time: number; messageId: string } | null, limit: number, cutline?: CutlineSet) {
    const { rows, total } = await this.heldSenderPage(ctx, { after, limit, ...(cutline ? { cutline } : {}), withTotal: after === null });
    return { rows: rows.map((r) => asRow(r as never)), total };
  }

  async oldPage(ctx: ServiceContext, after: { time: number; messageId: string } | null, limit: number, cutline?: CutlineSet) {
    const { reps, d } = this.heldSenderReps(ctx);
    const sender = sql`lower(${reps.fromAddress})`;
    const claim = cutline ? senderHasHeldClaimSql(d, ctx.accountId, sender, cutline, SCREENING_AUTH_VERDICTS) : undefined;
    // The held arrival asked of every sender, with no window mark in front of it.
    const arrival = cutline ? senderHasHeldArrivalSql(d, ctx.accountId, sender, cutline) : undefined;
    const filters = [
      eq(reps.rank, 1),
      cutline ? sql`(${groupedActiveSql(d, ctx.accountId, sender, cutline)} or ${claim} or ${arrival})` : undefined,
      claim
        ? sql`(not ${senderIsDecidedSql(d, ctx.accountId, sender)} or ${claim})`
        : sql`not ${senderIsDecidedSql(d, ctx.accountId, sender)}`,
      sql`not ${senderIsOwnSql(d, ctx.accountId, sender)}`,
    ];
    const raw = await ctx.db.select().from(reps)
      .where(and(...filters, after
        ? sql`(${reps.sortKey}, ${reps.messageId}) < (${d.ts(new Date(after.time))}, ${d.castUuid(after.messageId)})`
        : undefined))
      .orderBy(desc(reps.sortKey), desc(reps.messageId))
      .limit(limit);
    const rows = raw.map((r) => {
      const marked = Number(r.senderMarked ?? 0) === 1;
      return asRow({ ...r, sortAt: r.sortKey as Date, markedBrand: marked ? r.senderMarkedBrand ?? null : null } as never);
    });
    if (after !== null) return { rows, total: undefined };
    const field = (key: string) => d.jsonText(sql`o.payload`, key);
    const inFlight = sql`exists (
      select 1 from organizer_requests o
       where o.account_id = ${d.castUuid(ctx.accountId)}
         and o.state in ('pending', 'sent')
         and ${ruleNamesSenderSql(d, { kind: field("scope"), match: field("match"), destination: field("appliedFolder") }, sender)}
    )`;
    const [row] = await ctx.db.select({ n: sql<number | string>`count(*)` }).from(reps)
      .where(and(...filters, sql`not ${inFlight}`));
    return { rows, total: Number(row?.n ?? 0) };
  }
}

type PageOf = (after: { time: number; messageId: string } | null) => Promise<{ rows: Row[]; total: number | undefined }>;
async function walk(page: PageOf, limit: number): Promise<{ pages: Row[][]; total: number | undefined }> {
  const pages: Row[][] = [];
  let after: { time: number; messageId: string } | null = null;
  let total: number | undefined;
  for (let i = 0; i < 100; i++) {
    const p = await page(after);
    if (i === 0) total = p.total;
    pages.push(p.rows);
    if (p.rows.length < limit) return { pages, total };
    const last = p.rows[p.rows.length - 1]!;
    after = { time: last.sortAt, messageId: last.messageId };
  }
  throw new Error("the walk did not end");
}

/** The cutline asked per message names the same senders as the grouped form, under every window. */
export async function cutlineMatchesGrouped(w: World): Promise<void> {
  const d = dialect(w.db);
  const seen = new Set<string>();
  for (const [name, set] of cutlines(w)) {
    if (set === undefined) continue;
    const rows = await d.exec(w.db, sql`
      select x.addr,
             case when ${groupedActiveSql(d, w.accountId, sql`x.addr`, set)} then 1 else 0 end as grouped,
             case when ${senderIsActiveSql(d, w.accountId, sql`x.addr`, set)} then 1 else 0 end as per_row
        from (select distinct lower(m.from_address) as addr from messages m
               where m.account_id = ${d.castUuid(w.accountId)}) x
       order by 1`);
    expect(rows.length, name).toBeGreaterThan(40);
    for (const r of rows) {
      expect([String(r[0]), Number(r[2])], name).toEqual([String(r[0]), Number(r[1])]);
      seen.add(`${name}:${Number(r[1])}`);
    }
  }
  // Both answers occur under each window that can retire anybody: the comparison is not vacuous.
  for (const name of ["window", "baselined", "per mailbox"]) {
    expect(seen.has(`${name}:1`) && seen.has(`${name}:0`), name).toBe(true);
  }
}

/** Every page of every walk, and the first page's total, equal row for row under every window. */
export async function walksMatch(w: World): Promise<void> {
  const probe = new Probe({});
  const ctx = ctxOf(w);
  let marked = 0;
  let rows = 0;
  let arrived = 0;
  for (const [name, set] of cutlines(w)) {
    for (const limit of [3, 50]) {
      const before = await walk((after) => probe.oldPage(ctx, after, limit, set), limit);
      const after = await walk((a) => probe.newPage(ctx, a, limit, set), limit);
      expect(after.pages, `${name}, ${limit} a page`).toEqual(before.pages);
      expect(after.total, `${name}, ${limit} a page`).toBe(before.total);
      const all = after.pages.flat();
      rows += all.length;
      marked += all.filter((r) => r.markedBrand !== null).length;
      if (set !== undefined && name !== "all time") arrived += all.filter((r) => r.fromAddress === "arrival@d9.test").length;
      // The in-flight senders are on the pages and out of the total, as before.
      expect(after.total!, name).toBeLessThan(all.length);
    }
  }
  expect(rows, "the walks list somebody").toBeGreaterThan(0);
  expect(marked, "a marked sender reaches a page: the claim gate is exercised").toBeGreaterThan(0);
  expect(arrived, "a sender kept by a held arrival reaches a page under a window").toBeGreaterThan(0);
}
