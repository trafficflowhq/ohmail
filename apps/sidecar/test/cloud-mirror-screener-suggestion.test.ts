import type {
  MailboxDTO,
  MessageDTO,
  ScreenerSuggestionDTO,
  SnapshotResponse,
  SyncChange,
  SyncResponse,
} from "@ohmail/wire";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { routingDecisions } from "@trafficflow/db/mail";
import { SCREENER_SUGGESTION_PROVENANCE } from "@trafficflow/db";
import { dbFor, syncService } from "@trafficflow/services/mail";
import type {
  ServiceContext,
} from "@trafficflow/services/mail";
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
 * THE CLOUD-DOOR MIRROR CARRIES A BOUGHT SUGGESTION TO THE DESKTOP WINDOW. The hosted purchase
 * rides `/sync` as the narrow entity; this mirror lands it as a provenance-scoped
 * `routing_decisions` row (no rationale — the wire never carried one), re-emits it on the LOCAL
 * log, and the window's drain serves it back out of the LOCAL feed as the same entity, never a
 * tombstone. A suggestion about a message this mirror does not hold is SKIPPED — one unguarded
 * insert would abort the page and pin the cursor for ever. WATCHED RED FOR REAL: the first run
 * failed with the arm written and the row absent, because `APPLY_ORDER` is a THIRD list beside
 * `CLOUD_SYNC_TYPES` and the `applyUpsert` switch — a type missing from it is silently never
 * applied. A fourth such list fails here the same way.
 */

const CLOUD_ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOSTED_MAILBOXES: readonly MailboxDTO[] = [hostedMailbox(CLOUD_MAILBOX, "me@ohmail.test")];

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [mirrors], close: opens, remove: dirs }));

async function standUp(): Promise<{ opened: OpenLocalDb; world: LocalWorld; cursorPath: string }> {
  const dataDir = await freshDataDir("ohmail-suggestion-mirror-");
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: "me@ohmail.test", now: new Date() });
  return { opened, world, cursorPath: join(dataDir, "cloud-cursor.json") };
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
    cursor, hasMore, serverTime: iso(),
  };
}

const EMPTY_SNAPSHOT: SnapshotResponse = {
  asOfSeq: 99, changes: [], nextCursor: null, window: { days: 90, minRows: 500 },
};

function messageDTO(id: string, from: string): MessageDTO {
  return {
    id, accountId: CLOUD_ACCOUNT, mailboxId: CLOUD_MAILBOX, threadId: null,
    messageIdHeader: `<${id}@sender.test>`, subject: "hello there",
    from: { name: "Dana", address: from }, to: [{ name: null, address: "me@ohmail.test" }], cc: [],
    arrivedAt: "2026-09-01T08:00:00.000Z", date: "2026-09-01T08:00:00.000Z",
    folder: "ohmail/Screener", snippet: "as promised", unread: true, lastReadAt: null,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: iso(),
  };
}

function suggestionDTO(id: string, messageId: string, from: string): ScreenerSuggestionDTO {
  return {
    id, messageId, senderKey: from.toLowerCase(),
    decision: "yes", destination: "INBOX", spam: false, confidence: 0.8,
    boughtAt: "2026-09-18T09:00:00.000Z", updatedAt: iso(),
    actRefusedAt: null, actRefusal: null,
  };
}

function fakeAuth(pages: SyncResponse[]): CloudAuth {
  let s = 0;
  const empty = syncPage([], "end", false);
  const json = (v: unknown): Response =>
    new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  return {
    authedFetch: async (path: string) => {
      if (path.startsWith("/mailboxes")) return json(mailboxList(HOSTED_MAILBOXES));
      if (path.startsWith("/sync/snapshot")) return json(EMPTY_SNAPSHOT);
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

const ctxFor = (opened: OpenLocalDb, world: LocalWorld): ServiceContext => ({
  db: dbFor(opened.db, world.accountId), accountId: world.accountId, userId: world.userId, sessionId: null,
  now: () => new Date(), requestId: "", ip: "", userAgent: undefined, origin: undefined,
});

describe("the Cloud-door mirror carries a bought suggestion", () => {
  it("lands the row under its own provenance, no rationale, and re-serves the entity locally", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const msgId = randomUUID();
    const sgId = randomUUID();
    const page = syncPage([
      change("message", msgId, "create", 1, messageDTO(msgId, "Dana@Nowhere.test")),
      change("screener_suggestion", sgId, "create", 2, suggestionDTO(sgId, msgId, "Dana@Nowhere.test")),
    ], "c2", false);

    await createCloudMirror({
      db, world, auth: fakeAuth([page]), cursorPath, now: () => new Date(),
    }).pullOnce();

    const [row] = await db.select().from(routingDecisions).where(eq(routingDecisions.id, sgId));
    expect(row, "the wire's row id is the local row's id").toBeDefined();
    expect(row!.inputProvenance).toBe(SCREENER_SUGGESTION_PROVENANCE);
    expect(row!.rationale, "the wire carries no model text and the local row stores none").toBeNull();
    expect(row!.createdAt.toISOString(), "boughtAt survives the mirror").toBe("2026-09-18T09:00:00.000Z");

    const local = await syncService.getChanges(ctxFor(opened, world), { since: "0" });
    const served = [...local.changes.creates, ...local.changes.updates]
      .filter((c) => c.type === "screener_suggestion");
    const tombstoned = local.changes.deletes.filter((c) => c.type === "screener_suggestion");
    expect(tombstoned, "announced and withdrawn in the same breath — the re-key defect").toEqual([]);
    expect(served).toHaveLength(1);
    expect(served[0]!.entity).toMatchObject({
      id: sgId, messageId: msgId, senderKey: "dana@nowhere.test",
      decision: "yes", destination: "INBOX", spam: false, confidence: 0.8,
    });
    expect(Object.keys(served[0]!.entity as object), "the local feed's key census")
      .not.toContain("rationale");
  });

  it("skips a suggestion whose message this mirror does not hold — the cursor never wedges", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const sgId = randomUUID();
    const page = syncPage([
      change("screener_suggestion", sgId, "create", 1, suggestionDTO(sgId, randomUUID(), "x@y.test")),
    ], "c1", false);

    await createCloudMirror({
      db, world, auth: fakeAuth([page]), cursorPath, now: () => new Date(),
    }).pullOnce();

    const rows = await db.select().from(routingDecisions).where(and(
      eq(routingDecisions.accountId, world.accountId),
      eq(routingDecisions.inputProvenance, SCREENER_SUGGESTION_PROVENANCE),
    ));
    expect(rows).toEqual([]);
    const local = await syncService.getChanges(ctxFor(opened, world), { since: "0" });
    expect([...local.changes.creates, ...local.changes.deletes]
      .filter((c) => c.type === "screener_suggestion")).toEqual([]);
  });

  it("a delete change takes the local row with it", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const msgId = randomUUID();
    const sgId = randomUUID();
    const page1 = syncPage([
      change("message", msgId, "create", 1, messageDTO(msgId, "x@y.test")),
      change("screener_suggestion", sgId, "create", 2, suggestionDTO(sgId, msgId, "x@y.test")),
    ], "c2", true);
    const page2 = syncPage([
      change("screener_suggestion", sgId, "delete", 3),
    ], "c3", false);

    const mirror = createCloudMirror({
      db, world, auth: fakeAuth([page1, page2]), cursorPath, now: () => new Date(),
    });
    await mirror.pullOnce();
    await mirror.pullOnce();

    const rows = await db.select().from(routingDecisions).where(eq(routingDecisions.id, sgId));
    expect(rows).toEqual([]);
  });
});
