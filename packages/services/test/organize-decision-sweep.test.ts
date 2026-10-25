import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  accounts, accountSettings, auditAction, auditLog, changeLog, folderState, mailboxes, messageBodies, messageStates,
  mailboxFolders, messageInstances, messageTags, messages, rules, tags, threads, type LedgerTx,
} from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { agreeSweepSlice, agreeSweepRun, makeDrizzleRepo, type AgreeSweepCursor } from "@trafficflow/core/adapters/drizzle-repo";
import { ScreenerService, organizeDecisionCount, setDormancyDays, type ServiceContext } from "../src/mail.js";

/**
 * THE ORGANIZE DECISION DOES WHAT ITS SCREEN SAYS, ON BOTH STORES.
 *
 * The window step names a count before the press; the organizer that spends the press's stamp moves
 * that set and nothing else. Run by the default PGlite project and by `pnpm test:sqlite`, the
 * device store the phone's engine runs on. Each refusal has its control beside it.
 */

const NOW = new Date("2026-10-09T14:00:00.000Z");
const AT = new Date("2026-10-09T14:00:30.000Z");
const DAY = 86_400_000;
const INBOX = "INBOX";
const GATE = "ohmail/Screener";

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `ods-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `ods-${accountId.slice(0, 8)}@example.test`,
    organizerRole: "reader",
  }).returning();
  return { db, accountId, mailboxId: mb!.id };
}
type World = Awaited<ReturnType<typeof world>>;

let n = 0;
async function seed(
  w: World, from: string, daysOld: number,
  opts: { decided?: boolean; noArrival?: boolean; storedAt?: Date; headers?: Record<string, string[]>; threadId?: string; date?: Date } = {},
): Promise<string> {
  const i = n++;
  const arrived = new Date(NOW.getTime() - daysOld * DAY);
  const [m] = await w.db.insert(messages).values({
    accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: `h${i}`, dedupKey: `ods:${randomUUID()}`,
    subject: `Letter ${i}`, fromAddress: from, date: opts.date ?? arrived, createdAt: opts.storedAt ?? NOW,
    arrivedAt: opts.noArrival ? null : arrived, unread: true, messageIdHeader: `l${i}@rig.test`,
    ...(opts.threadId ? { threadId: opts.threadId } : {}),
    nativeLocator: { folder: INBOX, ref: `1:${i}` },
  }).returning();
  await w.db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: opts.headers ?? {} });
  await w.db.insert(folderState).values({
    messageId: m!.id, desiredFolder: INBOX, observedFolder: INBOX, lastSetBy: "external",
    reconcileStatus: "reconciled", conflict: false, ...(opts.decided ? { decidedAt: arrived } : {}),
  });
  return m!.id;
}

const ctxOf = (w: World): ServiceContext => ({
  db: w.db as unknown as ServiceContext["db"], accountId: w.accountId, userId: null,
  now: () => NOW, requestId: `ods-${randomUUID().slice(0, 8)}`,
});

/**
 * What the consent transaction of a person's first agree writes, at one instant (`organizeHere`).
 * `cutoff` is the window the record names (null all time); absent, a record from before it did.
 */
async function agreed(w: World, opts: { record: boolean; cutoff?: Date | null }): Promise<void> {
  await w.db.insert(accountSettings).values({ accountId: w.accountId, screeningBaselineAt: AT, dormancyDays: 365, screeningScope: "window" })
    .onConflictDoNothing();
  await w.db.update(mailboxes).set({ organizeConsentedAt: AT, takeoverAuthorizedAt: AT })
    .where(eq(mailboxes.id, w.mailboxId));
  if (opts.record) {
    await w.db.insert(auditLog).values({
      accountId: w.accountId, action: auditAction("organizer.agree_screens_backlog"),
      payload: opts.cutoff === undefined ? { mailboxId: w.mailboxId }
        : { mailboxId: w.mailboxId, cutoff: opts.cutoff === null ? null : opts.cutoff.toISOString() },
      createdAt: AT,
    });
  }
}

/** The gate's promotion: the role flips and the stamp is spent. */
async function promote(w: World): Promise<void> {
  await w.db.update(mailboxes).set({ organizerRole: "organizer", takeoverAuthorizedAt: null })
    .where(eq(mailboxes.id, w.mailboxId));
}

const knowledge = {
  knowledgeFor: (tx: unknown) => makeDrizzleRepo(tx as never),
  ledgerOf: (tx: unknown) => tx as LedgerTx,
};

/** One slice, as the hosts' run calls it. */
const sweep = (
  w: World, stamp: Date, held: boolean | "unread" = false,
  o: { now?: Date; cursor?: AgreeSweepCursor | null; slice?: number } = {},
) => agreeSweepSlice(w.db as never, {
  accountId: w.accountId, mailboxId: w.mailboxId, stamp, held, now: o.now ?? AT, ...knowledge,
  ...(o.cursor !== undefined ? { cursor: o.cursor } : {}), ...(o.slice !== undefined ? { slice: o.slice } : {}),
});

/** The run both hosts call once per organizing drain. */
const sweepRun = (w: World, o: { now?: Date; cursor?: AgreeSweepCursor | null; slice?: number; maxSlices?: number } = {}) =>
  agreeSweepRun(w.db as never, {
    accountId: w.accountId, mailboxId: w.mailboxId, stamp: AT, held: false, now: o.now ?? AT, ...knowledge,
    cursor: o.cursor ?? null, ...(o.slice !== undefined ? { slice: o.slice } : {}),
    ...(o.maxSlices !== undefined ? { maxSlices: o.maxSlices } : {}),
  });

/** Many letters in a few statements, each a day-fraction older than the last; returns ids in order. */
async function bulk(w: World, rows: ReadonlyArray<{ from: string; daysOld: number }>, tag: string): Promise<string[]> {
  const ids: string[] = [];
  for (let at = 0; at < rows.length; at += 250) {
    const part = rows.slice(at, at + 250);
    const made = await w.db.insert(messages).values(part.map((r, j) => {
      const arrived = new Date(NOW.getTime() - r.daysOld * DAY - (at + j) * 1000);
      return {
        accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: `${tag}${at + j}`, dedupKey: `ods:${randomUUID()}`,
        subject: `${tag} ${at + j}`, fromAddress: r.from, date: arrived, createdAt: NOW, arrivedAt: arrived,
        unread: true, nativeLocator: { folder: INBOX, ref: `7:${tag}${at + j}` },
      };
    })).returning({ id: messages.id, subject: messages.subject });
    for (const m of made) ids[Number(m.subject.slice(tag.length + 1))] = m.id;
    await w.db.insert(messageBodies).values(made.map((m) => ({ messageId: m.id, text: "", html: null, headers: {} })));
    await w.db.insert(folderState).values(made.map((m) => ({
      messageId: m.id, desiredFolder: INBOX, observedFolder: INBOX, lastSetBy: "external" as const,
      reconcileStatus: "reconciled" as const, conflict: false,
    })));
  }
  return ids;
}

const inInbox = async (w: World, ids: readonly string[]): Promise<number> => {
  let left = 0;
  for (const id of ids) if (await desired(w, id) === INBOX) left++;
  return left;
};

/** Where the letter is, whether it is unread, and how many change rows name it. */
const untouched = async (w: World, id: string) => {
  const [fs] = await w.db.select({ d: folderState.desiredFolder, o: folderState.observedFolder })
    .from(folderState).where(eq(folderState.messageId, id));
  const [m] = await w.db.select({ unread: messages.unread }).from(messages).where(eq(messages.id, id));
  const rows = await w.db.select({ seq: changeLog.seq }).from(changeLog)
    .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.entityId, id)));
  return { desired: fs!.d, observed: fs!.o, unread: m!.unread, changes: rows.length };
};
const STAY = { desired: INBOX, observed: INBOX, unread: true, changes: 0 };

const desired = async (w: World, id: string): Promise<string> =>
  (await w.db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id)))[0]!.d;

/** Three never-decided senders, 18 letters minutes old — the finding's shape. */
async function backlog(w: World): Promise<string[]> {
  const ids: string[] = [];
  for (const who of ["wren@rig.test", "rook@rig.test", "kite@rig.test"]) {
    for (let i = 0; i < 6; i++) ids.push(await seed(w, who, 0));
  }
  return ids;
}

describe("the organize decision moves exactly what it counted", () => {
  it("the count before the press equals what the organizer moves after it", async () => {
    const w = await world();
    const ids = await backlog(w);
    const before = await organizeDecisionCount(ctxOf(w), w.mailboxId, { dormancyDays: 365, scope: "window" });
    expect(before).toMatchObject({ letters: 18, senders: 3, total: 18, complete: true });

    await agreed(w, { record: true });
    await promote(w);
    const out = await sweep(w, AT);
    expect(out).toEqual({ kind: "swept", total: before.letters, senders: before.senders, next: null });
    for (const id of ids) expect(await desired(w, id)).toBe(GATE);
    // Once: the moved letters leave the set.
    expect(await sweep(w, AT)).toEqual({ kind: "swept", total: 0, senders: 0, next: null });
  });

  it("nothing outside the window moves, and the count leaves it out too", async () => {
    const w = await world();
    const inside = await seed(w, "fresh@rig.test", 10);
    const outside = await seed(w, "olden@rig.test", 800);
    // Half a day past the window's edge: inside the read's slack, outside the window itself.
    const edge = await seed(w, "edge@rig.test", 365.5);
    const c = await organizeDecisionCount(ctxOf(w), w.mailboxId, { dormancyDays: 365, scope: "window" });
    expect(c).toMatchObject({ letters: 1, senders: 1 });
    await agreed(w, { record: true });
    await promote(w);
    await sweep(w, AT);
    expect(await desired(w, inside)).toBe(GATE);
    expect(await desired(w, outside)).toBe(INBOX);
    expect(await desired(w, edge)).toBe(INBOX);
  });

  it("CONTROL — all time takes the old letter too, in the count and the move alike", async () => {
    const w = await world();
    const outside = await seed(w, "olden@rig.test", 800);
    expect(await organizeDecisionCount(ctxOf(w), w.mailboxId, { scope: "all_time" }))
      .toMatchObject({ letters: 1, senders: 1 });
    await agreed(w, { record: true });
    await w.db.update(accountSettings).set({ screeningScope: "all_time" }).where(eq(accountSettings.accountId, w.accountId));
    await promote(w);
    await sweep(w, AT);
    expect(await desired(w, outside)).toBe(GATE);
  });

  it("a person's own filing stays: a letter they moved, one in a pile, one tagged, a sender they decided", async () => {
    const w = await world();
    const moved = await seed(w, "moved@rig.test", 1, { decided: true });
    const piled = await seed(w, "piled@rig.test", 1);
    await w.db.insert(messageStates).values({ accountId: w.accountId, messageId: piled, state: "reply_later" });
    const tagged = await seed(w, "tagged@rig.test", 1);
    const [tag] = await w.db.insert(tags).values({ accountId: w.accountId, name: "keep" }).returning();
    await w.db.insert(messageTags).values({ accountId: w.accountId, messageId: tagged, tagId: tag!.id });
    const ruled = await seed(w, "ruled@rig.test", 1);
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "ruled@rig.test", destination: "INBOX",
      provenance: "manual", enabled: true, priority: 0, retroRequestedAt: null,
    });
    const stranger = await seed(w, "stranger@rig.test", 1);
    expect(await organizeDecisionCount(ctxOf(w), w.mailboxId, { dormancyDays: 365, scope: "window" }))
      .toMatchObject({ letters: 1, senders: 1 });
    await agreed(w, { record: true });
    await promote(w);
    expect(await sweep(w, AT)).toEqual({ kind: "swept", total: 1, senders: 1, next: null });
    for (const id of [moved, piled, tagged, ruled]) expect(await desired(w, id)).toBe(INBOX);
    expect(await desired(w, stranger)).toBe(GATE);
  });
});

describe("only the promotion that spends a person's first agree sweeps", () => {
  it("a stamp with no agree record (a claim-back, a takeover, a machine press) moves nothing", async () => {
    const w = await world();
    const ids = await backlog(w);
    await agreed(w, { record: false });
    await promote(w);
    expect(await sweep(w, AT)).toEqual({ kind: "not_an_agree" });
    for (const id of ids) expect(await desired(w, id)).toBe(INBOX);
  });

  it("a LATER stamp over an earlier consent moves nothing, though the earlier agree was recorded", async () => {
    const w = await world();
    await backlog(w);
    await agreed(w, { record: true });
    expect(await sweep(w, new Date(AT.getTime() + 60_000))).toEqual({ kind: "not_organizer" });
    await promote(w);
    expect(await sweep(w, new Date(AT.getTime() + 60_000))).toEqual({ kind: "not_an_agree" });
  });

  it("a travelling profile document holds the history: nothing moves", async () => {
    const w = await world();
    const ids = await backlog(w);
    await agreed(w, { record: true });
    await promote(w);
    expect(await sweep(w, AT, true)).toEqual({ kind: "held" });
    for (const id of ids) expect(await desired(w, id)).toBe(INBOX);
  });

  it("decline: no consent and no stamp — the row stays a reader and nothing is written", async () => {
    const w = await world();
    const ids = await backlog(w);
    expect(await sweep(w, AT)).toEqual({ kind: "not_organizer" });
    for (const id of ids) expect(await desired(w, id)).toBe(INBOX);
    const [row] = await w.db.select({ c: mailboxes.organizeConsentedAt }).from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    expect(row!.c).toBeNull();
    const marks = await w.db.select().from(auditLog)
      .where(and(eq(auditLog.accountId, w.accountId), eq(auditLog.action, auditAction("screener.unscreened_sweep"))));
    expect(marks).toHaveLength(0);
  });

  it("the sweep writes one undo row per sender, marked as the agree's", async () => {
    const w = await world();
    await backlog(w);
    await agreed(w, { record: true });
    await promote(w);
    await sweep(w, AT);
    const rows = await w.db.select({ payload: auditLog.payload, inverse: auditLog.inverse }).from(auditLog)
      .where(and(eq(auditLog.accountId, w.accountId), eq(auditLog.action, auditAction("screener.unscreened_sweep"))));
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.payload).toMatchObject({ count: 6, from: INBOX, to: GATE, via: "agree" });
      expect(r.inverse).toMatchObject({ from: GATE, to: INBOX });
    }
  });
});

describe("the hand-back's rulings", () => {
  it("a letter with no recorded arrival is outside the agree window, however recent; CONTROL — recorded inside, it moves", async () => {
    const w = await world();
    const legacy = await seed(w, "legacy@rig.test", 800, { noArrival: true });
    const lately = await seed(w, "lately@rig.test", 1, { noArrival: true });
    const recorded = await seed(w, "recorded@rig.test", 10);
    expect(await organizeDecisionCount(ctxOf(w), w.mailboxId, { dormancyDays: 60, scope: "window" }))
      .toMatchObject({ letters: 1, senders: 1 });
    await agreed(w, { record: true });
    await w.db.update(accountSettings).set({ dormancyDays: 60 }).where(eq(accountSettings.accountId, w.accountId));
    await promote(w);
    expect(await sweep(w, AT)).toEqual({ kind: "swept", total: 1, senders: 1, next: null });
    expect(await desired(w, legacy)).toBe(INBOX);
    expect(await desired(w, lately)).toBe(INBOX);
    expect(await desired(w, recorded)).toBe(GATE);
  });

  it("an answer to the person's own message is never swept; CONTROL — the same letter citing nothing is", async () => {
    const w = await world();
    const own = (await w.db.select({ a: mailboxes.address }).from(mailboxes).where(eq(mailboxes.id, w.mailboxId)))[0]!.a;
    // The gate's own evidence: a Sent folder, the copy's instance in it, written after the mailbox was connected.
    await w.db.update(mailboxes).set({ createdAt: new Date(NOW.getTime() - 30 * DAY), sentFolder: "Sent" })
      .where(eq(mailboxes.id, w.mailboxId));
    await w.db.insert(mailboxFolders).values({ mailboxId: w.mailboxId, folder: "Sent" });
    const [th] = await w.db.insert(threads).values({ accountId: w.accountId, subject: "plan", rootMessageIdHeader: "own-1@rig.test" }).returning();
    const sentAt = new Date(NOW.getTime() - 2 * DAY);
    const [sent] = await w.db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "sent", dedupKey: `ods:${randomUUID()}`, subject: "plan",
      fromAddress: own, date: sentAt, createdAt: sentAt, arrivedAt: sentAt, unread: false, threadId: th!.id,
      messageIdHeader: "own-1@rig.test", toAddresses: [{ name: null, address: "team@lists.rig.test" }],
      nativeLocator: { folder: "Sent", ref: "1:1" },
    }).returning();
    await w.db.insert(messageBodies).values({ messageId: sent!.id, text: "", html: null, headers: {} });
    await w.db.insert(messageInstances).values({
      accountId: w.accountId, mailboxId: w.mailboxId, messageId: sent!.id, folder: "Sent", uidvalidity: 1n, uid: 1, isPrimary: true,
    });
    await w.db.insert(folderState).values({
      messageId: sent!.id, desiredFolder: "Sent", observedFolder: "Sent", lastSetBy: "external", reconcileStatus: "reconciled", conflict: false,
    });
    const cites = { "in-reply-to": ["<own-1@rig.test>"], references: ["<own-1@rig.test>"] };
    const reply = await seed(w, "x@rig.test", 1, { headers: cites, threadId: th!.id });
    const stranger = await seed(w, "y@rig.test", 1);
    expect(await organizeDecisionCount(ctxOf(w), w.mailboxId, { dormancyDays: 60, scope: "window" }))
      .toMatchObject({ letters: 1, senders: 1 });
    await agreed(w, { record: true });
    await promote(w);
    expect(await sweep(w, AT)).toEqual({ kind: "swept", total: 1, senders: 1, next: null });
    expect(await desired(w, reply)).toBe(INBOX);
    expect(await desired(w, stranger)).toBe(GATE);
  });

  it("slice 1 takes the newest 1,000 by arrival and slice 2 the rest", async () => {
    const w = await world();
    // Stored oldest first, so neither the insert order nor the id order is the arrival order asked for.
    const rows = Array.from({ length: 1003 }, (_, k) => ({ k, arrived: new Date(NOW.getTime() - (k + 1) * 60_000) })).reverse();
    const ids: string[] = new Array<string>(1003);
    for (let at = 0; at < rows.length; at += 250) {
      const part = rows.slice(at, at + 250);
      const made = await w.db.insert(messages).values(part.map((r) => ({
        accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: `b${r.k}`, dedupKey: `ods:${randomUUID()}`,
        subject: `Bulk ${r.k}`, fromAddress: `s${r.k % 7}@bulk.test`, date: r.arrived, createdAt: NOW, arrivedAt: r.arrived,
        unread: true, nativeLocator: { folder: INBOX, ref: `9:${r.k}` },
      }))).returning({ id: messages.id, subject: messages.subject });
      for (const m of made) ids[Number(m.subject.slice("Bulk ".length))] = m.id;
      await w.db.insert(messageBodies).values(made.map((m) => ({ messageId: m.id, text: "", html: null, headers: {} })));
      await w.db.insert(folderState).values(made.map((m) => ({
        messageId: m.id, desiredFolder: INBOX, observedFolder: INBOX, lastSetBy: "external" as const,
        reconcileStatus: "reconciled" as const, conflict: false,
      })));
    }
    expect(await organizeDecisionCount(ctxOf(w), w.mailboxId, { dormancyDays: 365, scope: "window" }))
      .toMatchObject({ letters: 1003, senders: 7, total: 1003, complete: true });
    await agreed(w, { record: true });
    await promote(w);
    const first = await sweep(w, AT);
    expect(first).toMatchObject({ kind: "swept", total: 1000, next: { storedBy: AT } });
    for (const k of [0, 1, 999]) expect(await desired(w, ids[k]!)).toBe(GATE);
    for (const k of [1000, 1001, 1002]) expect(await desired(w, ids[k]!)).toBe(INBOX);
    const second = await sweep(w, AT, false, { cursor: first.kind === "swept" ? first.next : null });
    expect(second).toEqual({ kind: "swept", total: 3, senders: 3, next: null });
    for (const k of [1000, 1001, 1002]) expect(await desired(w, ids[k]!)).toBe(GATE);
    // 1003 letters through the store and the sweep: up to 7.9 s on the CI VMs and 200 s under 10% of a
    // CPU, past the 5 s default only because it never yields. No wait of its own.
  }, 300_000);

  it("a sender whose letters all sit past the first slice reaches the Screener (1,000 + 5)", async () => {
    const w = await world();
    const newer = await bulk(w, Array.from({ length: 1000 }, (_, k) => ({ from: `s${k % 7}@bulk.test`, daysOld: 1 })), "n");
    const late = await bulk(w, Array.from({ length: 5 }, () => ({ from: "late@bulk.test", daysOld: 30 })), "l");
    const old = await bulk(w, [{ from: "olden@bulk.test", daysOld: 800 }], "o");
    await agreed(w, { record: true });
    await promote(w);
    expect(await sweepRun(w)).toEqual({ verdict: "swept", total: 1005, senders: 8, slices: 2, next: null });
    expect(await inInbox(w, [...newer, ...late])).toBe(0);
    // CONTROL: outside the window stays where it is.
    expect(await desired(w, old[0]!)).toBe(INBOX);
  }, 300_000);

  it("a thousand letters from more senders than the 200 groups a press shows all move", async () => {
    const w = await world();
    const ids = await bulk(w, Array.from({ length: 1000 }, (_, k) => ({ from: `g${k % 250}@grp.test`, daysOld: 1 })), "g");
    await agreed(w, { record: true });
    await promote(w);
    expect(await sweepRun(w)).toMatchObject({ verdict: "swept", total: 1000, senders: 250, next: null });
    expect(await inInbox(w, ids)).toBe(0);
  }, 300_000);

  it("a drain's run stops at its slice bound and the next drain goes on from the cursor", async () => {
    const w = await world();
    const ids = await bulk(w, Array.from({ length: 7 }, (_, k) => ({ from: `p${k}@rig.test`, daysOld: 1 })), "p");
    await agreed(w, { record: true });
    await promote(w);
    const one = await sweepRun(w, { slice: 2, maxSlices: 2 });
    expect(one).toMatchObject({ verdict: "swept", total: 4, slices: 2, next: { storedBy: AT } });
    expect(await inInbox(w, ids)).toBe(3);
    const two = await sweepRun(w, { slice: 2, maxSlices: 2, cursor: one.next });
    expect(two).toMatchObject({ total: 3, next: null });
    expect(await inInbox(w, ids)).toBe(0);
  });

  it("a cursor whose letter vanished still finishes, from the top", async () => {
    const w = await world();
    const ids = await bulk(w, Array.from({ length: 5 }, (_, k) => ({ from: `v${k}@rig.test`, daysOld: 1 })), "v");
    await agreed(w, { record: true });
    await promote(w);
    const gone: AgreeSweepCursor = { storedBy: AT, after: randomUUID(), agreed: new Date(AT.getTime() - 365 * DAY) };
    expect(await sweepRun(w, { cursor: gone })).toMatchObject({ verdict: "swept", total: 5, next: null });
    expect(await inInbox(w, ids)).toBe(0);
  });

  it("while the import reads, the count names every in-window letter and sender: 1,250 from 220", async () => {
    const w = await world();
    await bulk(w, Array.from({ length: 1250 }, (_, k) => ({ from: `f${k % 220}@fx.test`, daysOld: 1 })), "f");
    await bulk(w, Array.from({ length: 30 }, (_, k) => ({ from: `f${k % 220}@fx.test`, daysOld: 800 })), "x");
    expect(await organizeDecisionCount(ctxOf(w), w.mailboxId, { dormancyDays: 365, scope: "window" }))
      .toMatchObject({ letters: 1250, senders: 220, total: 1250, complete: true, mirrored: false });
  }, 300_000);

  it("undated letters never stand in front of a dated one: under All time the dated letter moves, the undated stay", async () => {
    const w = await world();
    const undated: string[] = [];
    for (let at = 0; at < 201; at += 67) {
      const made = await w.db.insert(messages).values(Array.from({ length: 67 }, (_, j) => ({
        accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: `u${at + j}`, dedupKey: `ods:${randomUUID()}`,
        subject: `Undated ${at + j}`, fromAddress: `old${(at + j) % 5}@legacy.test`, date: NOW, createdAt: NOW, arrivedAt: null,
        unread: false, nativeLocator: { folder: INBOX, ref: `8:${at + j}` },
      }))).returning({ id: messages.id });
      undated.push(...made.map((m) => m.id));
      await w.db.insert(messageBodies).values(made.map((m) => ({ messageId: m.id, text: "", html: null, headers: {} })));
      await w.db.insert(folderState).values(made.map((m) => ({
        messageId: m.id, desiredFolder: INBOX, observedFolder: INBOX, lastSetBy: "external" as const,
        reconcileStatus: "reconciled" as const, conflict: false,
      })));
    }
    const dated = await seed(w, "dated@rig.test", 3);
    expect(await organizeDecisionCount(ctxOf(w), w.mailboxId, { scope: "all_time" })).toMatchObject({ letters: 1, senders: 1 });
    await agreed(w, { record: true });
    await w.db.update(accountSettings).set({ screeningScope: "all_time" }).where(eq(accountSettings.accountId, w.accountId));
    await promote(w);
    expect(await sweep(w, AT)).toEqual({ kind: "swept", total: 1, senders: 1, next: null });
    expect(await desired(w, dated)).toBe(GATE);
    for (const id of [undated[0]!, undated[200]!]) expect(await desired(w, id)).toBe(INBOX);
  });

  it("a settings folder that could not be read, or held a garbled document, moves nothing", async () => {
    const w = await world();
    const ids = await backlog(w);
    await agreed(w, { record: true });
    await promote(w);
    expect(await sweep(w, AT, "unread")).toEqual({ kind: "unread" });
    for (const id of ids) expect(await desired(w, id)).toBe(INBOX);
    // CONTROL: the clean read after it sweeps the same letters.
    expect(await sweep(w, AT, false)).toEqual({ kind: "swept", total: 18, senders: 3, next: null });
  });

  it("mail stored between the press and the promotion is swept; the count says while it is still reading", async () => {
    const w = await world();
    const before = await seed(w, "early@rig.test", 1);
    expect(await organizeDecisionCount(ctxOf(w), w.mailboxId, { dormancyDays: 60, scope: "window" }))
      .toMatchObject({ letters: 1, mirrored: false });
    await agreed(w, { record: true });
    const after = await seed(w, "late@rig.test", 1, { storedAt: new Date(AT.getTime() + 60_000) });
    await promote(w);
    const start = new Date(AT.getTime() + 120_000);
    const first = await sweep(w, AT, false, { now: start, slice: 1 });
    expect(first).toMatchObject({ kind: "swept", total: 1, next: { storedBy: start } });
    // Stored after the sweep started: the organizer's own gate takes it, not the sweep.
    const later = await seed(w, "later@rig.test", 1, { storedAt: new Date(start.getTime() + 60_000) });
    const second = await sweep(w, AT, false, { now: new Date(start.getTime() + 120_000), cursor: first.kind === "swept" ? first.next : null });
    expect(second).toMatchObject({ kind: "swept", total: 1 });
    expect(await desired(w, before)).toBe(GATE);
    expect(await desired(w, after)).toBe(GATE);
    expect(await desired(w, later)).toBe(INBOX);
    await w.db.update(mailboxes).set({ initialImportCompletedAt: AT }).where(eq(mailboxes.id, w.mailboxId));
    expect(await organizeDecisionCount(ctxOf(w), w.mailboxId, { dormancyDays: 60, scope: "window" }))
      .toMatchObject({ mirrored: true });
  });
});

describe("the sweep keeps to the window the person saw and agreed to", () => {
  it("migrated mail (an old Date, a recent arrival) is neither counted nor swept; CONTROL — both inside moves and is listed", async () => {
    const w = await world();
    const old = new Date(NOW.getTime() - 800 * DAY);
    const migrated: string[] = [];
    for (const who of ["mig1@rig.test", "mig2@rig.test", "mig1@rig.test"]) migrated.push(await seed(w, who, 3, { date: old }));
    const fresh = await seed(w, "fresh@rig.test", 3);
    expect(await organizeDecisionCount(ctxOf(w), w.mailboxId, { dormancyDays: 365, scope: "window" }))
      .toMatchObject({ letters: 1, senders: 1 });
    await agreed(w, { record: true });
    await promote(w);
    expect(await sweepRun(w)).toMatchObject({ verdict: "swept", total: 1, senders: 1, next: null });
    for (const id of migrated) expect(await untouched(w, id)).toEqual(STAY);
    expect(await desired(w, fresh)).toBe(GATE);
    const page = await new ScreenerService({ adapter: {} as never }).list(ctxOf(w), {});
    expect(page.items.map((i) => i.sender.address)).toEqual(["fresh@rig.test"]);
  });

  /** Two fresh letters, one 200 days old and one 800: slice 1 takes one fresh letter. */
  async function halfSwept(w: World, cutoff?: Date | null) {
    const ids = {
      fresh: [await seed(w, "a@rig.test", 1), await seed(w, "b@rig.test", 2)],
      mid: await seed(w, "mid@rig.test", 200),
      old: await seed(w, "old@rig.test", 800),
    };
    await agreed(w, { record: true, ...(cutoff !== undefined ? { cutoff } : {}) });
    await promote(w);
    const first = await sweepRun(w, { slice: 1, maxSlices: 1 });
    expect(first).toMatchObject({ verdict: "swept", total: 1 });
    return { ids, next: first.next };
  }

  it("a window widened to All time while slices remain moves nothing older than the agreed one", async () => {
    const w = await world();
    const { ids, next } = await halfSwept(w, new Date(AT.getTime() - 365 * DAY));
    await setDormancyDays(ctxOf(w), undefined, "all_time");
    expect(await sweepRun(w, { slice: 1, cursor: next })).toMatchObject({ verdict: "swept", total: 2, next: null });
    expect(await inInbox(w, [...ids.fresh, ids.mid])).toBe(0);
    expect(await untouched(w, ids.old)).toEqual(STAY);
  });

  it("a record from before the window was named: the first slice's window holds for the rest", async () => {
    const w = await world();
    const { ids, next } = await halfSwept(w);
    await setDormancyDays(ctxOf(w), undefined, "all_time");
    expect(await sweepRun(w, { slice: 1, cursor: next })).toMatchObject({ total: 2, next: null });
    expect(await untouched(w, ids.old)).toEqual(STAY);
  });

  it("CONTROL — a window narrowed to 90 days while slices remain narrows the rest", async () => {
    const w = await world();
    const { ids, next } = await halfSwept(w, new Date(AT.getTime() - 365 * DAY));
    await setDormancyDays(ctxOf(w), 90);
    expect(await sweepRun(w, { slice: 1, cursor: next })).toMatchObject({ total: 1, next: null });
    expect(await inInbox(w, ids.fresh)).toBe(0);
    for (const id of [ids.mid, ids.old]) expect(await untouched(w, id)).toEqual(STAY);
  });

  it("CONTROL — agreed to All time, the old letter moves", async () => {
    const w = await world();
    await w.db.insert(accountSettings).values({ accountId: w.accountId, screeningBaselineAt: AT, screeningScope: "all_time" });
    const { ids, next } = await halfSwept(w, null);
    expect(await sweepRun(w, { slice: 1, cursor: next })).toMatchObject({ total: 3, next: null });
    expect(await desired(w, ids.old)).toBe(GATE);
  });
});
