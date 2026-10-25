import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  accountSettings, changeLog, drafts, folderState, mailboxFolders, mailboxes, messageBodies,
  messageStates, messages, messageTags, outboundSends, rules, tags, threadNotes, threads,
} from "@trafficflow/db/mail";
import { syncService } from "@trafficflow/services/mail";
import type {
  MailboxDTO, MessageBodyBatchItem, MessageDTO, MessageStateDTO, Page, RuleDTO, SnapshotResponse,
  SyncChange, SyncResponse, TagDTO, ThreadDTO,
} from "@trafficflow/services/mail";
import { openLocalDb, type LocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld, type LocalWorld } from "../src/identity.js";
import { createCloudMirror as makeCloudMirror, CURSOR_VERSION, WINDOW_REFUSALS_MAX } from "../src/cloud-mirror.js";
// THE THRESHOLD IS THE ENGINE'S, and this import is the proof: the sidecar's mirror used to
// carry its own `CLOUD_STALE_RESUME_MS` with the same value and a restated argument, and these
// scenarios drove it. They now drive the shared constant (INSTANT-ARCH §6.7) — so a change to
// the policy moves this suite and the engine's together, which is the point of retiring the
// second copy.
import { STALE_RESUME_MS } from "@trafficflow/core/drain-policy";
import type { CloudAuth } from "../src/cloud-auth.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { idleSession } from "./fixtures/cloud-auth-double.js";
import { tearDown, tracked } from "./_teardown.js";

const mirrors: ReturnType<typeof makeCloudMirror>[] = [];
const createCloudMirror = tracked(makeCloudMirror, mirrors);

/**
 * THE CLOUD MIRROR CONVERGES AGAINST THE HOSTED FEED — pull, apply, and re-apply.
 *
 * PGlite is production-truth in the sidecar (`db.ts`), so these run against the real migrated mail
 * schema with no mock below the wire: the fake Cloud API answers `/mailboxes`, `/sync` and
 * `/messages/bodies` as JSON, and everything from the apply upserts to the local `change_log` is
 * real.
 *
 * The properties that decide whether the mirror is usable at all:
 *  · the ACCOUNT REMAP — every DTO carries the HOSTED `accountId`; the rows must land under the
 *    LOCAL account or the mirror renders empty;
 *  · the MAILBOX ATTRIBUTION, which is the opposite rule — a mirrored message keeps the HOSTED
 *    mailbox id, because that id is what a send has to carry back to Cloud and what the From
 *    selector offers. See `cloud-mailbox-refresh.test.ts` for the refresh that makes it hold; and
 *  · the local `change_log` — one row per applied entity, which is what makes the Swift
 *    projection's own `/sync` advance.
 */

// The HOSTED ids the feed carries. `CLOUD_ACCOUNT` never appears locally — that is the remap.
// `CLOUD_MAILBOX` DOES: the refresh mirrors the account's mailbox row under its own id.
const CLOUD_ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** The account's own mailbox, as `GET /mailboxes` answers it. Address = the local login. */
const HOSTED_MAILBOXES = [hostedMailbox(CLOUD_MAILBOX, "me@ohmail.test")];

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [mirrors], close: opens, remove: dirs }));

async function standUp(): Promise<{ opened: OpenLocalDb; world: LocalWorld; dataDir: string; cursorPath: string }> {
  const dataDir = await freshDataDir("ohmail-cloud-mirror-");
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: "me@ohmail.test", now: new Date() });
  return { opened, world, dataDir, cursorPath: join(dataDir, "cloud-cursor.json") };
}

const iso = (): string => new Date().toISOString();

function change(type: SyncChange["type"], id: string, op: SyncChange["op"], seq: number, entity?: unknown, move?: SyncChange["move"]): SyncChange {
  return { type, op, id, seq, updatedAt: iso(), ...(entity !== undefined ? { entity } : {}), ...(move ? { move } : {}) };
}

function syncPage(changes: SyncChange[], cursor: string, hasMore: boolean): SyncResponse {
  return {
    changes: {
      creates: changes.filter((c) => c.op === "create"),
      updates: changes.filter((c) => c.op === "update"),
      moves: changes.filter((c) => c.op === "move"),
      deletes: changes.filter((c) => c.op === "delete"),
    },
    cursor,
    hasMore,
    serverTime: iso(),
  };
}

function messageDTO(id: string, threadId: string | null, over: Partial<MessageDTO> = {}): MessageDTO {
  return {
    id,
    accountId: CLOUD_ACCOUNT,
    mailboxId: CLOUD_MAILBOX,
    threadId,
    messageIdHeader: `<${id}@sender.test>`,
    subject: "Can we talk?",
    from: { name: null, address: "stranger@nowhere.test" },
    to: [{ name: null, address: "me@ohmail.test" }],
    cc: [],
    arrivedAt: iso(), date: iso(),
    folder: "ohmail/Screener",
    snippet: "we have not met before",
    unread: true,
    lastReadAt: null,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: iso(),
    ...over,
  };
}

function threadDTO(id: string): ThreadDTO {
  return {
    id,
    accountId: CLOUD_ACCOUNT,
    subject: "Can we talk?",
    messageIds: [],
    participants: [{ name: null, address: "stranger@nowhere.test" }],
    lastMessageAt: iso(),
    unreadCount: 1,
    muted: false,
    folder: "ohmail/Screener",
    updatedAt: iso(),
  };
}

function ruleDTO(id: string): RuleDTO {
  return {
    id,
    kind: "sender",
    match: "stranger@nowhere.test",
    destination: "ohmail/Screened",
    priority: 0,
    provenance: "promoted",
    enabled: true,
    subjectContains: null,
    bodyContains: null,
    stats: { hits: 3, lastHitAt: iso(), demotions: 0 },
    retro: { requestedAt: null, doneAt: null },
    byOhmail: false,
    createdAt: iso(),
    updatedAt: iso(),
  };
}

function stateDTO(messageId: string): MessageStateDTO {
  return { messageId, state: "reply_later", bubbleUpAt: null, setAt: iso(), updatedAt: iso() };
}

/**
 * A `message_state` change's WIRE ID IS THE ROW'S UUID, never the message's, and that is why
 * every call below spells it as a second `randomUUID()`.
 *
 * `MessageStateDTO` is the only DTO on the wire with no `id` field, so it is easy to read the
 * change's id as the messageId — the hosted side spells it `s.id` in the snapshot and
 * `entityId: row.id` in every delta writer. This file used to pass `msgId` for both, which made
 * one identity out of two and hid a defect where the mirror kept the local row under a random id
 * and then announced it under the hosted one: the local feed could not materialize it and served
 * every triage state as a delete tombstone (`cloud-mirror-triage-identity.test.ts`).
 */
const stateWireId = (): string => randomUUID();

const jsonRes = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

/**
 * The mailbox refresh, for the hand-rolled fakes below — and it is answered FIRST in every one of
 * them on purpose.
 *
 * A fake that lets `/mailboxes` fall through to a generic `{items: []}` is worse than one that
 * 404s: an empty list is a valid answer meaning "this account has no mailboxes", so the mirror
 * would retire the row it holds and then skip every message for want of somewhere to file it. The
 * test would still be green about whatever else it asserts.
 */
const mailboxesFor = (path: string, boxes: readonly MailboxDTO[] = HOSTED_MAILBOXES): Response | null =>
  path.startsWith("/mailboxes") ? jsonRes(mailboxList(boxes)) : null;

/** Parse the `since` query param off a `/sync?…` path. */
const sinceOf = (path: string): string | null => new URLSearchParams(path.split("?")[1] ?? "").get("since");

/**
 * Answer the bootstrap's RULES-FIRST ask (`/sync?…&types=rule`) from a feed that carries no rule
 * changes: the same log, filtered — empty, `hasMore:false`. The hand-rolled fakes below route
 * through this BEFORE their own counting and `since` dispatch, because their claims are about the
 * MIXED replay (resume position, page counts, 410 recovery) and the rules pass would otherwise eat
 * their first page or shift their recorded ask list. The ordering pass itself is pinned by its own
 * describe block, against a feed that does carry a rule.
 */
const rulesFirstAnswer = (path: string): Response | null =>
  path.startsWith("/sync") && !path.startsWith("/sync/snapshot")
    && new URLSearchParams(path.split("?")[1] ?? "").get("types") === "rule"
    ? jsonRes(syncPage([], "0", false))
    : null;

/**
 * A snapshot page. `/sync/snapshot` page 1 is the account's live state — every tag, plus the newest
 * window of messages — and it is what the one-time stale-mirror tag repair probes.
 *
 * Every row carries `seq = asOfSeq`, which is the snapshot contract (`SnapshotResponse`) and not an
 * arrangement of this helper's.
 */
function snapshotPage(changes: SyncChange[], asOfSeq = 99): SnapshotResponse {
  return {
    asOfSeq,
    changes: changes.map((c) => ({ ...c, op: "create" as const, seq: asOfSeq })),
    nextCursor: null,
    window: { days: 90, minRows: 500 },
  };
}

/** The empty live state: an account with no tags, which is what most of these tests are. */
const NO_TAGS = snapshotPage([]);

function tagDTOFor(id: string, name = "Invoices", hue = "clay"): TagDTO {
  return { id, name, hue, createdAt: iso(), updatedAt: iso() } as TagDTO;
}

const bodyItem = (messageId: string, text: string, html: string | null = null): MessageBodyBatchItem =>
  ({ messageId, text, html, loadedRemoteContent: false });

/**
 * `GET /messages/bodies` AS THE HOSTED ACCOUNT ACTUALLY SERVES IT — and this is the half of the
 * harness that used to make the bug under test invisible.
 *
 * The old fake answered from a LIST OF PAGES consumed by call order, so the second request for the
 * first page returned the list's next entry and every request past the end returned
 * `{items: [], nextCursor: null}`. A mirror that restarted its walk on every poll therefore looked
 * identical to one that never restarted it: both got an empty answer. The re-walk that pinned a
 * desktop CPU was, structurally, not observable here.
 *
 * So this serves a CORPUS instead, exactly as `MessageService.getBodies` does:
 *
 *  · keyset by ascending `messages.id`, `after` exclusive, `nextCursor` = the last id of the page
 *    and null only when nothing is left — so asking again from the start RESENDS everything;
 *  · `?ids=` answers only the named messages, and a message the account does not hold is simply
 *    absent from the answer rather than an error.
 *
 * With that, "did this mirror re-fetch the account?" is a question the harness can be asked.
 */
function serveBodies(
  corpus: readonly MessageBodyBatchItem[],
  path: string,
  pageSize: number,
  idsByteBudget = Infinity,
): Page<MessageBodyBatchItem> {
  const q = new URLSearchParams(path.split("?")[1] ?? "");
  const sorted = [...corpus].sort((a, b) => (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0));
  const ids = q.get("ids");
  if (ids !== null) {
    const wanted = new Set(ids.split(",").map((s) => s.trim()).filter((s) => s !== ""));
    const owned = sorted.filter((i) => wanted.has(i.messageId));
    // THE BYTE BUDGET, exactly as `MessageService.getBodiesByIds` applies it: uuid-ordered rows
    // are included until the running total CROSSES the budget, the crossing row stays in, and
    // everything after it is simply ABSENT from the answer — indistinguishable on the wire from
    // an id the account does not own. That indistinguishability is what the test below is about.
    const items: MessageBodyBatchItem[] = [];
    let bytes = 0;
    for (const i of owned) {
      items.push(i);
      bytes += Buffer.byteLength(i.text, "utf8") + (i.html ? Buffer.byteLength(i.html, "utf8") : 0);
      if (bytes >= idsByteBudget) break;
    }
    return { items, nextCursor: null };
  }
  const after = q.get("after");
  const rest = after ? sorted.filter((i) => i.messageId > after) : sorted;
  const items = rest.slice(0, pageSize);
  const last = items[items.length - 1];
  return { items, nextCursor: last && rest.length > items.length ? last.messageId : null };
}

/** Every `/messages/bodies` path a fake was asked for, so a test can count the account's re-walks. */
type Asked = string[];

/**
 * A fake Cloud API: `/sync` pages by call order, `/messages/bodies` off a corpus.
 *
 * `/sync/snapshot` IS MATCHED BEFORE `/sync` and that ordering is load-bearing rather than
 * cosmetic: the snapshot path is a prefix match away from eating a `/sync` page out of the list and
 * silently shifting every later assertion in the file.
 */
function fakeAuth(
  sync: SyncResponse[],
  bodies: readonly MessageBodyBatchItem[] = [],
  snapshot: SnapshotResponse = NO_TAGS,
  opts: {
    bodiesPageSize?: number; asked?: Asked; mailboxes?: readonly MailboxDTO[]; idsByteBudget?: number;
    /**
     * Pages for the bootstrap's `?types=rule` pass, in call order. The default is DERIVED from
     * `sync` — one page holding every rule change the mixed pages carry — because that is what
     * the real `/sync` answers: the same log, filtered. A fake that answered "no rules" to a
     * feed that carries one would hide exactly the ordering this pass exists for.
     */
    ruleSync?: SyncResponse[];
  } = {},
): CloudAuth {
  let s = 0;
  let r = 0;
  const empty = syncPage([], "end", false);
  const ruleChanges = sync.flatMap((p) =>
    [...p.changes.creates, ...p.changes.updates, ...p.changes.moves, ...p.changes.deletes]
      .filter((c) => c.type === "rule"));
  const rulePages = opts.ruleSync ?? [syncPage(ruleChanges, "rules-end", false)];
  const pageSize = opts.bodiesPageSize ?? 100;
  const boxes = opts.mailboxes ?? HOSTED_MAILBOXES;
  const json = (v: unknown): Response => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  return {
    authedFetch: async (path: string) => {
      opts.asked?.push(path);
      // BEFORE `/messages/bodies` in this table only for readability; the paths do not overlap.
      // The mirror asks for this at the start of every pull and refuses to drain without it.
      if (path.startsWith("/mailboxes")) return json(mailboxList(boxes));
      if (path.startsWith("/sync/snapshot")) return json(snapshot);
      // The rules-first pass — `types=rule` and nothing else. Matched BEFORE the mixed pages so
      // the bootstrap's opening ask cannot eat `sync[0]` and shift every later assertion.
      if (path.startsWith("/sync") && sinceOf(path) !== null
          && new URLSearchParams(path.split("?")[1] ?? "").get("types") === "rule") {
        return json(rulePages[r++] ?? empty);
      }
      if (path.startsWith("/sync")) return json(sync[s++] ?? empty);
      if (path.startsWith("/messages/bodies")) {
        return json(serveBodies(bodies, path, pageSize, opts.idsByteBudget ?? Infinity));
      }
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  };
}

/** The body requests out of a recorded call log — the number this whole slice is about. */
const bodyCalls = (asked: Asked): string[] => asked.filter((p) => p.startsWith("/messages/bodies"));

describe("the Cloud mirror pulls and applies the hosted feed", () => {
  it("applies a page, REMAPS the account/mailbox, writes folder_state, and advances the local /sync", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const msgId = randomUUID();
    const ruleId = randomUUID();

    const page = syncPage([
      change("thread", threadId, "create", 1, threadDTO(threadId)),
      change("message", msgId, "create", 2, messageDTO(msgId, threadId)),
      change("rule", ruleId, "create", 3, ruleDTO(ruleId)),
      change("message_state", stateWireId(), "update", 4, stateDTO(msgId)),
    ], "c4", false);

    const mirror = createCloudMirror({ db, world, auth: fakeAuth([page]), cursorPath, now: () => new Date() });
    const applied = await mirror.pullOnce();
    // FIVE, not four: the bootstrap's rules-first pass applies the rule once (fakeAuth serves it
    // the feed's one rule change), and the mixed replay re-applies it at its natural seq — the
    // documented double-apply that keeps the pass cursorless and the sweep unremarkable.
    expect(applied).toBe(5);

    // THE ACCOUNT REMAP. The row exists under the LOCAL account, never the hosted one.
    const [m] = await db.select().from(messages).where(eq(messages.id, msgId));
    expect(m, "the message was not mirrored").toBeDefined();
    expect(m!.accountId).toBe(world.accountId);
    expect(m!.accountId).not.toBe(CLOUD_ACCOUNT);
    // AND THE MAILBOX ATTRIBUTION, which goes the other way: the HOSTED mailbox id, because that
    // is the id a send has to carry back to Cloud and the id the From selector offers. Attributing
    // this to the local placeholder is what made every Cloud-door send collect a 400.
    expect(m!.mailboxId).toBe(CLOUD_MAILBOX);
    expect(m!.mailboxId).not.toBe(world.mailboxId);
    expect(m!.subject).toBe("Can we talk?");

    // folder_state.desired_folder is what message-service projects as the folder.
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, msgId));
    expect(fs).toMatchObject({ desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener" });

    // thread, rule, message_state all landed, remapped.
    expect(await db.select().from(threads).where(eq(threads.id, threadId))).toHaveLength(1);
    const [r] = await db.select().from(rules).where(eq(rules.id, ruleId));
    expect(r).toMatchObject({ accountId: world.accountId, match: "stranger@nowhere.test", destination: "ohmail/Screened" });
    const [st] = await db.select().from(messageStates).where(eq(messageStates.messageId, msgId));
    expect(st).toMatchObject({ accountId: world.accountId, state: "reply_later" });

    // THE LOCAL /sync ADVANCES: one change_log row per applied entity, under the local account,
    // and the projection reads the message back through the real sync service.
    const clog = await db.select().from(changeLog).where(eq(changeLog.accountId, world.accountId));
    // Five rows for five applies (see the `applied` note above): the rule once from the
    // rules-first pass and once from the mixed replay — a duplicate announcement the projection's
    // idempotent upsert absorbs. AND THE ORDER IS THE FEATURE: the rule's first row precedes
    // every message row, so a client tailing this log can never hold the sender's mail without
    // their decision.
    expect(clog.length).toBe(5);
    const bySeq = [...clog].sort((a, b) => Number(a.seq) - Number(b.seq));
    const firstRule = bySeq.find((c) => c.entityType === "rule");
    const firstMessage = bySeq.find((c) => c.entityType === "message");
    expect(firstRule, "the rules-first pass wrote no local row").toBeDefined();
    expect(Number(firstRule!.seq), "rules must enter the local log before mail")
      .toBeLessThan(Number(firstMessage!.seq));
    const result = await syncService.getChanges(
      { db, accountId: world.accountId, userId: world.userId, sessionId: null, now: () => new Date(), requestId: "", ip: "", userAgent: undefined, origin: undefined },
      { since: "0" },
    );
    const all = [...result.changes.creates, ...result.changes.updates];
    const seen = all.find((c) => c.type === "message" && c.id === msgId);
    expect(seen, "the mirrored message did not surface through the local /sync").toBeDefined();
    expect((seen!.entity as MessageDTO).folder).toBe("ohmail/Screener");
  });

  it("the cursor file records progress and re-applying a page converges (crash recovery)", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const msgId = randomUUID();
    const page = syncPage([
      change("thread", threadId, "create", 1, threadDTO(threadId)),
      change("message", msgId, "create", 2, messageDTO(msgId, threadId)),
    ], "cursor-A", false);

    await createCloudMirror({ db, world, auth: fakeAuth([page]), cursorPath, now: () => new Date() }).pullOnce();
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ sync: "cursor-A" });
    const afterFirst = (await db.select().from(messages)).length;
    expect(afterFirst).toBe(1);

    // A crash BEFORE the cursor write is replayed by re-requesting the same page from "0".
    writeFileSync(cursorPath, JSON.stringify({ sync: "0", bodies: null }));
    await createCloudMirror({ db, world, auth: fakeAuth([page]), cursorPath, now: () => new Date() }).pullOnce();

    // Upserts, so the re-apply changes nothing about the row set.
    expect(await db.select().from(messages)).toHaveLength(1);
    expect(await db.select().from(threads)).toHaveLength(1);
    expect(await db.select().from(folderState)).toHaveLength(1);
  });

  it("drains multiple pages and backfills bodies from GET /messages/bodies", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const t1 = randomUUID(); const m1 = randomUUID();
    const t2 = randomUUID(); const m2 = randomUUID();

    const sync = [
      syncPage([
        change("thread", t1, "create", 1, threadDTO(t1)),
        change("message", m1, "create", 2, messageDTO(m1, t1)),
      ], "p1", true),
      syncPage([
        change("thread", t2, "create", 3, threadDTO(t2)),
        change("message", m2, "create", 4, messageDTO(m2, t2)),
      ], "p2", false),
    ];
    // ONE body per page, so the walk has to follow `nextCursor` to reach the second.
    const bodies = [bodyItem(m1, "first body", "<p>first body</p>"), bodyItem(m2, "second body")];

    const applied = await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth(sync, bodies, NO_TAGS, { bodiesPageSize: 1 }),
    }).pullOnce();
    expect(applied).toBe(4);
    expect(await db.select().from(messages)).toHaveLength(2);

    const [b1] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, m1));
    expect(b1).toMatchObject({ text: "first body", html: "<p>first body</p>" });
    const [b2] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, m2));
    expect(b2).toMatchObject({ text: "second body", html: null });
    // `"complete"`, not `null`. The walk finishing and the walk never having started are two
    // different facts and this field now holds them apart — see `BodiesWalk` in `cloud-mirror.ts`.
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ sync: "p2", bodies: "complete" });
  });

  it("a delete tombstone removes the message and its children", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const msgId = randomUUID();

    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([
        change("thread", threadId, "create", 1, threadDTO(threadId)),
        change("message", msgId, "create", 2, messageDTO(msgId, threadId)),
        change("message_state", stateWireId(), "update", 3, stateDTO(msgId)),
      ], "c1", false)]),
    }).pullOnce();
    expect(await db.select().from(messages)).toHaveLength(1);

    /* A later page deletes the message. `version` is stamped CURRENT on every cursor this file
       hand-writes to stand for "a mirror that has already drained": without it the file reads as
       the pre-re-key format and the next drain re-bootstraps from zero, which is a different
       migration with its own tests (`cloud-mailbox-refresh.test.ts`) and would quietly replace the
       scenario each of these is about. */
    writeFileSync(cursorPath, JSON.stringify({ version: CURSOR_VERSION, sync: "c1", bodies: null }));
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([change("message", msgId, "delete", 4)], "c2", false)]),
    }).pullOnce();

    expect(await db.select().from(messages).where(eq(messages.id, msgId))).toHaveLength(0);
    expect(await db.select().from(folderState).where(eq(folderState.messageId, msgId))).toHaveLength(0);
    expect(await db.select().from(messageStates).where(eq(messageStates.messageId, msgId))).toHaveLength(0);
    // A local delete change_log row was emitted.
    const del = await db.select().from(changeLog)
      .where(and(eq(changeLog.entityId, msgId), eq(changeLog.op, "delete")));
    expect(del).toHaveLength(1);
  });
});

/**
 * A PAGE THAT CARRIES NO BODY MAY NOT BLANK ONE.
 *
 * `/sync/snapshot` will not carry a stored draft body past `DRAFT_BODY_MAX_BYTES`: the row arrives
 * with `body: null` and `bodyOmitted: "over_ceiling"`. This store cannot hold that state —
 * `drafts.body` is `NOT NULL` — so the old `d.body ?? ""` wrote an EMPTY body over the mirror's
 * copy, and the compose surface would have opened an empty editor on a message that is not empty
 * and autosaved the blank back to the account. Which is mail loss, arriving as a successful sync.
 *
 * The rule is the browser mirror's rule at this seam: an unknown body is not a body. A row we hold
 * keeps its text and everything else on the DTO still lands; a row we have never seen is not
 * created from a page that cannot describe it.
 */
describe("a draft change with no body never overwrites the one this mirror holds", () => {
  const draftWithBody = (id: string, body: string | null, subject: string): Record<string, unknown> => ({
    id,
    mailboxId: CLOUD_MAILBOX,
    threadId: null,
    inReplyToMessageId: null,
    subject,
    body,
    ...(body === null ? { bodyOmitted: "over_ceiling" } : {}),
    html: null,
    to: [],
    cc: [],
    bcc: [],
    rationale: null,
    status: "draft",
    createdAt: iso(),
    updatedAt: iso(),
  });

  /**
   * AND THE SAME FOR A SENT DRAFT, WHERE THE PAGE DROPS BOTH ENCODINGS.
   *
   * The bootstrap stopped carrying a sent draft's text at all. `bodyOmitted: "sent"` says the page
   * carried NEITHER half, so `html: null` on such a row is "not carried", not "this draft is plain
   * text" — writing it would blank the rich copy of a message somebody sent.
   *
   * WATCHED RED by restoring `html: d.html ?? null` unconditionally: the stored html comes back
   * `null` while the subject updates around it.
   */
  it("keeps the stored html too when the page says it carried neither half", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const draftId = randomUUID();
    const rich = "<p>what the person sent</p>";

    const sentRow = (body: string | null, subject: string): Record<string, unknown> => ({
      ...draftWithBody(draftId, body, subject),
      status: "sent",
      html: body === null ? null : rich,
      ...(body === null ? { bodyOmitted: "sent" } : {}),
    });

    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage(
        [change("draft", draftId, "create", 1, sentRow("what the person sent", "first"))],
        "c1", false,
      )]),
    }).pullOnce();
    const [first] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(first!.html).toBe(rich);

    writeFileSync(cursorPath, JSON.stringify({ version: CURSOR_VERSION, sync: "c1", bodies: null }));
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage(
        [change("draft", draftId, "update", 2, sentRow(null, "renamed"))],
        "c2", false,
      )]),
    }).pullOnce();

    const [row] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(row!.html, "the rich half of a sent message is not blanked by a page that omitted it")
      .toBe(rich);
    expect(row!.body).toBe("what the person sent");
    expect(row!.subject, "the rest of the row still lands").toBe("renamed");
  });

  it("keeps the stored text and still applies the rest of the row", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const draftId = randomUUID();

    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage(
        [change("draft", draftId, "create", 1, draftWithBody(draftId, "what the person wrote", "first"))],
        "c1", false,
      )]),
    }).pullOnce();
    expect((await db.select().from(drafts).where(eq(drafts.id, draftId)))[0]!.body)
      .toBe("what the person wrote");

    // The next page is a snapshot re-apply that would not carry the body.
    writeFileSync(cursorPath, JSON.stringify({ version: CURSOR_VERSION, sync: "c1", bodies: null }));
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage(
        [change("draft", draftId, "update", 2, draftWithBody(draftId, null, "renamed"))],
        "c2", false,
      )]),
    }).pullOnce();

    const [row] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(row!.body, "a page that carried no body blanked the stored one").toBe("what the person wrote");
    // NOT a dropped page: everything the DTO did carry still landed, and the cursor advanced.
    expect(row!.subject).toBe("renamed");
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ sync: "c2" });
  });

  it("does not invent an empty draft for a row it has never seen", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const draftId = randomUUID();

    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage(
        [change("draft", draftId, "create", 1, draftWithBody(draftId, null, "the long one"))],
        "c1", false,
      )]),
    }).pullOnce();

    // An empty row here is a draft the surface would show as blank and then save as blank.
    expect(await db.select().from(drafts).where(eq(drafts.id, draftId))).toHaveLength(0);
    // The page is not a failure — the cursor moves, exactly as it does for an unknown mailbox.
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ sync: "c1" });
  });

  it("an ORDINARY page still writes the body — the refusal is scoped to the absent one", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const draftId = randomUUID();

    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage(
        [change("draft", draftId, "create", 1, draftWithBody(draftId, "first text", "s"))],
        "c1", false,
      )]),
    }).pullOnce();
    writeFileSync(cursorPath, JSON.stringify({ version: CURSOR_VERSION, sync: "c1", bodies: null }));
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage(
        [change("draft", draftId, "update", 2, draftWithBody(draftId, "the edit from another device", "s"))],
        "c2", false,
      )]),
    }).pullOnce();

    expect((await db.select().from(drafts).where(eq(drafts.id, draftId)))[0]!.body)
      .toBe("the edit from another device");
  });

  it("the EMPTY STRING is a body, and still clears one", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const draftId = randomUUID();

    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage(
        [change("draft", draftId, "create", 1, draftWithBody(draftId, "typed then deleted", "s"))],
        "c1", false,
      )]),
    }).pullOnce();
    writeFileSync(cursorPath, JSON.stringify({ version: CURSOR_VERSION, sync: "c1", bodies: null }));
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage(
        [change("draft", draftId, "update", 2, draftWithBody(draftId, "", "s"))],
        "c2", false,
      )]),
    }).pullOnce();

    // The positive control for the predicate: `typeof d.body === "string"` and not truthiness.
    // Somebody emptying a draft on another device must empty it here too.
    expect((await db.select().from(drafts).where(eq(drafts.id, draftId)))[0]!.body).toBe("");
  });
});

/**
 * A DELETE NEVER WEDGES THE FEED — the 2026-08-24 staleness incident, reproduced.
 *
 * A hard delete that leaves one foreign key pointing at the row does not lose that row: it aborts
 * the page transaction with 23503, the cursor never advances, and every retry replays the identical
 * page into the identical violation. A live Linux install sat exactly there for two days — one
 * local draft whose `in_reply_to_message_id` named a message deleted on Cloud, `cloud_pull_failed`
 * code 23503 on every poll, a mirror that looked online and served mail from before the wedge.
 *
 * Both tests assert THE FEED SURVIVED (the cursor file advanced past the delete page) and not just
 * the row states: with the detach removed, the delete throws and the cursor stays pinned, so the
 * cursor assertion is the one that goes red for the actual failure mode.
 */
describe("a delete never wedges the feed on a foreign key", () => {
  it("deleting a message a local draft replies to DETACHES the draft and advances the cursor", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const msgId = randomUUID();
    const draftId = randomUUID();

    const draftDTO = {
      id: draftId,
      mailboxId: CLOUD_MAILBOX,
      threadId,
      inReplyToMessageId: msgId,
      subject: "Re: Can we talk?",
      body: "still typing this",
      html: null,
      to: [{ name: null, address: "stranger@nowhere.test" }],
      cc: [],
      bcc: [],
      rationale: null,
      status: "draft",
      createdAt: iso(),
      updatedAt: iso(),
    };
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([
        change("thread", threadId, "create", 1, threadDTO(threadId)),
        change("message", msgId, "create", 2, messageDTO(msgId, threadId)),
        change("draft", draftId, "create", 3, draftDTO),
      ], "c1", false)]),
    }).pullOnce();
    const [before] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(before?.inReplyToMessageId, "the reply draft did not mirror with its target").toBe(msgId);

    // Cloud deletes the message the draft replies to. The next pull must APPLY, not abort.
    writeFileSync(cursorPath, JSON.stringify({ version: CURSOR_VERSION, sync: "c1", bodies: null }));
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([change("message", msgId, "delete", 4)], "c2", false)]),
    }).pullOnce();

    // THE FEED SURVIVED: the cursor moved past the delete page. This is the assertion that catches
    // the wedge itself — with the detach gone, the page aborts on 23503 and `sync` stays "c1".
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ sync: "c2" });
    expect(await db.select().from(messages).where(eq(messages.id, msgId))).toHaveLength(0);
    // The draft is the user's writing: it survives, detached, exactly as the hosted store keeps it.
    const [after] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(after, "the reply draft was deleted with its target").toBeDefined();
    expect(after!.inReplyToMessageId).toBeNull();
    // The detach is announced on the local /sync — one update row for the surviving draft.
    expect(await db.select().from(changeLog)
      .where(and(eq(changeLog.entityId, draftId), eq(changeLog.op, "update")))).toHaveLength(1);
  });

  it("a forward draft mirrors with its original, and deleting the original DETACHES it", async () => {
    const KEPT_PART = randomUUID();
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const msgId = randomUUID();
    const draftId = randomUUID();
    const draftDTO = {
      id: draftId, mailboxId: CLOUD_MAILBOX, threadId: null, inReplyToMessageId: null, forwardOfMessageId: msgId,
      forwardParts: [KEPT_PART],
      subject: "Fwd: Can we talk?", body: "see below", html: null,
      to: [{ name: null, address: "stranger@nowhere.test" }], cc: [], bcc: [], rationale: null,
      status: "draft", createdAt: iso(), updatedAt: iso(),
    };
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([
        change("thread", threadId, "create", 1, threadDTO(threadId)),
        change("message", msgId, "create", 2, messageDTO(msgId, threadId)),
        change("draft", draftId, "create", 3, draftDTO),
      ], "c1", false)]),
    }).pullOnce();
    const [before] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(before?.forwardOfMessageId, "the forward draft did not mirror with its original").toBe(msgId);
    expect(before?.forwardParts, "the kept files did not reach the window's copy").toEqual([KEPT_PART]);

    writeFileSync(cursorPath, JSON.stringify({ version: CURSOR_VERSION, sync: "c1", bodies: null }));
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([change("message", msgId, "delete", 4)], "c2", false)]),
    }).pullOnce();

    expect(JSON.parse(readFileSync(cursorPath, "utf8")), "the delete wedged the feed on the forward key").toMatchObject({ sync: "c2" });
    const [after] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(after, "the forward draft was deleted with its original").toBeDefined();
    expect(after!.forwardOfMessageId).toBeNull();
    expect(after!.forwardParts, "the kept list outlived its original").toBeNull();
    expect(after!.body).toBe("see below");
  });

  it("deleting a thread that a stale local message still points at DETACHES the message", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const msgId = randomUUID();
    const draftId = randomUUID();

    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([
        change("thread", threadId, "create", 1, threadDTO(threadId)),
        change("message", msgId, "create", 2, messageDTO(msgId, threadId)),
      ], "c1", false)]),
    }).pullOnce();
    /* The STANDALONE ERA's rows, seeded directly: a database that organized this mailbox before
       the door switched holds thread notes and send records the Cloud door never writes. Each is
       a foreign key into what the thread delete removes, so each is its own way to wedge — the
       note against `threads`, the send record against the draft a delete-based cascade would
       have taken with the thread. */
    await db.insert(drafts).values({
      id: draftId, accountId: world.accountId, mailboxId: CLOUD_MAILBOX, threadId,
      subject: "keep me", body: "the user's writing", to: [], cc: [], status: "draft", updatedAt: new Date(),
    } as typeof drafts.$inferInsert);
    await db.insert(outboundSends).values({
      accountId: world.accountId, idempotencyKey: "send-1", draftId,
      mintedMessageId: "<send-1@ohmail.test>",
    } as typeof outboundSends.$inferInsert);
    await db.insert(threadNotes).values({
      accountId: world.accountId, threadId, body: "remember this thread",
    } as typeof threadNotes.$inferInsert);

    /* A hosted merge deletes the losing thread (`thread-service.ts#merge`) after re-pointing its
       messages — but a message whose update was SKIPPED (unknown mailbox) or lost below the feed's
       retention horizon still holds the old thread id. Deliver ONLY the thread delete: that is the
       page the wedged mirror actually faces. */
    writeFileSync(cursorPath, JSON.stringify({ version: CURSOR_VERSION, sync: "c1", bodies: null }));
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([change("thread", threadId, "delete", 3)], "c2", false)]),
    }).pullOnce();

    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ sync: "c2" });
    expect(await db.select().from(threads).where(eq(threads.id, threadId))).toHaveLength(0);
    // The draft is the user's writing: it SURVIVES detached, send record intact — the hosted
    // store still holds it, and a mirror that deleted it would resurrect it only on its next
    // hosted edit. The note cannot outlive the thread it annotates (NOT NULL FK): it goes.
    const [d] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(d, "the draft was deleted with its thread").toBeDefined();
    expect(d!.threadId).toBeNull();
    expect(await db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId))).toHaveLength(1);
    expect(await db.select().from(threadNotes).where(eq(threadNotes.threadId, threadId))).toHaveLength(0);
    // The message is real mail: it survives, unthreaded, until its own next update re-threads it.
    const [m] = await db.select().from(messages).where(eq(messages.id, msgId));
    expect(m, "the message was deleted with its thread").toBeDefined();
    expect(m!.threadId).toBeNull();
    // AND THE SURVIVORS ARE ANNOUNCED: the local /sync is change_log over this database, so a
    // detach nothing records is a detach the window never redraws.
    expect(await db.select().from(changeLog)
      .where(and(eq(changeLog.entityId, draftId), eq(changeLog.op, "update")))).toHaveLength(1);
    expect(await db.select().from(changeLog)
      .where(and(eq(changeLog.entityId, msgId), eq(changeLog.op, "update")))).toHaveLength(1);
  });

  it("deleting a draft with a standalone-era send record clears the record first", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const draftId = randomUUID();
    const draftDTO = {
      id: draftId, mailboxId: CLOUD_MAILBOX, threadId: null, inReplyToMessageId: null,
      subject: "s", body: "b", html: null, to: [], cc: [], bcc: [], rationale: null,
      status: "draft", createdAt: iso(), updatedAt: iso(),
    };
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([change("draft", draftId, "create", 1, draftDTO)], "c1", false)]),
    }).pullOnce();
    await db.insert(outboundSends).values({
      accountId: world.accountId, idempotencyKey: "send-2", draftId,
      mintedMessageId: "<send-2@ohmail.test>",
    } as typeof outboundSends.$inferInsert);

    writeFileSync(cursorPath, JSON.stringify({ version: CURSOR_VERSION, sync: "c1", bodies: null }));
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([change("draft", draftId, "delete", 2)], "c2", false)]),
    }).pullOnce();

    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ sync: "c2" });
    expect(await db.select().from(drafts).where(eq(drafts.id, draftId))).toHaveLength(0);
    expect(await db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId))).toHaveLength(0);
  });

  it("a thread hoarding stale messages past the bind-parameter cap is repaired, not re-wedged on it", async () => {
    /* THE MEASURED BOUNDARY. PGlite 0.2.17 takes at most its bind-parameter ceiling per statement and
       a change-log insert spends six per row, so ONE unchunked announce batch throws
       `RangeError: Invalid array length` at exactly the survivor count that crosses it — the transaction rolls back,
       the cursor pins, and the mirror is wedged BY its own repair. This test sits on that exact
       count: with the chunking removed, the pull throws and the cursor assertion goes red. */
    const N = 5462;
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();

    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([change("thread", threadId, "create", 1, threadDTO(threadId))], "c1", false)]),
    }).pullOnce();

    // The stale population, seeded directly (their updates "never arrived"), in slices that stay
    // under the same bind-parameter cap the announce path is being tested against.
    const now = new Date();
    const rows = Array.from({ length: N }, () => {
      const id = randomUUID();
      return {
        id, accountId: world.accountId, mailboxId: CLOUD_MAILBOX, bodyHash: "",
        dedupKey: `cloud:${id}`, threadId, subject: "stale", fromAddress: "s@x.test",
        snippet: "", toAddresses: [], ccAddresses: [], unread: false, updatedAt: now,
      } as typeof messages.$inferInsert;
    });
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(messages).values(rows.slice(i, i + 500));
    }

    writeFileSync(cursorPath, JSON.stringify({ version: CURSOR_VERSION, sync: "c1", bodies: null }));
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([change("thread", threadId, "delete", 2)], "c2", false)]),
    }).pullOnce();

    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ sync: "c2" });
    expect(await db.select().from(threads).where(eq(threads.id, threadId))).toHaveLength(0);
    // Every survivor was detached AND announced — N update rows, no more, no fewer.
    const updates = await db.select({ id: changeLog.entityId }).from(changeLog)
      .where(and(eq(changeLog.entityType, "message"), eq(changeLog.op, "update")));
    expect(updates).toHaveLength(N);
  }, 300_000);
});

/**
 * THE BODY WALK HAPPENS ONCE — the fix for a desktop that never went idle.
 *
 * `GET /messages/bodies` answers `nextCursor: null` on the last page, and the cursor stored that
 * answer as-is. The next pull read the same null as "no `after=` to send" and started the account
 * again from its first message, so a settled mirror re-fetched and re-upserted every body it already
 * held, every poll, for as long as the app was open: thousands of round trips and one `SELECT` plus
 * one `UPSERT` per body, twenty seconds apart, for ever. The mirror it produced was correct — every
 * write is an upsert — which is precisely why nothing caught it. What it cost was a process pinned
 * near a full core and a write-ahead log that grew without bound.
 *
 * These are the properties that make "the walk is finished" mean something. Every one of them is a
 * COUNT OF REQUESTS rather than a statement about rows: the rows were always right.
 */
describe("the Cloud mirror walks the account's bodies once, then only fetches what is new", () => {
  /** A message + its thread, as one `/sync` page. */
  const seedPage = (ids: { threadId: string; messageIds: string[] }, cursor: string): SyncResponse =>
    syncPage([
      change("thread", ids.threadId, "create", 1, threadDTO(ids.threadId)),
      ...ids.messageIds.map((m, i) => change("message", m, "create", i + 2, messageDTO(m, ids.threadId))),
    ], cursor, false);

  it("makes NO body request at all on the pulls after the walk has finished", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const corpus = ids.map((id) => bodyItem(id, `body of ${id}`));

    const asked: Asked = [];
    // Two per page, so the first pull genuinely pages rather than finishing in one request.
    const auth = fakeAuth([seedPage({ threadId, messageIds: ids }, "c1")], corpus, NO_TAGS, {
      bodiesPageSize: 2, asked,
    });
    const mirror = createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() });

    await mirror.pullOnce();
    expect(await db.select().from(messageBodies), "the first pull did not mirror the bodies").toHaveLength(3);
    expect(bodyCalls(asked).length, "the walk should have paged").toBeGreaterThan(1);
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ bodies: "complete" });

    // THE ASSERTION. Four more polls over a mailbox that has not changed.
    asked.length = 0;
    for (let i = 0; i < 4; i++) await mirror.pullOnce();
    expect(
      bodyCalls(asked),
      "a settled mirror re-fetched bodies it already holds — this is the re-walk",
    ).toEqual([]);

    // And a RELAUNCH reads the finished state off disk rather than starting again.
    const later: Asked = [];
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([], corpus, NO_TAGS, { bodiesPageSize: 2, asked: later }),
    }).pullOnce();
    expect(bodyCalls(later), "a relaunch re-walked the whole account").toEqual([]);
  });

  it("fetches the body of a NEWLY ARRIVED message, and only that one", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const settled = [randomUUID(), randomUUID()];
    const arriving = randomUUID();
    const corpus = [...settled, arriving].map((id) => bodyItem(id, `body of ${id}`));

    // Pull 1: the two messages that were already there. The newcomer is in the hosted corpus but no
    // change has carried it yet, so the walk cannot have written its body.
    const asked: Asked = [];
    const auth = fakeAuth(
      [seedPage({ threadId, messageIds: settled }, "c1"),
        syncPage([change("message", arriving, "create", 9, messageDTO(arriving, threadId))], "c2", false)],
      corpus, NO_TAGS, { asked },
    );
    const mirror = createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() });
    await mirror.pullOnce();
    expect(await db.select().from(messageBodies)).toHaveLength(2);

    // Pull 2: the newcomer's `message` change arrives.
    asked.length = 0;
    await mirror.pullOnce();

    const bodies = await db.select().from(messageBodies).where(eq(messageBodies.messageId, arriving));
    expect(bodies, "the new message never got its body").toHaveLength(1);
    expect(bodies[0]!.text).toBe(`body of ${arriving}`);

    // ONE request, NAMING ONLY THE NEWCOMER. Not a keyset page — a keyset walk from the start would
    // have re-sent the two settled bodies, which is the whole shape being ruled out here.
    const calls = bodyCalls(asked);
    expect(calls, "the new body took more than one request").toHaveLength(1);
    expect(calls[0]).toContain(`ids=${arriving}`);
    for (const old of settled) {
      expect(calls[0], "the request named a message that already had a body").not.toContain(old);
    }

    // And it settles: the pull after that asks for nothing again.
    asked.length = 0;
    await mirror.pullOnce();
    expect(bodyCalls(asked), "the newcomer's body was fetched more than once").toEqual([]);
  });

  it("asks at most once for a message the hosted account no longer answers for", async () => {
    // `?ids=` omits a message this account does not hold rather than erroring, so a message deleted
    // on Cloud between the drain that mirrored it and the tombstone that removes it has no body and
    // never will. Re-asking every poll would be the re-walk again, in miniature.
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const held = randomUUID();
    const vanished = randomUUID();

    const asked: Asked = [];
    const auth = fakeAuth(
      [seedPage({ threadId, messageIds: [held] }, "c1"),
        syncPage([change("message", vanished, "create", 9, messageDTO(vanished, threadId))], "c2", false)],
      [bodyItem(held, "held")], NO_TAGS, { asked },
    );
    const mirror = createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() });
    await mirror.pullOnce();

    asked.length = 0;
    await mirror.pullOnce();
    expect(bodyCalls(asked), "the mirror did not ask for the body it is missing").toHaveLength(1);

    asked.length = 0;
    for (let i = 0; i < 3; i++) await mirror.pullOnce();
    expect(
      bodyCalls(asked),
      "the mirror kept asking for a body the account will never answer with",
    ).toEqual([]);
  });

  it("a body the BYTE BUDGET left out of a batch answer is not read as deleted — it still lands", async () => {
    /**
     * THE OWNER'S DESKTOP SYMPTOM, AS A MECHANISM (2026-08-21): one specific message renders on
     * webmail and opens BLANK on desktop, and stays blank for as long as the app stays open.
     *
     * `GET /messages/bodies?ids=` drops ids from its answer for TWO reasons the wire cannot
     * distinguish: the account does not own the id (deliberate — a 404 would be an existence
     * oracle), and `BODIES_BYTE_BUDGET` was crossed before the id's row was reached
     * (`message-service.ts`: "What is left out is asked for per message by the client" — the
     * answer's own contract). This mirror read EVERY absence as the first case and parked the id
     * in `unanswered` for the launch's lifetime — so a message that had the bad luck to sort
     * after ~4 MiB of catch-up neighbours in one 20-id batch mirrored as a row with NO body,
     * for ever on a long-running install. The webmail engine takes the same answer correctly
     * (`hydrateThread`: "ids the answer did not carry are fetched singly below"); only this
     * consumer conflated the two meanings.
     *
     * An owned message ALWAYS yields an item — the service LEFT-JOINs the body row and answers
     * empty text rather than omitting the row — so absence from a NON-EMPTY answer can only be
     * the budget, and an EMPTY answer to a non-empty ask can only be "none of these are owned".
     * That is the discriminator the fix uses, and this test drives both sides of it.
     */
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    // Literal uuids so the batch order is the one under test: `big` sorts BEFORE `victim`.
    const big = "1aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const victim = "2bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    const asked: Asked = [];
    const auth = fakeAuth(
      [seedPage({ threadId, messageIds: [] }, "c1"),
        syncPage([
          change("message", big, "create", 9, messageDTO(big, threadId)),
          change("message", victim, "create", 10, messageDTO(victim, threadId)),
        ], "c2", false)],
      [bodyItem(big, "x".repeat(64)), bodyItem(victim, "the body the reader could not open")],
      NO_TAGS,
      // The budget is crossed by `big`'s own row, so `victim` is absent from the first answer —
      // exactly the truncation shape the hosted service produces at 4 MiB.
      { asked, idsByteBudget: 32 },
    );
    const mirror = createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() });
    await mirror.pullOnce(); // the walk settles (both bodies FK-skip: no rows yet)
    await mirror.pullOnce(); // both messages land; the gap ask meets the budget

    // Give the steady state every later chance it denies itself within one launch.
    await mirror.pullOnce();
    await mirror.pullOnce();

    const [b] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, victim));
    expect(b, "the budget-truncated body was read as deleted and never fetched again").toBeDefined();
    expect(b!.text).toBe("the body the reader could not open");

    // And the settled state still settles: nothing left to ask for.
    asked.length = 0;
    await mirror.pullOnce();
    expect(bodyCalls(asked), "a stored body was re-asked for").toEqual([]);
  });

  /**
   * THE CURSOR FILES THAT ARE ALREADY ON DISK.
   *
   * Every install running before this change carries `bodies: null`, and that one value stands for
   * two different states: a walk that FINISHED (every mirror that has been up longer than the few
   * minutes a first walk takes — the common case) and one that has not started (a brand-new install
   * caught between its first `/sync` drain and its first body page). Reading them all as "not
   * started" would re-walk every account once per launch; reading them all as "finished" would
   * strand a half-imported mailbox with no way to fetch the rest.
   *
   * The tiebreaker is a fact already written down: `mailboxes.initial_import_completed_at` is
   * stamped exactly when a pass drains with the body walk spent, and never unstamped.
   */
  describe("a cursor file written before the walk had a terminal state", () => {
    it("reads a null cursor WITH the import stamp as a finished walk — no re-walk", async () => {
      const { opened, world, cursorPath } = await standUp();
      const db = opened.db;
      const threadId = randomUUID();
      const ids = [randomUUID(), randomUUID()];
      const corpus = ids.map((id) => bodyItem(id, `body of ${id}`));

      await createCloudMirror({
        db, world, cursorPath, now: () => new Date(),
        auth: fakeAuth([seedPage({ threadId, messageIds: ids }, "c1")], corpus),
      }).pullOnce();
      // THE MIRRORED row, not the local placeholder: the refresh retires that one on the first
      // pull, and the stamp belongs to the mailbox the mail actually came from.
      const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, CLOUD_MAILBOX));
      expect(row!.initialImportCompletedAt, "the first walk did not stamp the import").not.toBeNull();

      // The cursor an OLD build left behind: no terminal state in it at all.
      writeFileSync(cursorPath, JSON.stringify({ version: CURSOR_VERSION, sync: "c1", bodies: null, bootstrapping: false, tagBackfill: true }));

      const asked: Asked = [];
      await createCloudMirror({
        db, world, cursorPath, now: () => new Date(),
        auth: fakeAuth([], corpus, NO_TAGS, { asked }),
      }).pullOnce();

      expect(bodyCalls(asked), "an upgraded install re-walked its whole account").toEqual([]);
      // And it is written down, so the question is asked once rather than on every launch.
      expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ bodies: "complete" });
    });

    it("reads a null cursor WITHOUT the import stamp as a walk that has not started", async () => {
      const { opened, world, cursorPath } = await standUp();
      const db = opened.db;
      const threadId = randomUUID();
      const id = randomUUID();

      // The cursor an old build left mid-import: a null `bodies`, and a mailbox row that was never
      // stamped because no pass has yet drained with the walk spent. Written BEFORE the mirror is
      // constructed, because that is when the cursor file is read.
      writeFileSync(cursorPath, JSON.stringify({ sync: "0", bodies: null, bootstrapping: false }));
      const asked: Asked = [];
      const auth = fakeAuth(
        [seedPage({ threadId, messageIds: [id] }, "c1")],
        [bodyItem(id, "the body that was still owed")],
        NO_TAGS,
        { asked },
      );
      await createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() }).pullOnce();

      const [b] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, id));
      expect(b, "an unfinished import was mistaken for a finished one and never fetched its bodies").toBeDefined();
      const walked = bodyCalls(asked);
      expect(walked.length, "no keyset page was requested").toBeGreaterThan(0);
      expect(walked[0], "it resumed from somewhere instead of starting the walk").not.toContain("after=");
    });
  });
});

/**
 * QUITTING WHILE A PULL IS RUNNING.
 *
 * `stop()` cleared the poll timer and returned, which stops the NEXT pull and says nothing about the
 * one already walking. The database close that follows is queued behind everything that walk goes on
 * asking the database to do, so a quit during a drain waited on a walk that had not been told to
 * stop — past the shell's five-second grace, at which point the process is killed rather than
 * closed. With the walk asked to leave between pages, the wait is one request and one page.
 */
describe("the Cloud mirror stops a pull that is already running", () => {
  /** The shell's grace period (`apps/desktop/src-tauri/src/engine.rs`'s `STOP_GRACE`). */
  const STOP_GRACE_MS = 5_000;

  it("leaves mid-walk when asked, rather than finishing the account first", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    // Enough messages that finishing the walk would take far more pages than the ask allows.
    const ids = Array.from({ length: 60 }, () => randomUUID());
    const corpus = ids.map((id) => bodyItem(id, `body of ${id}`));

    const page = syncPage([
      change("thread", threadId, "create", 1, threadDTO(threadId)),
      ...ids.map((m, i) => change("message", m, "create", i + 2, messageDTO(m, threadId))),
    ], "c1", false);

    let askToStop: () => Promise<void> = async () => undefined;
    let stopping: Promise<void> | null = null;
    let bodyPages = 0;
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        if (path.startsWith("/sync/snapshot")) return jsonRes(NO_TAGS);
        if (path.startsWith("/sync")) return jsonRes(page);
        if (path.startsWith("/messages/bodies")) {
          bodyPages++;
          // Asked to quit while the walk is in flight — from inside the walk, which is the only
          // place the race this is about actually happens.
          if (bodyPages === 3) stopping ??= askToStop();
          return jsonRes(serveBodies(corpus, path, 1));
        }
        return new Response("not found", { status: 404 });
      },
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    const mirror = createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() });
    askToStop = () => mirror.stop();

    const began = Date.now();
    await mirror.pullOnce();
    await stopping;

    expect(bodyPages, "the walk finished the account instead of leaving when asked").toBeLessThan(8);
    expect(bodyPages, "the walk never started").toBeGreaterThanOrEqual(3);

    // Read BEFORE the close, because after it there is no database to read. An interrupted walk is
    // NOT a finished one, and nothing may claim the import completed.
    expect(
      (JSON.parse(readFileSync(cursorPath, "utf8")) as { bodies: unknown }).bodies,
      "an interrupted walk recorded itself as finished",
    ).not.toBe("complete");
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, CLOUD_MAILBOX));
    expect(row!.initialImportCompletedAt, "an interrupted pass stamped the import as finished").toBeNull();

    // AND THE DATABASE CLOSES BEHIND IT. This is the quit, in the order `cloud-engine.ts` performs
    // it: ask the mirror to stop, wait for it to be out of the database, then close.
    await opened.close();
    const elapsed = Date.now() - began;
    expect(elapsed, `the quit took ${elapsed}ms, past the ${STOP_GRACE_MS}ms grace`).toBeLessThan(STOP_GRACE_MS);
  });

  it("stops a DRAIN between pages, and leaves the bootstrap marked so the next launch redoes it", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();

    let syncPages = 0;
    let stopping: Promise<void> | null = null;
    let askToStop: () => Promise<void> = async () => undefined;
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        if (path.startsWith("/sync/snapshot")) return jsonRes(NO_TAGS);
        const rf = rulesFirstAnswer(path);
        if (rf) return rf; // the rules-first pass is not one of the endless pages under test
        if (path.startsWith("/sync")) {
          syncPages++;
          if (syncPages === 2) stopping ??= askToStop();
          // A feed that keeps saying `hasMore`, so the ASK is the only thing that can end this
          // drain — bounded at 50 pages purely so that a mirror which ignores the ask fails this
          // test on the page COUNT rather than hanging until a timeout. A guard that hangs is
          // indistinguishable from one that is slow.
          const m = randomUUID();
          return jsonRes(syncPage([
            change("thread", threadId, "create", syncPages * 2, threadDTO(threadId)),
            change("message", m, "create", syncPages * 2 + 1, messageDTO(m, threadId)),
          ], `p${syncPages}`, syncPages < 50));
        }
        if (path.startsWith("/messages/bodies")) return jsonRes({ items: [], nextCursor: null });
        return new Response("not found", { status: 404 });
      },
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    const mirror = createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() });
    askToStop = () => mirror.stop();

    const began = Date.now();
    await mirror.pullOnce();
    await stopping;

    // The bootstrap generation only marked part of the account, so it must NOT be swept against —
    // and the flag has to survive, or the next launch would resume incrementally from a partial
    // rebuild and sweep rows the feed simply had not reached.
    const cur = JSON.parse(readFileSync(cursorPath, "utf8")) as { bootstrapping: boolean };
    expect(cur.bootstrapping, "an interrupted bootstrap was recorded as a finished one").toBe(true);

    await opened.close();
    expect(Date.now() - began, "the drain did not stop when asked").toBeLessThan(STOP_GRACE_MS);
    expect(syncPages, "an endless drain ran on past the ask").toBeLessThan(8);
  });
});

describe("a 410 cursor-expiry re-bootstraps from since=0 and SWEEPS phantoms", () => {
  /**
   * The signal under test is `sync-service.ts`: a cursor below the retention horizon answers 410,
   * and a `since=0` re-pull replays only CURRENT entities. A message deleted on Cloud while the
   * mirror was offline — its tombstone since fallen below the horizon — is therefore ABSENT from the
   * re-pull, and without a sweep the local row would linger as a phantom forever. This fake answers
   * 410 to any stale (non-zero) cursor, then serves the current feed from `since=0`.
   */
  function fakeAuth410ThenBootstrap(bootstrap: SyncResponse): CloudAuth {
    let servedBootstrap = false;
    const empty = syncPage([], "end", false);
    return {
      authedFetch: async (path: string) => {
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        if (path.startsWith("/sync/snapshot")) return jsonRes(NO_TAGS);
        const rf = rulesFirstAnswer(path);
        if (rf) return rf; // the re-bootstrap's rules pass must not eat the one bootstrap page
        if (path.startsWith("/sync")) {
          const since = sinceOf(path);
          if (since && since !== "0") return new Response("cursor expired", { status: 410 });
          if (!servedBootstrap) { servedBootstrap = true; return jsonRes(bootstrap); }
          return jsonRes(empty);
        }
        if (path.startsWith("/messages/bodies")) return jsonRes({ items: [], nextCursor: null });
        return new Response("not found", { status: 404 });
      },
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
  }

  it("deletes the cursor, re-pulls from zero, sweeps a row absent from the feed, keeps the rest", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const tKeep = randomUUID(); const mKeep = randomUUID();
    const tPhantom = randomUUID(); const mPhantom = randomUUID();

    // ── Phase 1: an ordinary pull mirrors BOTH messages, plus the phantom's child state and body,
    //    and advances the cursor past zero (the next drain would be incremental). ──
    const seed = syncPage([
      change("thread", tKeep, "create", 1, threadDTO(tKeep)),
      change("message", mKeep, "create", 2, messageDTO(mKeep, tKeep)),
      change("thread", tPhantom, "create", 3, threadDTO(tPhantom)),
      change("message", mPhantom, "create", 4, messageDTO(mPhantom, tPhantom)),
      change("message_state", stateWireId(), "update", 5, stateDTO(mPhantom)),
    ], "cursor-seed", false);
    const seedBodies = [bodyItem(mKeep, "keep"), bodyItem(mPhantom, "phantom")];
    await createCloudMirror({ db, world, auth: fakeAuth([seed], seedBodies), cursorPath, now: () => new Date() }).pullOnce();

    expect(await db.select().from(messages)).toHaveLength(2);
    expect(await db.select().from(messageStates).where(eq(messageStates.messageId, mPhantom))).toHaveLength(1);
    expect(await db.select().from(messageBodies).where(eq(messageBodies.messageId, mPhantom))).toHaveLength(1);
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ sync: "cursor-seed", bootstrapping: false });

    // ── Phase 2: the phantom was deleted on Cloud long ago. The next incremental /sync answers 410;
    //    the re-pull's since=0 feed carries ONLY the surviving message. ──
    const bootstrap = syncPage([
      change("thread", tKeep, "create", 1, threadDTO(tKeep)),
      change("message", mKeep, "create", 2, messageDTO(mKeep, tKeep)),
    ], "cursor-fresh", false);

    await createCloudMirror({ db, world, auth: fakeAuth410ThenBootstrap(bootstrap), cursorPath, now: () => new Date() }).pullOnce();

    // THE SWEEP: the phantom message, its thread, state, folder_state and body are ALL gone.
    expect(await db.select().from(messages).where(eq(messages.id, mPhantom)), "the phantom message was not swept").toHaveLength(0);
    expect(await db.select().from(threads).where(eq(threads.id, tPhantom)), "the phantom thread was not swept").toHaveLength(0);
    expect(await db.select().from(messageStates).where(eq(messageStates.messageId, mPhantom))).toHaveLength(0);
    expect(await db.select().from(folderState).where(eq(folderState.messageId, mPhantom))).toHaveLength(0);
    expect(await db.select().from(messageBodies).where(eq(messageBodies.messageId, mPhantom))).toHaveLength(0);

    // The survivor and its thread/body are untouched — the sweep removes ONLY what the feed dropped.
    expect(await db.select().from(messages).where(eq(messages.id, mKeep))).toHaveLength(1);
    expect(await db.select().from(threads).where(eq(threads.id, tKeep))).toHaveLength(1);
    expect(await db.select().from(messageBodies).where(eq(messageBodies.messageId, mKeep))).toHaveLength(1);

    // The projection LEARNS the sweep: local delete change_log rows for the phantom message AND thread.
    const deletes = await db.select().from(changeLog).where(eq(changeLog.op, "delete"));
    expect(deletes.some((r) => r.entityType === "message" && r.entityId === mPhantom), "no delete row for the swept message").toBe(true);
    expect(deletes.some((r) => r.entityType === "thread" && r.entityId === tPhantom), "no delete row for the swept thread").toBe(true);

    // The cursor was rewritten from the fresh bootstrap and the flag cleared.
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ sync: "cursor-fresh", bootstrapping: false });
  });
});

describe("a bootstrap drains the account's RULES before its mail", () => {
  /**
   * THE OWNER-REPORTED SHAPE, at this seam: a `since=0` replay is seq-ordered, and a sender the
   * account decided AFTER their mail arrived replays as mail-first — so for the whole stretch
   * between the mail's seqs and the rule's, this mirror (and every client reading it: the shell's
   * snapshot off the live tables, its delta off the local `change_log`) holds messages whose
   * sender looks UNDECIDED. The consent cutline then presents an already-screened sender in the
   * Screener until the replay catches up. Unknown is not undecided.
   *
   * The bootstrap therefore opens with a `?types=rule` drain to the horizon, cursorless, so the
   * local log carries every rule below the first message whatever the hosted seq order was.
   *
   * WATCHED RED by deleting the `rulesFirstOwed` block from `drainSync`: the opening ask becomes
   * the mixed `since=0`, and the message's local row lands below the rule's.
   */
  const typesOf = (path: string): string | null =>
    new URLSearchParams(path.split("?")[1] ?? "").get("types");

  it("asks for rules first and lands them in the local change_log below the first message", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const msgId = randomUUID();
    const ruleId = randomUUID();

    // The defect's feed order: the decided sender's mail (seqs 1–2) strictly before the rule
    // that decided them (seq 3), across a page boundary so the mixed replay would have rendered
    // the mail alone. `fakeAuth` answers the rules pass with the same log filtered — the rule.
    const page1 = syncPage([
      change("thread", threadId, "create", 1, threadDTO(threadId)),
      change("message", msgId, "create", 2, messageDTO(msgId, threadId)),
    ], "p1", true);
    const page2 = syncPage([
      change("rule", ruleId, "create", 3, ruleDTO(ruleId)),
    ], "p2", false);

    const asked: Asked = [];
    await createCloudMirror({
      db, world, auth: fakeAuth([page1, page2], [], NO_TAGS, { asked }), cursorPath, now: () => new Date(),
    }).pullOnce();

    // The opening `/sync` ask is the rules pass — from zero, rules only.
    const firstSync = asked.find((p) => p.startsWith("/sync") && !p.startsWith("/sync/snapshot"));
    expect(firstSync, "the mirror never drained").toBeDefined();
    expect(typesOf(firstSync!)).toBe("rule");
    expect(sinceOf(firstSync!)).toBe("0");
    // …and it never advanced the cursor of record: the mixed replay still started at zero.
    const firstMixed = asked.find((p) => p.startsWith("/sync") && !p.startsWith("/sync/snapshot")
      && typesOf(p) !== "rule");
    expect(sinceOf(firstMixed!), "the rules pass must not commit the drain's cursor").toBe("0");

    // The local log a client tails: the rule's first row sits BELOW the message's, although the
    // hosted feed carried them the other way around.
    const clog = (await db.select().from(changeLog).where(eq(changeLog.accountId, world.accountId)))
      .sort((a, b) => Number(a.seq) - Number(b.seq));
    const ruleRow = clog.find((c) => c.entityType === "rule");
    const messageRow = clog.find((c) => c.entityType === "message");
    expect(ruleRow, "the rules pass wrote no local row").toBeDefined();
    expect(messageRow, "the mixed replay never landed the message").toBeDefined();
    expect(Number(ruleRow!.seq), "the sender's decision must enter the local log before their mail")
      .toBeLessThan(Number(messageRow!.seq));

    // And both converged: the mirror holds the rule and the message once each.
    expect(await db.select().from(rules).where(eq(rules.id, ruleId))).toHaveLength(1);
    expect(await db.select().from(messages).where(eq(messages.id, msgId))).toHaveLength(1);

    await opened.close();
  });

  /**
   * WATCHED RED by making `rulesFirstOwed` unconditionally true: the second pull — incremental,
   * cursor committed — opens with a `types=rule` ask it does not owe, one wasted request per
   * poll for the life of every warm mirror.
   */
  it("owes no rules pass on an incremental drain", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const msgId = randomUUID();
    const seed = syncPage([
      change("thread", threadId, "create", 1, threadDTO(threadId)),
      change("message", msgId, "create", 2, messageDTO(msgId, threadId)),
    ], "warm", false);
    await createCloudMirror({ db, world, auth: fakeAuth([seed]), cursorPath, now: () => new Date() }).pullOnce();

    const asked: Asked = [];
    await createCloudMirror({
      db, world, auth: fakeAuth([syncPage([], "warm", false)], [], NO_TAGS, { asked }), cursorPath, now: () => new Date(),
    }).pullOnce();
    expect(
      asked.some((p) => p.startsWith("/sync") && typesOf(p) === "rule"),
      "a warm, incremental drain asked for the rules pass it does not owe",
    ).toBe(false);

    await opened.close();
  });
});

describe("the Cloud mirror reconnects and resumes from the cursor file", () => {
  it("a dropped incremental drain leaves the committed cursor intact; the next pull resumes from it", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const t1 = randomUUID(); const m1 = randomUUID();
    const t2 = randomUUID(); const m2 = randomUUID();

    // Phase 1: a COMPLETE bootstrap mirrors m1 and commits cursor "c1" with the flag cleared.
    const boot = syncPage([
      change("thread", t1, "create", 1, threadDTO(t1)),
      change("message", m1, "create", 2, messageDTO(m1, t1)),
    ], "c1", false);
    await createCloudMirror({ db, world, auth: fakeAuth([boot]), cursorPath, now: () => new Date() }).pullOnce();
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ sync: "c1", bootstrapping: false });

    // Phase 2: a fresh mirror (a relaunch). The incremental /sync?since=c1 DROPS once, then serves page2.
    const page2 = syncPage([
      change("thread", t2, "create", 3, threadDTO(t2)),
      change("message", m2, "create", 4, messageDTO(m2, t2)),
    ], "c2", false);
    let dropped = false;
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        if (path.startsWith("/sync")) {
          if (sinceOf(path) === "c1") {
            if (!dropped) { dropped = true; throw new Error("network dropped"); }
            return jsonRes(page2);
          }
          return jsonRes(syncPage([], "end", false));
        }
        if (path.startsWith("/messages/bodies")) return jsonRes({ items: [], nextCursor: null });
        return new Response("not found", { status: 404 });
      },
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    const mirror = createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() });

    // The dropped drain rejects and marks the mirror offline; nothing new lands and the cursor holds.
    await expect(mirror.pullOnce()).rejects.toThrow(/network dropped/);
    expect(mirror.online(), "a failed pull marks the mirror offline").toBe(false);
    expect(await db.select().from(messages).where(eq(messages.id, m2))).toHaveLength(0);
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ sync: "c1" });

    // Reconnect: the next pull RESUMES from c1 (an incremental drain, no re-bootstrap) and applies m2.
    await mirror.pullOnce();
    expect(mirror.online(), "a successful pull marks the mirror online").toBe(true);
    expect(await db.select().from(messages).where(eq(messages.id, m2))).toHaveLength(1);
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ sync: "c2", bootstrapping: false });
  });
});

/**
 * TAGS REACH THE MIRROR — the identity and the assignment, which travel differently.
 *
 * A tag is two facts on the wire and they arrive by two routes. Its IDENTITY — the name and the
 * hue — is a `tag` entity of its own. Its ASSIGNMENT to a message is not: it rides the `message`
 * entity as `MessageDTO.labels`, so an assign or an unassign is one message change carrying the
 * whole set.
 *
 * Both halves were missing here, and the second was hidden by the first: the mirror asked for
 * eight of the feed's nine types and `tag` was not one of them, so nothing ever arrived to apply.
 * A hosted account with tags rendered an empty tag rail on the desktop and no chips on any
 * message, indistinguishable from an account that has never made one.
 */
describe("the Cloud mirror carries tags and their assignments", () => {
  it("asks the feed for tags at all", async () => {
    const { opened, world, cursorPath } = await standUp();
    const asked: string[] = [];
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        asked.push(path);
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        // The bootstrap's opening window reads the snapshot before the replay; a fake that let it
        // fall through to the feed page would answer a snapshot ask with a feed body.
        if (path.startsWith("/sync/snapshot")) return jsonRes(NO_TAGS);
        if (path.startsWith("/sync")) return jsonRes(syncPage([], "end", false));
        return jsonRes({ items: [], nextCursor: null });
      },
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    await createCloudMirror({ db: opened.db, world, auth, cursorPath, now: () => new Date() }).pullOnce();
    // The first MIXED `/sync`: the mailbox refresh runs ahead of the drain, and the bootstrap's
    // rules-first pass (`types=rule`) runs ahead of the mixed replay whose type list is under test.
    const drain = asked.find((p) => p.startsWith("/sync") && !p.startsWith("/sync/snapshot")
      && new URLSearchParams(p.split("?")[1] ?? "").get("types") !== "rule");
    expect(drain, "the mirror never drained").toBeDefined();
    const types = new URLSearchParams(drain!.split("?")[1]).get("types")!.split(",");
    expect(types, "the drain must name `tag` or the server sends none").toContain("tag");
  });

  it("applies a tag, remaps it, hangs a message's labels off it, and lets both go", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const msgId = randomUUID();
    const tagId = randomUUID();
    const strangerTag = randomUUID();

    const tagDTO = {
      id: tagId, name: "Invoices", hue: "clay",
      createdAt: iso(), updatedAt: iso(),
    };

    /* The tag's own change is at a LOWER seq than the message that names it — which is not an
       arrangement of this test's, it is the only order the hosted account can produce: a tag has
       to exist before anything can be assigned to it. `strangerTag` is the other case, an id in
       `labels` naming a tag this mirror has never received, and it must be skipped rather than
       stubbed. */
    const page = syncPage([
      change("tag", tagId, "create", 1, tagDTO),
      change("thread", threadId, "create", 2, threadDTO(threadId)),
      change("message", msgId, "create", 3, messageDTO(msgId, threadId, { labels: [tagId, strangerTag] })),
    ], "c3", false);

    await createCloudMirror({ db, world, auth: fakeAuth([page]), cursorPath, now: () => new Date() }).pullOnce();

    const [t] = await db.select().from(tags).where(eq(tags.id, tagId));
    expect(t, "the tag was not mirrored").toBeDefined();
    expect(t!.accountId).toBe(world.accountId);
    expect(t!.accountId).not.toBe(CLOUD_ACCOUNT);
    expect(t).toMatchObject({ name: "Invoices", hue: "clay" });

    const assigned = await db.select().from(messageTags).where(eq(messageTags.messageId, msgId));
    expect(assigned.map((a) => a.tagId)).toEqual([tagId]);
    expect(assigned[0]!.accountId).toBe(world.accountId);

    // AND IT SURFACES. The local `/sync` is what the window drains, so the assertion is made
    // where the client would see it rather than on the row that backs it.
    const ctx = { db, accountId: world.accountId, userId: world.userId, sessionId: null, now: () => new Date(), requestId: "", ip: "", userAgent: undefined, origin: undefined };
    const first = await syncService.getChanges(ctx, { since: "0" });
    const seenTag = [...first.changes.creates, ...first.changes.updates].find((c) => c.type === "tag" && c.id === tagId);
    expect(seenTag, "the tag did not surface through the local /sync").toBeDefined();
    const seenMsg = [...first.changes.creates, ...first.changes.updates].find((c) => c.type === "message" && c.id === msgId);
    expect((seenMsg!.entity as MessageDTO).labels).toEqual([tagId]);

    /* UNASSIGN. The wire delivers it as the same message with a shorter `labels`, so an apply that
       only ever inserted would leave the chip on for ever. */
    const unassign = syncPage([
      change("message", msgId, "update", 4, messageDTO(msgId, threadId, { labels: [] })),
    ], "c4", false);
    await createCloudMirror({ db, world, auth: fakeAuth([unassign]), cursorPath, now: () => new Date() }).pullOnce();
    expect(await db.select().from(messageTags).where(eq(messageTags.messageId, msgId))).toHaveLength(0);
    expect(await db.select().from(tags).where(eq(tags.id, tagId)), "the tag itself outlives the assignment").toHaveLength(1);

    /* AND A DELETED TAG takes its assignments with it and leaves the messages alone. */
    const reassign = syncPage([
      change("message", msgId, "update", 5, messageDTO(msgId, threadId, { labels: [tagId] })),
    ], "c5", false);
    await createCloudMirror({ db, world, auth: fakeAuth([reassign]), cursorPath, now: () => new Date() }).pullOnce();
    expect(await db.select().from(messageTags).where(eq(messageTags.messageId, msgId))).toHaveLength(1);

    const gone = syncPage([change("tag", tagId, "delete", 6)], "c6", false);
    await createCloudMirror({ db, world, auth: fakeAuth([gone]), cursorPath, now: () => new Date() }).pullOnce();
    expect(await db.select().from(tags).where(eq(tags.id, tagId))).toHaveLength(0);
    expect(await db.select().from(messageTags).where(eq(messageTags.messageId, msgId))).toHaveLength(0);
    expect(await db.select().from(messages).where(eq(messages.id, msgId)), "the message survives its tag").toHaveLength(1);
  });
});

/**
 * HOW FAR THIS MAILBOX HAS GOT, WRITTEN DOWN — the two columns the window's sync line reads.
 *
 * On a hosted account the worker writes them. On a mirrored install this process is the only thing
 * that could, and it was writing neither — so the mailbox row said "not one pass has completed"
 * and "the first import is not known to have finished" for the life of the install. The second is
 * read as a FLOOR: while it is null the client is entitled to keep saying "Syncing your mail",
 * absolutely for the first day. A desktop install would therefore have announced an import in
 * progress for a day over a mailbox that finished in a minute, which is why the window was given no
 * mailbox facts at all and had no first-sync progress either.
 */
describe("the Cloud mirror records how far it has got", () => {
  it("stamps the pass, and the completed first import, on the local mailbox row", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;

    // Before any pull the only row is the local placeholder `identity.ts` mints, and neither stamp
    // has been written. The refresh replaces it with the account's own on the first pull.
    const before = await db.select().from(mailboxes).where(eq(mailboxes.id, world.mailboxId));
    expect(before[0]!.lastSyncAt, "nothing has run yet").toBeNull();
    expect(before[0]!.initialImportCompletedAt).toBeNull();

    const threadId = randomUUID();
    const msgId = randomUUID();
    const page = syncPage([
      change("thread", threadId, "create", 1, threadDTO(threadId)),
      change("message", msgId, "create", 2, messageDTO(msgId, threadId)),
    ], "c2", false);

    await createCloudMirror({ db, world, auth: fakeAuth([page]), cursorPath, now: () => new Date() }).pullOnce();

    const [after] = await db.select().from(mailboxes).where(eq(mailboxes.id, CLOUD_MAILBOX));
    expect(after!.lastSyncAt, "a completed pull is a completed pass").not.toBeNull();
    expect(
      after!.initialImportCompletedAt,
      "the drain reached the horizon and the bodies cursor is spent — the import is finished",
    ).not.toBeNull();

    /* ONCE ONLY. A later pull is a later pass, not a second first import — the client reads this
       stamp as the moment the import ended, and moving it would restart the floor every poll. */
    const firstStamp = after!.initialImportCompletedAt!.getTime();
    await createCloudMirror({
      db, world, auth: fakeAuth([syncPage([], "c3", false)]), cursorPath, now: () => new Date(),
    }).pullOnce();
    const [later] = await db.select().from(mailboxes).where(eq(mailboxes.id, CLOUD_MAILBOX));
    expect(later!.initialImportCompletedAt!.getTime()).toBe(firstStamp);
  });
});

/**
 * THE MIRRORS THAT WERE ALREADY RUNNING WHEN THE TAG FIX LANDED.
 *
 * The fix above — naming `tag` in `types=` — is complete for a mirror that bootstraps AFTER it, and
 * that is the only case its proof covered. An install bootstrapped BEFORE it holds a cursor already
 * advanced past the tags' `change_log` rows, and `/sync` only ever looks forward: those tags cannot
 * arrive on any future delta, on any launch, ever. The rail stays empty for the life of the install
 * and looks exactly like an account that has never made a tag.
 *
 * The second half is the one that decides whether anything RENDERS. Assignments ride
 * `MessageDTO.labels` and the apply skips an id naming a tag the mirror has not got (the FK), so
 * every already-mirrored message on such an install dropped its labels on the way in. Restoring the
 * tag rows alone would bring back the rail and leave every message bare — which is why these tests
 * assert a CHIP, through the local `/sync` the window actually reads, and not a row in `tags`.
 */
describe("a mirror bootstrapped before the drain asked for tags repairs itself, once", () => {
  /** The counting fake: which paths were asked for, and what the snapshot answers. */
  function countingAuth(opts: {
    sync?: SyncResponse[];
    snapshot?: SnapshotResponse;
    snapshotStatus?: number;
  }): CloudAuth & { asked: string[] } {
    const asked: string[] = [];
    let s = 0;
    const empty = syncPage([], "end", false);
    return {
      asked,
      authedFetch: async (path: string) => {
        asked.push(path);
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        if (path.startsWith("/sync/snapshot")) {
          if (opts.snapshotStatus && opts.snapshotStatus !== 200) {
            return new Response("no", { status: opts.snapshotStatus });
          }
          return jsonRes(opts.snapshot ?? NO_TAGS);
        }
        // The bootstrap's rules pass rides its own ask; letting it fall through to the page list
        // would spend `sync[0]` on it and leave the mixed replay an empty feed.
        const rf = rulesFirstAnswer(path);
        if (rf) return rf;
        if (path.startsWith("/sync")) return jsonRes(opts.sync?.[s++] ?? empty);
        if (path.startsWith("/messages/bodies")) return jsonRes({ items: [], nextCursor: null });
        return new Response("not found", { status: 404 });
      },
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
  }

  const snapshotOf = (path: string): boolean => path.startsWith("/sync/snapshot");

  interface LocalCtx { db: LocalDb; accountId: string; userId: string | null; sessionId: string | null; now: () => Date; requestId: string; ip: string; userAgent: undefined; origin: undefined }
  const localCtx = (db: LocalDb, world: LocalWorld): LocalCtx => ({
    db, accountId: world.accountId, userId: world.userId, sessionId: null,
    now: () => new Date(), requestId: "", ip: "", userAgent: undefined, origin: undefined,
  });

  /**
   * Drain the LOCAL `/sync` to its head, exactly as the window does, and return what came down
   * plus the cursor it stopped on.
   *
   * The cursor is the point of it. A `since=0` read re-materializes every message from the current
   * rows, so it shows a repaired label whether or not the repair told anybody — which is a green
   * that says nothing about the install this fixes, where the window drained months ago and holds a
   * cursor. Asking from THAT cursor is the only form of the question the client actually asks.
   */
  async function drainLocal(ctx: LocalCtx, since: string): Promise<{ rows: SyncChange[]; cursor: string }> {
    const rows: SyncChange[] = [];
    let cursor = since;
    for (;;) {
      const page = await syncService.getChanges(ctx, { since: cursor });
      rows.push(...page.changes.creates, ...page.changes.updates, ...page.changes.moves, ...page.changes.deletes);
      cursor = page.cursor;
      if (!page.hasMore) return { rows, cursor };
    }
  }

  /**
   * Stand up the DAMAGED state the way the damage actually happened: pull a pre-fix feed — a
   * message whose `labels` name a tag no change ever carried — and then leave behind the cursor
   * file the old code wrote, which has no repair flag in it at all.
   */
  async function staleMirror(): Promise<{
    opened: OpenLocalDb; world: LocalWorld; cursorPath: string;
    msgId: string; threadId: string; tagId: string;
  }> {
    const { opened, world, cursorPath } = await standUp();
    const threadId = randomUUID();
    const msgId = randomUUID();
    const tagId = randomUUID();
    const page = syncPage([
      change("thread", threadId, "create", 1, threadDTO(threadId)),
      change("message", msgId, "create", 2, messageDTO(msgId, threadId, { labels: [tagId] })),
    ], "c2", false);
    await createCloudMirror({
      db: opened.db, world, auth: fakeAuth([page]), cursorPath, now: () => new Date(),
    }).pullOnce();
    // The cursor a pre-repair build left: advanced past the tags, and with no `tagBackfill` key.
    // `version` is current — see the note at the delete-tombstone test: the mailbox re-key is a
    // separate migration and letting it fire here would re-bootstrap the mirror this stands up.
    // `lastDrainAt` is FRESH on purpose: this block's claims are about the one-time tag repair's
    // own snapshot asks, and a stale stamp would fold the stale-resume freshen's ask (its own
    // describe block) into every count here.
    writeFileSync(cursorPath, JSON.stringify({
      version: CURSOR_VERSION, sync: "c2", bodies: null, bootstrapping: false,
      lastDrainAt: new Date().toISOString(),
    }));
    return { opened, world, cursorPath, msgId, threadId, tagId };
  }

  it("restores the tag AND the chip on an already-mirrored message, from one snapshot read", async () => {
    const { opened, world, cursorPath, msgId, threadId, tagId } = await staleMirror();
    const db = opened.db;

    // The damage, asserted before it is repaired — otherwise the repair below proves nothing.
    expect(await db.select().from(tags), "the pre-fix feed carried no tag").toHaveLength(0);
    expect(
      await db.select().from(messageTags).where(eq(messageTags.messageId, msgId)),
      "and the assignment was skipped, because the tag it names does not exist locally",
    ).toHaveLength(0);

    // THE WINDOW IS ALREADY CAUGHT UP. This install has been running: the Swift projection drained
    // the local feed long ago and holds a cursor at its head. Everything the repair is worth is
    // whether something arrives ABOVE this line.
    const ctx = localCtx(db, world);
    const caughtUp = (await drainLocal(ctx, "0")).cursor;

    // The next launch. The delta is EMPTY and always will be: these tags are old, so their rows sit
    // below "c2". The snapshot's page 1 is the only thing that can carry them.
    const auth = countingAuth({
      snapshot: snapshotPage([
        change("tag", tagId, "create", 0, tagDTOFor(tagId)),
        change("message", msgId, "create", 0, messageDTO(msgId, threadId, { labels: [tagId] })),
      ]),
    });
    await createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() }).pullOnce();

    const [t] = await db.select().from(tags).where(eq(tags.id, tagId));
    expect(t, "the tag was not restored").toBeDefined();
    expect(t!.accountId, "restored under the LOCAL identity, like everything else").toBe(world.accountId);
    expect(t!.name).toBe("Invoices");

    const assigned = await db.select().from(messageTags).where(eq(messageTags.messageId, msgId));
    expect(assigned.map((a) => a.tagId), "the message did not regain its label").toEqual([tagId]);

    // AND IT IS RENDER-READY, FROM WHERE THE WINDOW IS STANDING. The rows above are invisible to a
    // client that has already drained past the message's own create; what reaches it is whatever
    // the repair appended to the local change log. A repair that wrote the tag and the assignment
    // and told nobody passes every assertion above and lights nothing on screen until something
    // else happens to touch the message.
    const { rows } = await drainLocal(ctx, caughtUp);
    expect(rows.find((c) => c.type === "tag" && c.id === tagId), "the tag rail never hears about it").toBeDefined();
    const seenMsg = rows.find((c) => c.type === "message" && c.id === msgId);
    expect(seenMsg, "the repaired message never came back down the feed the window reads").toBeDefined();
    expect((seenMsg!.entity as MessageDTO).labels, "no chip on the message the window draws").toEqual([tagId]);
  });

  it("pages the snapshot tail, so a tagged message BELOW the window regains its chip", async () => {
    // The case for the desktop mirror. This install's `/sync?since=0` bootstrap replayed EVERY
    // message (unbounded by the snapshot window), so a below-window tagged message is present
    // locally — but its label was skipped when the tag did not yet exist. Page 1 of the snapshot
    // carries the tag and the newest messages; the below-window message appears only on the TAIL
    // page, so the repair heals it ONLY if it follows `nextCursor` past page 1.
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const msgWindowed = randomUUID();   // page 1 of the snapshot
    const msgTail = randomUUID();       // the tail page only
    const tagId = randomUUID();

    // The damage: a pre-fix feed delivered both messages with labels naming a tag no change carried.
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([
        change("thread", threadId, "create", 1, threadDTO(threadId)),
        change("message", msgWindowed, "create", 2, messageDTO(msgWindowed, threadId, { labels: [tagId] })),
        change("message", msgTail, "create", 3, messageDTO(msgTail, threadId, { labels: [tagId] })),
      ], "c3", false)]),
    }).pullOnce();
    // The cursor a pre-repair build left: advanced past the tags, no `tagBackfill` key.
    // `lastDrainAt` fresh for `staleMirror`'s reason: the count below is the REPAIR's asks alone.
    writeFileSync(cursorPath, JSON.stringify({
      version: CURSOR_VERSION, sync: "c3", bodies: null, bootstrapping: false,
      lastDrainAt: new Date().toISOString(),
    }));
    expect(await db.select().from(tags), "the pre-fix feed carried no tag").toHaveLength(0);
    expect(
      await db.select().from(messageTags).where(eq(messageTags.messageId, msgTail)),
      "the tail message's label was skipped — no tag to hang it on",
    ).toHaveLength(0);

    // A TWO-page snapshot. Page 1 = the tags + the windowed message; the tail page = the
    // below-window tagged message. `nextCursor` links them and the repair must follow it.
    const TAIL = "tail-cursor-token";
    const mkPage = (changes: SyncChange[], nextCursor: string | null): SnapshotResponse => ({
      asOfSeq: 99,
      changes: changes.map((c) => ({ ...c, op: "create" as const, seq: 99 })),
      nextCursor,
      window: { days: 90, minRows: 500 },
    });
    const page1 = mkPage([
      change("tag", tagId, "create", 0, tagDTOFor(tagId)),
      change("message", msgWindowed, "create", 0, messageDTO(msgWindowed, threadId, { labels: [tagId] })),
    ], TAIL);
    const tailPage = mkPage([
      change("message", msgTail, "create", 0, messageDTO(msgTail, threadId, { labels: [tagId] })),
    ], null);

    const asked: string[] = [];
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        asked.push(path);
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        if (path.startsWith("/sync/snapshot")) {
          const cur = new URLSearchParams(path.split("?")[1] ?? "").get("cursor");
          return jsonRes(cur === TAIL ? tailPage : page1);
        }
        if (path.startsWith("/sync")) return jsonRes(syncPage([], "c3", false));
        if (path.startsWith("/messages/bodies")) return jsonRes({ items: [], nextCursor: null });
        return new Response("not found", { status: 404 });
      },
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    await createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() }).pullOnce();

    expect(await db.select().from(tags).where(eq(tags.id, tagId)), "the tag was not restored").toHaveLength(1);
    expect(
      (await db.select().from(messageTags).where(eq(messageTags.messageId, msgWindowed))).map((r) => r.tagId),
      "the page-1 message did not regain its chip",
    ).toEqual([tagId]);
    expect(
      (await db.select().from(messageTags).where(eq(messageTags.messageId, msgTail))).map((r) => r.tagId),
      "the below-window message never regained its chip — the tail was not paged",
    ).toEqual([tagId]);

    // The repair FOLLOWED the cursor: two snapshot requests, the second carrying the tail token.
    const snaps = asked.filter((p) => p.startsWith("/sync/snapshot"));
    expect(snaps, "the repair did not page the snapshot").toHaveLength(2);
    expect(snaps[1], "the second page did not resume from nextCursor").toContain(`cursor=${TAIL}`);
    // Recorded done: a completed drain settles the flag, so no later pull re-pages.
    expect((JSON.parse(readFileSync(cursorPath, "utf8")) as { tagBackfill?: boolean }).tagBackfill).toBe(true);
  });

  /**
   * THE REPAIR'S OWN OUTPUT IS NOT ITS DETECTION SIGNAL. The paging loop is careful in the right
   * direction — a failed page returns WITHOUT marking the repair considered, so the next launch
   * resumes — and the gate above it read "this mirror holds tags" as "nothing to do". Page 1 of
   * the failed run had written those tags. The recovery the loop exists to provide was therefore
   * disabled by the run it was recovering from, permanently: the flag is never cleared.
   */
  it("a run that fails after page 1 RESUMES on the next launch, and is not retired by its own tags", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const msgWindowed = randomUUID();
    const msgTail = randomUUID();
    const tagId = randomUUID();

    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([
        change("thread", threadId, "create", 1, threadDTO(threadId)),
        change("message", msgWindowed, "create", 2, messageDTO(msgWindowed, threadId, { labels: [tagId] })),
        change("message", msgTail, "create", 3, messageDTO(msgTail, threadId, { labels: [tagId] })),
      ], "c3", false)]),
    }).pullOnce();
    writeFileSync(cursorPath, JSON.stringify({
      version: CURSOR_VERSION, sync: "c3", bodies: null, bootstrapping: false,
      lastDrainAt: new Date().toISOString(),
    }));

    const TAIL = "resume-tail-token";
    const mkPage = (changes: SyncChange[], nextCursor: string | null): SnapshotResponse => ({
      asOfSeq: 99,
      changes: changes.map((c) => ({ ...c, op: "create" as const, seq: 99 })),
      nextCursor,
      window: { days: 90, minRows: 500 },
    });
    const page1 = mkPage([
      change("tag", tagId, "create", 0, tagDTOFor(tagId)),
      change("message", msgWindowed, "create", 0, messageDTO(msgWindowed, threadId, { labels: [tagId] })),
    ], TAIL);
    const tailPage = mkPage([
      change("message", msgTail, "create", 0, messageDTO(msgTail, threadId, { labels: [tagId] })),
    ], null);

    const authOver = (tailOk: boolean, asked: string[]): CloudAuth => ({
      authedFetch: async (path: string) => {
        asked.push(path);
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        if (path.startsWith("/sync/snapshot")) {
          const cur = new URLSearchParams(path.split("?")[1] ?? "").get("cursor");
          if (cur !== TAIL) return jsonRes(page1);
          return tailOk ? jsonRes(tailPage) : new Response("upstream", { status: 502 });
        }
        if (path.startsWith("/sync")) return jsonRes(syncPage([], "c3", false));
        if (path.startsWith("/messages/bodies")) return jsonRes({ items: [], nextCursor: null });
        return new Response("not found", { status: 404 });
      },
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    });

    // LAUNCH 1 — page 1 applies, the tail page fails.
    const asked1: string[] = [];
    await createCloudMirror({ db, world, auth: authOver(false, asked1), cursorPath, now: () => new Date() }).pullOnce();

    expect(await db.select().from(tags).where(eq(tags.id, tagId)), "page 1 did not apply").toHaveLength(1);
    expect(
      (await db.select().from(messageTags).where(eq(messageTags.messageId, msgTail))),
      "the tail page failed, so its chip cannot be here yet",
    ).toHaveLength(0);
    const afterFirst = JSON.parse(readFileSync(cursorPath, "utf8")) as
      { tagBackfill?: boolean; tagBackfillBegun?: boolean };
    expect(afterFirst.tagBackfill, "a failed run must not be recorded as done").not.toBe(true);
    expect(afterFirst.tagBackfillBegun, "the run must record that it wrote tags of its own").toBe(true);

    // LAUNCH 2 — a new mirror over the same cursor file, everything answering.
    const asked2: string[] = [];
    await createCloudMirror({ db, world, auth: authOver(true, asked2), cursorPath, now: () => new Date() }).pullOnce();

    expect(
      asked2.filter((p) => p.startsWith("/sync/snapshot")),
      "the repair was retired by the tags its own first page wrote",
    ).not.toHaveLength(0);
    expect(
      (await db.select().from(messageTags).where(eq(messageTags.messageId, msgTail))).map((r) => r.tagId),
      "the below-window message never regained its chip",
    ).toEqual([tagId]);
    expect((JSON.parse(readFileSync(cursorPath, "utf8")) as { tagBackfill?: boolean }).tagBackfill).toBe(true);
  });

  it("fires exactly once: a second pull, and a later launch, ask for no snapshot", async () => {
    const { opened, world, cursorPath, msgId, threadId, tagId } = await staleMirror();
    const db = opened.db;
    const snapshot = snapshotPage([
      change("tag", tagId, "create", 0, tagDTOFor(tagId)),
      change("message", msgId, "create", 0, messageDTO(msgId, threadId, { labels: [tagId] })),
    ]);

    const first = countingAuth({ snapshot });
    const mirror = createCloudMirror({ db, world, auth: first, cursorPath, now: () => new Date() });
    await mirror.pullOnce();
    await mirror.pullOnce();
    expect(first.asked.filter(snapshotOf), "the repair probed more than once in one launch").toHaveLength(1);

    // A LATER LAUNCH — a new mirror over the same cursor file, which is the restart the flag exists
    // for. It reads the flag off disk and does not probe again.
    const later = countingAuth({ snapshot });
    await createCloudMirror({ db, world, auth: later, cursorPath, now: () => new Date() }).pullOnce();
    expect(later.asked.filter(snapshotOf), "a restart re-ran the one-time repair").toHaveLength(0);

    // And it left one assignment, not two — the apply is an upsert, so a re-run would converge
    // anyway; this says the second pull did not even try.
    expect(await db.select().from(messageTags).where(eq(messageTags.messageId, msgId))).toHaveLength(1);
  });

  it("never touches a mirror that already holds tags — a fresh sign-in is not probed at all", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const msgId = randomUUID();
    const tagId = randomUUID();

    // The POST-fix bootstrap: the feed names `tag`, so the tag and its assignment arrive natively.
    const auth = countingAuth({
      sync: [syncPage([
        change("tag", tagId, "create", 1, tagDTOFor(tagId, "Receipts", "moss")),
        change("thread", threadId, "create", 2, threadDTO(threadId)),
        change("message", msgId, "create", 3, messageDTO(msgId, threadId, { labels: [tagId] })),
      ], "c3", false)],
      // The bootstrap's OPENING WINDOW reads this snapshot first, so "Overwritten" lands and the
      // replay then writes "Receipts" over it. If the repair ran AFTER the drain — the only place
      // it can run — it would put "Overwritten" back, and the name assertion below catches it.
      snapshot: snapshotPage([change("tag", tagId, "create", 0, tagDTOFor(tagId, "Overwritten", "clay"))]),
    });
    await createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() }).pullOnce();

    // Exactly ONE snapshot read: the opening window's page 1 (a one-page snapshot). A second would
    // be the repair probing a mirror whose tags the drain has already delivered.
    expect(auth.asked.filter(snapshotOf), "a healthy mirror was probed for a repair it does not need").toHaveLength(1);
    const [t] = await db.select().from(tags).where(eq(tags.id, tagId));
    expect(t!.name, "the repair overwrote a tag the drain had already delivered").toBe("Receipts");
    // The gate is recorded, so no later pull spends a request on it either.
    expect((JSON.parse(readFileSync(cursorPath, "utf8")) as { tagBackfill?: boolean }).tagBackfill).toBe(true);
  });

  it("an account with no tags is settled after one probe, not probed on every pull", async () => {
    const { opened, world, cursorPath } = await staleMirror();
    const auth = countingAuth({ snapshot: NO_TAGS });
    const mirror = createCloudMirror({ db: opened.db, world, auth, cursorPath, now: () => new Date() });
    await mirror.pullOnce();
    await mirror.pullOnce();
    expect(auth.asked.filter(snapshotOf), "the probe repeated over an account with nothing to repair").toHaveLength(1);
  });

  it("a probe that does not answer leaves the mirror ONLINE and tries again next pull", async () => {
    const { opened, world, cursorPath, msgId, threadId, tagId } = await staleMirror();
    const db = opened.db;

    // A repair is a one-time extra on top of a mirror that works. If its failure could fail the
    // pull, the write-through proxy would answer `503 offline_read_only` — no writes at all — over
    // a snapshot request that has nothing to do with what the user is trying to do.
    const down = countingAuth({ snapshotStatus: 503 });
    const broken = createCloudMirror({ db, world, auth: down, cursorPath, now: () => new Date() });
    await expect(broken.pullOnce(), "a failed repair failed the whole pull").resolves.toBeTypeOf("number");
    expect(broken.online(), "a failed repair marked a working mirror offline").toBe(true);

    // Not marked done, so the next pull retries — and lands.
    const up = countingAuth({
      snapshot: snapshotPage([
        change("tag", tagId, "create", 0, tagDTOFor(tagId)),
        change("message", msgId, "create", 0, messageDTO(msgId, threadId, { labels: [tagId] })),
      ]),
    });
    await createCloudMirror({ db, world, auth: up, cursorPath, now: () => new Date() }).pullOnce();
    expect(up.asked.filter(snapshotOf), "a deferred repair never came back").toHaveLength(1);
    expect(await db.select().from(messageTags).where(eq(messageTags.messageId, msgId))).toHaveLength(1);
  });

  it("writes no assignment for a snapshot message this mirror does not hold", async () => {
    const { opened, world, cursorPath, tagId } = await staleMirror();
    const db = opened.db;
    const stranger = randomUUID();

    // The snapshot window can reach mail the drain has not applied here. `message_tags.message_id`
    // is a foreign key, so an assignment for it is not a row this repair may write — the drain owns
    // the mail and carries the labels with it when it lands.
    const auth = countingAuth({
      snapshot: snapshotPage([
        change("tag", tagId, "create", 0, tagDTOFor(tagId)),
        change("message", stranger, "create", 0, messageDTO(stranger, null, { labels: [tagId] })),
      ]),
    });
    await createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() }).pullOnce();

    expect(await db.select().from(tags).where(eq(tags.id, tagId)), "the tag itself is still restored").toHaveLength(1);
    expect(await db.select().from(messageTags).where(eq(messageTags.messageId, stranger))).toHaveLength(0);
    expect(await db.select().from(messages).where(eq(messages.id, stranger)), "and no message was invented for it").toHaveLength(0);
  });
});

/**
 * ═══ THE ONE-TIME CAP-MARKER REPAIR ════════════════════════════════════════════════════════
 *
 * A sidecar from before the storage-cap marker received a withheld batch item, ignored
 * `item.withheld`, and inserted an ordinary empty `message_bodies` row. Upgrading adds
 * `withheld_reason` as NULL — indistinguishable from "ordinarily stored and empty" — and the
 * catch-up query only ever offers ABSENT rows, so that mirror served a withheld body as an empty
 * one for ever. This repair offers every present-but-empty row once, then records that it did.
 *
 * The population is upgraded installs, so the fixture is a cursor file WITHOUT the flag: a fresh
 * install defaults it to `true` (its own walk writes markers from the start) and must never run
 * the pass at all.
 */
describe("the Cloud mirror repairs cap markers an older sidecar could not write", () => {
  const seedPage = (threadId: string, messageIds: string[], cursor: string): SyncResponse =>
    syncPage([
      change("thread", threadId, "create", 1, threadDTO(threadId)),
      ...messageIds.map((m, i) => change("message", m, "create", i + 2, messageDTO(m, threadId))),
    ], cursor, false);

  /** A withheld answer, as the hosted `getBodies` serves it: empty text, no html, the marker. */
  const withheldItem = (messageId: string): MessageBodyBatchItem =>
    ({ messageId, text: "", html: null, loadedRemoteContent: false, withheld: "storage_cap" });

  it("offers every present-but-empty body once, learns the marker, and never runs again", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const withheldId = randomUUID();
    const emptyId = randomUUID();
    const normalId = randomUUID();
    const ids = [withheldId, emptyId, normalId];

    // Pull 1 with an OLD-SIDECAR corpus: the withheld body arrives as a plain empty item, exactly
    // what a build that did not know the field would store.
    const oldCorpus = [
      bodyItem(withheldId, ""), bodyItem(emptyId, ""), bodyItem(normalId, "a real body"),
    ];
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([seedPage(threadId, ids, "c1")], oldCorpus),
    }).pullOnce();

    const before = await db.select().from(messageBodies).where(eq(messageBodies.messageId, withheldId));
    expect(before[0]!.withheldReason, "the premise: the old sidecar wrote no marker").toBeNull();
    expect(before[0]!.text).toBe("");

    // Now make the cursor look like one written BEFORE this repair existed: the flag absent, the
    // body walk already finished. Absent must read false, or upgraded installs stay broken.
    const onDisk = JSON.parse(readFileSync(cursorPath, "utf8")) as Record<string, unknown>;
    expect(onDisk.bodies, "the premise: the walk finished in pull 1").toBe("complete");
    delete onDisk.capMarkerRepair;
    writeFileSync(cursorPath, JSON.stringify(onDisk));

    // Pull 2: the hosted store now answers honestly for the withheld one.
    const asked: Asked = [];
    const newCorpus = [
      withheldItem(withheldId), bodyItem(emptyId, ""), bodyItem(normalId, "a real body"),
    ];
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([], newCorpus, NO_TAGS, { asked }),
    }).pullOnce();

    const healed = await db.select().from(messageBodies).where(eq(messageBodies.messageId, withheldId));
    expect(healed[0]!.withheldReason, "the repair did not carry the marker into the journal").toBe("storage_cap");

    // The genuinely empty body is untouched and still honest — offered, answered, left alone.
    const stillEmpty = await db.select().from(messageBodies).where(eq(messageBodies.messageId, emptyId));
    expect(stillEmpty[0]!.withheldReason).toBeNull();
    expect(stillEmpty[0]!.text).toBe("");

    // The row with real text was never a candidate, so the pass never asked about it.
    expect(bodyCalls(asked).length, "the repair should have asked once").toBeGreaterThan(0);
    expect(bodyCalls(asked).some((p) => p.includes(normalId)),
      "a body with real text is not a cap-marker candidate and must not be re-asked").toBe(false);

    // RECORDED, so a third pull runs nothing — the termination the cursor flag exists for. Without
    // it, the empty body above matches the predicate again on every pull, for ever.
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ capMarkerRepair: true });
    const later: Asked = [];
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([], newCorpus, NO_TAGS, { asked: later }),
    }).pullOnce();
    expect(bodyCalls(later), "the repair ran a second time — it is not one-time").toEqual([]);
  });

  it("a FRESH install never runs the pass — its own walk writes the markers", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const id = randomUUID();

    const asked: Asked = [];
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([seedPage(threadId, [id], "c1")], [withheldItem(id)], NO_TAGS, { asked }),
    }).pullOnce();

    // The walk itself carried the marker, so there is nothing to repair…
    const row = await db.select().from(messageBodies).where(eq(messageBodies.messageId, id));
    expect(row[0]!.withheldReason).toBe("storage_cap");
    // …and the flag was born true rather than being earned by a pass that had no work.
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ capMarkerRepair: true });

    asked.length = 0;
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([], [withheldItem(id)], NO_TAGS, { asked }),
    }).pullOnce();
    expect(bodyCalls(asked)).toEqual([]);
  });
});

describe("an interrupted BOOTSTRAP resumes from its committed cursor, and the sweep stays right", () => {
  /**
   * THE FAILURE THIS PINS: a bootstrap that restarted from `since=0` on EVERY interruption. On a large
   * account that is hundreds of pages, and a laptop's sleep, a network change or an app quit anywhere
   * in them started the whole replay over — so the mirror never reached the horizon and served
   * week-old mail for days while every retry looked alive. The generation now persists beside the
   * cursor, so a relaunch continues from the last committed page against the SAME marks, and the
   * trailing sweep still removes exactly what the feed dropped.
   *
   * The fake is STRICT about `since`: a resume asks for the cursor it committed, and that is the
   * only request that gets the second segment. A mirror that restarts from zero is answered with a
   * feed carrying only the second segment's message — which is precisely what makes the restart
   * form delete a real row (the first segment's message, never re-served), the wrong direction.
   */
  it("resumes from the committed cursor, keeps a row marked before the interruption, sweeps the phantom", async () => {
    const { opened, world, cursorPath, dataDir } = await standUp();
    const db = opened.db;
    const tKeepA = randomUUID(); const mKeepA = randomUUID();
    const tKeepB = randomUUID(); const mKeepB = randomUUID();
    const tPhantom = randomUUID(); const mPhantom = randomUUID();
    const genPath = join(dataDir, "cloud-bootstrap-gen.marks");

    // ── Phase 1: an ordinary pull mirrors keepA AND the phantom; the cursor moves past zero. ──
    const seed = syncPage([
      change("thread", tKeepA, "create", 1, threadDTO(tKeepA)),
      change("message", mKeepA, "create", 2, messageDTO(mKeepA, tKeepA)),
      change("thread", tPhantom, "create", 3, threadDTO(tPhantom)),
      change("message", mPhantom, "create", 4, messageDTO(mPhantom, tPhantom)),
    ], "cursor-seed", false);
    await createCloudMirror({ db, world, auth: fakeAuth([seed]), cursorPath, now: () => new Date() }).pullOnce();
    expect(await db.select().from(messages)).toHaveLength(2);

    // ── Phase 2: the cursor expired (410). The re-bootstrap's FIRST segment carries keepA and says
    //    there is more; the request for the next page DIES (a dropped network). ──
    const seg1 = syncPage([
      change("thread", tKeepA, "create", 1, threadDTO(tKeepA)),
      change("message", mKeepA, "create", 2, messageDTO(mKeepA, tKeepA)),
    ], "seg1", true);
    const seg2 = syncPage([
      change("thread", tKeepB, "create", 3, threadDTO(tKeepB)),
      change("message", mKeepB, "create", 4, messageDTO(mKeepB, tKeepB)),
    ], "seg2", false);
    const asked: string[] = [];
    let segment2Alive = false;
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        if (path.startsWith("/sync/snapshot")) return jsonRes(NO_TAGS);
        // The rules-first pass rides its own `since` sequence and is not the resume position
        // under test — answered before the strict dispatch so it cannot eat a segment.
        const rf = rulesFirstAnswer(path);
        if (rf) return rf;
        if (path.startsWith("/sync")) {
          asked.push(path);
          const since = sinceOf(path);
          if (since === "cursor-seed") return new Response("cursor expired", { status: 410 });
          if (since === "seg1") {
            if (!segment2Alive) throw new Error("ECONNRESET: the network went away mid-bootstrap");
            return jsonRes(seg2);
          }
          if (since === "seg2") return jsonRes(syncPage([], "seg2", false));
          // since=0 — the first segment (and, for a mirror that restarts from zero, the whole feed
          // it would see on its second attempt: keepB only, which is what makes that form wrong).
          return jsonRes(segment2Alive ? seg2 : seg1);
        }
        if (path.startsWith("/messages/bodies")) return jsonRes({ items: [], nextCursor: null });
        return new Response("not found", { status: 404 });
      },
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    await expect(createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() }).pullOnce())
      .rejects.toThrow(/network went away/);
    const mid = JSON.parse(readFileSync(cursorPath, "utf8")) as { sync: string; bootstrapping: boolean };
    expect(mid, "the first segment committed and the bootstrap stayed marked").toMatchObject({ sync: "seg1", bootstrapping: true });
    expect(readFileSync(genPath, "utf8"), "the generation's marks persisted beside the cursor").toContain(`message ${mKeepA}`);

    // ── Phase 3: the next launch. The network is back. ──
    segment2Alive = true;
    asked.length = 0;
    await createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() }).pullOnce();

    expect(asked.length).toBeGreaterThan(0);
    expect(sinceOf(asked[0]!), "the relaunch must RESUME from the committed cursor, not replay from zero").toBe("seg1");

    // THE SWEEP, across both segments: the phantom (in neither) is gone; keepA (segment 1, before the
    // interruption) SURVIVES; keepB (segment 2) landed.
    expect(await db.select().from(messages).where(eq(messages.id, mPhantom)), "the phantom was not swept").toHaveLength(0);
    expect(await db.select().from(messages).where(eq(messages.id, mKeepA)), "a row marked before the interruption was swept — the generation did not persist").toHaveLength(1);
    expect(await db.select().from(messages).where(eq(messages.id, mKeepB))).toHaveLength(1);

    const done = JSON.parse(readFileSync(cursorPath, "utf8")) as { sync: string; bootstrapping: boolean };
    expect(done).toMatchObject({ sync: "seg2", bootstrapping: false });
    expect(() => readFileSync(genPath), "a completed generation leaves no marks file behind").toThrow();
  });

  it("an interrupted RE-KEY resumes too — the upgraded install's replay is the case that never finished", async () => {
    const { opened, world, cursorPath, dataDir } = await standUp();
    const db = opened.db;
    const tId = randomUUID(); const mId = randomUUID();
    const genPath = join(dataDir, "cloud-bootstrap-gen.marks");
    // What an interrupted re-key leaves: an OLD-format cursor (version below CURSOR_VERSION —
    // the stamp lands only at completion), mid-bootstrap, with the generation's marks on disk.
    writeFileSync(cursorPath, JSON.stringify({ version: CURSOR_VERSION - 1, sync: "seg1", bodies: null, bootstrapping: true }));
    writeFileSync(genPath, `thread ${tId}\nmessage ${mId}\n`);
    const asked: string[] = [];
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        if (path.startsWith("/sync/snapshot")) return jsonRes(NO_TAGS);
        // The resumed re-key owes the rules-first pass too; it is not the resume position
        // this test pins, so it is answered outside the recorded ask list.
        const rf = rulesFirstAnswer(path);
        if (rf) return rf;
        if (path.startsWith("/sync")) {
          asked.push(path);
          const since = sinceOf(path);
          if (since === "seg1") {
            return jsonRes(syncPage([
              change("thread", tId, "create", 9, threadDTO(tId)),
              change("message", mId, "create", 10, messageDTO(mId, tId)),
            ], "seg2", false));
          }
          return jsonRes(syncPage([], since ?? "0", false));
        }
        if (path.startsWith("/messages/bodies")) return jsonRes({ items: [], nextCursor: null });
        return new Response("not found", { status: 404 });
      },
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    const mirror = createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() });
    await mirror.pullOnce();
    expect(sinceOf(asked[0]!), "the re-key must resume from its committed cursor, not start the whole replay over").toBe("seg1");
    const done = JSON.parse(readFileSync(cursorPath, "utf8")) as { version: number; bootstrapping: boolean };
    expect(done, "a completed re-key stamps the format version").toMatchObject({ version: CURSOR_VERSION, bootstrapping: false });
  });

  it("mid-bootstrap the mirror is ONLINE — a landing page is the opposite of unreachable", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const tId = randomUUID();
    let pages = 0;
    let observedOnline: boolean | null = null;
    let observe: () => void = () => {};
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        if (path.startsWith("/sync/snapshot")) return jsonRes(NO_TAGS);
        if (path.startsWith("/sync")) {
          pages += 1;
          if (pages === 1) throw new Error("ECONNRESET: first pull dies (the mirror goes offline)");
          if (pages === 4) observe(); // mid-bootstrap, pages landing
          const m = randomUUID();
          return jsonRes(syncPage([
            change("thread", tId, "create", pages * 2, threadDTO(tId)),
            change("message", m, "create", pages * 2 + 1, messageDTO(m, tId)),
          ], `p${pages}`, pages < 6));
        }
        if (path.startsWith("/messages/bodies")) return jsonRes({ items: [], nextCursor: null });
        return new Response("not found", { status: 404 });
      },
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    const mirror = createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() });
    observe = () => { observedOnline = mirror.online(); };
    await expect(mirror.pullOnce()).rejects.toThrow(/first pull dies/);
    expect(mirror.online(), "a failed pull marks the mirror offline").toBe(false);
    await mirror.pullOnce();
    expect(observedOnline, "pages were landing — the banner must not say offline").toBe(true);
  });

  it("a bootstrap interrupted by an older build (no marks file) restarts from zero — the safe answer", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    // The cursor an older build leaves: mid-bootstrap, committed past zero, current format, NO marks.
    writeFileSync(cursorPath, JSON.stringify({ version: CURSOR_VERSION, sync: "p7", bodies: null, bootstrapping: true }));
    const asked: string[] = [];
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        if (path.startsWith("/sync/snapshot")) return jsonRes(NO_TAGS);
        if (path.startsWith("/sync")) { asked.push(path); return jsonRes(syncPage([], "end", false)); }
        if (path.startsWith("/messages/bodies")) return jsonRes({ items: [], nextCursor: null });
        return new Response("not found", { status: 404 });
      },
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    await createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() }).pullOnce();
    expect(sinceOf(asked[0]!), "without marks to resume against, the only safe bootstrap is a full one").toBe("0");
  });
});

describe("a bootstrap opens with the snapshot WINDOW — newest mail first — and then replays the feed", () => {
  /**
   * THE OWNER-REPORTED SHAPE: a fresh desktop install synced oldest-first, because a `since=0`
   * replay is `change_log` in seq order, so the top of the Ohbox — this week's mail — was the LAST
   * thing to land. The bootstrap now runs in two phases (cloud-mirror.ts header, NEWEST FIRST): the
   * hosted snapshot's newest-first window through the same `applyPage`, then the replay from zero.
   * Neither phase writes the other's cursor, and both resume from a kill.
   *
   * These fakes are STRICT about position (the interrupted-bootstrap tests' discipline): a window
   * page or a feed page is served only to the ask that names it, so a mirror that restarts where it
   * should resume is answered a different world — and loses a real row to the sweep.
   */
  const typesOf = (path: string): string | null =>
    new URLSearchParams(path.split("?")[1] ?? "").get("types");
  const windowCursorOf = (path: string): string | null =>
    new URLSearchParams(path.split("?")[1] ?? "").get("cursor");
  const isSnapshot = (p: string): boolean => p.startsWith("/sync/snapshot");
  const isMixedFeed = (p: string): boolean => p.startsWith("/sync?") && typesOf(p) !== "rule";
  const isRulesPass = (p: string): boolean => p.startsWith("/sync?") && typesOf(p) === "rule";
  /**
   * The snapshot asks of the WINDOW phase: every one before the replay's first ask. The one-time
   * tag repair probes the snapshot AFTER the drain on an account that holds no tags (its own
   * describe block pins that), and that later ask is not the window's.
   */
  const windowAsks = (asked: readonly string[]): string[] => {
    const replayAt = asked.findIndex(isMixedFeed);
    return (replayAt === -1 ? [...asked] : asked.slice(0, replayAt)).filter(isSnapshot);
  };
  /** A snapshot page that says where the next one is — `snapshotPage` always ends the window. */
  const windowPage = (changes: SyncChange[], next: string | null): SnapshotResponse =>
    ({ ...snapshotPage(changes), nextCursor: next });
  const tokens = () => ({ accessToken: "a", refreshToken: "r" });
  type CursorOnDisk = { sync: string; bootstrapping: boolean; window: string | null };
  const cursorOnDisk = (path: string): CursorOnDisk => JSON.parse(readFileSync(path, "utf8")) as CursorOnDisk;

  /**
   * WATCHED RED by deleting the `windowOwed` block from `drainSync`: no snapshot ask precedes the
   * replay, and the newest message's local row lands ABOVE the oldest's.
   */
  it("lands the window before the replay's first page, so the newest message enters the local log first", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const tOld = randomUUID(); const mOld = randomUUID();   // the archive's first page: seqs 1–2
    const tNew = randomUUID(); const mNew = randomUUID();   // the newest message: window page 1, feed seqs 3–4
    const asked: string[] = [];
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        asked.push(path);
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        if (isSnapshot(path)) {
          return jsonRes(windowPage([
            change("thread", tNew, "create", 0, threadDTO(tNew)),
            change("message", mNew, "create", 0, messageDTO(mNew, tNew)),
          ], null));
        }
        const rf = rulesFirstAnswer(path);
        if (rf) return rf;
        if (path.startsWith("/sync")) {
          const since = sinceOf(path);
          if (since === "0") {
            return jsonRes(syncPage([
              change("thread", tOld, "create", 1, threadDTO(tOld)),
              change("message", mOld, "create", 2, messageDTO(mOld, tOld)),
            ], "p1", true));
          }
          if (since === "p1") {
            return jsonRes(syncPage([
              change("thread", tNew, "create", 3, threadDTO(tNew)),
              change("message", mNew, "create", 4, messageDTO(mNew, tNew)),
            ], "p2", false));
          }
          return jsonRes(syncPage([], since ?? "0", false));
        }
        if (path.startsWith("/messages/bodies")) return jsonRes({ items: [], nextCursor: null });
        return new Response("not found", { status: 404 });
      },
      currentTokens: tokens,
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    await createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() }).pullOnce();

    // THE ORDER OF ASKS: rules, then the window, then the mixed replay — which still starts at
    // zero, because the window writes no feed cursor.
    const rulesAt = asked.findIndex(isRulesPass);
    const windowAt = asked.findIndex(isSnapshot);
    const replayAt = asked.findIndex(isMixedFeed);
    expect(windowAt, "the bootstrap never read the snapshot window").toBeGreaterThan(-1);
    expect(rulesAt, "the rules pass must still open the bootstrap").toBeLessThan(windowAt);
    expect(windowAt, "the window must land before the replay's first page").toBeLessThan(replayAt);
    expect(sinceOf(asked[replayAt]!), "the window must not write the feed cursor").toBe("0");

    // THE LOCAL LOG a client tails: the newest message's first row sits BELOW the oldest's, although
    // the feed carries them the other way round.
    const clog = (await db.select().from(changeLog).where(eq(changeLog.accountId, world.accountId)))
      .sort((a, b) => Number(a.seq) - Number(b.seq));
    const firstRow = (id: string) => clog.find((c) => c.entityType === "message" && c.entityId === id);
    expect(firstRow(mNew), "the window landed no message").toBeDefined();
    expect(firstRow(mOld), "the replay landed no message").toBeDefined();
    expect(Number(firstRow(mNew)!.seq), "the newest message must enter the local log before the oldest")
      .toBeLessThan(Number(firstRow(mOld)!.seq));

    // Converged: both messages once each, the bootstrap closed, the window reset for the next one.
    expect(await db.select().from(messages).where(eq(messages.accountId, world.accountId))).toHaveLength(2);
    expect(cursorOnDisk(cursorPath)).toEqual(expect.objectContaining({ sync: "p2", bootstrapping: false, window: null }));
  });

  it("the window's first screenful of TEXT lands before the replay begins — not hours after it", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const tOld = randomUUID(); const mOld = randomUUID();
    const tNew = randomUUID(); const mNew = randomUUID();
    const asked: string[] = [];
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        asked.push(path);
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        if (isSnapshot(path)) {
          return jsonRes(windowPage([
            change("thread", tNew, "create", 0, threadDTO(tNew)),
            change("message", mNew, "create", 0, messageDTO(mNew, tNew)),
          ], null));
        }
        const rf = rulesFirstAnswer(path);
        if (rf) return rf;
        if (path.startsWith("/sync")) {
          const since = sinceOf(path);
          if (since === "0") {
            return jsonRes(syncPage([
              change("thread", tOld, "create", 1, threadDTO(tOld)),
              change("message", mOld, "create", 2, messageDTO(mOld, tOld)),
            ], "p1", true));
          }
          if (since === "p1") {
            return jsonRes(syncPage([
              change("message", mNew, "create", 3, messageDTO(mNew, tNew)),
            ], "p2", false));
          }
          return jsonRes(syncPage([], since ?? "0", false));
        }
        if (path.startsWith("/messages/bodies")) {
          return jsonRes({
            items: [bodyItem(mNew, "the newest body"), bodyItem(mOld, "the old body")]
              .filter((i) => path.includes(i.messageId)),
            nextCursor: null,
          });
        }
        return new Response("not found", { status: 404 });
      },
      currentTokens: tokens,
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    await createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() }).pullOnce();

    // The replay behind the window can run for HOURS on a large account, and the body pass runs
    // only after the whole drain — so the window's own screenful is asked for RIGHT AFTER the
    // window lands, before the replay's first page, or the newest mail opens blank for the
    // replay's whole life (the review round that held the CHANGELOG sentence against the code).
    const windowAt = asked.findIndex(isSnapshot);
    const replayAt = asked.findIndex(isMixedFeed);
    const firstBodies = asked.findIndex((p) => p.includes("/messages/bodies?ids="));
    expect(firstBodies, "no ids-mode body ask happened at all").toBeGreaterThan(windowAt);
    expect(firstBodies, "the window's bodies waited for the whole replay").toBeLessThan(replayAt);
    expect(asked[firstBodies]).toContain(mNew);

    const [body] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, mNew));
    expect(body?.text).toBe("the newest body");
  });

  it("a stop() during the window's body ask cuts the drain — the replay must not start after shutdown", async () => {
    // The pre-pass is an await between the window and the replay's first page: a stop() landing
    // inside it must be seen when it returns, or the drain starts another /sync request after
    // shutdown was asked for — past the shell's grace window (the review round on this change).
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const tNew = randomUUID(); const mNew = randomUUID();
    const asked: string[] = [];
    let stopper: (() => Promise<void>) | null = null;
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        asked.push(path);
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        if (isSnapshot(path)) {
          return jsonRes(windowPage([
            change("thread", tNew, "create", 0, threadDTO(tNew)),
            change("message", mNew, "create", 0, messageDTO(mNew, tNew)),
          ], null));
        }
        const rf = rulesFirstAnswer(path);
        if (rf) return rf;
        if (path.includes("/messages/bodies?ids=")) {
          void stopper?.();   // shutdown lands while the pre-pass is in flight
          return jsonRes({ items: [bodyItem(mNew, "the newest body")], nextCursor: null });
        }
        if (path.startsWith("/sync")) return jsonRes(syncPage([], "p1", false));
        return jsonRes({ items: [], nextCursor: null });
      },
      currentTokens: tokens,
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    const mirror = createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() });
    stopper = () => mirror.stop();
    await mirror.pullOnce();

    expect(asked.some((p) => p.includes("/messages/bodies?ids=")), "the pre-pass never ran").toBe(true);
    expect(asked.findIndex(isMixedFeed), "the replay started after shutdown was requested").toBe(-1);
  });

  /**
   * WATCHED RED by reverting `drainSync`'s resume condition to `!isBootstrapCursor(cursor.sync)`
   * alone: the relaunch starts a NEW generation (the marks truncated, the window pending), asks the
   * cursorless page 1, is answered a window without the first page's message, and the sweep deletes
   * that real row.
   */
  it("a kill INSIDE the window resumes at the page after the last committed one, and the sweep keeps what the window marked", async () => {
    const { opened, world, cursorPath, dataDir } = await standUp();
    const db = opened.db;
    const genPath = join(dataDir, "cloud-bootstrap-gen.marks");
    const tW1 = randomUUID(); const mW1 = randomUUID();   // window page 1
    const tW2 = randomUUID(); const mW2 = randomUUID();   // window page 2
    const tOld = randomUUID(); const mOld = randomUUID(); // the replay's only message
    let page2Alive = false;
    const asked: string[] = [];
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        if (isSnapshot(path)) {
          asked.push(path);
          const c = windowCursorOf(path);
          if (c === null) {
            // Page 1. AFTER the kill, a mirror that re-reads from page 1 is answered a window that
            // no longer carries mW1 — the strict fake's way of making a restart observable: nothing
            // re-marks mW1, and the sweep takes a row the account still holds.
            return jsonRes(page2Alive
              ? windowPage([change("thread", tW2, "create", 0, threadDTO(tW2)), change("message", mW2, "create", 0, messageDTO(mW2, tW2))], null)
              : windowPage([change("thread", tW1, "create", 0, threadDTO(tW1)), change("message", mW1, "create", 0, messageDTO(mW1, tW1))], "w2"));
          }
          if (c === "w2") {
            if (!page2Alive) throw new Error("ECONNRESET: the network went away mid-window");
            return jsonRes(windowPage([change("thread", tW2, "create", 0, threadDTO(tW2)), change("message", mW2, "create", 0, messageDTO(mW2, tW2))], null));
          }
          return new Response("cursor expired", { status: 410 });
        }
        const rf = rulesFirstAnswer(path);
        if (rf) return rf;
        if (path.startsWith("/sync")) {
          asked.push(path);
          if (sinceOf(path) === "0") {
            return jsonRes(syncPage([
              change("thread", tOld, "create", 1, threadDTO(tOld)),
              change("message", mOld, "create", 2, messageDTO(mOld, tOld)),
            ], "end", false));
          }
          return jsonRes(syncPage([], sinceOf(path) ?? "0", false));
        }
        if (path.startsWith("/messages/bodies")) return jsonRes({ items: [], nextCursor: null });
        return new Response("not found", { status: 404 });
      },
      currentTokens: tokens,
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };

    // ── The kill: page 1 committed, the ask for page 2 dies. ──
    await expect(createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() }).pullOnce())
      .rejects.toThrow(/mid-window/);
    expect(cursorOnDisk(cursorPath), "page 1 committed: the window's next page is on disk, the feed cursor untouched")
      .toEqual(expect.objectContaining({ sync: "0", bootstrapping: true, window: "w2" }));
    expect(readFileSync(genPath, "utf8"), "the window's marks persisted beside the cursor").toContain(`message ${mW1}`);
    expect(await db.select().from(messages).where(eq(messages.id, mW1)), "page 1 landed").toHaveLength(1);
    expect(asked.filter(isMixedFeed), "the replay must not start while the window is unfinished").toHaveLength(0);

    // ── The relaunch. The network is back. ──
    page2Alive = true;
    asked.length = 0;
    await createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() }).pullOnce();

    const snaps = windowAsks(asked);
    expect(snaps.length, "the relaunch read no window page").toBeGreaterThan(0);
    expect(windowCursorOf(snaps[0]!), "the relaunch must RESUME the window at its committed page, not re-read page 1").toBe("w2");
    expect(snaps.some((p) => windowCursorOf(p) === null), "the relaunch re-read page 1").toBe(false);
    expect(sinceOf(asked.find(isMixedFeed)!), "the replay then starts from zero").toBe("0");

    // THE SWEEP across the kill: mW1 (marked before it) SURVIVES, mW2 and mOld landed.
    expect(await db.select().from(messages).where(eq(messages.id, mW1)), "a row the window marked before the kill was swept — the window did not resume against its marks").toHaveLength(1);
    expect(await db.select().from(messages).where(eq(messages.id, mW2))).toHaveLength(1);
    expect(await db.select().from(messages).where(eq(messages.id, mOld))).toHaveLength(1);
    expect(cursorOnDisk(cursorPath)).toEqual(expect.objectContaining({ sync: "end", bootstrapping: false, window: null }));
    expect(() => readFileSync(genPath), "a completed generation leaves no marks file behind").toThrow();
  });

  /**
   * WATCHED RED by making `readWindowPass` read every on-disk value as pending: the relaunch no
   * longer honours the persisted `complete` and re-reads a window this generation already finished
   * — one snapshot ask it does not owe, and a window's worth of pages on a large account.
   */
  it("a kill in the REPLAY resumes the replay from its committed cursor and re-reads no window page", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const tW = randomUUID(); const mW = randomUUID();   // the window
    const tA = randomUUID(); const mA = randomUUID();   // replay segment 1
    const tB = randomUUID(); const mB = randomUUID();   // replay segment 2
    let seg2Alive = false;
    const asked: string[] = [];
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        if (isSnapshot(path)) {
          asked.push(path);
          return jsonRes(windowPage([change("thread", tW, "create", 0, threadDTO(tW)), change("message", mW, "create", 0, messageDTO(mW, tW))], null));
        }
        const rf = rulesFirstAnswer(path);
        if (rf) return rf;
        if (path.startsWith("/sync")) {
          asked.push(path);
          const since = sinceOf(path);
          if (since === "0") {
            return jsonRes(syncPage([change("thread", tA, "create", 1, threadDTO(tA)), change("message", mA, "create", 2, messageDTO(mA, tA))], "seg1", true));
          }
          if (since === "seg1") {
            if (!seg2Alive) throw new Error("ECONNRESET: the network went away mid-replay");
            return jsonRes(syncPage([change("thread", tB, "create", 3, threadDTO(tB)), change("message", mB, "create", 4, messageDTO(mB, tB))], "seg2", false));
          }
          return jsonRes(syncPage([], since ?? "0", false));
        }
        if (path.startsWith("/messages/bodies")) return jsonRes({ items: [], nextCursor: null });
        return new Response("not found", { status: 404 });
      },
      currentTokens: tokens,
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };

    await expect(createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() }).pullOnce())
      .rejects.toThrow(/mid-replay/);
    expect(cursorOnDisk(cursorPath), "the window completed and segment 1 committed before the kill")
      .toEqual(expect.objectContaining({ sync: "seg1", bootstrapping: true, window: "complete" }));

    seg2Alive = true;
    asked.length = 0;
    await createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() }).pullOnce();

    expect(windowAsks(asked), "a window this generation finished was read again").toHaveLength(0);
    expect(sinceOf(asked.find(isMixedFeed)!), "the replay must resume from its committed cursor").toBe("seg1");
    for (const id of [mW, mA, mB]) {
      expect(await db.select().from(messages).where(eq(messages.id, id)), `message ${id} missing after the resume`).toHaveLength(1);
    }
    expect(cursorOnDisk(cursorPath)).toEqual(expect.objectContaining({ sync: "seg2", bootstrapping: false, window: null }));
  });

  /**
   * WATCHED RED by deleting the 410 arm of `drainWindowFirst`: the pull throws `HTTP 410` on the
   * persisted cursor and the bootstrap never proceeds.
   */
  it("a 410 to the window's persisted cursor re-reads the window from page 1 inside the same generation", async () => {
    const { opened, world, cursorPath, dataDir } = await standUp();
    const db = opened.db;
    const tW = randomUUID(); const mW = randomUUID();
    // What a kill mid-window left behind, after a deploy that changed the snapshot cursor's grammar.
    writeFileSync(cursorPath, JSON.stringify({ version: CURSOR_VERSION, sync: "0", bodies: null, bootstrapping: true, window: "stale-w" }));
    writeFileSync(join(dataDir, "cloud-bootstrap-gen.marks"), "");
    const events: string[] = [];
    const asked: string[] = [];
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        if (isSnapshot(path)) {
          asked.push(path);
          if (windowCursorOf(path) === "stale-w") return new Response("cursor expired", { status: 410 });
          return jsonRes(windowPage([change("thread", tW, "create", 0, threadDTO(tW)), change("message", mW, "create", 0, messageDTO(mW, tW))], null));
        }
        const rf = rulesFirstAnswer(path);
        if (rf) return rf;
        if (path.startsWith("/sync")) { asked.push(path); return jsonRes(syncPage([], "end", false)); }
        if (path.startsWith("/messages/bodies")) return jsonRes({ items: [], nextCursor: null });
        return new Response("not found", { status: 404 });
      },
      currentTokens: tokens,
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    await createCloudMirror({
      db, world, auth, cursorPath, now: () => new Date(), log: (event: string) => { events.push(event); },
    }).pullOnce();

    expect(windowAsks(asked).map(windowCursorOf), "the refused cursor is tried once, then page 1").toEqual(["stale-w", null]);
    expect(events, "the restart is said out loud").toContain("cloud_window_restarted");
    expect(await db.select().from(messages).where(eq(messages.id, mW)), "the re-read window landed").toHaveLength(1);
    expect(cursorOnDisk(cursorPath)).toEqual(expect.objectContaining({ sync: "end", bootstrapping: false, window: null }));
  });

  /* THE ARRIVAL KEY'S CURSOR v2: a window paused across the
     deploy holds a v1 cursor — a HEADER-date position. The server's own decoder refuses it and the
     mirror re-reads the window once, inside the same generation, rather than resuming mid-order. */
  it("a v1 window cursor from before the arrival order is refused by the server and the window restarts", async () => {
    const { opened, world, cursorPath, dataDir } = await standUp();
    const db = opened.db;
    const tW = randomUUID(); const mW = randomUUID();
    const v1 = Buffer.from(JSON.stringify({ v: 1, s: "5", n: 2, d: Date.now(), i: randomUUID() }), "utf8").toString("base64url");
    writeFileSync(cursorPath, JSON.stringify({ version: CURSOR_VERSION, sync: "0", bodies: null, bootstrapping: true, window: v1 }));
    writeFileSync(join(dataDir, "cloud-bootstrap-gen.marks"), "");
    const events: string[] = [];
    const asked: string[] = [];
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        if (isSnapshot(path)) {
          asked.push(path);
          const c = windowCursorOf(path);
          if (c !== null) {
            try { syncService.decodeSnapshotCursor(c); } catch { return new Response("cursor expired", { status: 410 }); }
          }
          return jsonRes(windowPage([change("thread", tW, "create", 0, threadDTO(tW)), change("message", mW, "create", 0, messageDTO(mW, tW))], null));
        }
        const rf = rulesFirstAnswer(path);
        if (rf) return rf;
        if (path.startsWith("/sync")) { asked.push(path); return jsonRes(syncPage([], "end", false)); }
        if (path.startsWith("/messages/bodies")) return jsonRes({ items: [], nextCursor: null });
        return new Response("not found", { status: 404 });
      },
      currentTokens: tokens,
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    await createCloudMirror({
      db, world, auth, cursorPath, now: () => new Date(), log: (event: string) => { events.push(event); },
    }).pullOnce();
    expect(windowAsks(asked).map(windowCursorOf), "the v1 cursor is tried once, then page 1").toEqual([v1, null]);
    expect(events).toContain("cloud_window_restarted");
    expect(await db.select().from(messages).where(eq(messages.id, mW))).toHaveLength(1);
  });

  /**
   * WATCHED RED by dropping the 404 short-circuit in `drainWindowFirst` (a 404 then counts as an
   * ordinary refusal): the first pull rejects with `HTTP 404` instead of proceeding.
   */
  it("a server with no snapshot route degrades the bootstrap to the plain replay at once, and says so", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const tOld = randomUUID(); const mOld = randomUUID();
    const events: string[] = [];
    const asked: string[] = [];
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        if (isSnapshot(path)) { asked.push(path); return new Response("no such route", { status: 404 }); }
        const rf = rulesFirstAnswer(path);
        if (rf) return rf;
        if (path.startsWith("/sync")) {
          asked.push(path);
          if (sinceOf(path) === "0") {
            return jsonRes(syncPage([change("thread", tOld, "create", 1, threadDTO(tOld)), change("message", mOld, "create", 2, messageDTO(mOld, tOld))], "end", false));
          }
          return jsonRes(syncPage([], sinceOf(path) ?? "0", false));
        }
        if (path.startsWith("/messages/bodies")) return jsonRes({ items: [], nextCursor: null });
        return new Response("not found", { status: 404 });
      },
      currentTokens: tokens,
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    const mirror = createCloudMirror({
      db, world, auth, cursorPath, now: () => new Date(), log: (event: string) => { events.push(event); },
    });
    await expect(mirror.pullOnce(), "a missing snapshot route failed the whole bootstrap").resolves.toBeTypeOf("number");
    expect(windowAsks(asked), "the route is asked once, not per page").toHaveLength(1);
    expect(events).toContain("cloud_window_skipped");
    expect(await db.select().from(messages).where(eq(messages.id, mOld)), "the replay still landed the archive").toHaveLength(1);
    expect(mirror.online(), "a degraded ordering is not an offline mirror").toBe(true);
    expect(cursorOnDisk(cursorPath)).toEqual(expect.objectContaining({ sync: "end", bootstrapping: false, window: null }));
  });

  /**
   * THE POSTURE UNDER TEST: the window is an ordering, not a row the mirror owes, so a snapshot
   * route that keeps refusing (a cold query, an outage on that one route) is given
   * WINDOW_REFUSALS_MAX consecutive pulls — the reconnect ladder's first seconds — and then the
   * bootstrap proceeds oldest-first rather than never. Before that count the pull fails like any
   * drain failure, so a blip that clears in a second still buys the newest-first order.
   *
   * WATCHED RED both ways: skipping on the FIRST refusal makes pull 1 resolve (red on the first
   * `rejects`); throwing on EVERY refusal makes pull 3 reject too (red on the `resolves`). The
   * not-JSON case is red with the `res.json()` try/catch removed — the decode rejection then
   * propagates past the count and pull 3 rejects like the first two.
   */
  const refusals: Array<[string, () => Response]> = [
    ["a 503", () => new Response("cold", { status: 503 })],
    ["a 200 that is not JSON", () => new Response("<html>down for maintenance</html>", { status: 200, headers: { "content-type": "text/html" } })],
  ];
  for (const [shape, refuse] of refusals) it(`a snapshot route that keeps answering ${shape} is given three pulls, then the bootstrap proceeds without it`, async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const tOld = randomUUID(); const mOld = randomUUID();
    const events: string[] = [];
    const asked: string[] = [];
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        if (isSnapshot(path)) { asked.push(path); return refuse(); }
        const rf = rulesFirstAnswer(path);
        if (rf) return rf;
        if (path.startsWith("/sync")) {
          asked.push(path);
          if (sinceOf(path) === "0") {
            return jsonRes(syncPage([change("thread", tOld, "create", 1, threadDTO(tOld)), change("message", mOld, "create", 2, messageDTO(mOld, tOld))], "end", false));
          }
          return jsonRes(syncPage([], sinceOf(path) ?? "0", false));
        }
        if (path.startsWith("/messages/bodies")) return jsonRes({ items: [], nextCursor: null });
        return new Response("not found", { status: 404 });
      },
      currentTokens: tokens,
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    const mirror = createCloudMirror({
      db, world, auth, cursorPath, now: () => new Date(), log: (event: string) => { events.push(event); },
    });
    for (let pull = 1; pull < WINDOW_REFUSALS_MAX; pull++) {
      await expect(mirror.pullOnce(), `pull ${pull} should still be retrying the window`).rejects.toThrow(/HTTP (503|200) to the opening window/);
      expect(mirror.online(), "a refused pull reads as offline until the window is given up").toBe(false);
      expect(await db.select().from(messages).where(eq(messages.id, mOld)),
        "the replay must not start while the window is still being retried").toHaveLength(0);
    }
    await expect(mirror.pullOnce(), "the last permitted refusal should give the window up and proceed").resolves.toBeTypeOf("number");
    // Window-phase asks only: the account holds no tags, so the tag repair probes the (still
    // refusing) snapshot AFTER the drain, and that later ask is its own describe block's business.
    expect(windowAsks(asked), "one window ask per pull, no more").toHaveLength(WINDOW_REFUSALS_MAX);
    expect(events).toContain("cloud_window_skipped");
    expect(await db.select().from(messages).where(eq(messages.id, mOld)), "the replay still landed the archive").toHaveLength(1);
    expect(mirror.online()).toBe(true);
    expect(cursorOnDisk(cursorPath)).toEqual(expect.objectContaining({ sync: "end", bootstrapping: false, window: null }));
  });

  /**
   * THE LOOP A REVIEW FOUND: page 1 lands and hands out a cursor the server then refuses with 410
   * (a mixed-version deployment: one node issues cursors another cannot decode). One restart per
   * drain is right; COUNTING the second 410 as an ordinary refusal was not — the restart's landed
   * page 1 reset the count, and every pull replayed restart → page 1 → 410 → throw without ever
   * reaching the replay. A second 410 in the same drain is definitive: the window is given up.
   *
   * WATCHED RED by counting the 410 as an ordinary refusal (dropping `|| res.status === 410`):
   * pull 1 rejects instead of proceeding.
   */
  it("a server that refuses the cursor its own page 1 issued gets one restart, then the window is given up in the same pull", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const tW = randomUUID(); const mW = randomUUID();
    const tOld = randomUUID(); const mOld = randomUUID();
    const events: string[] = [];
    const asked: string[] = [];
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        if (isSnapshot(path)) {
          asked.push(path);
          if (windowCursorOf(path) === null) {
            return jsonRes(windowPage([change("thread", tW, "create", 0, threadDTO(tW)), change("message", mW, "create", 0, messageDTO(mW, tW))], "w2"));
          }
          return new Response("cursor expired", { status: 410 });
        }
        const rf = rulesFirstAnswer(path);
        if (rf) return rf;
        if (path.startsWith("/sync")) {
          asked.push(path);
          if (sinceOf(path) === "0") {
            return jsonRes(syncPage([change("thread", tOld, "create", 1, threadDTO(tOld)), change("message", mOld, "create", 2, messageDTO(mOld, tOld))], "end", false));
          }
          return jsonRes(syncPage([], sinceOf(path) ?? "0", false));
        }
        if (path.startsWith("/messages/bodies")) return jsonRes({ items: [], nextCursor: null });
        return new Response("not found", { status: 404 });
      },
      currentTokens: tokens,
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    const mirror = createCloudMirror({
      db, world, auth, cursorPath, now: () => new Date(), log: (event: string) => { events.push(event); },
    });
    await expect(mirror.pullOnce(), "the first pull must proceed to the replay, not fail on the second 410").resolves.toBeTypeOf("number");
    // page 1, the refused cursor, the restart's page 1, the refused cursor again — then the replay.
    expect(windowAsks(asked).map(windowCursorOf)).toEqual([null, "w2", null, "w2"]);
    expect(events).toContain("cloud_window_restarted");
    expect(events).toContain("cloud_window_skipped");
    expect(await db.select().from(messages).where(eq(messages.id, mW)), "page 1 landed, twice, idempotently").toHaveLength(1);
    expect(await db.select().from(messages).where(eq(messages.id, mOld)), "the replay landed the archive").toHaveLength(1);
    expect(cursorOnDisk(cursorPath)).toEqual(expect.objectContaining({ sync: "end", bootstrapping: false, window: null }));
  });
});

describe("the Cloud mirror carries the mailbox's own folders", () => {
  it("applies a folder entity, arms the local flag, surfaces it through the local /sync, and lets it go", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const folderId = randomUUID();

    // ── A folder create rides the hosted feed (the account turned "Use folders" on). ──
    const page = syncPage([
      change("folder", folderId, "create", 1, {
        id: folderId, name: "Projects/Acme", mailboxId: CLOUD_MAILBOX,
        mailbox: "me@ohmail.test", updatedAt: iso(),
      }),
    ], "f1", false);
    await createCloudMirror({ db, world, auth: fakeAuth([page]), cursorPath, now: () => new Date() }).pullOnce();

    // The local row wears the HOSTED entity id — one deep-link namespace across the doors.
    const [row] = await db.select().from(mailboxFolders).where(eq(mailboxFolders.id, folderId));
    expect(row, "the folder was not mirrored").toBeDefined();
    expect(row!.folder).toBe("Projects/Acme");
    expect(row!.mailboxId).toBe(CLOUD_MAILBOX);

    // The local flag follows the inventory — the local SyncService gates folder reads on it.
    const [settings] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, world.accountId));
    expect(settings?.foldersEnabledAt, "the local Use-folders flag was not armed").not.toBeNull();

    // AND IT SURFACES where the window drains: the LOCAL /sync, same service as the hosted API.
    const ctx = { db, accountId: world.accountId, userId: world.userId, sessionId: null, now: () => new Date(), requestId: "", ip: "", userAgent: undefined, origin: undefined };
    const first = await syncService.getChanges(ctx, { since: "0" });
    const seen = [...first.changes.creates, ...first.changes.updates]
      .find((c) => c.type === "folder" && c.id === folderId);
    expect(seen, "the folder did not surface through the local /sync").toBeDefined();
    expect((seen!.entity as { name: string }).name).toBe("Projects/Acme");

    // ── The hosted disable deletes the entity; the mirror follows, flag and all. ──
    const gone = syncPage([change("folder", folderId, "delete", 2)], "f2", false);
    await createCloudMirror({ db, world, auth: fakeAuth([gone]), cursorPath, now: () => new Date() }).pullOnce();
    expect(await db.select().from(mailboxFolders).where(eq(mailboxFolders.id, folderId))).toHaveLength(0);
    const [after] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, world.accountId));
    expect(after?.foldersEnabledAt ?? null, "the local flag outlived the last folder").toBeNull();
  });
});

describe("a mailbox the hosted account erased leaves this mirror too", () => {
  /**
   * THE HOSTED HALF OF "A REMOVED MAILBOX STAYS ON SCREEN". The standalone door's removal writes
   * one `mailbox` delete receipt so the window's mirror drops everything keyed by that mailbox;
   * the hosted erasure writes the same row (`mailbox-erasure.ts`), and this door has to apply it
   * or the desktop keeps a mailbox's mail that the account it mirrors has erased.
   *
   * MUTATION-WATCH (edit, watch, restore): remove `"mailbox"` from `APPLY_ORDER` in
   * `cloud-mirror.ts` and the reversed delete pass never reaches the case — the message stays and
   * no local delete row is written; drop the `case "mailbox"` body and the same two go red.
   */
  it("applies the mailbox receipt: its mail goes, and the local log says so", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const msgId = randomUUID();

    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([
        change("thread", threadId, "create", 1, threadDTO(threadId)),
        change("message", msgId, "create", 2, messageDTO(msgId, threadId)),
      ], "m1", false)]),
    }).pullOnce();
    expect(await db.select().from(messages), "the precondition: the mirror holds the mail")
      .toHaveLength(1);

    writeFileSync(cursorPath, JSON.stringify({ version: CURSOR_VERSION, sync: "m1", bodies: null }));
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([change("mailbox", CLOUD_MAILBOX, "delete", 3)], "m2", false)]),
    }).pullOnce();

    expect(await db.select().from(messages).where(eq(messages.mailboxId, CLOUD_MAILBOX)),
      "the erased mailbox's mail is still in this mirror").toHaveLength(0);
    /* AND THE WINDOW IS TOLD. The local change log is what the window's own mirror drains, so the
       receipt has to be re-emitted here — without it this database is right and the screen is
       not, which is the whole shape of the defect. */
    const del = await db.select().from(changeLog)
      .where(and(eq(changeLog.entityId, CLOUD_MAILBOX), eq(changeLog.op, "delete")));
    expect(del, "no local receipt: the window would keep rendering the erased mailbox")
      .toHaveLength(1);
    expect(del[0]!.entityType).toBe("mailbox");

    /* AND ITS OWN CONVERSATION. No other mailbox's message is in this thread, so it goes — the
       hosted sweep's rule, which deletes the same thread upstream; a shared one stays
       (`standalone-consent-and-removal.test.ts`, A SHARED CONVERSATION STAYS). */
    expect(await db.select().from(threads), "the erased mailbox's conversation stayed on disk")
      .toHaveLength(0);
  });
});

describe("an upgraded mirror backfills the folder entities its old apply loop dropped", () => {
  it("a failed snapshot read retries on the NEXT PULL of the same instance, and never fails the pull", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const folderId = randomUUID();
    // Bootstrap, then age the cursor file to the pre-folders shape (see the test below).
    await createCloudMirror({
      db, world, auth: fakeAuth([syncPage([], "b", false)], [], NO_TAGS), cursorPath, now: () => new Date(),
    }).pullOnce();
    const cur = JSON.parse(readFileSync(cursorPath, "utf8")) as Record<string, unknown>;
    delete cur.folderBackfill;
    writeFileSync(cursorPath, JSON.stringify(cur));

    // ONE mirror instance, two pulls: the snapshot REJECTS on the first (a dead network mid-
    // repair must neither fail the pull nor cache the refusal for ever) and answers on the
    // second — which is the promised retry, on the same long-lived instance production keeps.
    let failFirst = true;
    const empty = syncPage([], "later", false);
    const snapshotWithFolder = {
      changes: [{ type: "folder", op: "create", id: folderId, seq: 1, updatedAt: iso(),
        entity: { id: folderId, name: "Retry/Case", mailboxId: CLOUD_MAILBOX, mailbox: "me@ohmail.test", updatedAt: iso() } }],
      nextCursor: null, asOfSeq: 1, window: { days: 90, minRows: 5000 }, serverTime: iso(),
    } as unknown as SnapshotResponse;
    const mirror = createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: {
        authedFetch: async (path: string) => {
          const boxes = mailboxesFor(path);
          if (boxes) return boxes;
          if (path.startsWith("/sync/snapshot")) {
            if (failFirst) { failFirst = false; throw new Error("network died mid-repair"); }
            return new Response(JSON.stringify(snapshotWithFolder), { status: 200, headers: { "content-type": "application/json" } });
          }
          if (path.startsWith("/sync")) return new Response(JSON.stringify(empty), { status: 200, headers: { "content-type": "application/json" } });
          return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200, headers: { "content-type": "application/json" } });
        },
        currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
        sealState: () => ({ sealed: true, reason: null }),
        ...idleSession,
      },
    });
    await mirror.pullOnce();   // the rejection is swallowed, the pull succeeds
    expect(await db.select().from(mailboxFolders).where(eq(mailboxFolders.id, folderId))).toHaveLength(0);
    await mirror.pullOnce();   // the retry lands it
    expect(await db.select().from(mailboxFolders).where(eq(mailboxFolders.id, folderId))).toHaveLength(1);
  });

  it("one snapshot read recovers them, marks the repair consumed, and never re-asks", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const folderId = randomUUID();

    // ── The upgraded-mirror state: a cursor file WRITTEN BY THE PRE-FOLDERS BUILD — it has no
    //    `folderBackfill` key at all, and its cursor already sits past the folder creates that
    //    build drained and dropped (a delta only ever looks forward). Reached honestly: one
    //    bootstrap pull writes a modern cursor, then the file is rewritten to the OLD SHAPE by
    //    removing the key — byte-for-byte what an upgrade finds on disk.
    const snapshotWithFolder = {
      changes: [{
        type: "folder", op: "create", id: folderId, seq: 1, updatedAt: iso(),
        entity: { id: folderId, name: "Projects/Acme", mailboxId: CLOUD_MAILBOX, mailbox: "me@ohmail.test", updatedAt: iso() },
      }],
      nextCursor: null, asOfSeq: 1, window: { days: 90, minRows: 5000 }, serverTime: iso(),
    } as unknown as SnapshotResponse;

    // Pull #1: an ordinary bootstrap (its feed carries no folders — the account had not
    // enabled them yet, or the old build dropped them). It writes a modern cursor.
    await createCloudMirror({
      db, world,
      auth: fakeAuth([syncPage([], "past-the-folders", false)], [], NO_TAGS),
      cursorPath, now: () => new Date(),
    }).pullOnce();
    // The old build's file: same cursor, no folderBackfill key.
    const cur = JSON.parse(readFileSync(cursorPath, "utf8")) as Record<string, unknown>;
    delete cur.folderBackfill;
    writeFileSync(cursorPath, JSON.stringify(cur));

    // Pull #2 on the UPGRADED build: a quiet delta, and the one-time repair reads the
    // snapshot's first page — which names the folder, because entities are live state.
    const asked: string[] = [];
    await createCloudMirror({
      db, world,
      auth: fakeAuth([syncPage([], "later-1", false)], [], snapshotWithFolder, { asked }),
      cursorPath, now: () => new Date(),
    }).pullOnce();

    // The dropped inventory is back — under the hosted id — and the local flag with it.
    const [row] = await db.select().from(mailboxFolders).where(eq(mailboxFolders.id, folderId));
    expect(row, "the backfill did not recover the folder").toBeDefined();
    expect(row!.folder).toBe("Projects/Acme");
    const [settings] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, world.accountId));
    expect(settings?.foldersEnabledAt).not.toBeNull();

    // Consumed: the next pull asks for NO further snapshot page.
    const before = asked.filter((p) => p.startsWith("/sync/snapshot")).length;
    expect(before, "the repair read the snapshot at all").toBeGreaterThan(0);
    await createCloudMirror({
      db, world,
      auth: fakeAuth([syncPage([], "later-2", false)], [], snapshotWithFolder, { asked }),
      cursorPath, now: () => new Date(),
    }).pullOnce();
    expect(asked.filter((p) => p.startsWith("/sync/snapshot")).length, "the repair re-ran").toBe(before);
  });
});

/**
 * ═══ THE BODY FILL IS NEWEST-FIRST — the first screenful's bodies land first ═════════════════
 *
 * The list is newest-first (the NEWEST FIRST bootstrap) and the walk is a keyset in uuid order —
 * a random permutation of the mailbox — so which gaps a pull fills FIRST is the one ordering
 * decision left to this mirror, and it must be the list's own: `date desc nulls last, id desc`
 * (the snapshot window's exact sort). Both doors are pinned here: the bounded pre-pass that runs
 * ahead of the first walk's turns, and the steady-state gap fill.
 *
 * The fixtures pick uuids and dates so that EVERY other order the code could plausibly produce
 * is distinguishable: uuid-ASC (the order this replaced), uuid-DESC, and arrival order all
 * differ from date-DESC. The load-bearing mutation: put `asc(messages.id)` back in
 * `fetchMissingBodies` (the uuid-order mutant) and both tests below go red on the ids sequence.
 */
describe("the body fill is newest-first", () => {
  const T = "11111111-0000-4000-8000-000000000001";
  // uuid ascending: A < B < C — dates deliberately NOT aligned with either uuid direction.
  const A = "aaaaaaaa-0000-4000-8000-000000000001";  // 2026-08-24 — the middle
  const B = "bbbbbbbb-0000-4000-8000-000000000002";  // 2026-08-23 — the oldest
  const C = "cccccccc-0000-4000-8000-000000000003";  // 2026-08-25 — the newest
  const dated = (id: string, date: string) => messageDTO(id, T, { date });

  const idsParamOf = (call: string): string =>
    new URLSearchParams(call.split("?")[1] ?? "").get("ids") ?? "";

  it("while the walk is still running, a bounded newest-first ask goes FIRST — then the walk", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const corpus = [A, B, C].map((id) => bodyItem(id, `body of ${id}`));
    const asked: Asked = [];
    const auth = fakeAuth([syncPage([
      change("thread", T, "create", 1, threadDTO(T)),
      change("message", A, "create", 2, dated(A, "2026-08-24T10:00:00.000Z")),
      change("message", B, "create", 3, dated(B, "2026-08-23T10:00:00.000Z")),
      change("message", C, "create", 4, dated(C, "2026-08-25T10:00:00.000Z")),
    ], "c1", false)], corpus, NO_TAGS, { bodiesPageSize: 2, asked });

    await createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() }).pullOnce();

    const calls = bodyCalls(asked);
    // The FIRST body request of the pull is the newest-first `?ids=` ask, in the LIST's order —
    // newest date first, never uuid order (uuid-asc would be A,B,C; uuid-desc C,B,A).
    expect(calls.length).toBeGreaterThan(1);
    expect(idsParamOf(calls[0]!), "the pre-pass must ask newest-first, ahead of the walk")
      .toBe([C, A, B].join(","));
    // The walk still ran — keyset pages (no ids=) follow — and still finished.
    expect(calls.slice(1).some((c) => !c.includes("ids=")), "the uuid walk must still run").toBe(true);
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ bodies: "complete" });
    // The double-ask is absorbed by the upsert: three messages, three body rows, once each.
    expect(await db.select().from(messageBodies)).toHaveLength(3);
  });

  it("the steady-state gap fill asks newest-first too", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const settled = "99999999-0000-4000-8000-000000000009";
    // uuid ascending: D < E < F; dates make newest-first F,D,E — distinct from uuid-asc (D,E,F),
    // uuid-desc (F,E,D) and arrival order (D,E,F).
    const D = "dddddddd-0000-4000-8000-000000000004";  // 2026-08-22
    const E = "eeeeeeee-0000-4000-8000-000000000005";  // 2026-08-20
    const F = "ffffffff-0000-4000-8000-000000000006";  // 2026-08-26
    const corpus = [settled, D, E, F].map((id) => bodyItem(id, `body of ${id}`));
    const asked: Asked = [];
    const auth = fakeAuth([
      syncPage([
        change("thread", T, "create", 1, threadDTO(T)),
        change("message", settled, "create", 2, dated(settled, "2026-08-01T10:00:00.000Z")),
      ], "c1", false),
      syncPage([
        change("message", D, "create", 3, dated(D, "2026-08-22T10:00:00.000Z")),
        change("message", E, "create", 4, dated(E, "2026-08-20T10:00:00.000Z")),
        change("message", F, "create", 5, dated(F, "2026-08-26T10:00:00.000Z")),
      ], "c2", false),
    ], corpus, NO_TAGS, { asked });
    const mirror = createCloudMirror({ db, world, auth, cursorPath, now: () => new Date() });

    await mirror.pullOnce();   // the walk settles over the one existing message
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ bodies: "complete" });

    asked.length = 0;
    await mirror.pullOnce();   // the three newcomers arrive and their gap is filled

    const calls = bodyCalls(asked);
    expect(calls, "one gap, one request").toHaveLength(1);
    expect(idsParamOf(calls[0]!), "the gap fill must start at the top of the list")
      .toBe([F, D, E].join(","));
  });
});

/**
 * ═══ A WARM MIRROR RESUMING STALE FRESHENS NEWEST-FIRST — INSTANT-ARCH §8 stage 2 ════════════
 *
 * The engine's `freshenStaleResume`, ported. The gap was this file's own: the newest-first
 * window exists only for the cursor-"0" bootstrap, so a desktop reopened days later replayed
 * its whole backlog oldest-first and the newest week of mail landed LAST — the measured
 * "10–15 s to a current view". Now a pull whose {@link CursorState.lastDrainAt} is older than
 * `STALE_RESUME_MS` lands snapshot page 1 through the same `landPage` a window page
 * takes, BEFORE the replay's first `/sync` ask — rows only, the feed cursor untouched.
 *
 * Every guard below was watched RED against a named mutation, then the implementation restored:
 *  · freshen-skipped-on-resume — removing the `freshenStaleResume()` call: the ordering guard
 *    sees `/sync` first and the newest message misses the head start.
 *  · freshen-inside-bootstrap — dropping the `sweep === null` gate: the bootstrap's snapshot
 *    ask count gains the freshen's extra ask (whose unmarked rows the trailing sweep would
 *    delete as phantoms).
 *  · stale-stamped-on-failure — stamping `lastDrainAt` at pull START instead of completion:
 *    the failed-pull guard sees a fresh stamp over a mirror that never converged.
 */
describe("a warm mirror resuming STALE freshens newest-first", () => {
  /** A clock past the staleness threshold — what "reopened days later" reads as. */
  const futureNow = (): Date => new Date(Date.now() + STALE_RESUME_MS + 60_000);

  /** Bootstrap once and settle: a warm mirror whose cursor file carries a completion stamp. */
  async function warmSettledMirror(): Promise<{
    opened: OpenLocalDb; world: LocalWorld; cursorPath: string; threadId: string;
  }> {
    const { opened, world, cursorPath } = await standUp();
    const threadId = randomUUID();
    const oldId = randomUUID();
    const seed = syncPage([
      change("thread", threadId, "create", 1, threadDTO(threadId)),
      change("message", oldId, "create", 2, messageDTO(oldId, threadId)),
    ], "c2", false);
    await createCloudMirror({
      db: opened.db, world, auth: fakeAuth([seed]), cursorPath, now: () => new Date(),
    }).pullOnce();
    // The completed pull is what wrote the stamp — the freshen and freshness() read this write.
    const file = JSON.parse(readFileSync(cursorPath, "utf8")) as { lastDrainAt?: unknown };
    expect(typeof file.lastDrainAt, "a completed pull did not stamp lastDrainAt").toBe("string");
    return { opened, world, cursorPath, threadId };
  }

  it("asks the snapshot BEFORE the delta and lands the newest mail ahead of the replay — cursor untouched", async () => {
    const { opened, world, cursorPath, threadId } = await warmSettledMirror();
    const newest = randomUUID();
    const asked: string[] = [];
    // The mail that arrived while the laptop was closed rides snapshot page 1; the delta pages
    // are what they are — the freshen's whole point is not waiting for them.
    const snap = snapshotPage([
      change("message", newest, "create", 0, messageDTO(newest, threadId, { subject: "arrived while closed" })),
    ]);
    await createCloudMirror({
      db: opened.db, world, cursorPath, now: futureNow,
      auth: fakeAuth([syncPage([], "c2", false)], [], snap, { asked }),
    }).pullOnce();

    const wire = asked.filter((p) => p.startsWith("/sync"));
    expect(wire[0], "the freshen did not run before the replay").toMatch(/^\/sync\/snapshot/);
    expect(wire[1], "the replay did not follow the freshen").toMatch(/^\/sync\?/);
    expect(sinceOf(wire[1]!), "the replay must resume from the COMMITTED cursor").toBe("c2");
    expect(
      await opened.db.select().from(messages).where(eq(messages.id, newest)),
      "the newest message did not land",
    ).toHaveLength(1);
    // Rows only: the feed cursor is the delta's alone — a freshen that moved it would skip
    // every tombstone in the backlog.
    expect((JSON.parse(readFileSync(cursorPath, "utf8")) as { sync: string }).sync).toBe("c2");
  });

  it("freshens ONLY past the threshold — a fresh resume asks for no snapshot at all", async () => {
    const { opened, world, cursorPath } = await warmSettledMirror();
    const askedFresh: string[] = [];
    await createCloudMirror({
      db: opened.db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([], "c2", false)], [], NO_TAGS, { asked: askedFresh }),
    }).pullOnce();
    expect(
      askedFresh.filter((p) => p.startsWith("/sync/snapshot")),
      "a healthy resume paid a snapshot ask it does not need",
    ).toHaveLength(0);

    const askedStale: string[] = [];
    await createCloudMirror({
      db: opened.db, world, cursorPath, now: futureNow,
      auth: fakeAuth([syncPage([], "c2", false)], [], NO_TAGS, { asked: askedStale }),
    }).pullOnce();
    expect(
      askedStale.filter((p) => p.startsWith("/sync/snapshot")),
      "a stale resume owes exactly one freshen ask",
    ).toHaveLength(1);
  });

  it("a snapshot that will not answer costs the head start and nothing else", async () => {
    const { opened, world, cursorPath, threadId } = await warmSettledMirror();
    const late = randomUUID();
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        if (path.startsWith("/sync/snapshot")) return new Response("no", { status: 503 });
        if (path.startsWith("/sync")) {
          return jsonRes(syncPage([change("message", late, "create", 3, messageDTO(late, threadId))], "c3", false));
        }
        if (path.startsWith("/messages/bodies")) return jsonRes({ items: [], nextCursor: null });
        return new Response("not found", { status: 404 });
      },
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    const mirror = createCloudMirror({ db: opened.db, world, auth, cursorPath, now: futureNow });
    await mirror.pullOnce();
    // The replay is the contract: it ran, converged, and the mirror is online.
    expect(mirror.online()).toBe(true);
    expect(await opened.db.select().from(messages).where(eq(messages.id, late))).toHaveLength(1);
    expect((JSON.parse(readFileSync(cursorPath, "utf8")) as { sync: string }).sync).toBe("c3");
  });

  it("never freshens INSIDE a bootstrap — the window owns newest-first and the sweep owns the marks", async () => {
    const { opened, world, cursorPath } = await standUp();
    const threadId = randomUUID();
    const m = randomUUID();
    const asked: string[] = [];
    const seed = syncPage([
      change("thread", threadId, "create", 1, threadDTO(threadId)),
      change("message", m, "create", 2, messageDTO(m, threadId)),
    ], "c2", false);
    // A fresh install's lastDrainAt is null — "not known to be current" — but this pull is a
    // BOOTSTRAP, and a freshen here would land UNMARKED rows into a generation whose trailing
    // sweep deletes everything unmarked. Exactly two snapshot asks belong to a bootstrap with
    // no tags: the opening window's, and the one-time tag repair's probe. A third is the leak.
    await createCloudMirror({
      db: opened.db, world, cursorPath, now: futureNow,
      auth: fakeAuth([seed], [], NO_TAGS, { asked }),
    }).pullOnce();
    expect(asked.filter((p) => p.startsWith("/sync/snapshot"))).toHaveLength(2);
  });

  it("stamps lastDrainAt at COMPLETION only — a failed pull leaves the stale stamp standing", async () => {
    const { opened, world, cursorPath } = await warmSettledMirror();
    const before = (JSON.parse(readFileSync(cursorPath, "utf8")) as { lastDrainAt: string }).lastDrainAt;
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        if (path.startsWith("/sync/snapshot")) return jsonRes(NO_TAGS);
        if (path.startsWith("/sync")) return new Response("boom", { status: 500 });
        return new Response("not found", { status: 404 });
      },
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    const mirror = createCloudMirror({ db: opened.db, world, auth, cursorPath, now: futureNow });
    await expect(mirror.pullOnce()).rejects.toThrow();
    expect(
      (JSON.parse(readFileSync(cursorPath, "utf8")) as { lastDrainAt: string }).lastDrainAt,
      "a pull that never converged claimed to be current",
    ).toBe(before);
    // And freshness() tells the window the truth: still stale, still labeled.
    expect(mirror.freshness().state).toBe("stale");
  });

  it("freshness(): unknown before any completed pull, current after one, stale past the threshold", async () => {
    const { opened, world, cursorPath } = await standUp();
    const clock = { now: new Date() };
    const mirror = createCloudMirror({
      db: opened.db, world, cursorPath, now: () => clock.now,
      auth: fakeAuth([syncPage([], "c1", false)]),
    });
    expect(mirror.freshness()).toEqual({ state: "unknown", asOf: null });
    await mirror.pullOnce();
    const settled = mirror.freshness();
    expect(settled.state).toBe("current");
    expect(settled.asOf).toBe(clock.now.toISOString());
    clock.now = new Date(clock.now.getTime() + STALE_RESUME_MS + 1);
    expect(mirror.freshness().state).toBe("stale");
  });
});

/**
 * ═══ THE BACKLOG DIET'S DESKTOP HALF — INSTANT-ARCH §6.3 / §8 stage 3 ════════════════════════
 *
 * Two moves, both keyed on the freshen's OWN staleness verdict so they can never fire apart:
 *
 *  · DENSE PAGES — a warm-stale replay asks `/sync` for `BACKLOG_PAGE_LIMIT` rows per page
 *    (the server coalesces a stale span, so page count is the cost that matters); a fresh
 *    resume and every bootstrap keep the deployed 500.
 *  · THE SUPERSESSION SKIP — the freshen returns the ledger of what it landed at `asOfSeq`,
 *    and the replay drops any change for one of those identities at `seq ≤ asOfSeq`. This
 *    mirror keeps no per-row seq, so without the skip the replay's wire copies RE-APPLY over
 *    the freshen's rows — pure serial PGlite work at best, and a row walked BACKWARDS whenever
 *    the wire copy is older than the freshen's read (the engine's seq guard refuses exactly
 *    this; the skip is that guard, expressed relationally).
 *
 * Every guard was watched RED against a named mutation (2026-08-29), then restored:
 *  · dense-ask-dropped — serving `pageLimit` unconditionally: the dense test sees limit=500;
 *  · skip-dropped — applying every replay row: the supersession test sees the freshen's row
 *    overwritten by the older wire copy;
 *  · skip-inside-bootstrap — removing the `sweep === null` gate: the 410 test's bootstrap page
 *    is filtered, its rows never marked, and the trailing sweep deletes the live message.
 */
describe("stage 3 — dense stale pages and the freshen-supersession skip", () => {
  const futureNow = (): Date => new Date(Date.now() + STALE_RESUME_MS + 60_000);
  const limitOf = (path: string): string | null => new URLSearchParams(path.split("?")[1] ?? "").get("limit");
  const replayAsks = (asked: string[]): string[] => asked.filter((p) =>
    p.startsWith("/sync?") && new URLSearchParams(p.split("?")[1] ?? "").get("types") !== "rule");

  /** Bootstrap once and settle — a warm mirror whose cursor carries a completion stamp. */
  async function warmSettled(): Promise<{
    opened: OpenLocalDb; world: LocalWorld; cursorPath: string; threadId: string; oldId: string;
  }> {
    const { opened, world, cursorPath } = await standUp();
    const threadId = randomUUID();
    const oldId = randomUUID();
    const seed = syncPage([
      change("thread", threadId, "create", 1, threadDTO(threadId)),
      change("message", oldId, "create", 2, messageDTO(oldId, threadId)),
    ], "c2", false);
    await createCloudMirror({
      db: opened.db, world, auth: fakeAuth([seed]), cursorPath, now: () => new Date(),
    }).pullOnce();
    return { opened, world, cursorPath, threadId, oldId };
  }

  it("a stale replay asks for the dense page; a fresh resume keeps the deployed 500", async () => {
    const { opened, world, cursorPath } = await warmSettled();
    const askedStale: string[] = [];
    await createCloudMirror({
      db: opened.db, world, cursorPath, now: futureNow,
      auth: fakeAuth([syncPage([], "c2", false)], [], NO_TAGS, { asked: askedStale }),
    }).pullOnce();
    expect(replayAsks(askedStale).map(limitOf), "the stale replay did not ask dense").toEqual(["2000"]);

    // The fresh resume reads the same future clock the stale pull stamped on: one read behind that
    // stamp is a clock stepped back, which freshens once by rule (`mirrorStale`).
    const askedFresh: string[] = [];
    await createCloudMirror({
      db: opened.db, world, cursorPath, now: futureNow,
      auth: fakeAuth([syncPage([], "c2", false)], [], NO_TAGS, { asked: askedFresh }),
    }).pullOnce();
    expect(replayAsks(askedFresh).map(limitOf), "a fresh resume must keep the deployed page size").toEqual(["500"]);
  });

  it("the replay's superseded copies are skipped — the freshen's row is never walked backwards", async () => {
    const { opened, world, cursorPath, threadId, oldId } = await warmSettled();
    const newcomer = randomUUID();
    // The freshen lands OLD at its state-as-of-99 …
    const snap = snapshotPage([
      change("message", oldId, "create", 0, messageDTO(oldId, threadId, { subject: "fresh copy" })),
    ]);
    // … and the replay then serves the SAME identity at an older seq (a plain remainder page's
    // history copy — this mirror has no seq guard, so only the skip stands between the freshen's
    // row and this overwrite) plus a newcomer the freshen never saw, which must land.
    const replay = syncPage([
      change("message", oldId, "update", 5, messageDTO(oldId, threadId, { subject: "history copy" })),
      change("message", newcomer, "create", 6, messageDTO(newcomer, threadId, { subject: "newcomer" })),
    ], "c9", false);
    await createCloudMirror({
      db: opened.db, world, cursorPath, now: futureNow,
      auth: fakeAuth([replay], [], snap),
    }).pullOnce();

    const [old] = await opened.db.select().from(messages).where(eq(messages.id, oldId));
    expect(old?.subject, "the freshen's copy was walked backwards by a superseded wire row").toBe("fresh copy");
    expect(
      await opened.db.select().from(messages).where(eq(messages.id, newcomer)),
      "a row the freshen never landed must still apply",
    ).toHaveLength(1);
    // The cursor advanced over the skipped rows — the skip is a read decision, never a cursor one.
    expect((JSON.parse(readFileSync(cursorPath, "utf8")) as { sync: string }).sync).toBe("c9");
  });

  it("a mid-drain 410 disarms the skip — bootstrap pages are never filtered, so the sweep keeps their rows", async () => {
    const { opened, world, cursorPath, threadId, oldId } = await warmSettled();
    // The freshen (first snapshot ask) lands OLD's fresh state; every later snapshot ask — the
    // re-bootstrap's window, the tag repair's probe — sees an EMPTY account, so the bootstrap
    // page below is the ONLY thing that can mark OLD into the new generation. If the skip were
    // still armed there, OLD would be filtered (same identity, seq 2 ≤ asOfSeq 99), never
    // marked, and the trailing sweep would delete the live row the freshen just wrote.
    let snapAsks = 0;
    const freshenSnap = snapshotPage([
      change("thread", threadId, "create", 0, threadDTO(threadId)),
      change("message", oldId, "create", 0, messageDTO(oldId, threadId, { subject: "fresh copy" })),
    ]);
    const bootstrap = syncPage([
      change("thread", threadId, "create", 1, threadDTO(threadId)),
      change("message", oldId, "create", 2, messageDTO(oldId, threadId, { subject: "bootstrap copy" })),
    ], "c9", false);
    let servedBootstrap = false;
    const asked: string[] = [];
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        asked.push(path);
        const boxes = mailboxesFor(path);
        if (boxes) return boxes;
        if (path.startsWith("/sync/snapshot")) return jsonRes(snapAsks++ === 0 ? freshenSnap : NO_TAGS);
        const rf = rulesFirstAnswer(path);
        if (rf) return rf;
        if (path.startsWith("/sync")) {
          const since = sinceOf(path);
          if (since && since !== "0") return new Response("cursor expired", { status: 410 });
          if (!servedBootstrap) { servedBootstrap = true; return jsonRes(bootstrap); }
          return jsonRes(syncPage([], "end", false));
        }
        if (path.startsWith("/messages/bodies")) return jsonRes({ items: [], nextCursor: null });
        return new Response("not found", { status: 404 });
      },
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    await createCloudMirror({ db: opened.db, world, auth, cursorPath, now: futureNow }).pullOnce();

    const [old] = await opened.db.select().from(messages).where(eq(messages.id, oldId));
    expect(old, "the bootstrap page was filtered, so the sweep deleted the live row").toBeDefined();
    expect(old?.subject, "the bootstrap's own copy must have applied unfiltered").toBe("bootstrap copy");
    // And the re-bootstrap's replay kept the deployed page size — dense pages are the warm
    // stale replay's alone.
    const bootstrapAsks = replayAsks(asked).filter((p) => sinceOf(p) === "0");
    expect(bootstrapAsks.length).toBeGreaterThan(0);
    for (const p of bootstrapAsks) expect(limitOf(p)).toBe("500");
  });

  it("a reply draft the freshen landed DETACHED is healed by the replay — partial applies never enter the ledger", async () => {
    // Review round 1 of this slice: the draft arm lands a reply whose parent message is not
    // yet mirrored WITH ITS REPLY LINK NULLED (user writing is never dropped), and returns
    // truthily. A ledger that recorded that partial apply as the entity's full state would
    // skip the replay's own copy of the draft — the one that, applying AFTER its parent lands
    // (message precedes draft in APPLY_ORDER), restores the relationship — and the draft
    // stayed detached until its next edit. MUTATION-PROOFED: ledgering partials
    // (`appliedKeys?.add` without the outcome check in applyPage) turns this red.
    const { opened, world, cursorPath, threadId } = await warmSettled();
    const parent = randomUUID();
    const draftId = randomUUID();
    const draftDTO = (reply: string | null) => ({
      id: draftId, mailboxId: CLOUD_MAILBOX, threadId, inReplyToMessageId: reply,
      subject: "Re: hello", body: "typing", html: null,
      to: [{ name: null, address: "stranger@nowhere.test" }], cc: [], bcc: [],
      rationale: null, status: "draft", createdAt: iso(), updatedAt: iso(),
    });
    // The freshen sees the draft but NOT its parent (outside snapshot page 1's window).
    const snap = snapshotPage([
      change("draft", draftId, "create", 0, draftDTO(parent)),
    ]);
    // The replay carries the parent AND the draft's own change, both at seq ≤ asOfSeq.
    const replay = syncPage([
      change("message", parent, "create", 4, messageDTO(parent, threadId)),
      change("draft", draftId, "update", 5, draftDTO(parent)),
    ], "c9", false);
    await createCloudMirror({
      db: opened.db, world, cursorPath, now: futureNow,
      auth: fakeAuth([replay], [], snap),
    }).pullOnce();

    const [row] = await opened.db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(row, "the draft must exist").toBeDefined();
    expect(row!.inReplyToMessageId, "the replay's copy must heal the detached reply link").toBe(parent);
  });
});

/**
 * A PAGE NEVER UNDOES A RESTORE WITH AN OLDER DELETE.
 *
 * `applyPage` groups by KIND — creates in `APPLY_ORDER`, then deletes in reverse — and that
 * decided which of two changes to ONE entity won: delete a message elsewhere and restore it
 * between two polls, and the page applied the restore first and the delete second. The mail was
 * gone locally with the cursor past the only copy of the event, and nothing came back to heal it.
 *
 * Fix: a delete applies only when nothing LATER in the same page names its `type:id`.
 */
describe("a delete in a page loses to a later change to the same message", () => {
  /** A mirror that has already drained, so the next pull is incremental — see the tombstone test. */
  const settled = (cursorPath: string, sync: string): void => {
    writeFileSync(cursorPath, JSON.stringify({ version: CURSOR_VERSION, sync, bodies: "complete" }));
  };

  const seeded = async (): Promise<{ db: LocalDb; world: LocalWorld; cursorPath: string; msgId: string; threadId: string }> => {
    const { opened, world, cursorPath } = await standUp();
    const threadId = randomUUID();
    const msgId = randomUUID();
    await createCloudMirror({
      db: opened.db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([
        change("thread", threadId, "create", 1, threadDTO(threadId)),
        change("message", msgId, "create", 2, messageDTO(msgId, threadId)),
      ], "c1", false)]),
    }).pullOnce();
    expect(await opened.db.select().from(messages).where(eq(messages.id, msgId))).toHaveLength(1);
    settled(cursorPath, "c1");
    return { db: opened.db, world, cursorPath, msgId, threadId };
  };

  it("delete THEN restore in one page leaves the message present, with the cursor advanced", async () => {
    const { db, world, cursorPath, msgId, threadId } = await seeded();

    // The other device deleted it and put it back, both between two polls. One page, feed order.
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([
        change("message", msgId, "delete", 10),
        change("message", msgId, "create", 11, messageDTO(msgId, threadId, { subject: "put back" })),
      ], "c2", false)]),
    }).pullOnce();

    const [row] = await db.select().from(messages).where(eq(messages.id, msgId));
    expect(row, "the restored message was deleted by the older change in its own page").toBeDefined();
    expect(row!.subject, "the restore is the page's last word about this message").toBe("put back");
    expect(await db.select().from(folderState).where(eq(folderState.messageId, msgId))).toHaveLength(1);
    // No tombstone was announced locally either — the projection must not drop the row.
    const del = await db.select().from(changeLog)
      .where(and(eq(changeLog.entityId, msgId), eq(changeLog.op, "delete")));
    expect(del, "a delete the page superseded was still announced to the local feed").toHaveLength(0);
    // AND THE CURSOR ADVANCED: this is not a page held back for a later retry.
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ sync: "c2" });
  });

  it("an ordinary delete, with nothing later in the page, still applies", async () => {
    const { db, world, cursorPath, msgId } = await seeded();

    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([change("message", msgId, "delete", 10)], "c2", false)]),
    }).pullOnce();

    expect(await db.select().from(messages).where(eq(messages.id, msgId)),
      "the guard made an ordinary delete lose").toHaveLength(0);
    const del = await db.select().from(changeLog)
      .where(and(eq(changeLog.entityId, msgId), eq(changeLog.op, "delete")));
    expect(del, "the local feed was never told").toHaveLength(1);
  });

  it("restore THEN delete in one page still deletes — the guard reads later-in-page, not presence", async () => {
    const { db, world, cursorPath, msgId, threadId } = await seeded();

    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([
        change("message", msgId, "create", 10, messageDTO(msgId, threadId, { subject: "put back" })),
        change("message", msgId, "delete", 11),
      ], "c2", false)]),
    }).pullOnce();

    expect(await db.select().from(messages).where(eq(messages.id, msgId)),
      "the delete is the page's last word and must stand").toHaveLength(0);
  });
});

/**
 * A WITHHELD BODY IS NOT AN ORDINARILY EMPTY ONE, AND A RESTORE REFILLS IT.
 *
 * The hosted store husks a body it declines to hold and says why (`storage_cap`, `junk_filed`,
 * `expunged`). The mirror carried only the cap marker and stored the other two as ordinary empty
 * rows, which `fetchMissingBodies` never re-asks — restore from Junk elsewhere and this mirror
 * opened it blank for ever. Fix: every marker mirrored verbatim, and a message change re-owes the
 * two the hosted side refills, since a body is not a `/sync` entity.
 */
describe("a body the hosted account withheld is re-owed when its message changes", () => {
  const husk = (messageId: string, withheld: "junk_filed" | "storage_cap" | "too_large"): MessageBodyBatchItem =>
    ({ messageId, text: "", html: null, loadedRemoteContent: false, withheld });

  const seedPage = (threadId: string, ids: string[], cursor: string): SyncResponse =>
    syncPage([
      change("thread", threadId, "create", 1, threadDTO(threadId)),
      ...ids.map((m, i) => change("message", m, "create", i + 2, messageDTO(m, threadId))),
    ], cursor, false);

  it("a junk husk is stored AS a husk, and the restore's message change brings the body back", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const msgId = randomUUID();

    // Pull 1: the hosted account withheld this body because it filed the message to Junk.
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([seedPage(threadId, [msgId], "c1")], [husk(msgId, "junk_filed")]),
    }).pullOnce();

    const [stored] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, msgId));
    expect(stored, "the husk row is still written — absence means UNFETCHED").toBeDefined();
    expect(stored!.withheldReason, "a junk husk stored as an ordinarily empty row is the defect")
      .toBe("junk_filed");

    // Pull 2: restored upstream. The hosted refill records the message's own change, and the
    // account now answers with the bytes.
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth(
        [syncPage([change("message", msgId, "update", 9, messageDTO(msgId, threadId))], "c2", false)],
        [bodyItem(msgId, "the mail that came back")],
      ),
    }).pullOnce();

    const [healed] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, msgId));
    expect(healed!.text, "the restored message still opens blank").toBe("the mail that came back");
    expect(healed!.withheldReason, "the marker outlived the husk").toBeNull();
  });

  it("a husk that STAYS husked is asked once and re-stored; a too-large husk is not asked at all", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const junkId = randomUUID();
    const capId = randomUUID();
    const bigId = randomUUID();
    const corpus = [husk(junkId, "junk_filed"), husk(capId, "storage_cap"), husk(bigId, "too_large")];

    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([seedPage(threadId, [junkId, capId, bigId], "c1")], corpus),
    }).pullOnce();

    // Both messages change upstream; NEITHER body was restored — the hosted account still withholds.
    const asked: Asked = [];
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([
        change("message", junkId, "update", 9, messageDTO(junkId, threadId)),
        change("message", capId, "update", 10, messageDTO(capId, threadId)),
        change("message", bigId, "update", 11, messageDTO(bigId, threadId)),
      ], "c2", false)], corpus, NO_TAGS, { asked }),
    }).pullOnce();

    const calls = bodyCalls(asked);
    expect(calls, "the re-owed body is one ask, not a walk").toHaveLength(1);
    expect(calls[0]!.includes(junkId), "the junk husk's message changed, so its body is owed").toBe(true);
    expect(calls[0]!.includes(capId),
      "the storage refill gives a cap husk its text back with a message change, so its body is owed").toBe(true);

    // The account answered with the husk again, so the husk is what this mirror holds — no body
    // was invented, and the hosted Junk exclusion is untouched.
    const [junk] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, junkId));
    expect(junk!.text).toBe("");
    expect(junk!.withheldReason).toBe("junk_filed");
    const [cap] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, capId));
    expect(cap!.withheldReason, "the cap husk still withheld upstream was not stored as itself").toBe("storage_cap");
    // A message over the download ceiling keeps its marker here, so the desktop says why it is empty.
    expect(calls[0]!.includes(bigId), "nothing refills a too-large body, so it is never re-asked").toBe(false);
    const [big] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, bigId));
    expect(big!.withheldReason, "the too-large husk was mirrored as an ordinarily empty body").toBe("too_large");
  });

  it("an ordinary poll over a settled mailbox asks for no body at all", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const junkId = randomUUID();
    const plainId = randomUUID();
    const corpus = [husk(junkId, "junk_filed"), bodyItem(plainId, "an ordinary body")];

    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([seedPage(threadId, [junkId, plainId], "c1")], corpus),
    }).pullOnce();

    const asked: Asked = [];
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([syncPage([], "c2", false)], corpus, NO_TAGS, { asked }),
    }).pullOnce();

    expect(bodyCalls(asked), "a husk left absent would be re-asked on every poll, for ever").toEqual([]);
    expect((await db.select().from(messageBodies)).length, "both rows are settled answers").toBe(2);
  });

  /**
   * An older sidecar kept a cap husk through the change the storage refill records, so a letter whose
   * text came back upstream before the upgrade opens empty here. Every local cap husk is asked once,
   * recorded in the cursor file; a fresh install's flag is born set.
   */
  it("an upgraded mirror asks once for every cap husk an older sidecar kept, and never again", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const capId = randomUUID();
    const plainId = randomUUID();
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([seedPage(threadId, [capId, plainId], "c1")], [husk(capId, "storage_cap"), bodyItem(plainId, "a body")]),
    }).pullOnce();
    const onDisk = JSON.parse(readFileSync(cursorPath, "utf8")) as Record<string, unknown>;
    expect(onDisk.bodies, "the premise: the walk finished in pull 1").toBe("complete");
    expect(onDisk.capRefillRepair, "a fresh install's flag is born set").toBe(true);
    delete onDisk.capRefillRepair;
    writeFileSync(cursorPath, JSON.stringify(onDisk));

    const corpus = [bodyItem(capId, "the text that came back"), bodyItem(plainId, "a body")];
    const asked: Asked = [];
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([], corpus, NO_TAGS, { asked }),
    }).pullOnce();
    const [row] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, capId));
    expect({ text: row!.text, withheld: row!.withheldReason }).toEqual({ text: "the text that came back", withheld: null });
    expect(bodyCalls(asked).some((p) => p.includes(plainId)), "a body with text is not asked").toBe(false);
    expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toMatchObject({ capRefillRepair: true });

    const later: Asked = [];
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([], corpus, NO_TAGS, { asked: later }),
    }).pullOnce();
    expect(bodyCalls(later), "the re-ask ran a second time — it is not one-time").toEqual([]);
  });
});
