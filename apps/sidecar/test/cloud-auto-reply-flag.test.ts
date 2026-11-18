import type {
  EngineMessage,
  MailboxDTO,
  MessageDTO,
  SnapshotResponse,
  SyncChange,
  SyncResponse,
} from "@ohmail/wire";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { awayReplies, changeLog } from "@trafficflow/db/mail";
import { materializeMessages } from "@trafficflow/services/mail";
import { ohboxView, type EntityReader } from "@ohmail/client-engine";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld, type LocalWorld } from "../src/identity.js";
import { createCloudMirror as makeCloudMirror, CURSOR_VERSION } from "../src/cloud-mirror.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { idleSession } from "./fixtures/cloud-auth-double.js";
import { tearDown, tracked } from "./_teardown.js";

const mirrors: ReturnType<typeof makeCloudMirror>[] = [];
const createCloudMirror = tracked(makeCloudMirror, mirrors);

/**
 * A MIRRORED AWAY REPLY KEEPS THE FLAG CLOUD GAVE IT (FIX-024).
 *
 * The web holds the away responder's own replies out of the Ohbox's "Earlier" by the hosted
 * `autoReplyByUs`. The local door derives that flag from the `away_replies` ledger, which the wire
 * does not carry, so the Cloud-paired desktop listed every such reply as the person's own mail. The
 * `message` arm now writes the hosted fact, and an upgraded mirror repairs the replies it holds once.
 */

const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWN = "me@ohmail.test";
const HOSTED_MAILBOXES: readonly MailboxDTO[] = [hostedMailbox(CLOUD_MAILBOX, OWN)];

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [mirrors], close: opens, remove: dirs }));

async function standUp(): Promise<{ db: OpenLocalDb["db"]; world: LocalWorld; cursorPath: string }> {
  const dataDir = await freshDataDir("ohmail-auto-reply-flag-");
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: OWN, now: new Date() });
  return { db: opened.db, world, cursorPath: join(dataDir, "cloud-cursor.json") };
}

const iso = (): string => new Date().toISOString();
const json = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

function syncPage(changes: SyncChange[], cursor: string): SyncResponse {
  return {
    changes: { creates: changes.filter((c) => c.op === "create"), updates: changes.filter((c) => c.op === "update"), moves: [], deletes: [] },
    cursor, hasMore: false, serverTime: iso(),
  };
}
const EMPTY_SNAPSHOT: SnapshotResponse = { asOfSeq: 99, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } };

/** An own Sent copy as the hosted door materializes it; `flag` is the hosted `autoReplyByUs`. */
function sent(id: string, header: string, flag: boolean | undefined): MessageDTO {
  return {
    id, accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", mailboxId: CLOUD_MAILBOX, threadId: null,
    messageIdHeader: header, subject: "Re: a question",
    from: { name: null, address: OWN }, to: [{ name: null, address: "friend@elsewhere.test" }], cc: [],
    // The wire carries the mailbox's own Sent path, which `Destination` does not name.
    arrivedAt: "2026-09-22T08:00:00.000Z", date: "2026-09-22T08:00:00.000Z", folder: "Sent" as MessageDTO["folder"],
    snippet: "", unread: false, lastReadAt: null, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-22T08:00:00.000Z",
    ...(flag === undefined ? {} : { autoReplyByUs: flag }),
  };
}
const change = (m: MessageDTO, op: SyncChange["op"], seq: number): SyncChange => ({ type: "message", op, id: m.id, seq, updatedAt: iso(), entity: m });

/** A fake Cloud API: the mailbox list, `/sync` pages by call order, and `GET /messages/:id` from `hosted`. */
function fakeAuth(sync: SyncResponse[], hosted: MessageDTO[], opts: { asked?: string[]; failReadOnce?: boolean } = {}): CloudAuth {
  let s = 0;
  let fail = opts.failReadOnce === true;
  const empty = syncPage([], "end");
  return {
    authedFetch: async (path: string) => {
      opts.asked?.push(path);
      if (path.startsWith("/mailboxes")) return json(mailboxList(HOSTED_MAILBOXES));
      if (path.startsWith("/sync/snapshot")) return json(EMPTY_SNAPSHOT);
      if (path.startsWith("/sync")) return json(sync[s++] ?? empty);
      if (path.startsWith("/messages/bodies")) return json({ items: [], nextCursor: null });
      const one = /^\/messages\/([^/?]+)$/.exec(path);
      if (one) {
        if (fail) { fail = false; throw new Error("network died mid-repair"); }
        const m = hosted.find((h) => h.id === decodeURIComponent(one[1]!));
        return m ? json(m) : new Response("not found", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  };
}

/** What the local door hands the window for these rows. */
async function localFlags(db: OpenLocalDb["db"], world: LocalWorld, ids: string[]): Promise<Record<string, boolean | undefined>> {
  const dtos = await materializeMessages(db, world.accountId, ids);
  return Object.fromEntries(ids.map((id) => [id, dtos.get(id)?.autoReplyByUs]));
}
const facts = async (db: OpenLocalDb["db"], world: LocalWorld) =>
  db.select().from(awayReplies).where(eq(awayReplies.accountId, world.accountId));

describe("the message arm carries the hosted away-reply flag", () => {
  it("a flagged reply reads flagged through the local door; the person's own reply does not", async () => {
    const { db, world, cursorPath } = await standUp();
    const reply = sent(randomUUID(), "auto-1@ohmail.test", true);
    const mine = sent(randomUUID(), "mine-1@ohmail.test", false);
    await createCloudMirror({ db, world, cursorPath, now: () => new Date(), auth: fakeAuth([syncPage([change(reply, "create", 1), change(mine, "create", 2)], "c1")], []) }).pullOnce();
    expect(await localFlags(db, world, [reply.id, mine.id]), "the mirror dropped the hosted flag").toEqual({ [reply.id]: true, [mine.id]: false });
    // Where the person sees it: the Ohbox's "Earlier" holds the person's reply and not the responder's.
    const held: Record<string, unknown[]> = { message: [...(await materializeMessages(db, world.accountId, [reply.id, mine.id])).values()] };
    const reader = {
      get: (t: string, id: string) => (held[t] as Array<{ id: string }> | undefined)?.find((e) => e.id === id),
      list: (t: string) => held[t] ?? [], version: () => 1, stampOf: () => 1, stampExcept: () => 1,
      entries: (t: string) => ((held[t] ?? []) as Array<{ id: string }>).map((e, i) => ({ id: e.id, entity: e, seq: i + 1 })),
    } as unknown as EntityReader;
    expect(ohboxView(reader).previouslySeen.map((m: EngineMessage) => m.id)).toEqual([mine.id]);
  });

  it("a re-delivered reply writes its fact once, and an absent flag writes none", async () => {
    const { db, world, cursorPath } = await standUp();
    const reply = sent(randomUUID(), "auto-2@ohmail.test", true);
    const old = sent(randomUUID(), "old-2@ohmail.test", undefined);
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([change(reply, "create", 1), change(old, "create", 2)], "c1"), syncPage([change(reply, "update", 3)], "c2")], []),
    }).pullOnce();
    const rows = await facts(db, world);
    expect(rows.map((r) => r.mintedMessageId)).toEqual(["<auto-2@ohmail.test>"]);
    expect(rows[0]).toMatchObject({ outcome: "sent", messageId: null, sender: "friend@elsewhere.test", mailboxId: CLOUD_MAILBOX });
  });
});

describe("an upgraded mirror repairs the away replies it holds unflagged", () => {
  /** What a pre-fix build left: the reply mirrored, no fact, a cursor that never heard of the repair. */
  async function staleMirror() {
    const { db, world, cursorPath } = await standUp();
    const reply = sent(randomUUID(), "auto-3@ohmail.test", true);
    const mine = sent(randomUUID(), "mine-3@ohmail.test", false);
    await createCloudMirror({ db, world, cursorPath, now: () => new Date(), auth: fakeAuth([syncPage([change(reply, "create", 1), change(mine, "create", 2)], "c1")], []) }).pullOnce();
    await db.delete(awayReplies).where(eq(awayReplies.accountId, world.accountId));
    const cur = JSON.parse(readFileSync(cursorPath, "utf8")) as Record<string, unknown>;
    delete cur.autoReplyRepair;
    writeFileSync(cursorPath, JSON.stringify(cur));
    return { db, world, cursorPath, reply, mine };
  }

  it("re-reads the account's own rows once, writes the fact, announces it, and never asks again", async () => {
    const { db, world, cursorPath, reply, mine } = await staleMirror();
    expect((await localFlags(db, world, [reply.id]))[reply.id], "the stale shape was not built").toBe(false);
    const asked: string[] = [];
    const events: string[] = [];
    const mirror = createCloudMirror({ db, world, cursorPath, now: () => new Date(), log: (e) => { events.push(e); }, auth: fakeAuth([syncPage([], "c2"), syncPage([], "c3")], [reply, mine], { asked }) });
    await mirror.pullOnce();
    expect(await localFlags(db, world, [reply.id, mine.id])).toEqual({ [reply.id]: true, [mine.id]: false });
    // The window's mirror drains this log: without the receipt the database is right and the screen is not.
    const announced = await db.select().from(changeLog).where(and(eq(changeLog.accountId, world.accountId), eq(changeLog.entityType, "message"), eq(changeLog.entityId, reply.id), eq(changeLog.op, "update")));
    expect(announced).toHaveLength(1);
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ autoReplyRepair: true });
    expect(events).toContain("cloud_auto_reply_repair_applied");
    const reads = asked.filter((p) => /^\/messages\/[^/]+$/.test(p) && !p.startsWith("/messages/bodies")).length;
    expect(reads).toBe(2);
    await mirror.pullOnce();
    expect(asked.filter((p) => /^\/messages\/[^/]+$/.test(p) && !p.startsWith("/messages/bodies")).length, "a consumed repair asked again").toBe(reads);
  });

  it("a failed read leaves the repair unconsumed and the pull green; the next pull heals", async () => {
    const { db, world, cursorPath, reply, mine } = await staleMirror();
    const mirror = createCloudMirror({ db, world, cursorPath, now: () => new Date(), auth: fakeAuth([syncPage([], "c2"), syncPage([], "c3")], [reply, mine], { failReadOnce: true }) });
    await mirror.pullOnce();
    expect((await localFlags(db, world, [reply.id]))[reply.id]).toBe(false);
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).not.toMatchObject({ autoReplyRepair: true });
    await mirror.pullOnce();
    expect((await localFlags(db, world, [reply.id]))[reply.id]).toBe(true);
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ autoReplyRepair: true });
  });

  it("a mirror whose own rows carry no flag is read, left alone, and marked", async () => {
    const { db, world, cursorPath, mine } = await staleMirror();
    await db.delete(awayReplies).where(eq(awayReplies.accountId, world.accountId));
    const events: string[] = [];
    await createCloudMirror({ db, world, cursorPath, now: () => new Date(), log: (e) => { events.push(e); }, auth: fakeAuth([syncPage([], "c2")], [mine]) }).pullOnce();
    expect(await facts(db, world)).toHaveLength(0);
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ autoReplyRepair: true });
    expect(events).not.toContain("cloud_auto_reply_repair_applied");
  });

  it("a bootstrap replays every message through the corrected arm and consumes the repair without a read", async () => {
    const { db, world, cursorPath } = await standUp();
    const reply = sent(randomUUID(), "auto-4@ohmail.test", true);
    writeFileSync(cursorPath, JSON.stringify({ version: CURSOR_VERSION, sync: "0", bodies: null }));
    const asked: string[] = [];
    await createCloudMirror({ db, world, cursorPath, now: () => new Date(), auth: fakeAuth([syncPage([change(reply, "create", 1)], "c1")], [reply], { asked }) }).pullOnce();
    expect((await localFlags(db, world, [reply.id]))[reply.id]).toBe(true);
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ autoReplyRepair: true });
    expect(asked.some((p) => /^\/messages\/[^/]+$/.test(p) && !p.startsWith("/messages/bodies"))).toBe(false);
  });
});
