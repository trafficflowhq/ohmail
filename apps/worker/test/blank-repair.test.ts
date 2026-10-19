import { describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import {
  UNMETERED_STORAGE_CAP, commitChange, createLogger, planChange, type Change, type NativeLocator,
} from "@trafficflow/core/mail";
import { MessageGoneError, parseRef, type MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import {
  accounts, changeLog, folderState, mailboxes, messageFailures, messageInstances, messages, type Tx,
} from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  BLANK_REPAIR_RETRY_BASE_MS, blankRepairPass, newBlankRepairMemory, type BlankRepairMemory,
} from "../src/blank-repair.js";
import { FIXTURE_AUTHORITY } from "./_door.js";

/**
 * THE BLANK REPAIR ON THE STORE (IMAP-STREAMING-FETCH-TAKES-UNSOLICITED-FLAGS), on both store types
 * (this file is in the SQLite run too), against a fake server that holds the real letters.
 *
 * The damage, seeded as an older build left it: one blank row (what an empty source parses to; a
 * one-blank-line letter normalizes to the same row) holding three places. Its primary is in
 * ohmail/Screener, where its own move filed letter 0; a hidden place in INBOX holds letter 1; a place
 * in Sent holds the person's own letter 2. The server holds the three real letters there. Apply sends
 * letter 0 back to INBOX, releases the other two with a re-read owed, and leaves the blank to the
 * reaper; dry writes nothing anywhere; a second run writes nothing; a real content-free letter is kept;
 * a reader moves nothing.
 *
 * ONE PROCESS IS ONE MEMORY (`newBlankRepairMemory`): visits that share one are one process's, and
 * no place is downloaded twice by one — dry counts from what it read, and a place whose read or
 * move failed waits, longer each time, instead of being fetched on every cycle.
 */

const EPOCH = "7";
const letter = (n: number, from: string): Buffer => Buffer.from([
  `Message-ID: <letter-${n}@x.example>`, `From: ${from}`, "To: mila@lichtgrat.example", `Subject: letter ${n}`,
  "Date: Mon, 19 Oct 2026 09:00:00 +0000", "Content-Type: text/plain; charset=utf-8", "", `body ${n}`,
].join("\r\n"));

/** A mail server that holds letters by folder and UID, re-reads them and moves them. */
function fakeServer(seed: Record<string, Record<number, Buffer>>) {
  const boxes = new Map(Object.entries(seed).map(([f, m]) => [f, new Map(Object.entries(m).map(([u, b]) => [Number(u), b]))]));
  const moves: string[] = [];
  const reads: string[] = [];
  let bytes = 0;
  let moveAttempts = 0;
  let nextUid = 100;
  let failReads = false;
  const failing = new Set<string>();
  const refusing = new Set<string>();
  let duringRead: (() => Promise<void>) | undefined;
  const adapter = {
    async fetchByUid(folder: string, uids: readonly number[], opts: { maxBytes?: number } = {}) {
      reads.push(`${folder}:${uids.join(",")}`);
      if (failReads || failing.has(folder)) throw new Error("the connection dropped");
      await duringRead?.();
      const box = boxes.get(folder) ?? new Map<number, Buffer>();
      const creates: Change[] = [];
      const absent: number[] = [];
      const oversize: number[] = [];
      for (const uid of uids) {
        const raw = box.get(uid);
        if (raw === undefined) absent.push(uid);
        else if (opts.maxBytes !== undefined && raw.length > opts.maxBytes) oversize.push(uid);
        else {
          bytes += raw.length;
          creates.push({ type: "create", locator: { folder, ref: `${EPOCH}:${uid}` }, raw, seen: false });
        }
      }
      return { uidValidity: EPOCH, creates, absent, oversize };
    },
    async move(locator: NativeLocator, toFolder: string): Promise<NativeLocator> {
      moveAttempts++;
      // Neither gone nor a refusal: a server that will not take this move (an ambiguous INBOX, a
      // copy whose source survived), which the repair can only try again later.
      if (refusing.has(locator.folder)) throw new Error("the move could not be verified");
      const { uid } = parseRef(locator.ref);
      const raw = boxes.get(locator.folder)?.get(uid);
      if (raw === undefined) throw new MessageGoneError(locator, true);
      boxes.get(locator.folder)!.delete(uid);
      const to = boxes.get(toFolder) ?? new Map<number, Buffer>();
      const landed = nextUid++;
      to.set(landed, raw);
      boxes.set(toFolder, to);
      moves.push(`${locator.folder}:${uid} -> ${toFolder}:${landed}`);
      return { folder: toFolder, ref: `${EPOCH}:${landed}` };
    },
  } as unknown as MailboxAdapter;
  const held = (folder: string): string[] => [...(boxes.get(folder)?.values() ?? [])].map((b) => /Message-ID: <([^>]+)>/.exec(b.toString())?.[1] ?? "");
  return {
    adapter, moves, reads, held, failReads: () => { failReads = true; },
    duringRead: (fn: () => Promise<void>) => { duringRead = fn; },
    failFolder: (folder: string) => { failing.add(folder); },
    refuseMovesFrom: (folder: string) => { refusing.add(folder); },
    takeMovesFrom: (folder: string) => { refusing.delete(folder); },
    /** Every byte of letter this server has handed over: the download a visit costs. */
    bytes: () => bytes,
    moveAttempts: () => moveAttempts,
  };
}

interface PassOpts {
  role?: "organizer" | "reader";
  /** The process this visit runs in; a fresh one when absent. */
  memory?: BlankRepairMemory;
  at?: Date;
  placesPerVisit?: number;
}

async function world() {
  const db = (await makeTestDb()) as unknown as Tx;
  const [a] = await db.insert(accounts).values({ name: "blank-repair" }).returning();
  const accountId = a!.id;
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "mila@lichtgrat.example" }).returning();
  const mailboxId = mb!.id;
  const repo = makeDrizzleRepo(db);
  /** One real ingest, plan and commit in one transaction, as the cycle does. */
  const ingest = (folder: string, uid: number, raw: Buffer) => db.transaction(async (tx) => {
    const r = makeDrizzleRepo(tx as never);
    const change: Change = { type: "create", locator: { folder, ref: `${EPOCH}:${uid}` }, raw, seen: false };
    const plan = await planChange(change, { repo: r, accountId, mailboxId, readerMode: false });
    return commitChange(plan, { storageCap: UNMETERED_STORAGE_CAP, repo: r, accountId, mailboxId });
  });
  /** The blank as an older build stored it: its first place, then the others joined as instances. */
  const blankAt = async (primary: { folder: string; uid: number }, others: Array<{ folder: string; uid: number }>,
    fs: { desired: string; observed: string; lastSetBy: "us" | "external" }) => {
    const { messageId } = await ingest(primary.folder, primary.uid, Buffer.from("\r\n"));
    for (const o of others) await repo.recordInstance(messageId, { folder: o.folder, ref: `${EPOCH}:${o.uid}` });
    await repo.upsertFolderState(messageId, { desiredFolder: fs.desired, observedFolder: fs.observed, lastSetBy: fs.lastSetBy });
    return messageId;
  };
  const lines: string[] = [];
  const pass = (adapter: MailboxAdapter, mode: "dry" | "apply", opts: PassOpts = {}) =>
    blankRepairPass({
      repo, adapter, accountId, mailboxId, role: opts.role ?? "organizer", mode,
      memory: opts.memory ?? newBlankRepairMemory(),
      ...(opts.at !== undefined ? { now: () => opts.at! } : {}),
      ...(opts.placesPerVisit !== undefined ? { placesPerVisit: opts.placesPerVisit } : {}),
      write: (fn) => repo.transaction(fn), writeAuthority: FIXTURE_AUTHORITY, version: "test-build",
      log: createLogger({ service: "worker", level: "info", sink: (l) => lines.push(l) }),
    });
  const bigints = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);
  const snapshot = async (): Promise<string> => JSON.stringify(await Promise.all([
    db.select().from(messages).orderBy(messages.id),
    db.select().from(messageInstances).orderBy(messageInstances.id),
    db.select().from(folderState).orderBy(folderState.id),
    db.select().from(messageFailures).orderBy(messageFailures.id),
    db.select().from(changeLog).orderBy(changeLog.seq),
  ]), bigints);
  /** The `blank_repair` lines, counts only: the stamp, the level and the ids taken off. */
  const said = (): Array<Record<string, unknown>> => lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.event === "blank_repair")
    .map(({ ts: _t, level: _l, service: _s, event: _e, mailboxId: _m, accountId: _a, ...counts }) => counts);
  return { db, repo, accountId, mailboxId, ingest, blankAt, pass, snapshot, lines, said };
}

const SCREENER = { folder: "ohmail/Screener", uid: 4 };
const HIDDEN = { folder: "INBOX", uid: 11 };
const SENT = { folder: "Sent", uid: 21 };
const MOVED_BY_US = { desired: "ohmail/Screener", observed: "ohmail/Screener", lastSetBy: "us" as const };
const damagedServer = () => fakeServer({
  "ohmail/Screener": { 4: letter(0, "anna@x.example") },
  INBOX: { 11: letter(1, "ben@x.example"), 12: letter(3, "carla@x.example") },
  Sent: { 21: letter(2, "mila@lichtgrat.example") },
});
/** The first visit's instant; `after(ms)` is a later one. */
const START = new Date("2026-10-19T12:00:00Z");
const after = (ms: number): Date => new Date(START.getTime() + ms);

describe("listBlankMessages", () => {
  it("lists the blank row with its places, primary first, and its folder_state — and nothing else", async () => {
    const w = await world();
    const blank = await w.blankAt(SCREENER, [HIDDEN, SENT], MOVED_BY_US);
    await w.ingest("INBOX", 12, letter(3, "carla@x.example"));
    const rows = await w.repo.listBlankMessages!(w.mailboxId);
    expect(rows.map((r) => r.messageId)).toEqual([blank]);
    expect(rows[0]!.places.map((p) => [p.folder, p.uid, p.isPrimary])).toEqual([
      ["ohmail/Screener", 4, true], ["INBOX", 11, false], ["Sent", 21, false],
    ]);
    expect(rows[0]!.placeCount).toBe(3);
    expect(rows[0]!.folderState).toEqual(MOVED_BY_US);
    // A tombstoned blank is no longer one.
    await w.db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, blank));
    expect(await w.repo.listBlankMessages!(w.mailboxId)).toEqual([]);
  });

  it("counts every place the row holds, past the listing's bound too", async () => {
    const w = await world();
    await w.blankAt(SCREENER, [HIDDEN, SENT], MOVED_BY_US);
    const [row] = await w.repo.listBlankMessages!(w.mailboxId, 2);
    expect(row!.places.map((p) => p.uid)).toEqual([4, 11]);
    expect(row!.placeCount, "the count stopped at the listing's bound").toBe(3);
  });
});

describe("the blank repair pass", () => {
  it("dry: reads, counts, and writes nothing to the store or the server", async () => {
    const w = await world();
    await w.blankAt(SCREENER, [HIDDEN, SENT], MOVED_BY_US);
    const server = damagedServer();
    const before = await w.snapshot();
    const r = await w.pass(server.adapter, "dry");
    expect(r).toMatchObject({ mode: "dry", blanks: 1, places: 3, returned: 1, released: 2, owed: 2, kept: 0, unreadable: 0 });
    expect(server.moves).toEqual([]);
    expect(await w.snapshot()).toBe(before);
    expect(w.said()).toEqual([{
      mode: "dry", blanks: 1, places: 3, read: 3, kept: 0, returned: 1, released: 2, owed: 2, unreadable: 0,
      failed: 0, deferred: 0, remaining: 0,
    }]);
  });

  it("dry, twice in one process: the second visit downloads nothing, and the count stands", async () => {
    const w = await world();
    await w.blankAt(SCREENER, [HIDDEN, SENT], MOVED_BY_US);
    const server = damagedServer();
    const memory = newBlankRepairMemory();
    await w.pass(server.adapter, "dry", { memory });
    const once = server.bytes();
    expect(once, "the first visit read no letter").toBeGreaterThan(0);
    await w.pass(server.adapter, "dry", { memory });
    expect(server.bytes(), "the second dry visit downloaded the same letters again").toBe(once);
    expect(server.reads).toEqual(["ohmail/Screener:4", "INBOX:11", "Sent:21"]);
    // The count was whole after the first visit and said once.
    expect(w.said()).toHaveLength(1);
    expect(w.said()[0]).toMatchObject({ places: 3, read: 3, returned: 1, released: 2, owed: 2, remaining: 0 });
  });

  it("dry counts every place, not only the first five, and reads each once", async () => {
    const w = await world();
    const archive = (uid: number) => ({ folder: "Archive", uid });
    await w.blankAt(SCREENER, [archive(31), archive(32), archive(33), HIDDEN, { folder: "INBOX", uid: 13 }, SENT,
      { folder: "Sent", uid: 22 }], MOVED_BY_US);
    const server = fakeServer({
      "ohmail/Screener": { 4: letter(0, "anna@x.example") },
      Archive: { 31: letter(31, "ben@x.example"), 32: letter(32, "ben@x.example"), 33: letter(33, "ben@x.example") },
      INBOX: { 11: letter(1, "ben@x.example"), 13: letter(13, "ben@x.example") },
      Sent: { 21: letter(2, "mila@lichtgrat.example"), 22: letter(22, "mila@lichtgrat.example") },
    });
    const memory = newBlankRepairMemory();
    const first = await w.pass(server.adapter, "dry", { memory });
    const second = await w.pass(server.adapter, "dry", { memory });
    expect(second.places, "the second visit counted the same five places again").toBe(8);
    expect(first).toMatchObject({ places: 5, read: 5, remaining: 3 });
    expect(second).toMatchObject({ places: 8, read: 3, remaining: 0, returned: 1, released: 7, owed: 7, kept: 0 });
    const read = server.bytes();
    expect(await w.pass(server.adapter, "dry", { memory })).toMatchObject({ read: 0 });
    expect(server.bytes()).toBe(read);
    // Every place was read exactly once.
    const uids = server.reads.flatMap((r) => r.split(":")[1]!.split(",")).sort();
    expect(uids).toEqual(["11", "13", "21", "22", "31", "32", "33", "4"]);
    expect(w.said().at(-1)).toMatchObject({ places: 8, remaining: 0, returned: 1, released: 7 });
  });

  it("dry counts past the listing's bound: a hundred and twenty places, all of them", async () => {
    const w = await world();
    const inbox = Array.from({ length: 120 }, (_, i) => i + 1);
    await w.blankAt({ folder: "INBOX", uid: 1 }, inbox.slice(1).map((uid) => ({ folder: "INBOX", uid })),
      { desired: "INBOX", observed: "INBOX", lastSetBy: "us" });
    const server = fakeServer({ INBOX: Object.fromEntries(inbox.map((uid) => [uid, letter(uid, "ben@x.example")])) });
    const memory = newBlankRepairMemory();
    const visits = [];
    for (let i = 0; i < 4; i++) visits.push(await w.pass(server.adapter, "dry", { memory, placesPerVisit: 50 }));
    expect(visits.map((v) => [v.places, v.read, v.remaining])).toEqual([[50, 50, 70], [100, 50, 20], [120, 20, 0], [0, 0, 0]]);
    expect(visits[2]).toMatchObject({ released: 120, owed: 120, returned: 0 });
  });

  it("apply: letter 0 back in INBOX, the other places released with a re-read owed, the blank left to the reaper", async () => {
    const w = await world();
    const blank = await w.blankAt(SCREENER, [HIDDEN, SENT], MOVED_BY_US);
    const server = damagedServer();
    const r = await w.pass(server.adapter, "apply");
    expect(r).toMatchObject({ mode: "apply", blanks: 1, places: 3, read: 3, returned: 1, released: 2, owed: 2, remaining: 0 });
    expect(server.moves).toEqual(["ohmail/Screener:4 -> INBOX:100"]);
    expect(server.held("INBOX").sort()).toEqual(["letter-0@x.example", "letter-1@x.example", "letter-3@x.example"]);
    expect(await w.db.select().from(messageInstances).where(eq(messageInstances.messageId, blank))).toEqual([]);
    const owed = await w.db.select({ folder: messageFailures.folder, uid: messageFailures.uid, code: messageFailures.code })
      .from(messageFailures).where(and(eq(messageFailures.mailboxId, w.mailboxId), isNull(messageFailures.resolvedAt)));
    expect(owed.sort((a, b) => a.uid - b.uid)).toEqual([
      { folder: "INBOX", uid: 11, code: "unclassified" }, { folder: "Sent", uid: 21, code: "unclassified" },
    ]);
    // The reaper's own predicate takes the blank now that it holds no place.
    expect(await w.repo.transaction((r) => r.tombstoneInstanceless(w.accountId, w.mailboxId, 10))).toBe(1);
    const [row] = await w.db.select({ deletedAt: messages.deletedAt }).from(messages).where(eq(messages.id, blank));
    expect(row!.deletedAt).not.toBe(null);
  });

  it("a second apply writes nothing", async () => {
    const w = await world();
    await w.blankAt(SCREENER, [HIDDEN, SENT], MOVED_BY_US);
    const server = damagedServer();
    await w.pass(server.adapter, "apply");
    const after = await w.snapshot();
    const again = await w.pass(server.adapter, "apply");
    expect(again).toMatchObject({ places: 0, returned: 0, released: 0 });
    expect(await w.snapshot()).toBe(after);
    expect(server.moves).toHaveLength(1);
  });

  it("a move still owed for the blank is withdrawn, so the reconcile cannot carry the letter off", async () => {
    const w = await world();
    const blank = await w.blankAt({ folder: "INBOX", uid: 11 }, [], { desired: "ohmail/Screener", observed: "INBOX", lastSetBy: "us" });
    const server = fakeServer({ INBOX: { 11: letter(1, "ben@x.example") } });
    const r = await w.pass(server.adapter, "apply");
    expect(r).toMatchObject({ returned: 0, released: 1, owed: 1 });
    expect(server.moves).toEqual([]);
    expect((await w.repo.listPendingFolderStates(w.mailboxId)).map((p) => p.messageId)).not.toContain(blank);
  });

  it("a decision made on the blank while its place was read is not written over: the place waits, and is not read again", async () => {
    const w = await world();
    const blank = await w.blankAt({ folder: "INBOX", uid: 11 }, [], { desired: "ohmail/Screener", observed: "INBOX", lastSetBy: "us" });
    const server = fakeServer({ INBOX: { 11: letter(1, "ben@x.example") } });
    server.duringRead(() => w.repo.upsertFolderState(blank, { desiredFolder: "Archive", observedFolder: "INBOX", lastSetBy: "us" }));
    const memory = newBlankRepairMemory();
    const r = await w.pass(server.adapter, "apply", { memory, at: START });
    expect(r).toMatchObject({ released: 0, owed: 0, deferred: 1 });
    const [fs] = await w.db.select().from(folderState).where(eq(folderState.messageId, blank));
    expect(fs).toMatchObject({ desiredFolder: "Archive", observedFolder: "INBOX" });
    expect(await w.db.select().from(messageInstances).where(eq(messageInstances.messageId, blank))).toHaveLength(1);
    expect(await w.db.select().from(messageFailures).where(eq(messageFailures.mailboxId, w.mailboxId))).toEqual([]);
    // The next visit leaves it to its wait; once that is over it is settled from the reading held.
    await w.pass(server.adapter, "apply", { memory, at: START });
    expect(server.reads, "the deferred place was read again at once").toEqual(["INBOX:11"]);
    expect(await w.pass(server.adapter, "apply", { memory, at: after(BLANK_REPAIR_RETRY_BASE_MS) }))
      .toMatchObject({ read: 0, released: 1, owed: 1, deferred: 0 });
    expect(server.reads).toEqual(["INBOX:11"]);
  });

  it("two places of one blank with a move owed: the withdrawal is made once and both are released", async () => {
    const w = await world();
    await w.blankAt({ folder: "INBOX", uid: 11 }, [{ folder: "INBOX", uid: 12 }], { desired: "ohmail/Screener", observed: "INBOX", lastSetBy: "us" });
    const server = fakeServer({ INBOX: { 11: letter(1, "ben@x.example"), 12: letter(3, "carla@x.example") } });
    expect(await w.pass(server.adapter, "apply")).toMatchObject({ released: 2, owed: 2, deferred: 0 });
  });

  it("a letter whose move back keeps failing waits, longer each time, and is never downloaded again", async () => {
    const w = await world();
    const blank = await w.blankAt(SCREENER, [], MOVED_BY_US);
    const server = damagedServer();
    server.refuseMovesFrom("ohmail/Screener");
    const memory = newBlankRepairMemory();
    await w.pass(server.adapter, "apply", { memory, at: START });
    expect(server.moveAttempts()).toBe(1);
    const second = await w.pass(server.adapter, "apply", { memory, at: START });
    expect(server.reads, "the place was read again on the next visit").toEqual(["ohmail/Screener:4"]);
    expect(server.moveAttempts(), "the failed move was tried again on the next visit").toBe(1);
    expect(second).toMatchObject({ places: 0, read: 0, remaining: 1 });
    // Its wait over, the move is tried again from the reading this process holds; the next wait is twice as long.
    const firstRetry = after(BLANK_REPAIR_RETRY_BASE_MS);
    expect(await w.pass(server.adapter, "apply", { memory, at: firstRetry })).toMatchObject({ places: 1, read: 0, failed: 1, remaining: 1 });
    expect(server.moveAttempts()).toBe(2);
    const stillWaiting = new Date(firstRetry.getTime() + BLANK_REPAIR_RETRY_BASE_MS);
    expect(await w.pass(server.adapter, "apply", { memory, at: stillWaiting })).toMatchObject({ places: 0 });
    expect(server.moveAttempts()).toBe(2);
    // CONTROL: the server takes the move at last, and the place is released.
    server.takeMovesFrom("ohmail/Screener");
    const secondRetry = new Date(firstRetry.getTime() + 2 * BLANK_REPAIR_RETRY_BASE_MS);
    expect(await w.pass(server.adapter, "apply", { memory, at: secondRetry })).toMatchObject({ places: 1, read: 0, returned: 1, remaining: 0 });
    expect(server.reads).toEqual(["ohmail/Screener:4"]);
    expect(server.held("INBOX")).toContain("letter-0@x.example");
    expect(await w.db.select().from(messageInstances).where(eq(messageInstances.messageId, blank))).toEqual([]);
  });

  it("places that cannot be read wait: the next visit reads the others, and those only when their wait is over", async () => {
    const w = await world();
    const archive = (uid: number) => ({ folder: "Archive", uid });
    await w.blankAt(archive(1), [archive(2), archive(3), archive(4), archive(5), { folder: "INBOX", uid: 11 }],
      { desired: "Archive", observed: "Archive", lastSetBy: "external" });
    const server = fakeServer({ INBOX: { 11: letter(1, "ben@x.example") } });
    server.failFolder("Archive");
    const memory = newBlankRepairMemory();
    const archiveReads = () => server.reads.filter((r) => r.startsWith("Archive:")).length;
    expect(await w.pass(server.adapter, "apply", { memory, at: START })).toMatchObject({ places: 5, unreadable: 5, released: 0 });
    const second = await w.pass(server.adapter, "apply", { memory, at: START });
    expect(archiveReads(), "a place that could not be read was read again at once").toBe(1);
    expect(second).toMatchObject({ places: 1, read: 1, released: 1, owed: 1, remaining: 5 });
    expect(server.reads).toContain("INBOX:11");
    expect(await w.pass(server.adapter, "apply", { memory, at: START })).toMatchObject({ places: 0, read: 0, remaining: 5 });
    expect(archiveReads()).toBe(1);
    expect(await w.pass(server.adapter, "apply", { memory, at: after(BLANK_REPAIR_RETRY_BASE_MS) })).toMatchObject({ places: 5, unreadable: 5 });
    expect(archiveReads()).toBe(2);
  });

  it("CONTROL: a real letter with no content is kept, nothing is written, and it is not read again", async () => {
    const w = await world();
    await w.blankAt({ folder: "INBOX", uid: 30 }, [], { desired: "INBOX", observed: "INBOX", lastSetBy: "us" });
    const server = fakeServer({ INBOX: { 30: Buffer.from("\r\n") } });
    const memory = newBlankRepairMemory();
    const before = await w.snapshot();
    expect(await w.pass(server.adapter, "apply", { memory })).toMatchObject({ kept: 1, released: 0, returned: 0, remaining: 0 });
    expect(await w.snapshot()).toBe(before);
    expect(await w.pass(server.adapter, "apply", { memory })).toMatchObject({ places: 0 });
    expect(server.reads).toEqual(["INBOX:30"]);
  });

  it("CONTROL: a reader moves nothing — the letter in the Screener is re-read where it stands", async () => {
    const w = await world();
    await w.blankAt(SCREENER, [], MOVED_BY_US);
    const server = damagedServer();
    const r = await w.pass(server.adapter, "apply", { role: "reader" });
    expect(r).toMatchObject({ returned: 0, released: 1, owed: 1 });
    expect(server.moves).toEqual([]);
    expect(server.held("ohmail/Screener")).toEqual(["letter-0@x.example"]);
  });

  it("a place the server no longer holds is released without a re-read; a failed read changes nothing", async () => {
    const w = await world();
    await w.blankAt({ folder: "INBOX", uid: 40 }, [], { desired: "INBOX", observed: "INBOX", lastSetBy: "us" });
    const gone = fakeServer({ INBOX: {} });
    const before = await w.snapshot();
    const failing = fakeServer({ INBOX: {} });
    failing.failReads();
    expect(await w.pass(failing.adapter, "apply")).toMatchObject({ unreadable: 1, released: 0 });
    expect(await w.snapshot()).toBe(before);
    expect(await w.pass(gone.adapter, "apply")).toMatchObject({ released: 1, owed: 0 });
    expect(await w.db.select().from(messageFailures).where(eq(messageFailures.mailboxId, w.mailboxId))).toEqual([]);
  });
});
