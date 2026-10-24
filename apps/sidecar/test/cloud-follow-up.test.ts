import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { folderState } from "@trafficflow/db/mail";
import type { MessageDTO, SyncChange, SyncResponse, ThreadDTO } from "@trafficflow/services/mail";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld } from "../src/identity.js";
import { createCloudMirror, FOLLOW_UP_CAP_MS, type CloudMirror } from "../src/cloud-mirror.js";
import { createWriteThroughProxy } from "../src/cloud-proxy.js";
import { drainOnFollowUp } from "../src/cloud-engine.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { idleSession } from "./fixtures/cloud-auth-double.js";
import { tearDown } from "./_teardown.js";

/**
 * THE FOLLOW-UP CHAIN — an echo the 1.5 s bound cut keeps asking the hosted feed off the request
 * path, one chain per route, until the copy holds the write or 10 s; and a local drain with nothing
 * new waits on that chain. A fake hosted account whose `/sync` the test slows; real PGlite.
 */

const MB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const iso = (): string => new Date().toISOString();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/* The bound, the chain's naps and the hosted account's slowness on a FAKE clock, PGlite on real
   turns: `advance` moves the virtual clock ten ms per real turn, so every duration below is
   virtual and a loaded machine cannot stretch one into a red. */
// `performance`: the mirror's deadlines and Retry-After waits read the monotonic clock.
const fakeClock = (): void => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }); };
const turn = (): Promise<void> => new Promise((r) => setImmediate(r));
async function advance(ms: number): Promise<void> {
  for (let at = 0; at < ms; at += 10) {
    await vi.advanceTimersByTimeAsync(Math.min(10, ms - at));
    await turn();
  }
}
/** Step the fake clock until `p` settles (or `capMs` of virtual time passes), then hand it back. */
async function settle<T>(p: Promise<T>, capMs = 30_000): Promise<T> {
  let done = false;
  void p.then(() => { done = true; }, () => { done = true; });
  for (let at = 0; !done && at < capMs; at += 10) await advance(10);
  return p;
}
const cursorOf = (n: number): string => Buffer.from(String(n), "utf8").toString("base64url");
const seqOf = (c: string | null): number => (!c || c === "0" ? 0 : Number(Buffer.from(c, "base64url").toString("utf8")) || 0);

function messageDTO(id: string, threadId: string, folder: string): MessageDTO {
  return {
    id, accountId: "acct", mailboxId: MB, threadId, messageIdHeader: `<${id}@x.test>`, subject: "s",
    from: { name: null, address: "a@x.test" }, to: [], cc: [], arrivedAt: iso(), date: iso(), folder, snippet: "",
    unread: true, lastReadAt: null, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: iso(),
  } as MessageDTO;
}

function hostedCloud() {
  const threadId = randomUUID();
  const msgId = randomUUID();
  /* `readFirst`: the page is read when ASKED and answered after `syncMs`, so a pull asked before a
     write never carries it. `beyond`: the write answers a seq the feed never reaches. */
  const knobs = { syncMs: 0, readFirst: false, sync429: false, beyond: false };
  const asks = { sync: 0, marked: 0 };
  let seq = 100_000;
  const log: SyncChange[] = [];
  const commit = (c: Omit<SyncChange, "seq" | "updatedAt">): number => {
    seq += 1;
    log.push({ ...c, seq, updatedAt: iso() } as SyncChange);
    return seq;
  };
  const thread = (subject: string): ThreadDTO => ({ id: threadId, accountId: "acct", subject, messageIds: [],
    participants: [], lastMessageAt: iso(), unreadCount: 1, muted: false, folder: "INBOX", updatedAt: iso() } as ThreadDTO);
  commit({ type: "thread", op: "create", id: threadId, entity: thread("s") });
  commit({ type: "message", op: "create", id: msgId, entity: messageDTO(msgId, threadId, "INBOX") });
  const json = (v: unknown, headers: Record<string, string> = {}, status = 200): Response =>
    new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
  const echo = (s: number): Record<string, string> => ({ "x-sync-seq": String(knobs.beyond ? s + 1_000 : s) });
  const auth: CloudAuth = {
    authedFetch: async (path: string, init?: RequestInit) => {
      const url = new URL(path, "https://cloud.test");
      const method = (init?.method ?? "GET").toUpperCase();
      if (new Headers(init?.headers).has("x-ohmail-echo")) asks.marked += 1;
      if (url.pathname === "/mailboxes" && method === "GET") return json(mailboxList([hostedMailbox(MB, "me@ohmail.test")]));
      if (url.pathname === "/sync/snapshot") return new Response("no snapshot", { status: 404 });
      if (url.pathname === "/sync") {
        if (url.searchParams.get("types") === "rule") {
          return json({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: iso() });
        }
        asks.sync += 1;
        if (knobs.sync429) return json({ error: { code: "busy" } }, { "retry-after": "30" }, 429);
        const since = seqOf(url.searchParams.get("since"));
        let rows = knobs.readFirst ? log.filter((c) => c.seq > since) : [];
        if (knobs.syncMs > 0) await sleep(knobs.syncMs);
        if (!knobs.readFirst) rows = log.filter((c) => c.seq > since);
        const page: SyncResponse = {
          changes: {
            creates: rows.filter((c) => c.op === "create"), updates: rows.filter((c) => c.op === "update"),
            moves: rows.filter((c) => c.op === "move"), deletes: rows.filter((c) => c.op === "delete"),
          },
          cursor: cursorOf(rows.length ? rows[rows.length - 1]!.seq : since), hasMore: false, serverTime: iso(),
        };
        return json(page);
      }
      if (url.pathname === "/messages/bodies") return json({ items: [], nextCursor: null });
      if (/^\/messages\/[^/]+\/move$/.test(url.pathname) && method === "POST") {
        const dto = messageDTO(msgId, threadId, "ohmail/News");
        return json(dto, echo(commit({ type: "message", op: "update", id: msgId, entity: dto })));
      }
      if (url.pathname === `/threads/${threadId}` && method === "PATCH") {
        const dto = thread("renamed");
        return json(dto, echo(commit({ type: "thread", op: "update", id: threadId, entity: dto })));
      }
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  } as unknown as CloudAuth;
  return { auth, knobs, asks, msgId, threadId };
}

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
const mirrors: CloudMirror[] = [];
afterEach(() => tearDown({ stop: [mirrors], close: opens, remove: dirs }));

async function standUp() {
  const dataDir = await freshDataDir("ohmail-follow-up-");
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: "me@ohmail.test", now: new Date() });
  const cloud = hostedCloud();
  const mirror = createCloudMirror({ db: opened.db, world, auth: cloud.auth, cursorPath: join(dataDir, "cloud-cursor.json"), pollIntervalMs: 3_600_000 });
  mirrors.push(mirror);
  await mirror.pullOnce();
  const events: string[] = [];
  const proxy = createWriteThroughProxy({ auth: cloud.auth, mirror, log: (e: string) => { events.push(e); } });
  const folderOf = async (): Promise<string | undefined> =>
    (await opened.db.select().from(folderState).where(eq(folderState.messageId, cloud.msgId)))[0]?.desiredFolder;
  const press = (path: string, method: string, body: unknown): Promise<Response> =>
    proxy.forward(new Request(`http://sidecar${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const move = (): Promise<Response> => settle(press(`/messages/${cloud.msgId}/move`, "POST", { folder: "ohmail/News" }));
  const until = async (f: () => boolean | Promise<boolean>, ms: number): Promise<number> => {
    const t = Date.now();
    while (!(await f()) && Date.now() - t < ms) await advance(10);
    return Date.now() - t;
  };
  return { cloud, mirror, proxy, events, folderOf, press, move, until };
}

describe("an echo the bound cut is followed up off the request path", () => {
  afterEach(async () => {
    await settle(Promise.all(mirrors.map((m) => m.stop().catch(() => undefined))));
    vi.useRealTimers();
  });

  it("a covered echo schedules no follow-up pull", async () => {
    const t = await standUp();
    fakeClock();
    const before = t.cloud.asks.sync;
    await t.move();
    expect(t.mirror.followUps()).toBe(0);
    await advance(3_000);
    expect(t.cloud.asks.sync - before, "a covered write asked the feed again").toBe(1);
  }, 10_000);

  it("a pull asked before the write cannot carry it; the chain asks again and the copy has it", async () => {
    const t = await standUp();
    fakeClock();
    t.cloud.knobs.syncMs = 2_500;
    t.cloud.knobs.readFirst = true;
    const asked = t.cloud.asks.sync;
    const early = t.mirror.pullOnce();
    while (t.cloud.asks.sync === asked) await turn();
    const res = await t.move();
    expect(res.status).toBe(200);
    expect(t.mirror.followUps(), "the cut echo left no chain").toBe(1);
    expect(await t.mirror.awaitLaterEchoes(0), "an unmarked write held the window's drains").toBe(true);
    await settle(early);
    expect(await t.folderOf(), "the pull in flight at the press carried the write").toBe("INBOX");
    const waited = await t.until(async () => (await t.folderOf()) === "ohmail/News", 8_000);
    expect(await t.folderOf(), "only the poll, an hour away, would have carried it").toBe("ohmail/News");
    expect(waited).toBeLessThan(8_000);
    await t.until(() => t.mirror.followUps() === 0, 1_000);
    expect(t.mirror.followUps(), "a covered chain stays live").toBe(0);
  }, 15_000);

  it("a write marked `x-ohmail-echo: later` is answered at once; the chain and a waiting drain still carry it", async () => {
    const t = await standUp();
    fakeClock();
    t.cloud.knobs.syncMs = 2_500;
    t.cloud.knobs.readFirst = true;
    const asked = t.cloud.asks.sync;
    const early = t.mirror.pullOnce();
    while (t.cloud.asks.sync === asked) await turn();
    const at = Date.now();
    const res = await settle(t.proxy.forward(new Request(`http://sidecar/messages/${t.cloud.msgId}/move`, {
      method: "POST", headers: { "content-type": "application/json", "x-ohmail-echo": "later" }, body: JSON.stringify({ folder: "ohmail/News" }),
    })));
    expect(res.status).toBe(200);
    expect(Date.now() - at, "the marked write waited for this computer's copy").toBeLessThan(100);
    expect(res.headers.get("x-sync-seq"), "a marked answer carried a seq").toBeNull();
    expect(t.events).not.toContain("cloud_write_echo");
    expect(t.cloud.asks.marked, "the marker reached the account").toBe(0);
    expect(t.mirror.followUps(), "the marked write left no chain").toBe(1);
    let released = false;
    const held = t.mirror.awaitLaterEchoes(FOLLOW_UP_CAP_MS).then((v) => { released = true; return v; });
    await advance(100);
    expect(released, "a drain asked after the send did not wait for it").toBe(false);
    const drained = drainOnFollowUp(new Map(), "k", t.mirror,
      async () => ((await t.folderOf()) === "ohmail/News" ? news() : quiet()), quiet());
    expect((await settle(drained)).changes.updates, "the drain answered before the copy held the write").toHaveLength(1);
    expect(await settle(held)).toBe(true);
    expect(await t.folderOf()).toBe("ohmail/News");
    await settle(early);
  }, 15_000);

  it("two cut echoes on one route share one chain, and a second route has its own", async () => {
    const t = await standUp();
    fakeClock();
    t.cloud.knobs.syncMs = 4_000;
    const before = t.cloud.asks.sync;
    await Promise.all([t.move(), t.move()]);
    expect(t.mirror.followUps()).toBe(1);
    await settle(t.press(`/threads/${t.cloud.threadId}`, "PATCH", { subject: "renamed" }));
    expect(t.mirror.followUps()).toBe(2);
    await t.until(() => t.mirror.followUps() === 0, 12_000);
    expect(t.mirror.followUps()).toBe(0);
    expect(await t.folderOf()).toBe("ohmail/News");
    // The await's pull and, at most, one the thread chain began after it: every ask joined one.
    expect(t.cloud.asks.sync - before).toBeLessThanOrEqual(2);
  }, 20_000);

  it("a second cut on a route joins the live chain rather than asking on its own schedule", async () => {
    const t = await standUp();
    fakeClock();
    t.cloud.knobs.beyond = true;
    await t.move();
    expect(t.mirror.followUps()).toBe(1);
    await t.move();
    const from = t.cloud.asks.sync;
    await t.until(() => t.mirror.followUps() === 0, 6_000);
    expect(t.mirror.followUps()).toBe(0);
    // The first chain's steps at 1 s and 2 s remain; a second chain would add four of its own.
    expect(t.cloud.asks.sync - from, "the second cut ran a chain of its own").toBeLessThanOrEqual(2);
  }, 15_000);

  it("stopping the mirror ends every chain and answers a drain waiting on one", async () => {
    const t = await standUp();
    fakeClock();
    t.cloud.knobs.syncMs = 4_000;
    await t.move();
    expect(t.mirror.followUps()).toBe(1);
    // Past the first step: the chain now waits on the running 4 s pull, not on its own nap.
    await advance(600);
    const waiting = t.mirror.awaitFollowUp(10_000);
    const at = Date.now();
    const stopped = t.mirror.stop();
    expect(await waiting).toBe(true);
    expect(Date.now() - at, "a drain waited on a chain the stop left behind").toBeLessThan(300);
    expect(t.mirror.followUps()).toBe(0);
    await settle(stopped);
  }, 15_000);

  it("the chain ends at the 10 s cap and leaves the rest to the poll", async () => {
    const t = await standUp();
    fakeClock();
    t.cloud.knobs.syncMs = 3_000;
    t.cloud.knobs.beyond = true;
    const before = t.cloud.asks.sync;
    await t.move();
    const cut = Date.now();
    expect(t.mirror.followUps()).toBe(1);
    await t.until(() => t.mirror.followUps() === 0, FOLLOW_UP_CAP_MS + 2_000);
    const lived = Date.now() - cut;
    expect(t.mirror.followUps(), "a chain outlived its cap").toBe(0);
    expect(lived).toBeGreaterThanOrEqual(FOLLOW_UP_CAP_MS - 200);
    expect(lived).toBeLessThan(FOLLOW_UP_CAP_MS + 500);
    await advance(3_500);
    const asked = t.cloud.asks.sync - before;
    await advance(2_500);
    expect(t.cloud.asks.sync - before, "the chain kept asking after its cap").toBe(asked);
    expect(asked).toBeLessThanOrEqual(5);
  }, 25_000);

  it("a hosted Retry-After past the cap ends the chain without asking", async () => {
    const t = await standUp();
    fakeClock();
    t.cloud.knobs.sync429 = true;
    const before = t.cloud.asks.sync;
    await t.move();
    await advance(1_500);
    expect(t.mirror.followUps()).toBe(0);
    expect(t.cloud.asks.sync - before, "the chain asked a server that said wait 30 s").toBe(1);
  });
});

const quiet = (cursor = "c"): SyncResponse =>
  ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor, hasMore: false, serverTime: iso() });
const news = (): SyncResponse =>
  ({ changes: { creates: [], updates: [{ type: "thread", op: "update", id: "t", seq: 9, updatedAt: iso() } as SyncChange], moves: [], deletes: [] }, cursor: "d", hasMore: false, serverTime: iso() });

/**
 * A mirror double: `live` chains, and `progress()` wakes every `awaitFollowUp` as a page commit
 * does. Its wait does not answer false for "no chain" as the mirror's does, so the drain's own
 * chain check is the one that ends it.
 */
function chainDouble() {
  let live = 0;
  const wakes = new Set<() => void>();
  const mirror = {
    followUps: () => live,
    awaitFollowUp: (ms: number): Promise<boolean> => new Promise<boolean>((r) => {
      const w = (): void => { wakes.delete(w); clearTimeout(t); r(true); };
      const t = setTimeout(() => { wakes.delete(w); r(false); }, ms);
      wakes.add(w);
    }),
  };
  return { mirror, setLive: (n: number) => { live = n; }, progress: () => { for (const w of [...wakes]) w(); } };
}

describe("a drain with nothing new waits on a live chain", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("answers at once when no chain is live", async () => {
    const d = chainDouble();
    let asked = 0;
    const r = await drainOnFollowUp(new Map(), "k", d.mirror, async () => { asked += 1; return news(); }, quiet());
    expect(asked).toBe(0);
    expect(r.changes.updates).toHaveLength(0);
  });

  it("answers with the page the chain brings in, and a second drain on the cursor shares the wait", async () => {
    const d = chainDouble();
    d.setLive(1);
    const held = new Map<string, Promise<SyncResponse>>();
    let asked = 0;
    let carried = false;
    const ask = async (): Promise<SyncResponse> => { asked += 1; return carried ? news() : quiet(); };
    const a = drainOnFollowUp(held, "k", d.mirror, ask, quiet());
    const b = drainOnFollowUp(held, "k", d.mirror, ask, quiet());
    await sleep(50);
    d.progress();
    await sleep(20);
    expect(asked, "a page that carried nothing ended the wait").toBe(1);
    carried = true;
    d.progress();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.changes.updates).toHaveLength(1);
    expect(rb).toBe(ra);
    expect(asked, "the second drain asked on its own").toBe(2);
    expect(held.size).toBe(0);
  });

  it("never outlives its chain", async () => {
    fakeClock();
    const d = chainDouble();
    d.setLive(1);
    const t = Date.now();
    const r = drainOnFollowUp(new Map(), "k", d.mirror, async () => quiet(), quiet(), 3_000);
    await advance(100);
    d.setLive(0);
    d.progress();
    await r;
    expect(Date.now() - t, "the drain waited past its chain").toBeLessThan(400);
  });

  it("is bounded per request while a chain stays live", async () => {
    fakeClock();
    const d = chainDouble();
    d.setLive(1);
    const t = Date.now();
    const r = await settle(drainOnFollowUp(new Map(), "k", d.mirror, async () => quiet(), quiet(), 300));
    expect(r.changes.updates).toHaveLength(0);
    expect(Date.now() - t).toBeGreaterThanOrEqual(280);
    expect(Date.now() - t).toBeLessThan(1_000);
  });
});
