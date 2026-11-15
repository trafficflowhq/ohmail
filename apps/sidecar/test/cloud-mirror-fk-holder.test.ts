import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  approvals, messages, messageSearch, routingDecisions, tags, unsubscribeExamined, unsubscribeRecords,
} from "@trafficflow/db/mail";
import type {
  ApprovalDTO, MailboxDTO, MessageDTO, RoutingDecisionDTO, SnapshotResponse, SyncChange,
  SyncResponse, TagDTO,
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
 * FK HOLDERS LAND BEFORE THEIR REFERRERS, AND A ROW THAT STILL REFUSES IS QUARANTINED.
 * Mail 0118 gave `approvals.routing_decision_id`, `approvals.message_id` and
 * `routing_decisions.matched_rule_id` composite foreign keys the mirror's apply never knew:
 * `approval` sat BEFORE `routing_decision` in APPLY_ORDER and wrote both pointers unguarded, so
 * on the released 0.20.0 a fresh paired desktop's first pull aborted its page on
 * `approvals_routing_decision_id_account_fk` (23503) for ever while the app looked settled —
 * seen in the field, 2026-09-19. The first describe pins order and guards; the second
 * the belt: an integrity refusal quarantines the ROW, with the constraint named and the cursor advanced.
 */

const CLOUD_ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOSTED_MAILBOXES: readonly MailboxDTO[] = [hostedMailbox(CLOUD_MAILBOX, "me@ohmail.test")];

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [mirrors], close: opens, remove: dirs }));

async function standUp(): Promise<{ opened: OpenLocalDb; world: LocalWorld; cursorPath: string }> {
  const dataDir = await freshDataDir("ohmail-fk-holder-");
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

function messageDTO(id: string): MessageDTO {
  return {
    id, accountId: CLOUD_ACCOUNT, mailboxId: CLOUD_MAILBOX, threadId: null,
    messageIdHeader: `<${id}@sender.test>`, subject: "hello there",
    from: { name: "Dana", address: "dana@nowhere.test" },
    to: [{ name: null, address: "me@ohmail.test" }], cc: [],
    arrivedAt: "2026-09-01T08:00:00.000Z", date: "2026-09-01T08:00:00.000Z",
    folder: "INBOX", snippet: "as promised", unread: true, lastReadAt: null,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: iso(),
  };
}

function decisionDTO(id: string, messageId: string, matchedRuleId: string | null): RoutingDecisionDTO {
  return {
    id, accountId: CLOUD_ACCOUNT, messageId, inputProvenance: "ai", matchedRuleId,
    destination: "INBOX", confidence: 0.9, rationale: null, spam: false,
    status: "pending_approval", createdAt: iso(), updatedAt: iso(),
  };
}

function approvalDTO(id: string, messageId: string | null, routingDecisionId: string | null): ApprovalDTO {
  return {
    id, kind: "routing", messageId,
    proposed: { action: "file", summary: "file under INBOX", payload: null },
    routingDecisionId, confidence: 0.9, expiresAt: iso(), status: "pending",
    createdAt: iso(), updatedAt: iso(),
  };
}

function tagDTO(id: string): TagDTO {
  return { id, name: "receipts", hue: "moss", createdAt: iso(), updatedAt: iso() };
}

/** The screener-suggestion test's stub, plus an optional hook run before each `/sync` answer. */
function fakeAuth(pages: SyncResponse[], beforeSync?: (page: number) => Promise<void>): CloudAuth {
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
      if (path.startsWith("/sync")) {
        await beforeSync?.(s);
        return json(pages[s++] ?? empty);
      }
      if (path.startsWith("/messages/bodies")) return json({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  };
}

type LoggedLine = { event: string; fields: Record<string, unknown> };
const capture = (lines: LoggedLine[]) =>
  (event: string, fields?: Record<string, unknown>): void => {
    lines.push({ event, fields: fields ?? {} });
  };

describe("FK holders land before their referrers", () => {
  it("an approval and its routing decision in ONE page apply whole — the reproduced 0.20.0 wedge", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const msgId = randomUUID();
    const rdId = randomUUID();
    const apId = randomUUID();
    /* The approval's change PRECEDES its decision's, which the wire is free to do — the released
       build applied it first by APPLY_ORDER alone and 23503-aborted the whole page. */
    const page = syncPage([
      change("message", msgId, "create", 1, messageDTO(msgId)),
      change("approval", apId, "create", 2, approvalDTO(apId, msgId, rdId)),
      change("routing_decision", rdId, "create", 3, decisionDTO(rdId, msgId, null)),
    ], "c3", false);
    const lines: LoggedLine[] = [];

    const mirror = createCloudMirror({
      db, world, auth: fakeAuth([page]), cursorPath, now: () => new Date(), log: capture(lines),
    });
    await mirror.pullOnce();

    const [ap] = await db.select().from(approvals).where(eq(approvals.id, apId));
    expect(ap, "the approval landed").toBeDefined();
    expect(ap!.routingDecisionId, "with its decision pointer intact").toBe(rdId);
    expect(ap!.messageId).toBe(msgId);
    const [rd] = await db.select().from(routingDecisions).where(eq(routingDecisions.id, rdId));
    expect(rd).toBeDefined();
    expect(mirror.quarantined(), "nothing was refused").toEqual({ count: 0, retrying: 0, exact: true, constraint: null });
    expect(lines.filter((l) => l.event === "cloud_page_integrity_refused")).toEqual([]);
  });

  it("an approval whose decision is in a LATER page lands degraded and heals when the holder arrives", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const msgId = randomUUID();
    const rdId = randomUUID();
    const apId = randomUUID();
    const page1 = syncPage([
      change("message", msgId, "create", 1, messageDTO(msgId)),
      change("approval", apId, "create", 2, approvalDTO(apId, msgId, rdId)),
    ], "c2", true);
    const page2 = syncPage([
      change("routing_decision", rdId, "create", 3, decisionDTO(rdId, msgId, null)),
      // The wire re-emits the approval when its entity changes; the replayed copy is what heals
      // the degraded pointer, exactly as a reply draft's parent does.
      change("approval", apId, "update", 4, approvalDTO(apId, msgId, rdId)),
    ], "c4", false);

    const lines: LoggedLine[] = [];
    const mirror = createCloudMirror({
      db, world, auth: fakeAuth([page1, page2]), cursorPath, now: () => new Date(), log: capture(lines),
    });
    await mirror.pullOnce();

    const [ap] = await db.select().from(approvals).where(eq(approvals.id, apId));
    expect(ap, "the degraded approval still landed — user-visible state is never dropped").toBeDefined();
    expect(ap!.routingDecisionId, "healed once the holder arrived").toBe(rdId);
    expect(mirror.quarantined()).toEqual({ count: 0, retrying: 0, exact: true, constraint: null });
    /* THE GUARD, NOT THE BELT. Without this line the quarantine heals a removed guard to the same
       end state and the case stays green — measured (mutation): the guard's own evidence is
       that no page ever ABORTED, which the belt cannot fake. */
    expect(lines.filter((l) => l.event === "cloud_page_integrity_refused"),
      "a guarded pointer must degrade quietly, never abort its page into the quarantine").toEqual([]);
  });

  it("a routing decision naming a rule this mirror lacks lands without the attribution", async () => {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const msgId = randomUUID();
    const rdId = randomUUID();
    const page = syncPage([
      change("message", msgId, "create", 1, messageDTO(msgId)),
      // `matched_rule_id` carries a composite FK since mail 0118; the rule fell below the
      // retention horizon and is never coming. The decision must land anyway.
      change("routing_decision", rdId, "create", 2, decisionDTO(rdId, msgId, randomUUID())),
    ], "c2", false);

    const mirror = createCloudMirror({
      db, world, auth: fakeAuth([page]), cursorPath, now: () => new Date(),
    });
    await mirror.pullOnce();

    const [rd] = await db.select().from(routingDecisions).where(eq(routingDecisions.id, rdId));
    expect(rd, "the decision landed").toBeDefined();
    expect(rd!.matchedRuleId, "without the pointer it cannot hold").toBeNull();
    expect(mirror.quarantined()).toEqual({ count: 0, retrying: 0, exact: true, constraint: null });
  });
});

describe("a row that still fails an integrity constraint is quarantined, named, and retried", () => {
  /**
   * The fixture is the NEXT mail 0118: a constraint the apply has never heard of, added straight
   * to the local store (a CHECK, so class 23 like the FK it stands in for). That is the exact
   * population the quarantine exists for — a schema gains a rule and the apply's guards lag it —
   * and it cannot be answered by teaching the apply this constraint, which is what every case
   * above does for the ones we know.
   */
  const PROBE = "tags_quarantine_probe";
  async function wedgeOnce(): Promise<{
    opened: OpenLocalDb; world: LocalWorld; cursorPath: string;
    msgId: string; tagId: string; lines: LoggedLine[];
    mirror: ReturnType<typeof createCloudMirror>;
  }> {
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    await db.execute(sql.raw(
      `ALTER TABLE tags ADD CONSTRAINT ${PROBE} CHECK (name <> 'quarantine-me')`,
    ));
    const msgId = randomUUID();
    const tagId = randomUUID();
    const page = syncPage([
      change("message", msgId, "create", 1, messageDTO(msgId)),
      change("tag", tagId, "create", 2, { ...tagDTO(tagId), name: "quarantine-me" }),
    ], "c2", false);
    const lines: LoggedLine[] = [];
    const mirror = createCloudMirror({
      db, world, auth: fakeAuth([page]), cursorPath, now: () => new Date(), log: capture(lines),
    });
    await mirror.pullOnce();
    return { opened, world, cursorPath, msgId, tagId, lines, mirror };
  }
  const dropProbe = async (db: OpenLocalDb["db"]): Promise<void> => {
    await db.execute(sql.raw(`ALTER TABLE tags DROP CONSTRAINT ${PROBE}`));
  };

  it("the failing row is held with its constraint named, the page's other rows land, the cursor advances", async () => {
    const { opened, cursorPath, msgId, tagId, lines, mirror } = await wedgeOnce();
    const db = opened.db;

    // The pull RESOLVED — the released behaviour was a throw here and a cursor pinned for ever.
    expect(await db.select().from(messages).where(eq(messages.id, msgId)),
      "the page's other rows landed").toHaveLength(1);
    expect(await db.select().from(tags).where(eq(tags.id, tagId))).toEqual([]);
    expect(mirror.quarantined()).toEqual({ count: 1, retrying: 1, exact: true, constraint: PROBE });

    const cursorFile = JSON.parse(readFileSync(cursorPath, "utf8")) as { sync: string; quarantine?: unknown[] };
    expect(cursorFile.sync, "the cursor advanced past the poisoned page").toBe("c2");
    expect(cursorFile.quarantine, "the held row survives a relaunch on disk").toHaveLength(1);

    const refused = lines.find((l) => l.event === "cloud_page_integrity_refused");
    expect(refused, "the page-level refusal is logged").toBeDefined();
    expect(refused!.fields.constraint).toBe(PROBE);
    const held = lines.find((l) => l.event === "cloud_row_quarantined");
    expect(held, "the row-level hold is logged").toBeDefined();
    expect(held!.fields.constraint, "with the constraint NAMED — the released build logged a bare 23503")
      .toBe(PROBE);
    expect(held!.fields.table).toBe("tags");
    expect(held!.fields.kind).toBe("tag");
  });

  it("the next pull re-applies the held row once the refusal is gone — the retry door", async () => {
    const { opened, cursorPath, tagId, lines, mirror } = await wedgeOnce();
    const db = opened.db;

    // The obstacle clears (here: the probe constraint; in production: the holder arrives), and
    // the post-pull retry applies the held row. This is also what the pane's "Sync now" runs.
    await dropProbe(db);
    await mirror.pullOnce();

    expect(await db.select().from(tags).where(eq(tags.id, tagId))).toHaveLength(1);
    expect(mirror.quarantined()).toEqual({ count: 0, retrying: 0, exact: true, constraint: null });
    // The LAST retry line is the verdict — the wedging pull's own retry ran first and honestly
    // reported `applied: 0, failed: 1` while the probe still stood.
    const retries = lines.filter((l) => l.event === "cloud_quarantine_retry");
    expect(retries.length, "each pull with held rows reports a retry").toBeGreaterThanOrEqual(2);
    expect(retries[0]!.fields, "the first retry, under the standing refusal, says so")
      .toMatchObject({ applied: 0, failed: 1 });
    expect(retries.at(-1)!.fields).toMatchObject({ applied: 1, failed: 0 });
    const cursorFile = JSON.parse(readFileSync(cursorPath, "utf8")) as { quarantine?: unknown[] };
    expect(cursorFile.quarantine, "an empty quarantine leaves no key behind").toBeUndefined();
  });

  it("the quarantine survives a RELAUNCH: a new mirror over the same cursor heals it", async () => {
    const { opened, world, cursorPath, tagId, mirror } = await wedgeOnce();
    const db = opened.db;
    await mirror.stop();

    const revived = createCloudMirror({
      db, world, auth: fakeAuth([]), cursorPath, now: () => new Date(),
    });
    expect(revived.quarantined(), "restored from the cursor file before any pull")
      .toEqual({ count: 1, retrying: 1, exact: true, constraint: PROBE });

    await dropProbe(db);
    await revived.pullOnce();
    expect(await db.select().from(tags).where(eq(tags.id, tagId))).toHaveLength(1);
    expect(revived.quarantined()).toEqual({ count: 0, retrying: 0, exact: true, constraint: null });
  });

  it("a message DELETE clears the examined-unsubscribe ledger with the message — the walk is complete", async () => {
    /* `unsubscribe_examined` carries TWO keys into the delete walk (`message_id`, and `record_id`
       into `unsubscribe_records`) and was in neither — a seeded row made the message's own
       tombstone the header's 23503. Standalone-era table, so it is seeded here the way a
       standalone-era database would hold it. */
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const msgId = randomUUID();
    // `hasMore: false`, so the FIRST pull stops after the create and the ledger can be seeded
    // between the pulls — a drain that answers `true` here consumes page 2 in the same pull.
    const page1 = syncPage([change("message", msgId, "create", 1, messageDTO(msgId))], "c1", false);
    const page2 = syncPage([change("message", msgId, "delete", 2)], "c2", false);
    const lines: LoggedLine[] = [];
    const mirror = createCloudMirror({
      db, world, auth: fakeAuth([page1, page2]), cursorPath, now: () => new Date(), log: capture(lines),
    });
    await mirror.pullOnce();
    const recId = randomUUID();
    await db.insert(unsubscribeRecords).values({
      id: recId, accountId: world.accountId, mailboxId: CLOUD_MAILBOX, messageId: msgId,
      listKey: "list@nowhere.test", state: "sent",
    });
    await db.insert(unsubscribeExamined).values({
      messageId: msgId, recordId: recId, accountId: world.accountId,
    });

    await mirror.pullOnce();

    expect(await db.select().from(messages).where(eq(messages.id, msgId)),
      "the tombstone took the message despite the seeded ledger row").toEqual([]);
    expect(mirror.quarantined(), "and nothing had to be quarantined for it")
      .toEqual({ count: 0, retrying: 0, exact: true, constraint: null });
  });

  it("a message DELETE takes its search document with it", async () => {
    // Mail 0125's document hangs off the message by FK; the mirror writes it with the letter.
    const { opened, world, cursorPath } = await standUp();
    const db = opened.db;
    const msgId = randomUUID();
    const page1 = syncPage([change("message", msgId, "create", 1, messageDTO(msgId))], "c1", false);
    const page2 = syncPage([change("message", msgId, "delete", 2)], "c2", false);
    const lines: LoggedLine[] = [];
    const mirror = createCloudMirror({
      db, world, auth: fakeAuth([page1, page2]), cursorPath, now: () => new Date(), log: capture(lines),
    });
    await mirror.pullOnce();
    expect(await db.select().from(messageSearch).where(eq(messageSearch.messageId, msgId)),
      "the letter's document was written with it").toHaveLength(1);

    await mirror.pullOnce();

    expect(await db.select().from(messages).where(eq(messages.id, msgId)),
      "the tombstone took the message despite its search document").toEqual([]);
    expect(await db.select().from(messageSearch).where(eq(messageSearch.messageId, msgId)),
      "and the document went with it").toEqual([]);
    expect(mirror.quarantined(), "and nothing had to be quarantined for it")
      .toEqual({ count: 0, retrying: 0, exact: true, constraint: null });
  });
});
