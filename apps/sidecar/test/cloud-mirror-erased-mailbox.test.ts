import type { DraftDTO, MessageDTO, RuleDTO, SyncChange, SyncResponse, ThreadDTO } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { awayReplies, changeLog, drafts, mailboxFolders, mailboxes, messages, rules, threads } from "@trafficflow/db/mail";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld } from "../src/identity.js";
import { createCloudMirror as makeCloudMirror } from "../src/cloud-mirror.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { tearDown, tracked } from "./_teardown.js";

const mirrors: ReturnType<typeof makeCloudMirror>[] = [];
const createCloudMirror = tracked(makeCloudMirror, mirrors);

/**
 * THE MIRROR DOES NOT REFILL A MAILBOX THIS INSTALL ERASED.
 *
 * The erasure leaves the `mailboxes` row as its tombstone here exactly as on the hosted store —
 * the standalone door runs the same `sweepMailboxData` — and the replay's folder, message and
 * draft writes hang off that row alone. SKIPPED rather than refused: `applyPage` has no catch
 * above it and the cursor moves only when it returns, so a throw would stop the mirror for every
 * mailbox on the device; both halves are asserted below. PGlite is production-truth in the
 * sidecar. Mutations watched red, restored by `cmp`: each arm's guard cut → its row present again.
 */

const CLOUD_ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOSTED = [hostedMailbox(CLOUD_MAILBOX, "me@ohmail.test")];

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [mirrors], close: opens, remove: dirs }));

const iso = (): string => new Date().toISOString();

const change = (
  type: SyncChange["type"], id: string, seq: number, entity: unknown,
): SyncChange => ({ type, op: "create", id, seq, updatedAt: iso(), entity });

const page = (changes: SyncChange[], cursor: string): SyncResponse => ({
  changes: { creates: changes, updates: [], moves: [], deletes: [] },
  cursor, hasMore: false, serverTime: iso(),
});


function messageDTO(id: string): MessageDTO {
  return {
    id, accountId: CLOUD_ACCOUNT, mailboxId: CLOUD_MAILBOX, threadId: null,
    messageIdHeader: `<${id}@sender.test>`, subject: "Can we talk?",
    from: { name: null, address: "stranger@nowhere.test" },
    to: [{ name: null, address: "me@ohmail.test" }], cc: [],
    arrivedAt: iso(), date: iso(), folder: "ohmail/Screener",
    snippet: "we have not met before", unread: true, lastReadAt: null,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: iso(),
  };
}

function draftDTO(id: string): DraftDTO {
  return {
    id, mailboxId: CLOUD_MAILBOX, threadId: null, inReplyToMessageId: null, forwardOfMessageId: null,
    subject: "unsent", body: "words nobody has read yet", html: null,
    to: [], cc: [], bcc: [], rationale: null, status: "draft",
    sendAt: null, sendError: null, createdAt: iso(), updatedAt: iso(), contentRevision: "r1",
  };
}

function ruleDTO(id: string): RuleDTO {
  return {
    id, kind: "sender", match: "stranger@nowhere.test", destination: "ohmail/Screened",
    priority: 0, provenance: "promoted", enabled: true,
    subjectContains: null, bodyContains: null,
    stats: { hits: 1, lastHitAt: iso(), demotions: 0 },
    retro: { requestedAt: null, doneAt: null },
    byOhmail: false,
    createdAt: iso(), updatedAt: iso(),
  };
}

/** The fake Cloud API: the mailbox list it refuses to drain without, then one page. */
function fakeAuth(pages: SyncResponse[]): CloudAuth {
  let s = 0;
  const json = (v: unknown): Response =>
    new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  const empty = page([], "end");
  return {
    authedFetch: async (path: string) => {
      if (path.startsWith("/mailboxes")) return json(mailboxList(HOSTED));
      if (path.startsWith("/sync/snapshot")) return json({ changes: [], cursor: "snap", window: null, serverTime: iso() });
      // The rules-first pass asks with `types=rule` before the mixed replay; serving it the
      // feed's own rule changes is what the suite beside this one does.
      if (path.startsWith("/sync")
        && new URLSearchParams(path.split("?")[1] ?? "").get("types") === "rule") {
        return json(empty);
      }
      if (path.startsWith("/sync")) return json(pages[s++] ?? empty);
      if (path.startsWith("/messages/bodies")) return json({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
  } as unknown as CloudAuth;
}

describe("the Cloud mirror leaves an erased mailbox erased", () => {
  it("skips its folder, its mail and its drafts — and the rest of the page still lands", async () => {
    const dataDir = await freshDataDir("ohmail-mirror-erased-");
    dirs.push(dataDir);
    const opened = await openLocalDb(dataDir);
    opens.push(opened);
    const db = opened.db;
    const world = await ensureLocalWorld(db, { address: "me@ohmail.test", now: new Date() });
    const cursorPath = join(dataDir, "cloud-cursor.json");

    // A first pull with an empty page, so the refresh writes the mailbox row this install holds.
    await createCloudMirror({ db, world, auth: fakeAuth([page([], "c0")]), cursorPath, now: () => new Date() })
      .pullOnce();
    const [mirrored] = await db.select().from(mailboxes).where(eq(mailboxes.id, CLOUD_MAILBOX));
    expect(mirrored, "the refresh did not mirror the hosted mailbox").toBeDefined();

    // THE ERASURE, on this store — the stamp `sweepMailboxData` writes first and the tombstone it
    // leaves behind. `status` is deliberately left alone: the arms under test ask `erased_at`, and
    // a disabled row would be skipped by the mailbox pre-scan before they were reached.
    await db.update(mailboxes).set({ erasedAt: new Date() }).where(eq(mailboxes.id, CLOUD_MAILBOX));

    const msgId = randomUUID();
    const draftId = randomUUID();
    const folderId = randomUUID();
    const ruleId = randomUUID();
    const feed = page([
      change("folder", folderId, 1, { id: folderId, name: "Receipts", mailboxId: CLOUD_MAILBOX }),
      change("message", msgId, 2, messageDTO(msgId)),
      change("draft", draftId, 3, draftDTO(draftId)),
      // The account's own row, which no mailbox erasure touches: the page must still land it, or
      // a skip would be indistinguishable from the stall this shape exists to avoid.
      change("rule", ruleId, 4, ruleDTO(ruleId)),
    ], "c1");

    await createCloudMirror({ db, world, auth: fakeAuth([feed]), cursorPath, now: () => new Date() })
      .pullOnce();

    expect(await db.select().from(mailboxFolders).where(eq(mailboxFolders.mailboxId, CLOUD_MAILBOX)))
      .toHaveLength(0);
    expect(await db.select().from(messages).where(eq(messages.id, msgId))).toHaveLength(0);
    expect(await db.select().from(drafts).where(eq(drafts.id, draftId))).toHaveLength(0);
    // …and the page was not refused: the account-scoped change landed.
    expect(await db.select().from(rules).where(eq(rules.id, ruleId))).toHaveLength(1);
    // The mailbox row itself SURVIVES, stamped — that is how the removal is remembered.
    const [after] = await db.select().from(mailboxes).where(eq(mailboxes.id, CLOUD_MAILBOX));
    expect(after!.erasedAt, "the refresh cleared the erasure stamp").not.toBeNull();
  });

  it("a mailbox DELETE lands inside the page transaction even with an away ledger row", async () => {
    /* THE CLOUD HALF of the standalone removal's defect. The door runs the same table walk inside
       ITS page transaction, so mail 0118's away key refused the whole page rather than one row —
       every later change on that page with it. Driven through `pullOnce`, not by calling the walk,
       because a test that calls it directly proves neither door. */
    const dataDir = await freshDataDir("ohmail-mirror-mbdelete-");
    dirs.push(dataDir);
    const opened = await openLocalDb(dataDir);
    opens.push(opened);
    const db = opened.db;
    const world = await ensureLocalWorld(db, { address: "me@ohmail.test", now: new Date() });
    const cursorPath = join(dataDir, "cloud-cursor.json");

    const msgId = randomUUID();
    await createCloudMirror({ db, world, auth: fakeAuth([page([change("message", msgId, 1, messageDTO(msgId))], "c0")]), cursorPath, now: () => new Date() })
      .pullOnce();
    expect(await db.select().from(messages).where(eq(messages.id, msgId))).toHaveLength(1);
    await db.insert(awayReplies).values({
      accountId: world.accountId, mailboxId: CLOUD_MAILBOX, messageId: msgId,
      sender: "correspondent@elsewhere.example", outcome: "sent",
    });

    const ruleId = randomUUID();
    const gone = (type: SyncChange["type"], id: string, seq: number): SyncChange =>
      ({ ...change(type, id, seq, null), op: "delete" });
    const feed: SyncResponse = {
      changes: { creates: [change("rule", ruleId, 3, ruleDTO(ruleId))], updates: [], moves: [],
        // An account-scoped create on the SAME page: a refusal would take it with the delete.
        deletes: [gone("mailbox", CLOUD_MAILBOX, 2)] },
      cursor: "c1", hasMore: false, serverTime: iso(),
    };
    await createCloudMirror({ db, world, auth: fakeAuth([feed]), cursorPath, now: () => new Date() })
      .pullOnce();

    expect(await db.select().from(messages).where(eq(messages.id, msgId)),
      "the mailbox delete left its mail behind").toHaveLength(0);
    expect(await db.select().from(awayReplies), "the away ledger outlived its mailbox").toHaveLength(0);
    expect(await db.select().from(rules).where(eq(rules.id, ruleId)),
      "the page was refused, so the rule beside the delete never landed").toHaveLength(1);
  });

  it("a mailbox DELETE tells the window which conversations it took, when the feed did not", async () => {
    /* A hosted erasure names each conversation it deletes; one from before it did (or a row from a
       standalone era) reaches this door as the receipt alone. The walk takes the thread, so the
       local log must say so or the window keeps its subject. Mutation: drop the announcement from
       `deleteOne` and the thread delete is absent. */
    const dataDir = await freshDataDir("ohmail-mirror-mbthread-");
    dirs.push(dataDir);
    const opened = await openLocalDb(dataDir);
    opens.push(opened);
    const db = opened.db;
    const world = await ensureLocalWorld(db, { address: "me@ohmail.test", now: new Date() });
    const cursorPath = join(dataDir, "cloud-cursor.json");

    const threadId = randomUUID();
    const msgId = randomUUID();
    const thread: ThreadDTO = {
      id: threadId, accountId: CLOUD_ACCOUNT, subject: "Can we talk?", messageIds: [msgId],
      participants: [], lastMessageAt: iso(), unreadCount: 1, muted: false, folder: "INBOX", updatedAt: iso(),
    };
    await createCloudMirror({ db, world, auth: fakeAuth([page([
      change("thread", threadId, 1, thread), change("message", msgId, 2, { ...messageDTO(msgId), threadId }),
    ], "c0")]), cursorPath, now: () => new Date() }).pullOnce();
    expect(await db.select().from(threads).where(eq(threads.id, threadId)), "the precondition").toHaveLength(1);

    const feed: SyncResponse = {
      changes: { creates: [], updates: [], moves: [],
        deletes: [{ ...change("mailbox", CLOUD_MAILBOX, 3, null), op: "delete" }] },
      cursor: "c1", hasMore: false, serverTime: iso(),
    };
    await createCloudMirror({ db, world, auth: fakeAuth([feed]), cursorPath, now: () => new Date() })
      .pullOnce();

    expect(await db.select().from(threads).where(eq(threads.id, threadId)),
      "the walk left the erased mailbox's conversation").toHaveLength(0);
    const said = (await db.select().from(changeLog).where(eq(changeLog.entityId, threadId)))
      .filter((r) => r.entityType === "thread" && r.op === "delete");
    expect(said, "the window was never told the conversation went").toHaveLength(1);
  });

  it("applies the same page when the mailbox is LIVE — the skip is not everything", async () => {
    const dataDir = await freshDataDir("ohmail-mirror-live-");
    dirs.push(dataDir);
    const opened = await openLocalDb(dataDir);
    opens.push(opened);
    const db = opened.db;
    const world = await ensureLocalWorld(db, { address: "me@ohmail.test", now: new Date() });
    const cursorPath = join(dataDir, "cloud-cursor.json");

    const msgId = randomUUID();
    const draftId = randomUUID();
    const folderId = randomUUID();
    const feed = page([
      change("folder", folderId, 1, { id: folderId, name: "Receipts", mailboxId: CLOUD_MAILBOX }),
      change("message", msgId, 2, messageDTO(msgId)),
      change("draft", draftId, 3, draftDTO(draftId)),
    ], "c1");

    await createCloudMirror({ db, world, auth: fakeAuth([feed]), cursorPath, now: () => new Date() })
      .pullOnce();

    expect(await db.select().from(mailboxFolders).where(eq(mailboxFolders.mailboxId, CLOUD_MAILBOX)))
      .toHaveLength(1);
    expect(await db.select().from(messages).where(eq(messages.id, msgId))).toHaveLength(1);
    expect(await db.select().from(drafts).where(eq(drafts.id, draftId))).toHaveLength(1);
  });
});
