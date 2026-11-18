import type { MessageDTO, SnapshotResponse, SyncChange, SyncResponse } from "@ohmail/wire";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { count } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { messages } from "@trafficflow/db/mail";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld, type LocalWorld } from "../src/identity.js";
import { createCloudMirror as makeCloudMirror } from "../src/cloud-mirror.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import { loopHold } from "../src/loop-hold.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { pgliteOf } from "./_store-client.js";
import { idleSession } from "./fixtures/cloud-auth-double.js";
import { tearDown, tracked } from "./_teardown.js";

const mirrors: ReturnType<typeof makeCloudMirror>[] = [];
const createCloudMirror = tracked(makeCloudMirror, mirrors);

/**
 * A MIRROR PAGE IS ONE TRANSACTION WHOSE CPU WORK TAKES TURNS. The page apply hands the event loop
 * back inside its transaction (`loop-hold.ts`), so a search relayed during a first fill is not
 * frozen behind a whole page of rows. Read through the transaction PGlite hands drizzle: the loop turns
 * between the page's BEGIN and COMMIT, and a fault injected after a turn leaves no row of the page.
 */

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PAGE = 400;
const iso = (): string => new Date().toISOString();

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [mirrors], close: opens, remove: dirs }));

async function standUp(): Promise<{ opened: OpenLocalDb; world: LocalWorld; cursorPath: string }> {
  const dataDir = await freshDataDir("ohmail-page-turns-");
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: "me@ohmail.test", now: new Date() });
  return { opened, world, cursorPath: join(dataDir, "cloud-cursor.json") };
}

function dto(id: string, i: number): MessageDTO {
  return {
    id, accountId: ACCOUNT, mailboxId: MAILBOX, threadId: null, messageIdHeader: `<${id}@x.test>`,
    subject: `Message ${i} about herons`, from: { name: null, address: `sender${i % 7}@birds.test` },
    to: [{ name: null, address: "me@ohmail.test" }], cc: [], arrivedAt: iso(), date: iso(), folder: "INBOX",
    snippet: "lorem ipsum dolor sit amet ".repeat(5), unread: i % 3 === 0, lastReadAt: null,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: iso(),
  };
}

function bigPage(): SyncResponse {
  const creates: SyncChange[] = Array.from({ length: PAGE }, (_, i) => {
    const id = randomUUID();
    return { type: "message", op: "create", id, seq: i + 1, updatedAt: iso(), entity: dto(id, i) };
  });
  return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: "c-end", hasMore: false, serverTime: iso() };
}

const EMPTY_SNAPSHOT: SnapshotResponse = { asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } };

function fakeAuth(feed: SyncResponse | Record<string, SyncResponse>): CloudAuth {
  const pages: Record<string, SyncResponse> = "changes" in feed ? { "0": feed as SyncResponse } : feed;
  const json = (v: unknown): Response =>
    new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  const empty: SyncResponse = { changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "c-end", hasMore: false, serverTime: iso() };
  return {
    authedFetch: async (path: string) => {
      if (path.startsWith("/mailboxes")) return json(mailboxList([hostedMailbox(MAILBOX, "me@ohmail.test")]));
      if (path.startsWith("/sync/snapshot")) return json(EMPTY_SNAPSHOT);
      if (path.startsWith("/sync") && new URLSearchParams(path.split("?")[1] ?? "").get("types") === "rule") return json(empty);
      if (path.startsWith("/sync")) return json(pages[new URLSearchParams(path.split("?")[1] ?? "").get("since") ?? "0"] ?? empty);
      if (path.startsWith("/messages/bodies")) return json({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  };
}

interface TxClient { query: (...a: unknown[]) => Promise<unknown> }
type Pglite = { transaction: <T>(cb: (tx: TxClient) => Promise<T>) => Promise<T> };

/**
 * THE TRANSACTION PGLITE HANDS DRIZZLE, WATCHED: loop turns counted between BEGIN and COMMIT of the
 * transaction that inserts messages, and — when `failAt` is set — that many-th message insert
 * thrown THROUGH that transaction, the connection a real fault would come from.
 */
function watchPageTransactions(opened: OpenLocalDb, failAt: number | null) {
  const client = pgliteOf(opened.db) as unknown as Pglite;
  type Mark = { entry: number; firstInsert: number; lastInsert: number; returned: number; committed: number };
  const seen = { pages: 0, turnsInside: [] as number[], turnsBeforeFault: null as number | null, faults: 0, marks: [] as Mark[] };
  let turns = 0;
  let ticking = true;
  const tick = (): void => { turns++; if (ticking) setImmediate(tick); };
  setImmediate(tick);
  let inserts = 0;
  const original = client.transaction.bind(client);
  client.transaction = async <T>(cb: (tx: TxClient) => Promise<T>): Promise<T> => {
    const mark: Mark = { entry: -1, firstInsert: -1, lastInsert: -1, returned: -1, committed: -1 };
    const out = await original(async (tx: TxClient) => {
      mark.entry = turns;
      const query = tx.query.bind(tx);
      const watchedQuery = async (...args: unknown[]): Promise<unknown> => {
        if (typeof args[0] === "string" && /^insert into "messages"/i.test(args[0])) {
          if (mark.firstInsert < 0) mark.firstInsert = turns;
          mark.lastInsert = turns;
          inserts++;
          if (failAt !== null && inserts === failAt) {
            seen.faults++;
            seen.turnsBeforeFault = turns - mark.entry;
            throw new Error("injected fault mid-page");
          }
        }
        return query(...args);
      };
      const r = await cb(new Proxy(tx, { get: (t, p) => (p === "query" ? watchedQuery : Reflect.get(t, p)) }));
      mark.returned = turns;
      return r;
    });
    mark.committed = turns;
    if (mark.firstInsert >= 0) {
      seen.pages++;
      seen.turnsInside.push(mark.returned - mark.entry);
      seen.marks.push(mark);
    }
    return out;
  };
  return { seen, stop: (): void => { ticking = false; client.transaction = original; } };
}

const messageCount = async (opened: OpenLocalDb): Promise<number> =>
  (await opened.db.select({ n: count() }).from(messages))[0]!.n;

describe("loopHold", () => {
  it("yields at the first checkpoint, then once per spent budget, and never before", async () => {
    let now = 0;
    const hold = loopHold(20, () => now);
    const order: string[] = [];
    setImmediate(() => order.push("turn 1"));
    await hold();
    order.push("first");
    setImmediate(() => order.push("turn 2"));
    now = 19;
    await hold();
    order.push("under budget");
    now = 20;
    await hold();
    order.push("spent");
    expect(order).toEqual(["turn 1", "first", "under budget", "turn 2", "spent"]);
  });
});

describe("a mirror page applies in one transaction and takes turns inside it", () => {
  it(`a page of ${PAGE} messages turns the loop between its BEGIN and COMMIT, and lands whole`, { timeout: 30_000 }, async () => {
    const { opened, world, cursorPath } = await standUp();
    const watch = watchPageTransactions(opened, null);
    const mirror = createCloudMirror({ db: opened.db, world, auth: fakeAuth(bigPage()), cursorPath, now: () => new Date() });
    try {
      await mirror.pullOnce();
    } finally {
      watch.stop();
    }
    expect(watch.seen.pages, "the page was one transaction").toBe(1);
    expect(watch.seen.turnsInside[0], "the loop turned inside the page transaction").toBeGreaterThanOrEqual(2);
    expect(await messageCount(opened)).toBe(PAGE);
  });

  it("the page's parse, its last change and its commit are each a stretch of their own", { timeout: 30_000 }, async () => {
    const { opened, world, cursorPath } = await standUp();
    const small = (from: number, cursor: string, hasMore: boolean): SyncResponse => {
      const creates: SyncChange[] = Array.from({ length: 3 }, (_, k) => {
        const id = randomUUID();
        return { type: "message", op: "create", id, seq: from + k, updatedAt: iso(), entity: dto(id, from + k) };
      });
      return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor, hasMore, serverTime: iso() };
    };
    const watch = watchPageTransactions(opened, null);
    const mirror = createCloudMirror({
      db: opened.db, world, auth: fakeAuth({ "0": small(1, "c-1", true), "c-1": small(4, "c-end", false) }),
      cursorPath, now: () => new Date(),
    });
    try {
      await mirror.pullOnce();
    } finally {
      watch.stop();
    }
    const [one, two] = watch.seen.marks;
    expect(watch.seen.marks.length, "two page transactions").toBe(2);
    expect(one!.firstInsert - one!.entry, "the first checkpoint turns the loop").toBeGreaterThanOrEqual(1);
    expect(one!.returned - one!.lastInsert, "the last change and the commit are apart").toBeGreaterThanOrEqual(1);
    expect(two!.entry - one!.committed, "the commit and what follows it are apart").toBeGreaterThanOrEqual(1);
    expect(await messageCount(opened)).toBe(6);
  });

  it("a fault after a turn leaves no row of the page, and the same page lands whole on the retry", { timeout: 30_000 }, async () => {
    const { opened, world, cursorPath } = await standUp();
    const page = bigPage();
    const before = await messageCount(opened);
    const watch = watchPageTransactions(opened, PAGE - 20);
    const mirror = createCloudMirror({ db: opened.db, world, auth: fakeAuth(page), cursorPath, now: () => new Date() });
    let refused: unknown = null;
    try {
      await mirror.pullOnce();
    } catch (err) {
      refused = err;
    } finally {
      watch.stop();
    }
    expect(watch.seen.faults, "the fault fired through the page's own transaction").toBe(1);
    expect(watch.seen.turnsBeforeFault, "the loop had turned inside the page before the fault").toBeGreaterThanOrEqual(1);
    expect(String(refused)).toMatch(/injected fault mid-page/);
    expect(await messageCount(opened), "no row of the refused page is in the mirror").toBe(before);
    // The positive control: the page itself is sound.
    await mirror.pullOnce();
    expect(await messageCount(opened)).toBe(before + PAGE);
  });
});
