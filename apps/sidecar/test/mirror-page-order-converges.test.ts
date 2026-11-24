import type { SyncChange, SyncResponse } from "@ohmail/wire";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { drafts, messages, threads } from "@trafficflow/db/mail";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld } from "../src/identity.js";
import { createCloudMirror as makeCloudMirror, CURSOR_VERSION } from "../src/cloud-mirror.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { idleSession } from "./fixtures/cloud-auth-double.js";
import { tearDown, tracked } from "./_teardown.js";

const mirrors: ReturnType<typeof makeCloudMirror>[] = [];
const createCloudMirror = tracked(makeCloudMirror, mirrors);

/**
 * THE ONE CROSSING A REAL PAGE CARRIES CONVERGES UNDER KIND ORDER (MIRROR-PAGE-ORDER-IS-PER-ENTITY-
 * NOT-PER-FEED, closed NOT-REACHABLE). `sync-page-closure.test.ts` (services) drives the server's
 * writers into one page and finds exactly one non-delete naming an entity the page tombstones: a
 * reply draft naming its Trash-deleted message. That measured page, applied by the mirror in ONE
 * pull (kind order: upserts, then deletes) and one change per pull (feed order), ends in one state —
 * because `applyDelete` detaches the draft exactly as the feed-order FK-skip leaves it detached.
 */
const ACC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const iso = (): string => new Date().toISOString();
const opens: OpenLocalDb[] = []; const dirs: string[] = [];
afterEach(() => tearDown({ stop: [mirrors], close: opens, remove: dirs }));
const ch = (type: SyncChange["type"], id: string, op: SyncChange["op"], seq: number, entity?: unknown): SyncChange =>
  ({ type, op, id, seq, updatedAt: iso(), ...(entity !== undefined ? { entity } : {}) }) as SyncChange;
const page = (cs: SyncChange[], cursor: string): SyncResponse => ({
  changes: { creates: cs.filter((c) => c.op === "create"), updates: cs.filter((c) => c.op === "update"),
    moves: cs.filter((c) => c.op === "move"), deletes: cs.filter((c) => c.op === "delete") },
  cursor, hasMore: false, serverTime: iso(),
});
const msg = (id: string, threadId: string) => ({
  id, accountId: ACC, mailboxId: MB, threadId, messageIdHeader: `<${id}@s.test>`, subject: "Can we talk?",
  from: { name: null, address: "s@nowhere.test" }, to: [{ name: null, address: "me@ohmail.test" }], cc: [],
  arrivedAt: iso(), date: iso(), folder: "INBOX", snippet: "x", unread: true, lastReadAt: null,
  hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: iso(),
});
const thread = (id: string) => ({ id, accountId: ACC, subject: "Can we talk?", messageIds: [],
  participants: [{ name: null, address: "s@nowhere.test" }], lastMessageAt: iso(), unreadCount: 1, muted: false,
  folder: "INBOX", updatedAt: iso() });
const draft = (id: string, threadId: string, inReplyTo: string, subject: string) => ({ id, mailboxId: MB, threadId,
  inReplyToMessageId: inReplyTo, subject, body: "typing", html: null, to: [{ name: null, address: "s@nowhere.test" }],
  cc: [], bcc: [], rationale: null, status: "draft", createdAt: iso(), updatedAt: iso() });
function auth(pages: SyncResponse[]): CloudAuth {
  let s = 0;
  const json = (v: unknown): Response => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  const empty = page([], "end");
  return {
    authedFetch: async (path: string) => {
      if (path.startsWith("/mailboxes")) return json(mailboxList([hostedMailbox(MB, "me@ohmail.test")]));
      if (path.startsWith("/sync/snapshot")) return json({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });
      if (path.startsWith("/sync") && new URLSearchParams(path.split("?")[1] ?? "").get("types") === "rule") return json(empty);
      if (path.startsWith("/sync")) return json(pages[s++] ?? empty);
      if (path.startsWith("/messages/bodies")) return json({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  } as CloudAuth;
}

async function run(split: boolean): Promise<string> {
  const dataDir = await freshDataDir("ohmail-page-order-"); dirs.push(dataDir);
  const opened = await openLocalDb(dataDir); opens.push(opened);
  const db = opened.db;
  const world = await ensureLocalWorld(db, { address: "me@ohmail.test", now: new Date() });
  const cursorPath = join(dataDir, "cloud-cursor.json");
  const t = "11111111-1111-4111-8111-111111111111", m = "22222222-2222-4222-8222-222222222222", d = "33333333-3333-4333-8333-333333333333";
  await createCloudMirror({ db, world, cursorPath, now: () => new Date(),
    auth: auth([page([ch("thread", t, "create", 1, thread(t)), ch("message", m, "create", 2, msg(m, t))], "c1")]) }).pullOnce();
  // The measured page: a message delete, a draft create naming it, two more message deletes, a draft update.
  const measured = [ch("message", m, "delete", 3), ch("draft", d, "create", 4, draft(d, t, m, "re")),
    ch("message", m, "delete", 8), ch("message", m, "delete", 10), ch("draft", d, "update", 11, draft(d, t, m, "re: after"))];
  const pages = split ? measured.map((c, i) => page([c], `p${i}`)) : [page(measured, "p")];
  for (const p of pages) {
    writeFileSync(cursorPath, JSON.stringify({ version: CURSOR_VERSION, sync: "c1", bodies: null }));
    await createCloudMirror({ db, world, cursorPath, now: () => new Date(), auth: auth([p]) }).pullOnce();
  }
  const msgs = await db.select({ id: messages.id }).from(messages).where(eq(messages.id, m));
  const [dr] = await db.select({ id: drafts.id, subject: drafts.subject, reply: drafts.inReplyToMessageId, thread: drafts.threadId }).from(drafts).where(eq(drafts.id, d));
  const th = await db.select({ id: threads.id }).from(threads).where(eq(threads.id, t));
  return JSON.stringify({ message: msgs.length, draft: dr ?? null, thread: th.length });
}

describe("kind order and feed order reach one state on the measured page", () => {
  it("kind order in one page and feed order one change per page reach one state", { timeout: 120_000 }, async () => {
    const kind = await run(false);
    const feed = await run(true);
    expect(kind, "the page applied by kind reached a different state than the feed's order").toBe(feed);
    // And the state is the one the account holds: the message gone, the draft kept and detached.
    expect(JSON.parse(kind)).toMatchObject({ message: 0, draft: { subject: "re: after", reply: null }, thread: 1 });
  });
});
