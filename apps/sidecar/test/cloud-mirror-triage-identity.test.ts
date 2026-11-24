import type {
  MailboxDTO,
  MessageDTO,
  MessageStateDTO,
  SnapshotResponse,
  SyncChange,
  SyncResponse,
  ThreadDTO,
} from "@ohmail/wire";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { changeLog, messageStates } from "@trafficflow/db/mail";
import { dbFor, syncService } from "@trafficflow/services/mail";
import type {
  ServiceContext,
} from "@trafficflow/services/mail";
import {
  MemoryMirrorStore, ohboxView, parkedMessageIds, triagePiles,
  type SyncResponse as ClientSyncResponse,
} from "@ohmail/client-engine";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld, type LocalWorld } from "../src/identity.js";
import { createCloudMirror as makeCloudMirror } from "../src/cloud-mirror.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { idleSession } from "./fixtures/cloud-auth-double.js";
import { tearDown, tracked } from "./_teardown.js";

const mirrors: ReturnType<typeof makeCloudMirror>[] = [];
const createCloudMirror = tracked(makeCloudMirror, mirrors);

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A TRIAGE STATE KEEPS ITS HOSTED IDENTITY THROUGH THE CLOUD-DOOR MIRROR
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────────────────────
 *
 * `message_states` is the ONE table this mirror inserted WITHOUT the hosted row's id (its
 * conflict target is the unique `message_id`), so the local row was minted a fresh uuid while
 * `applyPage` recorded the local change-log row under the HOSTED id. The local `/sync` then
 * materializes by `message_states.id`, found nothing, and — by the delta contract — served the
 * change as a DELETE TOMBSTONE. So on a Cloud-door desktop NO triage state ever reached the
 * window: every `message_state` change was announced and then withdrawn in the same breath.
 *
 * What the reader saw is the whole of the report. `MessageDTO.triage` is a projection joined off
 * `message_states` BY MESSAGE ID, so it landed correctly — the row kept its "Back Tuesday 09:00"
 * chip. But `parkedMessageIds` and `triagePiles` read the `message_state` ENTITY, which was
 * absent, so nothing was held out of the Ohbox and nothing was listed under Resurface. Mail parked
 * until Tuesday sat in the Ohbox, unread, wearing the date it was waiting for; the Resurface pile
 * showed only a stale local overlay from a triage done on that machine. Web and desktop
 * disagreed on the same account, on the same selectors, because one of them was missing an entity.
 *
 * ── WHY THE SUITE DID NOT SEE IT ──────────────────────────────────────────────────────────
 *
 * `cloud-mirror.test.ts` drives `change("message_state", msgId, …)` — the wire id spelled as the
 * MESSAGE id — and asserts the local ROW landed. Production spells that id as the
 * `message_states` row's uuid (`SyncService.getSnapshot` emits `s.id`; `TriageService.setState`,
 * `MessageService.markSeen` and `bubbleUpPass` all record `entityId: row.id`), and the assertion
 * stopped at the row rather than following it out through the local feed. `sweepPhantoms` states
 * the same false premise in a comment — "`message_state`'s /sync id is its messageId" — so the
 * fixture and the code agreed with each other and not with the server.
 *
 * ── WHAT IS ASSERTED ──────────────────────────────────────────────────────────────────────
 *
 * The wire id here is a uuid DISTINCT from the message id, which is the production shape and the
 * one thing the old fixture could not express. Then: the identity is carried into the local row;
 * the local feed answers with the ENTITY rather than a tombstone; and the window's own store,
 * fed that feed and read through the shipped selectors, holds the not-yet-due message under
 * Resurface and in none of the three Ohbox groups.
 *
 * The last arm is the invariant rather than the case: NO change this mirror records may come back
 * from the local feed as a delete. A re-keyed entity of any type fails there without anybody
 * having to think of it.
 *
 * ── HOW TO WATCH IT FAIL ──────────────────────────────────────────────────────────────────
 *
 * In `cloud-mirror.ts`'s `applyUpsert`, `case "message_state"`, drop `id: s.id ?? ch.id` from the
 * insert values and from the conflict `set`. Every arm below goes red: the local row carries a
 * random id, the feed answers `message_state` as a delete, the pile is empty and the parked row
 * stands in the Ohbox. That mutation was run.
 */

const CLOUD_ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOSTED_MAILBOXES: readonly MailboxDTO[] = [hostedMailbox(CLOUD_MAILBOX, "me@ohmail.test")];

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [mirrors], close: opens, remove: dirs }));

async function standUp(): Promise<{
  opened: OpenLocalDb; world: LocalWorld; cursorPath: string; dataDir: string;
}> {
  const dataDir = await freshDataDir("ohmail-triage-identity-");
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: "me@ohmail.test", now: new Date() });
  return { opened, world, cursorPath: join(dataDir, "cloud-cursor.json"), dataDir };
}

const iso = (): string => new Date().toISOString();

function change(
  type: SyncChange["type"], id: string, op: SyncChange["op"], seq: number, entity?: unknown,
): SyncChange {
  return { type, op, id, seq, updatedAt: iso(), ...(entity !== undefined ? { entity } : {}) };
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

const EMPTY_SNAPSHOT: SnapshotResponse = {
  asOfSeq: 99, changes: [], nextCursor: null, window: { days: 90, minRows: 500 },
};

function messageDTO(id: string, threadId: string | null, over: Partial<MessageDTO> = {}): MessageDTO {
  return {
    id,
    accountId: CLOUD_ACCOUNT,
    mailboxId: CLOUD_MAILBOX,
    threadId,
    messageIdHeader: `<${id}@sender.test>`,
    subject: "The quarterly numbers",
    from: { name: "Dana", address: "dana@nowhere.test" },
    to: [{ name: null, address: "me@ohmail.test" }],
    cc: [],
    arrivedAt: "2026-09-01T08:00:00.000Z",
    date: "2026-09-01T08:00:00.000Z",
    folder: "INBOX",
    snippet: "as promised",
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
    subject: "The quarterly numbers",
    messageIds: [],
    participants: [{ name: "Dana", address: "dana@nowhere.test" }],
    lastMessageAt: "2026-09-01T08:00:00.000Z",
    unreadCount: 1,
    muted: false,
    folder: "INBOX",
    updatedAt: iso(),
  };
}

/** A fake Cloud API: `/mailboxes`, one `/sync` page, an empty snapshot, no bodies. */
function fakeAuth(pages: SyncResponse[]): CloudAuth {
  let s = 0;
  const empty = syncPage([], "end", false);
  const json = (v: unknown): Response =>
    new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  return {
    authedFetch: async (path: string) => {
      if (path.startsWith("/mailboxes")) return json(mailboxList(HOSTED_MAILBOXES));
      if (path.startsWith("/sync/snapshot")) return json(EMPTY_SNAPSHOT);
      // The bootstrap's rules-first ask, answered empty: this feed carries no rule change.
      if (path.startsWith("/sync")
        && new URLSearchParams(path.split("?")[1] ?? "").get("types") === "rule") {
        return json(syncPage([], "rules-end", false));
      }
      if (path.startsWith("/sync")) return json(pages[s++] ?? empty);
      if (path.startsWith("/messages/bodies")) return json({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  };
}

/**
 * A fake that answers by `since`, which the arm about a RESUMED bootstrap needs.
 *
 * {@link fakeAuth} serves its next page for any `/sync` ask, so a resume — which asks from the
 * COMMITTED cursor — was handed the whole feed again and re-applied the rows the sweep was about
 * to take. That made the fixture repair the damage it exists to measure: the keying check could be
 * deleted and every arm stayed green. Here a bootstrap ask (`since` empty or `"0"`) gets the feed
 * and any other ask gets an empty page, which is what the real feed does with a cursor at the
 * horizon.
 */
function fakeAuthBySince(feed: SyncResponse, resumeCursor: string): CloudAuth {
  const json = (v: unknown): Response =>
    new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  return {
    authedFetch: async (path: string) => {
      if (path.startsWith("/mailboxes")) return json(mailboxList(HOSTED_MAILBOXES));
      if (path.startsWith("/sync/snapshot")) return json(EMPTY_SNAPSHOT);
      if (path.startsWith("/sync")) {
        const q = new URLSearchParams(path.split("?")[1] ?? "");
        if (q.get("types") === "rule") return json(syncPage([], "rules-end", false));
        const since = q.get("since") ?? "";
        const bootstrapping = since === "" || since === "0";
        return json(bootstrapping ? feed : syncPage([], resumeCursor, false));
      }
      if (path.startsWith("/messages/bodies")) return json({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  };
}

const ctxFor = (opened: OpenLocalDb, world: LocalWorld): ServiceContext => ({
  db: dbFor(opened.db, world.accountId), accountId: world.accountId, userId: world.userId, sessionId: null,
  now: () => new Date(), requestId: "", ip: "", userAgent: undefined, origin: undefined,
});

/** Tomorrow, so `bubbleUpPass` cannot flip it and the row must WAIT under Resurface. */
const NOT_YET_DUE = new Date(Date.now() + 24 * 3600_000).toISOString();

/**
 * One message parked until tomorrow, mirrored from the hosted feed, then read back through the
 * LOCAL feed the window polls. Shared so the mechanism (the identity) and the consequence (the
 * piles) can red independently — a single `it` would stop at the first assertion and the
 * consequence would never be measured.
 */
async function landOneParkedMessage(): Promise<{
  db: OpenLocalDb["db"]; msgId: string; stateId: string;
  row: typeof messageStates.$inferSelect | undefined;
  local: Awaited<ReturnType<typeof syncService.getChanges>>;
}> {
  const { opened, world, cursorPath } = await standUp();
  const db = opened.db;
  const threadId = randomUUID();
  const msgId = randomUUID();
  // THE PRODUCTION SHAPE: the change's id is the `message_states` ROW's uuid, never the
  // message's. The old fixture spelled these the same and could not see the defect.
  const stateId = randomUUID();

  const state: MessageStateDTO = {
    messageId: msgId, state: "bubbled_up", bubbleUpAt: NOT_YET_DUE, setAt: iso(), updatedAt: iso(),
  };
  const page = syncPage([
    change("thread", threadId, "create", 1, threadDTO(threadId)),
    change("message", msgId, "create", 2, messageDTO(msgId, threadId, { triage: state })),
    change("message_state", stateId, "update", 3, state),
  ], "c3", false);

  await createCloudMirror({
    db, world, auth: fakeAuth([page]), cursorPath, now: () => new Date(),
  }).pullOnce();

  const [row] = await db.select().from(messageStates).where(eq(messageStates.messageId, msgId));
  const local = await syncService.getChanges(ctxFor(opened, world), { since: "0" });
  return { db, msgId, stateId, row, local };
}

describe("the Cloud-door mirror carries a triage state's hosted identity", () => {
  it("lands the state under its hosted id and serves it as an ENTITY, not a tombstone", async () => {
    const { msgId, stateId, row, local } = await landOneParkedMessage();
    expect(stateId).not.toBe(msgId);

    // THE IDENTITY IS CARRIED. Without this the local row holds a random uuid and the local
    // change log names a row that does not exist.
    expect(row, "the triage state was not mirrored at all").toBeDefined();
    expect(row!.state).toBe("bubbled_up");
    expect(row!.id, "the local row did not keep the hosted row's id").toBe(stateId);

    expect(
      local.changes.deletes.filter((c) => c.type === "message_state").map((c) => c.id),
      "the mirror announced the triage state and the local feed withdrew it as a delete",
    ).toEqual([]);
    const served = [...local.changes.creates, ...local.changes.updates]
      .find((c) => c.type === "message_state");
    expect(served, "no triage state reached the window through the local feed").toBeDefined();
    const servedState = served!.entity as MessageStateDTO;
    expect(servedState.messageId).toBe(msgId);
    expect(servedState.state).toBe("bubbled_up");
    expect(servedState.bubbleUpAt).toBe(NOT_YET_DUE);
  });

  it("keeps a message parked until tomorrow OUT of the Ohbox and under Resurface", async () => {
    const { msgId, local } = await landOneParkedMessage();

    // The window's own store, fed the local feed verbatim, read through the shipped selectors:
    // the desktop's byte shape end to end, with no DTO restated by hand.
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyResponse(local as unknown as ClientSyncResponse);

    // THE REPORTED SYMPTOM FIRST. The row wears its "back tomorrow" chip either way —
    // `MessageDTO.triage` is joined by message id and lands correctly — so the Ohbox is where the
    // false state is visible.
    const ohbox = ohboxView(store);
    const inOhbox = [...ohbox.resurfaced, ...ohbox.newForYou, ...ohbox.previouslySeen]
      .map((m) => m.id);
    expect(inOhbox, "a message parked until tomorrow was standing in the Ohbox").not.toContain(msgId);

    const pile = triagePiles(store).resurface;
    expect(pile.map((e) => e.messageId), "the Resurface pile did not list the parked message")
      .toEqual([msgId]);
    expect(pile[0]!.resurfaceAt).toBe(NOT_YET_DUE);
    expect(parkedMessageIds(store).has(msgId)).toBe(true);
  });

  /**
   * THE TWO COPIES OF THE TRIAGE FACT AGREE — the census, over a drained mirror.
   *
   * `triage` travels twice: inline on the `message` entity, and as its own `message_state`
   * entity. The consumers read DIFFERENT copies — the "Back {when}" chip reads the inline one
   * (`OhboxView.tsx`), while the Ohbox hold-out and the piles read the entity
   * (`parkedMessageIds` → `winningStates` → `pileOfState`) — so the difference between the two
   * counts IS the set that shows a chip and is not held out of the Ohbox. That is the reported
   * symptom expressed as arithmetic, and it is 1 before this fix and 0 after it.
   *
   * Counted over the window's store rather than over the local tables, because the store is what
   * the two consumers read. The split is produced by the real mechanism (the local feed's
   * tombstone), not seeded by hand — a hand-seeded split would measure the census and not the
   * drain.
   */
  it("counts the same number of parked messages in both copies of the triage fact", async () => {
    const { msgId, local } = await landOneParkedMessage();

    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyResponse(local as unknown as ClientSyncResponse);

    const byEntity = store.list<MessageStateDTO>("message_state")
      .filter((s) => s.state === "bubbled_up").map((s) => s.messageId);
    const byInline = store.list<MessageDTO>("message")
      .filter((m) => m.triage?.state === "bubbled_up").map((m) => m.id);

    expect(byInline, "the inline copy lost the parked message").toEqual([msgId]);
    expect(
      byInline.filter((id) => !byEntity.includes(id)),
      "messages whose chip says they are parked and whose state nothing can hold out",
    ).toEqual([]);
    expect(byEntity.filter((id) => !byInline.includes(id)), "a state with no message to name it")
      .toEqual([]);
  });

  /**
   * AN INSTALL UPGRADED FROM A BUILD THAT MINTED ITS OWN ID HEALS IN PLACE — no migration.
   *
   * This is the path every existing Cloud-door install takes, so it is the arm the fix rests on.
   * The row is seeded here exactly as the previous build wrote it: correct message, correct
   * state, a LOCAL random id. The conflict target is the unique `message_id`, so the page that
   * carries the state again updates that row and puts the hosted id on it, rather than inserting
   * a second row or failing the unique.
   *
   * The re-drain that carries it is not left to chance either: `CURSOR_VERSION` was bumped with
   * this fix, so an upgraded install re-bootstraps once from `since=0` and every state on disk
   * passes through this arm. Without the bump a state nobody touches again emits no delta and
   * would never be repaired — the population `CURSOR_VERSION`'s own docblock exists for.
   */
  it("heals a row an older build minted its own id for, without a second row", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const msgId = randomUUID();
    const hostedStateId = randomUUID();

    const state: MessageStateDTO = {
      messageId: msgId, state: "bubbled_up", bubbleUpAt: NOT_YET_DUE, setAt: iso(), updatedAt: iso(),
    };
    const page = syncPage([
      change("thread", threadId, "create", 1, threadDTO(threadId)),
      change("message", msgId, "create", 2, messageDTO(msgId, threadId, { triage: state })),
    ], "c2", false);

    // The message first, so the seeded row can satisfy the FK the previous build satisfied.
    await createCloudMirror({
      db, world, auth: fakeAuth([page]), cursorPath, now: () => new Date(),
    }).pullOnce();

    // The previous build's row: right in every field but its id.
    const localMintedId = randomUUID();
    await db.insert(messageStates).values({
      id: localMintedId,
      accountId: world.accountId,
      messageId: msgId,
      state: "bubbled_up",
      bubbleUpAt: new Date(NOT_YET_DUE),
      setAt: new Date(),
      updatedAt: new Date(),
    });

    // The re-bootstrap carries the state under its hosted id.
    const repage = syncPage([
      change("thread", threadId, "create", 1, threadDTO(threadId)),
      change("message", msgId, "create", 2, messageDTO(msgId, threadId, { triage: state })),
      change("message_state", hostedStateId, "update", 3, state),
    ], "c3", false);
    await createCloudMirror({
      db, world, auth: fakeAuth([repage]), cursorPath, now: () => new Date(),
    }).pullOnce();

    const rows = await db.select().from(messageStates).where(eq(messageStates.messageId, msgId));
    expect(rows, "the heal inserted a second row instead of updating the one on disk").toHaveLength(1);
    expect(rows[0]!.id, "the locally minted id survived the heal").toBe(hostedStateId);
    expect(rows[0]!.id).not.toBe(localMintedId);

    const local = await syncService.getChanges(ctxFor(opened, world), { since: "0" });
    const served = [...local.changes.creates, ...local.changes.updates]
      .find((c) => c.type === "message_state");
    expect(served, "the healed row still does not reach the window").toBeDefined();
    expect((served!.entity as MessageStateDTO).bubbleUpAt).toBe(NOT_YET_DUE);
  });

  /**
   * A BOOTSTRAP INTERRUPTED UNDER THE OLD KEYING STILL RESUMES — the SWEEP is what stands down.
   *
   * A generation mark is an entity's id, so this fix — which moved `message_state` from the
   * messageId to the row id — makes every mark an earlier build wrote unreadable. The sweep reads
   * an unreadable mark as "the feed never sent this row" and DELETES it, so an install that
   * happened to be mid-replay at the upgrade would have had every triage state it had already
   * applied swept: the defect this release fixes, reintroduced for exactly that population, and
   * silently.
   *
   * Seeded here as it appears on disk: a version-1 cursor still `bootstrapping`, and a generation
   * file in the old format whose `message_state` mark is the MESSAGE id.
   *
   * The first cut of this fix refused the WHOLE file, which discarded the resume — and main's own
   * two arms said so: "an interrupted RE-KEY resumes too" went red with the cursor back at 0
   * instead of seg1, and "a 410 to the window's persisted cursor re-reads the window from page 1
   * inside the same generation" lost its persisted cursor. Both are right: a restart on every
   * interruption never finishes on a large mailbox. The marks are per TYPE, so the generation
   * loads and the sweep skips only the type whose keying moved.
   */
  it("does not sweep a triage state against marks from the previous keying", async () => {
    const { opened, world, cursorPath, dataDir } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const msgId = randomUUID();
    const stateId = randomUUID();

    const state: MessageStateDTO = {
      messageId: msgId, state: "bubbled_up", bubbleUpAt: NOT_YET_DUE, setAt: iso(), updatedAt: iso(),
    };
    const feed = (): SyncResponse => syncPage([
      change("thread", threadId, "create", 1, threadDTO(threadId)),
      change("message", msgId, "create", 2, messageDTO(msgId, threadId, { triage: state })),
      change("message_state", stateId, "update", 3, state),
    ], "c3", false);

    await createCloudMirror({
      db, world, auth: fakeAuth([feed()]), cursorPath, now: () => new Date(),
    }).pullOnce();
    expect(await db.select().from(messageStates).where(eq(messageStates.messageId, msgId)))
      .toHaveLength(1);

    // The upgrade, mid-replay: a version-1 cursor that is still bootstrapping, beside a
    // generation file in the old format — `message_state` marked by the MESSAGE id. The resume
    // must still happen; what must not is a sweep of that type against ids these marks cannot
    // name.
    writeFileSync(cursorPath, JSON.stringify({
      version: 1, sync: "c3", bodies: "complete", bootstrapping: true, window: { phase: "complete" },
    }));
    writeFileSync(
      join(dataDir, "cloud-bootstrap-gen.marks"),
      `thread ${threadId}\nmessage ${msgId}\nmessage_state ${msgId}\n`,
    );

    // `since`-aware from here: a RESUME asks from `c3` and must be answered with nothing, or the
    // re-delivered page re-applies the very rows the sweep is about to take.
    await createCloudMirror({
      db, world, auth: fakeAuthBySince(feed(), "c3"), cursorPath, now: () => new Date(),
    }).pullOnce();

    const rows = await db.select().from(messageStates).where(eq(messageStates.messageId, msgId));
    expect(rows, "the sweep ran against marks from another keying and took the triage state").toHaveLength(1);
    expect(rows[0]!.id).toBe(stateId);

    const local = await syncService.getChanges(ctxFor(opened, world), { since: "0" });
    const served = [...local.changes.creates, ...local.changes.updates]
      .find((c) => c.type === "message_state");
    expect(served, "the state does not reach the window after the upgrade drain").toBeDefined();
  });

  it("does not announce any change the local feed answers as a delete (the invariant)", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const msgA = randomUUID();
    const msgB = randomUUID();
    const stateA = randomUUID();
    const stateB = randomUUID();

    const page = syncPage([
      change("thread", threadId, "create", 1, threadDTO(threadId)),
      change("message", msgA, "create", 2, messageDTO(msgA, threadId)),
      change("message", msgB, "create", 3, messageDTO(msgB, threadId)),
      change("message_state", stateA, "update", 4, {
        messageId: msgA, state: "bubbled_up", bubbleUpAt: NOT_YET_DUE, setAt: iso(), updatedAt: iso(),
      } satisfies MessageStateDTO),
      change("message_state", stateB, "update", 5, {
        messageId: msgB, state: "reply_later", bubbleUpAt: null, setAt: iso(), updatedAt: iso(),
      } satisfies MessageStateDTO),
    ], "c5", false);

    await createCloudMirror({
      db, world, auth: fakeAuth([page]), cursorPath, now: () => new Date(),
    }).pullOnce();

    // Every non-delete row the mirror wrote must materialize. A re-keyed entity of ANY type is a
    // delete here, which is what makes this an invariant rather than a second copy of arm 1.
    const announced = (await db.select().from(changeLog)
      .where(eq(changeLog.accountId, world.accountId)))
      .filter((c) => c.op !== "delete")
      .map((c) => `${c.entityType}:${c.entityId}`);
    expect(announced.length).toBeGreaterThan(0);

    const local = await syncService.getChanges(ctxFor(opened, world), { since: "0" });
    const withdrawn = local.changes.deletes.map((c) => `${c.type}:${c.id}`)
      .filter((k) => announced.includes(k));
    expect(withdrawn, "the mirror announced entities the local feed cannot materialize").toEqual([]);
  });

  it("a hosted DELETE of the state removes the local row, keyed the same way", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const threadId = randomUUID();
    const msgId = randomUUID();
    const stateId = randomUUID();

    const first = syncPage([
      change("thread", threadId, "create", 1, threadDTO(threadId)),
      change("message", msgId, "create", 2, messageDTO(msgId, threadId)),
      change("message_state", stateId, "update", 3, {
        messageId: msgId, state: "set_aside", bubbleUpAt: null, setAt: iso(), updatedAt: iso(),
      } satisfies MessageStateDTO),
    ], "c3", false);

    await createCloudMirror({
      db, world, auth: fakeAuth([first]), cursorPath, now: () => new Date(),
    }).pullOnce();
    expect(await db.select().from(messageStates).where(eq(messageStates.messageId, msgId)))
      .toHaveLength(1);

    // The hosted feed spells a state deletion with the ROW's id, exactly as it spelled the update.
    const second = syncPage([change("message_state", stateId, "delete", 4)], "c4", false);
    await createCloudMirror({
      db, world, auth: fakeAuth([second]), cursorPath, now: () => new Date(),
    }).pullOnce();
    expect(
      await db.select().from(messageStates).where(eq(messageStates.messageId, msgId)),
      "the delete arm keys on a different column from the upsert arm",
    ).toHaveLength(0);
  });
});
