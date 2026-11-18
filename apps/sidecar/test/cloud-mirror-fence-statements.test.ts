import type { MailboxDTO, MessageDTO, SyncChange, SyncResponse } from "@ohmail/wire";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { accounts, awayReplies, mailboxes, messages, threads } from "@trafficflow/db/mail";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld, type LocalWorld } from "../src/identity.js";
import { createCloudMirror as makeCloudMirror } from "../src/cloud-mirror.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { idleSession } from "./fixtures/cloud-auth-double.js";
import { freshDataDir } from "./_datadir.js";
import { tearDown, tracked } from "./_teardown.js";

const mirrors: ReturnType<typeof makeCloudMirror>[] = [];
const createCloudMirror = tracked(makeCloudMirror, mirrors);

/**
 * THE AWAY-REPLY ARM ASKS THE ERASURE FENCE ONLY WHEN IT WILL WRITE (FIX-025).
 *
 * It asked both stamps for EVERY mirrored message and only then read `autoReplyByUs`, so a
 * message that writes no away reply paid two reads for nothing — a third of a first sync's
 * statements went to the fence. Counted, not timed: the instrument counts protocol Parse/Query
 * messages, so statements inside a transaction count too. The straddle cases hold the fence's
 * point: a page applied after an erasure's stamp writes nothing for what it erased.
 */

const CLOUD_ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWN = "me@ohmail.test";
const HOSTED: readonly MailboxDTO[] = [hostedMailbox(CLOUD_MAILBOX, OWN)];
/** The fixture mailbox and its page; a measurement run scales both (to production's page size). */
const N = Number(process.env.OHMAIL_FENCE_RIG_MESSAGES ?? "500");
const PAGE = Number(process.env.OHMAIL_FENCE_RIG_PAGE ?? "250");

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [mirrors], close: opens, remove: dirs }));

/** Every statement the store is asked for, by its SQL text, while counting is on. */
function statementCounter(): { on: () => void; off: () => string[] } {
  let counting = false;
  let seen: string[] = [];
  const proto = PGlite.prototype as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const original = proto.execProtocol!;
  if (!(original as unknown as { __fence?: boolean }).__fence) {
    const cstring = (b: Uint8Array, at: number): [string, number] => {
      let end = at;
      while (end < b.length && b[end] !== 0) end++;
      return [Buffer.from(b.subarray(at, end)).toString("utf8"), end + 1];
    };
    const wrapped = async function counted(this: unknown, ...args: unknown[]): Promise<unknown> {
      const b = args[0] as Uint8Array;
      // Parse ('P') is one extended-protocol statement, Query ('Q') one simple one; the rest of
      // each exchange (describe, bind, execute, sync) belongs to the statement already counted.
      if (counting && b[0] === 0x50) seen.push(cstring(b, cstring(b, 5)[1])[0]);
      else if (counting && b[0] === 0x51) seen.push(cstring(b, 5)[0]);
      return original.apply(this, args);
    };
    (wrapped as unknown as { __fence: boolean }).__fence = true;
    proto.execProtocol = wrapped as never;
  }
  return { on: () => { counting = true; seen = []; }, off: () => { counting = false; return seen; } };
}
const counter = statementCounter();
/** A fence read: an erasure stamp asked FOR SHARE. */
const isFence = (s: string): boolean => /select "erased_at" from "(accounts|mailboxes)"[\s\S]*for share/i.test(s);

const iso = (): string => new Date().toISOString();
const json = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

function messageDTO(i: number, threadId: string | null, flag: boolean): MessageDTO {
  const at = new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString();
  return {
    id: randomUUID(), accountId: CLOUD_ACCOUNT, mailboxId: CLOUD_MAILBOX, threadId,
    messageIdHeader: `m-${i}@sender.test`, subject: `message ${i}`,
    from: { name: null, address: `sender-${i % 50}@elsewhere.test` },
    to: [{ name: null, address: OWN }], cc: [],
    arrivedAt: at, date: at, folder: "INBOX" as MessageDTO["folder"],
    snippet: "", unread: true, lastReadAt: null, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: at, autoReplyByUs: flag,
  };
}

/** `count` messages — pairs share a thread, every other pair has none — as `/sync` pages. */
function feed(count: number, flagged: (i: number) => boolean): { pages: SyncResponse[]; threaded: number } {
  const changes: SyncChange[] = [];
  let threaded = 0;
  let thread = randomUUID();
  for (let i = 0; i < count; i++) {
    if (i % 4 === 0) thread = randomUUID();
    const inThread = i % 4 < 2;
    if (inThread) threaded++;
    const m = messageDTO(i, inThread ? thread : null, flagged(i));
    changes.push({ type: "message", op: "create", id: m.id, seq: i + 1, updatedAt: iso(), entity: m });
  }
  const pages: SyncResponse[] = [];
  for (let at = 0; at < changes.length; at += PAGE) {
    const slice = changes.slice(at, at + PAGE);
    pages.push({
      changes: { creates: slice, updates: [], moves: [], deletes: [] },
      cursor: `c${at + slice.length}`, hasMore: at + PAGE < changes.length, serverTime: iso(),
    });
  }
  return { pages, threaded };
}

/** A fake Cloud API: the mailbox list, no opening window, and the replay by call order. */
function fakeAuth(
  pages: SyncResponse[], beforePage?: (n: number) => Promise<void>, hosted: readonly MailboxDTO[] = HOSTED,
): CloudAuth {
  let s = 0;
  const empty: SyncResponse = {
    changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "end", hasMore: false, serverTime: iso(),
  };
  return {
    authedFetch: async (path: string) => {
      if (path.startsWith("/mailboxes")) return json(mailboxList(hosted));
      if (path.startsWith("/sync/snapshot")) return new Response("not found", { status: 404 });
      if (path.startsWith("/sync") && new URLSearchParams(path.split("?")[1] ?? "").get("types") === "rule") {
        return json(empty);
      }
      if (path.startsWith("/sync")) {
        const n = s++;
        await beforePage?.(n);
        return json(pages[n] ?? empty);
      }
      if (path.startsWith("/messages/bodies")) return json({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  } as unknown as CloudAuth;
}

async function standUp(label: string): Promise<{ db: OpenLocalDb["db"]; world: LocalWorld; cursorPath: string }> {
  const dataDir = await freshDataDir(label);
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: OWN, now: new Date() });
  return { db: opened.db, world, cursorPath: join(dataDir, "cloud-cursor.json") };
}

/** One first sync of `count` messages, counted. */
async function firstSync(count: number, flagged: (i: number) => boolean) {
  const { db, world, cursorPath } = await standUp("ohmail-fence-statements-");
  const { pages, threaded } = feed(count, flagged);
  const mirror = createCloudMirror({ db, world, auth: fakeAuth(pages), cursorPath, now: () => new Date(), pageLimit: PAGE });
  counter.on();
  let seen: string[];
  const started = performance.now();
  try {
    await mirror.pullOnce();
  } finally {
    seen = counter.off();
  }
  const ms = Math.round(performance.now() - started);
  const landed = (await db.select({ id: messages.id }).from(messages)).length;
  return { seen, threaded, landed, fence: seen.filter(isFence).length, ms, db, world };
}

describe("a first sync asks the erasure fence only where a write depends on it", () => {
  it(`${N} messages that write no away reply ask only the message arm's own stamps`, async () => {
    const empty = await firstSync(0, () => false);
    const run = await firstSync(N, () => false);
    expect(run.landed, "the fixture did not mirror").toBe(N);
    // eslint-disable-next-line no-console -- the reading the report quotes
    console.log(`FENCE-RIG messages=${N} threaded=${run.threaded} statements=${run.seen.length} ` +
      `per_message=${(run.seen.length / N).toFixed(3)} fence=${run.fence} ` +
      `fence_per_message=${((run.fence - empty.fence) / N).toFixed(3)} fence_without_messages=${empty.fence} ms=${run.ms}`);
    expect(empty.fence, "the instrument read no fence at all").toBeGreaterThan(0);
    // The message arm's two doors: its mailbox's stamp for every message, the account's for every
    // thread stub. Nothing else per message — the away arm reads nothing for a row it will not write.
    expect(run.fence - empty.fence, "a message that writes no away reply asked the fence again")
      .toBe(N + run.threaded);
  }, 300_000);

  it("…and a flagged reply still asks both stamps before its write — the control", async () => {
    const count = 200;
    const flagged = (i: number): boolean => i % 10 === 0;
    const plain = await firstSync(count, () => false);
    const replies = await firstSync(count, flagged);
    const f = Array.from({ length: count }, (_, i) => i).filter(flagged).length;
    expect(await replies.db.select().from(awayReplies).where(eq(awayReplies.accountId, replies.world.accountId)))
      .toHaveLength(f);
    expect(replies.fence - plain.fence, "a flagged reply wrote without asking both stamps").toBe(2 * f);
  }, 300_000);
});

/** One page of `count` flagged replies for `mailboxId`, headers `<tag>-<i>`, threaded or not. */
function repliesPage(
  mailboxId: string, tag: string, count: number, seq: number, more: boolean, threadId: string | null = null,
): SyncResponse {
  const creates: SyncChange[] = Array.from({ length: count }, (_, i) => {
    const m = { ...messageDTO(seq + i, threadId, true), mailboxId, messageIdHeader: `${tag}-${i}@ohmail.test` };
    return { type: "message", op: "create", id: m.id, seq: seq + i, updatedAt: iso(), entity: m };
  });
  return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: `c${seq + count}`, hasMore: more, serverTime: iso() };
}
const merge = (a: SyncResponse, b: SyncResponse): SyncResponse =>
  ({ ...b, changes: { ...b.changes, creates: [...a.changes.creates, ...b.changes.creates] } });
const headers = async (db: OpenLocalDb["db"]): Promise<string[]> =>
  (await db.select({ h: messages.messageIdHeader }).from(messages)).map((r) => r.h ?? "").sort();
const minted = async (db: OpenLocalDb["db"], world: LocalWorld): Promise<string[]> =>
  (await db.select({ id: awayReplies.mintedMessageId }).from(awayReplies)
    .where(eq(awayReplies.accountId, world.accountId))).map((r) => r.id ?? "").sort();

describe("a drain that straddles an erasure writes nothing for what it erased", () => {
  it("the page after the ACCOUNT's erasure writes no message, thread or away reply", async () => {
    const { db, world, cursorPath } = await standUp("ohmail-fence-straddle-erasure-");
    const thread = randomUUID();
    const pages = [
      repliesPage(CLOUD_MAILBOX, "before", 2, 1, true),
      merge(repliesPage(CLOUD_MAILBOX, "after-solo", 2, 10, false),
        repliesPage(CLOUD_MAILBOX, "after-thread", 2, 12, false, thread)),
    ];
    let before: { messages: number; replies: number } | null = null;
    // A WARM mirror, so the drain below is incremental: a bootstrap's phantom sweep would take a
    // stray thread stub at the end and hide the one door this case must watch.
    await createCloudMirror({ db, world, auth: fakeAuth([]), cursorPath, now: () => new Date(), pageLimit: PAGE }).pullOnce();
    // THE ERASURE, between the pages: `deleteAccount`'s stamp, then its sweep — every row keyed by
    // the account's mailboxes goes with them, and the stamped `accounts` row stays.
    const auth = fakeAuth(pages, async (n) => {
      if (n !== 1) return;
      before = { messages: (await headers(db)).length, replies: (await minted(db, world)).length };
      await db.update(accounts).set({ erasedAt: new Date() }).where(eq(accounts.id, world.accountId));
      await db.execute(sql`truncate table mailboxes cascade`);
    });
    await createCloudMirror({ db, world, auth, cursorPath, now: () => new Date(), pageLimit: PAGE }).pullOnce();
    expect(before, "the page before the erasure did not land — the case measured nothing")
      .toEqual({ messages: 2, replies: 2 });
    // SKIPPED, not refused: the cursor moved past the page, so a throw is not what kept it out.
    expect((JSON.parse(readFileSync(cursorPath, "utf8")) as { sync?: string }).sync).toBe("c14");
    expect(await headers(db), "a message was written after the account's erasure").toEqual([]);
    expect(await minted(db, world), "an away reply was written after the account's erasure").toEqual([]);
    expect(await db.select().from(threads).where(eq(threads.id, thread)), "a thread stub outlived the erasure")
      .toHaveLength(0);
  }, 60_000);

  it("…with the rows still standing behind the stamp, the away arm's own read refuses the reply", async () => {
    const { db, world, cursorPath } = await standUp("ohmail-fence-straddle-stamp-");
    const pages = [repliesPage(CLOUD_MAILBOX, "before", 3, 1, true), repliesPage(CLOUD_MAILBOX, "after", 3, 10, false)];
    // The stamp ALONE, as the suite beside this one writes it: the mailbox row stands, so nothing
    // but the away arm's own fence is left between an unthreaded reply and its ledger row.
    const auth = fakeAuth(pages, async (n) => {
      if (n === 1) await db.update(accounts).set({ erasedAt: new Date() }).where(eq(accounts.id, world.accountId));
    });
    await createCloudMirror({ db, world, auth, cursorPath, now: () => new Date(), pageLimit: PAGE }).pullOnce();
    expect(await minted(db, world), "an away reply was written after the account's stamp (or none before it)")
      .toEqual(["<before-0@ohmail.test>", "<before-1@ohmail.test>", "<before-2@ohmail.test>"]);
  }, 60_000);

  it("one page naming an erased and a live MAILBOX writes the live one's rows alone", async () => {
    const other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const { db, world, cursorPath } = await standUp("ohmail-fence-straddle-mailbox-");
    const pages = [
      merge(repliesPage(CLOUD_MAILBOX, "gone-before", 2, 1, false), repliesPage(other, "live-before", 2, 3, true)),
      merge(repliesPage(CLOUD_MAILBOX, "gone-after", 2, 10, false), repliesPage(other, "live-after", 2, 12, false)),
    ];
    const auth = fakeAuth(pages, async (n) => {
      if (n === 1) await db.update(mailboxes).set({ erasedAt: new Date() }).where(eq(mailboxes.id, CLOUD_MAILBOX));
    }, [...HOSTED, hostedMailbox(other, "other@ohmail.test")]);
    await createCloudMirror({ db, world, auth, cursorPath, now: () => new Date(), pageLimit: PAGE }).pullOnce();
    const kept = ["gone-before-0", "gone-before-1", "live-after-0", "live-after-1", "live-before-0", "live-before-1"];
    expect(await headers(db), "the erased mailbox took mail after its stamp, or the live one lost some")
      .toEqual(kept.map((k) => `${k}@ohmail.test`));
    expect(await minted(db, world), "the erased mailbox took an away reply after its stamp")
      .toEqual(kept.map((k) => `<${k}@ohmail.test>`));
  }, 60_000);
});
