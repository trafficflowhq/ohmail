import type { MessageDTO, SyncChange, SyncResponse, ThreadDTO } from "@ohmail/wire";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { folderState, mailboxes } from "@trafficflow/db/mail";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld } from "../src/identity.js";
import { createCloudMirror, type CloudMirror } from "../src/cloud-mirror.js";
import { createWriteThroughProxy } from "../src/cloud-proxy.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { idleSession } from "./fixtures/cloud-auth-double.js";
import { tearDown } from "./_teardown.js";

/**
 * THE TIGHT ECHO — the proxy's wait is read inside the mirror's pull, bounded at 1.5 s, and its
 * answer speaks this install's sequence. A fake hosted account whose `/sync` pages and refusals the
 * test slows or shapes; real PGlite under the mirror. The hosted seq starts high, as a long-lived
 * account's does, so a relayed seq is visibly not a local one.
 */

const MB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SEQ_BASE = 100_000;
const iso = (): string => new Date().toISOString();
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
  const knobs = { syncMs: 0, tailMs: 0, sync429: false, retryAfterS: 30 };
  const asks = { sync: 0, mailboxes: 0 };
  let seq = SEQ_BASE;
  let displayName: string | null = null;
  const log: SyncChange[] = [];
  const commit = (c: Omit<SyncChange, "seq" | "updatedAt">): number => {
    seq += 1;
    log.push({ ...c, seq, updatedAt: iso() } as SyncChange);
    return seq;
  };
  commit({ type: "thread", op: "create", id: threadId, entity: { id: threadId, accountId: "acct", subject: "s", messageIds: [],
    participants: [], lastMessageAt: iso(), unreadCount: 1, muted: false, folder: "INBOX", updatedAt: iso() } as ThreadDTO });
  commit({ type: "message", op: "create", id: msgId, entity: messageDTO(msgId, threadId, "INBOX") });
  const json = (v: unknown, headers: Record<string, string> = {}, status = 200): Response =>
    new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const auth: CloudAuth = {
    authedFetch: async (path: string, init?: RequestInit) => {
      const url = new URL(path, "https://cloud.test");
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.pathname === "/mailboxes" && method === "GET") {
        asks.mailboxes += 1;
        return json(mailboxList([hostedMailbox(MB, "me@ohmail.test", { displayName })]));
      }
      if (url.pathname === "/sync/snapshot") return new Response("no snapshot", { status: 404 });
      if (url.pathname === "/sync") {
        if (url.searchParams.get("types") === "rule") {
          return json({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: iso() });
        }
        asks.sync += 1;
        if (knobs.sync429) return json({ error: { code: "busy" } }, { "retry-after": String(knobs.retryAfterS) }, 429);
        if (knobs.syncMs > 0) await sleep(knobs.syncMs);
        const since = seqOf(url.searchParams.get("since"));
        const rows = log.filter((c) => c.seq > since);
        // `tailMs`: a page with news says there is more, and the empty page after it is slow — a
        // pull that stays on the wire well after the page that carried the write committed.
        if (rows.length === 0 && knobs.tailMs > 0) await sleep(knobs.tailMs);
        const page: SyncResponse = {
          changes: {
            creates: rows.filter((c) => c.op === "create"), updates: rows.filter((c) => c.op === "update"),
            moves: rows.filter((c) => c.op === "move"), deletes: rows.filter((c) => c.op === "delete"),
          },
          cursor: cursorOf(rows.length ? rows[rows.length - 1]!.seq : since), hasMore: knobs.tailMs > 0 && rows.length > 0, serverTime: iso(),
        };
        return json(page);
      }
      if (url.pathname === "/messages/bodies") return json({ items: [], nextCursor: null });
      const move = /^\/messages\/([^/]+)\/move$/.exec(url.pathname);
      if (move && method === "POST") {
        const dto = messageDTO(msgId, threadId, "ohmail/News");
        const s = commit({ type: "message", op: "update", id: msgId, entity: dto });
        return json(dto, { "x-sync-seq": String(s) });
      }
      if (url.pathname === `/mailboxes/${MB}` && method === "PATCH") {
        displayName = (JSON.parse(String(init?.body ? new TextDecoder().decode(init.body as ArrayBuffer) : "{}")) as { displayName?: string }).displayName ?? null;
        return json(hostedMailbox(MB, "me@ohmail.test", { displayName }));
      }
      if (url.pathname === "/away-responder" && method === "PUT") return json({ enabled: false, body: "away" });
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  } as unknown as CloudAuth;
  return { auth, knobs, asks, msgId, cloudSeq: () => seq };
}

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
const mirrors: CloudMirror[] = [];
afterEach(() => tearDown({ stop: [mirrors], close: opens, remove: dirs }));

async function standUp() {
  const dataDir = await freshDataDir("ohmail-echo-tight-");
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: "me@ohmail.test", now: new Date() });
  const cloud = hostedCloud();
  const events: string[] = [];
  const mirror = createCloudMirror({ db: opened.db, world, auth: cloud.auth, cursorPath: join(dataDir, "cloud-cursor.json"), pollIntervalMs: 3_600_000 });
  mirrors.push(mirror);
  await mirror.pullOnce();
  const proxy = createWriteThroughProxy({ auth: cloud.auth, mirror, log: (e) => { events.push(e); } });
  const folderOf = async (): Promise<string | undefined> =>
    (await opened.db.select().from(folderState).where(eq(folderState.messageId, cloud.msgId)))[0]?.desiredFolder;
  const press = async (path: string, method: string, body: unknown): Promise<{ res: Response; ms: number }> => {
    const t = Date.now();
    const res = await proxy.forward(new Request(`http://sidecar${path}`, {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    return { res, ms: Date.now() - t };
  };
  return { opened, cloud, mirror, events, folderOf, press };
}

/* The echo bound and the hosted account's slowness on a FAKE clock, PGlite on real turns: `until`
   spends real turns while the virtual clock stands still, so a timer fires only when a case moves
   it, and every `ms` below is virtual. `release` lets the held pulls end before teardown. */
const until = async (ready: () => boolean): Promise<void> => {
  while (!ready()) await new Promise((r) => setImmediate(r));
};
// `performance`: the mirror's deadlines and Retry-After waits read the monotonic clock.
const fakeClock = (): void => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }); };
/** Ten virtual ms per real turn, until `done` or `capMs` of virtual time has passed. */
const stepUntil = async (done: () => boolean, capMs: number): Promise<void> => {
  for (let at = 0; at < capMs && !done(); at += 10) {
    await vi.advanceTimersByTimeAsync(10);
    await new Promise((r) => setImmediate(r));
  }
};
const release = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(10_000);
  vi.useRealTimers();
};

describe("the echo-await is tight and speaks the local sequence", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("a fast pull covers the write: answered at once, no seq, and the local copy already holds it", async () => {
    const t = await standUp();
    fakeClock();
    const { res, ms } = await t.press(`/messages/${t.cloud.msgId}/move`, "POST", { folder: "ohmail/News" });
    expect(res.status).toBe(200);
    expect(ms).toBeLessThan(1_000);
    expect(res.headers.get("x-sync-seq"), "a covered write reconciles from the local /sync").toBeNull();
    expect(await t.folderOf()).toBe("ohmail/News");
    expect(t.events).not.toContain("cloud_write_echo");
    await release();
  });

  it("the wait ends at the page that covers it, not when the pull ends", async () => {
    const t = await standUp();
    t.cloud.knobs.tailMs = 4_000;
    fakeClock();
    const { res, ms } = await t.press(`/messages/${t.cloud.msgId}/move`, "POST", { folder: "ohmail/News" });
    expect(res.headers.get("x-sync-seq")).toBeNull();
    expect(ms, "the answer waited for the whole pull").toBeLessThan(1_000);
    expect(await t.folderOf()).toBe("ohmail/News");
    expect(t.mirror.draining(), "the pull is still on the wire").toBe(true);
    await release();
  });

  it("a pull that would take 4 s is cut at the deadline, and the answer carries the LOCAL head", async () => {
    const t = await standUp();
    t.cloud.knobs.syncMs = 4_000;
    fakeClock();
    const before = t.cloud.asks.sync;
    let answered = false;
    const pressed = t.press(`/messages/${t.cloud.msgId}/move`, "POST", { folder: "ohmail/News" })
      .finally(() => { answered = true; });
    // The pull is on the wire and held there by the 4 s the hosted account takes; one tick short
    // of the bound the write is still waiting, and the bound alone answers it.
    await until(() => t.cloud.asks.sync > before);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(answered, "the write was answered before the bound").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => answered);
    const { res, ms } = await pressed;
    expect(res.status).toBe(200);
    expect(ms).toBeGreaterThanOrEqual(1_400);
    expect(ms).toBeLessThan(2_500);
    expect(t.events).toContain("cloud_write_echo");
    const stamped = res.headers.get("x-sync-seq");
    expect(stamped, "the hosted seq was relayed into the window's sequence").not.toBe(String(t.cloud.cloudSeq()));
    expect(stamped).toBe(String(await t.mirror.localSeq()));
    expect(await t.folderOf(), "the local copy has not pulled it yet").toBe("INBOX");
    await release();
  });

  it("a hosted Retry-After past the deadline answers at once rather than asking again", async () => {
    const t = await standUp();
    t.cloud.knobs.sync429 = true;
    fakeClock();
    const before = t.cloud.asks.sync;
    let answered = false;
    const pressed = t.press(`/messages/${t.cloud.msgId}/move`, "POST", { folder: "ohmail/News" })
      .finally(() => { answered = true; });
    // The one breath the loop takes after a settled pull is the only timer between the 429 and
    // the answer; neither the bound (1.5 s) nor the Retry-After (30 s) is ever reached.
    await until(() => t.cloud.asks.sync > before);
    await stepUntil(() => answered, 1_000);
    const { ms } = await pressed;
    expect(ms).toBeLessThan(1_000);
    expect(t.cloud.asks.sync - before, "the await hammered a refusing server").toBe(1);
    await release();
  });

  /* A Retry-After inside the deadline, and the wall clock stepped back an hour after it was read:
     the quiet is a monotonic instant, so the echo waits its two seconds and asks again. */
  const quietAcrossAStep = async (stepMs: number): Promise<{ answer: boolean | null; asked: number }> => {
    const t = await standUp();
    t.cloud.knobs.sync429 = true;
    t.cloud.knobs.retryAfterS = 2;
    fakeClock();
    await t.mirror.pullOnce().catch(() => undefined);
    t.cloud.knobs.sync429 = false;
    vi.setSystemTime(Date.now() - stepMs);
    const before = t.cloud.asks.sync;
    let answer: boolean | null = null;
    void t.mirror.awaitFreshPull(5_000).then((v) => { answer = v; });
    await stepUntil(() => answer !== null, 6_000);
    await release();
    return { answer, asked: t.cloud.asks.sync - before };
  };

  it("a hosted Retry-After inside the deadline is waited out by its own length across a clock stepped back", async () => {
    const r = await quietAcrossAStep(60 * 60_000);
    expect(r.answer, "the echo read the clock's step as an hour of Retry-After and gave up").toBe(true);
    expect(r.asked).toBeGreaterThanOrEqual(1);
  });

  it("CONTROL: with no step the Retry-After is waited out and the echo asks again", async () => {
    const r = await quietAcrossAStep(0);
    expect(r.answer).toBe(true);
    expect(r.asked).toBeGreaterThanOrEqual(1);
  });

  it("a write whose reads all relay (the away responder) asks the mirror nothing", async () => {
    const t = await standUp();
    const before = { ...t.cloud.asks };
    const { res } = await t.press("/away-responder", "PUT", { enabled: false, body: "away" });
    expect(res.status).toBe(200);
    expect(t.cloud.asks).toEqual(before);
  });

  it("a mailbox edit reads back at once, even while a pull is on the wire", async () => {
    const t = await standUp();
    t.cloud.knobs.tailMs = 4_000;
    fakeClock();
    const before = t.cloud.asks.sync;
    const inFlight = t.mirror.pullOnce();
    await until(() => t.cloud.asks.sync > before);
    expect(t.mirror.draining()).toBe(true);
    const { res, ms } = await t.press(`/mailboxes/${MB}`, "PATCH", { displayName: "Work" });
    expect(res.status).toBe(200);
    expect(ms).toBeLessThan(1_000);
    const [row] = await t.opened.db.select().from(mailboxes).where(eq(mailboxes.id, MB));
    expect(row?.displayName).toBe("Work");
    await vi.advanceTimersByTimeAsync(4_000);
    await inFlight;
    await release();
  });
});
