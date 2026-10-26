import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  approvals, drafts, folderState, mailboxes, messageStates, messages, messageTags, recordChange,
  routingDecisions, rules, tags, threads,
} from "@trafficflow/db";
import {
  assertSnapshotWindow, SNAPSHOT_DRAFT_PAGE, SNAPSHOT_WINDOW, SyncService,
  type ServiceContext, type SnapshotResponse, type SyncChange,
} from "../src/index.js";
import { SNAPSHOT_CURSOR_MAX_CHARS, SNAPSHOT_CURSOR_VERSION } from "../src/sync-service.js";
import { ClientMirror } from "./_apply-harness.js";

/**
 * `GET /sync/snapshot`, THE BOOTSTRAP READER.
 *
 * The delta reader answers "what changed since N". This answers "what IS there", and the
 * difference is the whole point: replaying `change_log` from 0 sends a message's whole history
 * to arrive at one row, and on a real mailbox that was minutes of wall clock across dozens of
 * pages. The properties that make the replacement safe, and which this file asserts:
 *
 *  1. Every row is `op: "create"` at `seq = asOfSeq`, so the client's EXISTING apply path — and
 *     specifically its older-or-equal seq guard — is correct with no new code on that side. A
 *     later delta (seq > asOfSeq) wins; a re-applied page (seq == asOfSeq) is ignored.
 *  2. Page 1 carries the person-sized live state IN FULL — rules, tags. A paged rule set
 *     would show routing that does not match what the server does. DRAFTS ARE NOT THAT: a draft
 *     is a composed message, so they ride the pages newest-first and outlive the message walk
 *     when there are more of them than there is mail.
 *  2b. Everything keyed to a MESSAGE — threads, `message_state`, a pending `routing_decision`,
 *     an `approval` — rides with the page that carries the message, so no page can exceed its
 *     row limit on them and no client is handed child state for a message it was not sent.
 *  3. Every page of one snapshot reads at the SAME `asOfSeq`, carried in the opaque cursor.
 *  4. The window is SERVED, not agreed, so no client hardcodes 90 days.
 *  5. Account scoping is on every predicate — asserted with a second account holding a full set
 *     of rows of every type.
 *
 * The consistency claim under CONCURRENT COMMIT is not here: it is a row-lock property and PGlite
 * is a single connection, so a sequential test of it cannot fail. See
 * `sync-snapshot-seq.pg.test.ts`.
 */
const svc = new SyncService();

type Db = Awaited<ReturnType<typeof makeTestDb>>;

const NOW = new Date("2026-08-07T12:00:00.000Z");
const DAY = 86_400_000;

async function setup() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `a-${accountId}@x.example`,
  }).returning();
  const ctx: ServiceContext = {
    db, accountId, userId: null, now: () => NOW, requestId: "snap",
  };
  return { db, accountId, mailboxId: mb!.id, ctx };
}

/** In a transaction, because `allocateSeqRange` refuses an autocommit handle — see `rec` in
 *  `sync-service.test.ts` for why that refusal exists. */
const rec = (db: Db, accountId: string, entityType: string, entityId: string) =>
  db.transaction((tx) => recordChange(tx as never, {
    accountId, entityType: entityType as never, entityId, op: "create",
  }));

async function addMessage(
  db: Db, accountId: string, mailboxId: string, opts: { date?: Date; subject?: string } = {},
): Promise<string> {
  const [m] = await db.insert(messages).values({
    accountId, mailboxId, bodyHash: "h", dedupKey: randomUUID(),
    subject: opts.subject ?? "s", fromAddress: "f@x.example",
    ...(opts.date ? { date: opts.date } : {}),
  }).returning();
  await db.insert(folderState).values({
    messageId: m!.id, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
  });
  return m!.id;
}

const idsOf = (r: SnapshotResponse, type: string): string[] =>
  r.changes.filter((c) => c.type === type).map((c) => c.id);

/** Drain a whole snapshot, returning every page. */
async function drain(ctx: ServiceContext, limit: number): Promise<SnapshotResponse[]> {
  const pages: SnapshotResponse[] = [];
  let cursor: string | undefined;
  for (let guard = 0; ; guard += 1) {
    const page: SnapshotResponse = await svc.getSnapshot(ctx, {
      limit, ...(cursor ? { cursor } : {}),
    });
    pages.push(page);
    if (page.nextCursor === null) return pages;
    cursor = page.nextCursor;
    if (guard > 200) throw new Error("snapshot drain did not terminate");
  }
}

describe("page 1 carries the live state plus the newest messages", () => {
  it("emits every rule, message_state, PENDING routing_decision, approval and draft", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();

    const m1 = await addMessage(db, accountId, mailboxId, { date: new Date(NOW.getTime() - DAY) });
    const m2 = await addMessage(db, accountId, mailboxId, { date: new Date(NOW.getTime() - 2 * DAY) });

    const [rule] = await db.insert(rules).values({
      accountId, kind: "sender", match: "anna@x.example", destination: "INBOX",
    }).returning();
    const [state] = await db.insert(messageStates).values({
      accountId, messageId: m1, state: "reply_later",
    }).returning();
    const [pending] = await db.insert(routingDecisions).values({
      accountId, messageId: m1, inputProvenance: "ai", destination: "ohmail/News",
      status: "pending_approval",
    }).returning();
    // A DECIDED decision. History, not live state: an ingesting account holds one row per
    // message, so shipping them all would make page 1 unbounded.
    const [decided] = await db.insert(routingDecisions).values({
      accountId, messageId: m2, inputProvenance: "rule", destination: "ohmail/Feed",
      status: "auto_applied",
    }).returning();
    const [approval] = await db.insert(approvals).values({
      accountId, kind: "routing", messageId: m1, action: "move", status: "pending",
    }).returning();
    const [draft] = await db.insert(drafts).values({
      accountId, mailboxId, subject: "re: hi", body: "hello",
    }).returning();
    const [tag] = await db.insert(tags).values({ accountId, name: "Invoices", hue: "moss" }).returning();

    // Some history, so `asOfSeq` is a real number rather than 0.
    for (const id of [m1, m2]) await rec(db, accountId, "message", id);
    await rec(db, accountId, "rule", rule!.id);

    const page = await svc.getSnapshot(ctx, {});

    expect(idsOf(page, "rule")).toEqual([rule!.id]);
    expect(idsOf(page, "message_state")).toEqual([state!.id]);
    expect(idsOf(page, "routing_decision")).toEqual([pending!.id]);
    expect(idsOf(page, "routing_decision")).not.toContain(decided!.id);
    expect(idsOf(page, "approval")).toEqual([approval!.id]);
    expect(idsOf(page, "draft")).toEqual([draft!.id]);
    expect(idsOf(page, "tag")).toEqual([tag!.id]);
    // Newest first.
    expect(idsOf(page, "message")).toEqual([m1, m2]);

    // The DTOs are the delta's DTOs, not a second projection of the same rows.
    const ruleChange = page.changes.find((c) => c.type === "rule")!;
    expect(ruleChange.entity).toEqual(await svc.getChanges(ctx, {})
      .then((d) => d.changes.creates.find((c) => c.type === "rule")!.entity));

    // A `message_state` change is keyed by its OWN row id, which is what `change_log` holds —
    // the DTO carries `messageId` and has no `id` field of its own to confuse it with.
    const st = page.changes.find((c) => c.type === "message_state")!;
    expect(st.id).toBe(state!.id);
    expect((st.entity as { messageId: string }).messageId).toBe(m1);
  });

  it("EVERY row is op:create at seq === asOfSeq, and asOfSeq is the account's committed high water", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    for (let i = 0; i < 3; i += 1) {
      const id = await addMessage(db, accountId, mailboxId, { date: new Date(NOW.getTime() - i * DAY) });
      await rec(db, accountId, "message", id);
    }

    const page = await svc.getSnapshot(ctx, {});
    expect(page.asOfSeq).toBe(3);
    expect(page.changes.length).toBeGreaterThan(0);
    for (const c of page.changes) {
      expect(c.op).toBe("create");
      expect(c.seq).toBe(page.asOfSeq);
      expect(c.entity).toBeDefined();
    }

    // The delta cursor the client will use next is exactly this point.
    expect(svc.decodeCursor(svc.encodeCursor(BigInt(page.asOfSeq)))).toEqual({ seq: 3n, generation: null, floor: null });
  });

  it("serves the window rather than expecting the client to know it", async () => {
    const { ctx } = await setup();
    const page = await svc.getSnapshot(ctx, {});
    expect(page.window).toEqual({ days: 90, minRows: 5000, maxRows: 10_000 });
    expect(page.window).toEqual(SNAPSHOT_WINDOW);
  });

  it("an account with nothing in it snapshots to asOfSeq 0 and no cursor", async () => {
    // The delta from "0" is a full replay, so a client that bootstraps an empty account and
    // then polls is correct rather than merely lucky.
    const { ctx, accountId } = await setup();
    const page = await svc.getSnapshot(ctx, {});
    expect(page.asOfSeq).toBe(0);
    // ONE row even here: the settings doorbell rides page 1 for every account (default-shaped
    // for one that has never written a knob), so a fresh mirror starts with a stamp to compare
    // future settings changes against. Nothing else — the account is empty.
    expect(page.changes.map((c) => c.type)).toEqual(["settings"]);
    expect(page.changes[0]!.id).toBe(accountId);
    expect(page.nextCursor).toBeNull();
  });
});

describe("paging", () => {
  it("drains newest-first, exactly once per message, at ONE asOfSeq for every page", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const created: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const id = await addMessage(db, accountId, mailboxId, {
        date: new Date(NOW.getTime() - i * DAY), subject: `s${i}`,
      });
      await rec(db, accountId, "message", id);
      created.push(id);       // created[0] is the NEWEST
    }
    const [rule] = await db.insert(rules).values({
      accountId, kind: "sender", match: "anna@x.example", destination: "INBOX",
    }).returning();

    const pages = await drain(ctx, 2);
    expect(pages.length).toBe(4);            // 2 + 2 + 2 + 1

    // ONE consistent point across the whole snapshot.
    for (const p of pages) expect(p.asOfSeq).toBe(pages[0]!.asOfSeq);

    // Newest first, every message exactly once.
    const delivered = pages.flatMap((p) => idsOf(p, "message"));
    expect(delivered).toEqual(created);
    expect(new Set(delivered).size).toBe(delivered.length);

    // The live state is on page 1 ONLY — a client that stops early holds a PARTIAL mirror, never
    // a partial rule set. Pages 2+ carry messages and the threads those messages name, and
    // nothing else.
    expect(idsOf(pages[0]!, "rule")).toEqual([rule!.id]);
    for (const p of pages.slice(1)) {
      expect(p.changes.every((c) => c.type === "message" || c.type === "thread")).toBe(true);
      expect(idsOf(p, "rule")).toEqual([]);
    }
  });

  it("a malformed or unversioned cursor is a 410, not a guess at a position", async () => {
    const { ctx } = await setup();
    for (const bad of [
      "!!!not-base64!!!",
      Buffer.from("null", "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ v: 2, s: "1", d: null, i: "x", n: 0 }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ v: SNAPSHOT_CURSOR_VERSION, s: "nope", d: null, i: "x", n: 0 }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ v: SNAPSHOT_CURSOR_VERSION, s: "1", d: null, i: "", n: 0 }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ v: SNAPSHOT_CURSOR_VERSION, s: "1", d: null, i: "x", n: -1 }), "utf8").toString("base64url"),
    ]) {
      await expect(svc.getSnapshot(ctx, { cursor: bad }), bad).rejects.toMatchObject({
        code: "cursor_expired", httpStatus: 410,
      });
    }
  });

  it("undated mail sorts into the TAIL and still pages", async () => {
    // Postgres puts NULLs FIRST for a DESC sort, so a snapshot that left the ordering to the
    // default would OPEN the newest-first window with the least useful mail in the mailbox.
    const { db, accountId, mailboxId, ctx } = await setup();
    const dated = await addMessage(db, accountId, mailboxId, { date: new Date(NOW.getTime() - DAY) });
    const undatedA = await addMessage(db, accountId, mailboxId);
    const undatedB = await addMessage(db, accountId, mailboxId);

    const delivered = (await drain(ctx, 1)).flatMap((p) => idsOf(p, "message"));
    expect(delivered[0]).toBe(dated);
    expect(delivered.slice(1).sort()).toEqual([undatedA, undatedB].sort());
    expect(delivered).toHaveLength(3);
  });
});

describe("account scoping (#9), on every type", () => {
  it("a second account's rows are never in the first account's snapshot", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const mine = await addMessage(db, accountId, mailboxId, { date: new Date(NOW.getTime() - DAY) });
    const [myRule] = await db.insert(rules).values({
      accountId, kind: "sender", match: "mine@x.example", destination: "INBOX",
    }).returning();

    // A whole second account in the same database, with a row of every type the snapshot reads.
    const other = randomUUID();
    const [otherMb] = await db.insert(mailboxes).values({
      accountId: other, provider: "imap", address: `b-${other}@x.example`,
    }).returning();
    const theirs = await addMessage(db, other, otherMb!.id, { date: new Date(NOW.getTime()) });
    await db.insert(rules).values({
      accountId: other, kind: "sender", match: "theirs@x.example", destination: "INBOX",
    });
    await db.insert(messageStates).values({ accountId: other, messageId: theirs, state: "reply_later" });
    await db.insert(routingDecisions).values({
      accountId: other, messageId: theirs, inputProvenance: "ai", destination: "ohmail/News",
      status: "pending_approval",
    });
    await db.insert(approvals).values({
      accountId: other, kind: "routing", messageId: theirs, action: "move", status: "pending",
    });
    await db.insert(drafts).values({ accountId: other, mailboxId: otherMb!.id, subject: "theirs" });
    await db.insert(tags).values({ accountId: other, name: "Theirs", hue: "clay" });
    const [theirThread] = await db.insert(threads).values({
      accountId: other, subject: "theirs",
    }).returning();
    await db.update(messages).set({ threadId: theirThread!.id }).where(eq(messages.id, theirs));
    await rec(db, other, "message", theirs);

    const pages = await drain(ctx, 50);
    const all = pages.flatMap((p) => p.changes);
    // The account's OWN settings doorbell is part of its page-1 inventory now — its id is the
    // account's own, which is exactly what the scoping assertion should see; the other
    // account's ids stay absent below.
    expect(all.map((c) => c.id).sort()).toEqual([mine, myRule!.id, accountId].sort());

    // …and the other account's own snapshot is the mirror image, so the scoping is a filter
    // rather than an empty read.
    const theirCtx: ServiceContext = { ...ctx, accountId: other };
    const theirs1 = await svc.getSnapshot(theirCtx, {});
    expect(idsOf(theirs1, "message")).toEqual([theirs]);
    expect(theirs1.changes.map((c) => c.id)).not.toContain(mine);
  });
});

describe("threads ride WITH the page that references them", () => {
  it("each page carries its own messages' threads, and never the whole thread table", async () => {
    // Window coherence is the claim. A thread whose every message falls outside the message
    // window is a header over mail the client does not have, so it must NOT be shipped — and
    // that is precisely what shipping the thread table would do.
    const { db, accountId, mailboxId, ctx } = await setup();
    const [inWindow] = await db.insert(threads).values({ accountId, subject: "recent" }).returning();
    const [outOfWindow] = await db.insert(threads).values({ accountId, subject: "ancient" }).returning();

    const recent: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const id = await addMessage(db, accountId, mailboxId, { date: new Date(NOW.getTime() - i * DAY) });
      await db.update(messages).set({ threadId: inWindow!.id }).where(eq(messages.id, id));
      recent.push(id);
    }
    // A thread whose only message is far older than everything above it — so with `limit` small
    // it is not on page 1, and it appears only on the page its message lands on.
    const ancient = await addMessage(db, accountId, mailboxId, { date: new Date(NOW.getTime() - 900 * DAY) });
    await db.update(messages).set({ threadId: outOfWindow!.id }).where(eq(messages.id, ancient));

    const pages = await drain(ctx, 2);

    // Page 1 holds the two newest messages and ONLY their thread.
    expect(idsOf(pages[0]!, "thread")).toEqual([inWindow!.id]);
    expect(idsOf(pages[0]!, "thread")).not.toContain(outOfWindow!.id);

    // The ancient thread arrives on the page carrying its message, and not before.
    const pageOfAncient = pages.findIndex((p) => idsOf(p, "message").includes(ancient));
    expect(pageOfAncient).toBeGreaterThan(0);
    expect(idsOf(pages[pageOfAncient]!, "thread")).toContain(outOfWindow!.id);

    // The DTO is the delta's DTO — same projection, so a thread cannot look different depending
    // on which reader produced it.
    const fromSnapshot = pages[0]!.changes.find((c) => c.type === "thread")!.entity;
    await rec(db, accountId, "thread", inWindow!.id);
    const fromDelta = (await svc.getChanges(ctx, {})).changes.creates
      .find((c) => c.type === "thread")!.entity;
    expect(fromSnapshot).toEqual(fromDelta);
    expect((fromSnapshot as { messageIds: string[] }).messageIds).toHaveLength(4);
  });

  it("a thread named by twenty messages on ONE page is emitted once", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const [t] = await db.insert(threads).values({ accountId, subject: "busy" }).returning();
    for (let i = 0; i < 20; i += 1) {
      const id = await addMessage(db, accountId, mailboxId, { date: new Date(NOW.getTime() - i * DAY) });
      await db.update(messages).set({ threadId: t!.id }).where(eq(messages.id, id));
    }
    const page = await svc.getSnapshot(ctx, {});
    expect(idsOf(page, "message")).toHaveLength(20);
    expect(idsOf(page, "thread")).toEqual([t!.id]);
  });

  it("a thread STRADDLING a page boundary is duplicated, and the duplicate is a no-op", async () => {
    // Deliberate: the cursor cannot carry the emitted thread ids without growing without bound,
    // so the duplicate is allowed and absorbed by the client's older-or-equal seq guard. This is
    // that claim driven rather than asserted in a comment.
    const { db, accountId, mailboxId, ctx } = await setup();
    const [t] = await db.insert(threads).values({ accountId, subject: "straddles" }).returning();
    for (let i = 0; i < 4; i += 1) {
      const id = await addMessage(db, accountId, mailboxId, { date: new Date(NOW.getTime() - i * DAY) });
      await db.update(messages).set({ threadId: t!.id }).where(eq(messages.id, id));
    }

    const pages = await drain(ctx, 2);
    // Every page THAT CARRIES MESSAGES names the thread — and more than one does, which is what
    // makes this a straddle rather than a single-page case. The drain's last page can be empty
    // (`hasMore` is "the page was full", so a mailbox that divides evenly ends on a blank one),
    // and an empty page correctly names no thread.
    const withMessages = pages.filter((p) => idsOf(p, "message").length > 0);
    expect(withMessages.length).toBeGreaterThan(1);
    for (const p of withMessages) expect(idsOf(p, "thread")).toEqual([t!.id]);
    for (const p of pages) if (idsOf(p, "message").length === 0) expect(idsOf(p, "thread")).toEqual([]);

    // Applied in order, the mirror holds ONE thread and the guard absorbed the rest: all the
    // copies are at the same seq, so the store is never rewritten by the later ones.
    const mirror = new ClientMirror();
    for (const p of pages) mirror.applyChanges(p.changes as SyncChange[]);
    const live = mirror.snapshot();
    expect([...live.keys()].filter((k) => k.startsWith("thread:"))).toEqual([`thread:${t!.id}`]);
    expect((live.get(`thread:${t!.id}`) as { messageIds: string[] }).messageIds).toHaveLength(4);
  });
});

describe("a snapshot page costs a constant number of queries", () => {
  /**
   * THE REASON `materializeThreads` EXISTS, ASSERTED RATHER THAN ASSUMED.
   *
   * `materializeThread` is three round trips for ONE thread. A full page of messages can name
   * hundreds of them, and the per-id reader in a loop is three round trips for each — the same
   * shape that once pushed `/sync` past the function timeout so the client received NOTHING and
   * every view rendered empty against a mailbox full of messages. A duration
   * assertion would be a flake; CONSTANCY is the property that actually prevents it, so that is
   * what is measured. Modelled on the identical guard over `getChanges` in `sync-service.test.ts`.
   */
  function counting(db: Db): { db: Db; selects: () => number; bytes: () => number } {
    let n = 0;
    let bytes = 0;
    const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
    // Follows a select's builder chain to its `then`, and tallies the rows it resolves to.
    const tally = <T extends object>(obj: T): T => new Proxy(obj, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== "function" || prop === "constructor") return value;
        if (prop === "then") {
          return (ok?: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
            (value as (a: unknown, b: unknown) => unknown).call(target, (rows: unknown) => {
              bytes += Buffer.byteLength(JSON.stringify(rows, big) ?? "");
              return ok ? ok(rows) : rows;
            }, ko);
        }
        return (...args: unknown[]) => {
          const out = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (out === target) return receiver;
          return out !== null && typeof out === "object" && ("then" in out || "from" in out) ? tally(out) : out;
        };
      },
    });
    const proxy = new Proxy(db as object, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== "select" || typeof value !== "function") return value;
        return (...args: unknown[]) => {
          n += 1;
          return tally((value as (...a: unknown[]) => object).apply(target, args));
        };
      },
    }) as Db;
    return { db: proxy, selects: () => n, bytes: () => bytes };
  }

  async function costOf(messageCount: number, threadCount: number): Promise<number> {
    const { db, accountId, mailboxId, ctx } = await setup();
    const threadIds: string[] = [];
    for (let i = 0; i < threadCount; i += 1) {
      const [t] = await db.insert(threads).values({ accountId, subject: `t${i}` }).returning();
      threadIds.push(t!.id);
    }
    for (let i = 0; i < messageCount; i += 1) {
      const id = await addMessage(db, accountId, mailboxId, { date: new Date(NOW.getTime() - i * DAY) });
      await db.update(messages).set({ threadId: threadIds[i % threadCount]! })
        .where(eq(messages.id, id));
    }
    const counted = counting(db);
    const res = await svc.getSnapshot({ ...ctx, db: counted.db }, { limit: 500 });
    // A query-count assertion over an EMPTY page would pass for the very outage it prevents.
    expect(idsOf(res, "message")).toHaveLength(messageCount);
    expect(idsOf(res, "thread")).toHaveLength(threadCount);
    return counted.selects();
  }

  it("one message in one thread costs what forty messages in twenty threads cost", async () => {
    const one = await costOf(1, 1);
    const many = await costOf(40, 20);
    expect(many).toBe(one);
    // …and the constant is small, and ITEMISED so a future N+1 has to move a number somebody can
    // check: 1 seq high-water + 5 page-1 reads (rules, the read mailboxes' documents, drafts,
    // tags, and the message-less approvals that have no page to ride with) + 1 folders-flag probe
    // + 2 settings-doorbell reads + 1 keyset page + 1 message read (the row, its folder and triage
    // state, tags, away answer and three flags, joined) + 3 batched thread reads + 3 batched CHILD
    // reads (message_states, pending routing_decisions, approvals, each keyed on the page's
    // message ids) = 17. Every batched read is once per PAGE and never once per row, which is the
    // property this test defends: forty messages in twenty threads cost what one in one costs.
    expect(one).toBe(17);
  }, 120_000);

  /** The bytes a limit-1 page reads when its one message sits in a 60-letter conversation. */
  async function bytesNaming(payload: number): Promise<number> {
    const { db, accountId, mailboxId, ctx } = await setup();
    const [t] = await db.insert(threads).values({ accountId, subject: "the long one" }).returning();
    for (let i = 0; i < 60; i += 1) {
      await db.insert(messages).values({
        accountId, mailboxId, bodyHash: "h", dedupKey: randomUUID(), threadId: t!.id,
        subject: "s".repeat(payload), snippet: "p".repeat(payload), fromAddress: "f@x.example",
        date: new Date(NOW.getTime() - i * 60_000), unread: i % 2 === 0,
      });
    }
    const counted = counting(db);
    const res = await svc.getSnapshot({ ...ctx, db: counted.db }, { limit: 1 });
    expect(idsOf(res, "message")).toHaveLength(1);
    const thread = res.changes.find((c) => c.type === "thread")?.entity as { messageIds: string[] };
    expect(thread.messageIds).toHaveLength(60);
    return counted.bytes();
  }

  it("a page naming a long conversation reads its members' ids, not their mail", async () => {
    const plain = await bytesNaming(10);
    const heavy = await bytesNaming(2_000);
    // Only the page's own message carries its subject and snippet; the other 59 letters may not.
    expect(heavy - plain).toBeLessThan(12_000);
  }, 120_000);
});

describe("a message's child state is bounded BY THE PAGE, and never orphaned", () => {
  /**
   * Page 1 used to read `message_states`, pending `routing_decisions` and
   * `approvals` per ACCOUNT with no limit applied, which made it both unbounded and
   * window-incoherent — measured on the hosted service: child-and-small-state rows far past the limit on one page,
   * and approvals whose message the window excludes.
   * The second half is the one a person could see: `triagePiles` joins a `message_state` to its
   * message and, finding none, files the pile entry under the bare id.
   */
  async function withChildren(n: number) {
    const s = await setup();
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const id = await addMessage(s.db, s.accountId, s.mailboxId, {
        date: new Date(NOW.getTime() - i * DAY),
      });
      ids.push(id);
      await s.db.insert(messageStates).values({
        accountId: s.accountId, messageId: id, state: "reply_later",
      });
      await s.db.insert(routingDecisions).values({
        accountId: s.accountId, messageId: id, inputProvenance: "ai",
        destination: "ohmail/News", status: "pending_approval",
      });
      await s.db.insert(approvals).values({
        accountId: s.accountId, kind: "routing", messageId: id, action: "move", status: "pending",
      });
    }
    return { ...s, ids };
  }

  it("page 1 carries no more children than its row limit, however many the account holds", async () => {
    const { ctx } = await withChildren(24);
    const page = await svc.getSnapshot(ctx, { limit: 5 });
    for (const type of ["message", "message_state", "routing_decision", "approval"]) {
      expect(idsOf(page, type).length, type).toBeLessThanOrEqual(5);
    }
    // A bound assertion over an EMPTY page would pass for the very defect it prevents.
    expect(idsOf(page, "message_state")).toHaveLength(5);
  });

  it("every child on a page names a message ON THAT PAGE — on every page of a full drain", async () => {
    const { ctx } = await withChildren(24);
    const CHILD = ["message_state", "routing_decision", "approval"];
    let children = 0;
    for (const page of await drain(ctx, 5)) {
      const onPage = new Set(
        page.changes.filter((c) => c.type === "message").map((c) => c.id),
      );
      for (const c of page.changes.filter((c) => CHILD.includes(c.type))) {
        children += 1;
        expect(onPage.has((c.entity as { messageId: string }).messageId), c.type).toBe(true);
      }
    }
    // 24 messages × 3 child rows: every one delivered, each beside its own message.
    expect(children).toBe(72);
  });

  /** Live child state on one message, returned by row id. The triage state is a parameter because
   *  it decides admission: the snapshot's tail carries a message below the window that owns a
   *  `message_states` row other than `none`, so a truncation fixture has to rest at `none`. */
  async function attachChildren(
    s: Awaited<ReturnType<typeof setup>>, messageId: string, triage: "reply_later" | "none" = "reply_later",
  ) {
    const [state] = await s.db.insert(messageStates).values({
      accountId: s.accountId, messageId, state: triage,
    }).returning();
    const [approval] = await s.db.insert(approvals).values({
      accountId: s.accountId, kind: "routing", messageId, action: "move", status: "pending",
    }).returning();
    const [pending] = await s.db.insert(routingDecisions).values({
      accountId: s.accountId, messageId, inputProvenance: "ai",
      destination: "ohmail/News", status: "pending_approval",
    }).returning();
    return [state!.id, approval!.id, pending!.id];
  }

  it("a child below the window rides with its parent or with neither — and each tail key is measured alone", async () => {
    // RE-DERIVED TWICE. It began as "a child whose message the WINDOW truncates is emitted on NO
    // page" with a PENDING approval and decision on the buried message; the tail now reaches for
    // those, and for a PARK. The invariant underneath never moved — a child is emitted with its
    // parent or not at all — so the fixture drives each admission key SEPARATELY: a buried message
    // owning nothing the tail wants, one owning only a park, one owning only pending actions. A
    // twin carrying both keys would pass while either arm was dead.
    //
    // A two-row fixture cannot express any of it: the volume floor delivers a small mailbox in
    // full, so the mailbox has to be big enough for the window to actually cut.
    const s = await setup();
    const total = SNAPSHOT_WINDOW.minRows + 3000;
    const old = NOW.getTime() - 200 * DAY;
    const rows = Array.from({ length: total }, (_, i) => ({
      accountId: s.accountId, mailboxId: s.mailboxId, bodyHash: "h", dedupKey: `w:${i}`,
      subject: `s${i}`, fromAddress: "f@x.example", date: new Date(old - i * 1000),
    }));
    for (let i = 0; i < rows.length; i += 1000) {
      await s.db.insert(messages).values(rows.slice(i, i + 1000));
    }
    // Older than every row above, so all three sort last and the window truncates all three.
    // QUIET owns nothing the tail reaches: no tag, a `message_states` row resting at `none` — the
    // released state every park returns to — and no pending row.
    const quiet = await addMessage(s.db, s.accountId, s.mailboxId, {
      date: new Date(old - total * 1000),
    });
    // NOT `attachChildren`: it always writes a PENDING approval and decision, which the tail
    // reaches for — the whole point of this row is a child the tail does NOT want.
    const [quietState] = await s.db.insert(messageStates).values({
      accountId: s.accountId, messageId: quiet, state: "none",
    }).returning();
    const quietChildren = [quietState!.id];
    // PARKED owns ONLY a park, so it measures the park key and no other.
    const parked = await addMessage(s.db, s.accountId, s.mailboxId, {
      date: new Date(old - (total + 1) * 1000),
    });
    const [parkedState] = await s.db.insert(messageStates).values({
      accountId: s.accountId, messageId: parked, state: "reply_later",
    }).returning();
    // PENDING owns an approval and a routing decision somebody is waiting on, and rests at `none`
    // so the park key cannot be what carries it.
    const pendingParent = await addMessage(s.db, s.accountId, s.mailboxId, {
      date: new Date(old - (total + 2) * 1000),
    });
    const pendingChildren = await attachChildren(s, pendingParent, "none");

    const emitted = new Set((await drain(s.ctx, 2000)).flatMap((p) => p.changes).map((c) => c.id));

    // THE TRUNCATION IS STILL THE PREMISE: a buried message with nothing the tail reaches for
    // stays below it, and its children stay with it. Without this the rest is vacuous.
    expect(emitted.has(quiet)).toBe(false);
    for (const id of quietChildren) expect(emitted.has(id)).toBe(false);
    // THE PARK KEY, alone.
    expect(emitted.has(parked)).toBe(true);
    expect(emitted.has(parkedState!.id)).toBe(true);
    // THE PENDING KEYS, alone — and every child rides with the message.
    expect(emitted.has(pendingParent)).toBe(true);
    for (const id of pendingChildren) expect(emitted.has(id)).toBe(true);
    // …and the window still delivered its own rows, so this is not a snapshot of nothing.
    expect(emitted.size).toBeGreaterThanOrEqual(SNAPSHOT_WINDOW.minRows);
  }, 300_000);

  it("a TOMBSTONED message's child state is emitted on no page either (mail 0065)", async () => {
    // The snapshot withholds a tombstoned message from a fresh mirror on purpose. Its child
    // state used to arrive anyway — the same orphan, reached without a large mailbox.
    const s = await setup();
    await addMessage(s.db, s.accountId, s.mailboxId, { date: new Date(NOW.getTime() - DAY) });
    const gone = await addMessage(s.db, s.accountId, s.mailboxId, {
      date: new Date(NOW.getTime() - 2 * DAY),
    });
    const childIds = await attachChildren(s, gone);
    await s.db.update(messages).set({ deletedAt: NOW }).where(eq(messages.id, gone));

    const emitted = new Set((await drain(s.ctx, 500)).flatMap((p) => p.changes).map((c) => c.id));
    expect(emitted.has(gone)).toBe(false);
    for (const id of childIds) expect(emitted.has(id)).toBe(false);
  });

  it("an approval with NO message still arrives — the bounded page-1 read admits it", async () => {
    const s = await setup();
    await addMessage(s.db, s.accountId, s.mailboxId, { date: new Date(NOW.getTime() - DAY) });
    const [orphan] = await s.db.insert(approvals).values({
      accountId: s.accountId, kind: "draft_send", action: "send", status: "pending",
    }).returning();
    const page = await svc.getSnapshot(s.ctx, {});
    expect(idsOf(page, "approval")).toContain(orphan!.id);
  });
});

describe("tags are live state and boot with the rail", () => {
  it("every tag is on page 1, whether or not any message carries it", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const [used] = await db.insert(tags).values({ accountId, name: "Invoices", hue: "moss" }).returning();
    const [unused] = await db.insert(tags).values({ accountId, name: "Later", hue: "dusk" }).returning();
    await addMessage(db, accountId, mailboxId, { date: new Date(NOW.getTime() - DAY) });

    const page = await svc.getSnapshot(ctx, {});
    // BOTH — an unused tag is still a tag the person made, and a rail missing it looks deleted.
    expect(idsOf(page, "tag").sort()).toEqual([used!.id, unused!.id].sort());
    const dto = page.changes.find((c) => c.id === used!.id)!.entity as { name: string; hue: string };
    expect(dto).toMatchObject({ name: "Invoices", hue: "moss" });
  });
});

describe("the client apply path is unchanged", () => {
  it("snapshot then delta converges, and the older-or-equal guard needs no new code", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const m1 = await addMessage(db, accountId, mailboxId, { date: new Date(NOW.getTime() - DAY) });
    await rec(db, accountId, "message", m1);
    const [rule] = await db.insert(rules).values({
      accountId, kind: "sender", match: "anna@x.example", destination: "INBOX",
    }).returning();
    await rec(db, accountId, "rule", rule!.id);

    const snap = await svc.getSnapshot(ctx, {});
    const mirror = new ClientMirror();
    mirror.applyChanges(snap.changes as SyncChange[]);
    // `settings:<accountId>` rides along — the consent doorbell on page 1; the client apply is
    // type-agnostic, which is exactly what this test exists to keep true.
    expect([...mirror.snapshot().keys()].sort())
      .toEqual([`message:${m1}`, `rule:${rule!.id}`, `settings:${accountId}`].sort());

    // Re-applying the page is a no-op: every row is at seq == asOfSeq, which the guard refuses.
    const before = JSON.stringify([...mirror.snapshot().entries()].sort());
    mirror.applyChanges(snap.changes as SyncChange[]);
    expect(JSON.stringify([...mirror.snapshot().entries()].sort())).toBe(before);

    // A change AFTER the snapshot point arrives through the delta at a HIGHER seq and wins.
    await db.update(rules).set({ enabled: false }).where(eq(rules.id, rule!.id));
    await rec(db, accountId, "rule", rule!.id);
    const delta = await svc.getChanges(ctx, { since: svc.encodeCursor(BigInt(snap.asOfSeq)) });
    expect(delta.changes.creates.map((c) => c.seq)).toEqual([snap.asOfSeq + 1]);
    mirror.applyChanges(delta.changes.creates);
    expect((mirror.snapshot().get(`rule:${rule!.id}`) as { enabled: boolean }).enabled).toBe(false);
  });
});

describe("the window bounds a large mailbox", () => {
  it("stops once BOTH floors are satisfied, and never before the volume floor", async () => {
    // The recency floor alone would truncate a mailbox that has been quiet for three months, so
    // the volume floor carries it; the volume floor alone would page a decade of mail into a
    // bootstrap, so the recency floor stops it. This drives the seam between them: every row here
    // is older than 90 days, so paging is held open by `minRows` and by nothing else, and it must
    // stop at `minRows` rather than draining the mailbox.
    const { db, accountId, mailboxId, ctx } = await setup();
    const total = SNAPSHOT_WINDOW.minRows + 3000;
    const old = NOW.getTime() - 200 * DAY;
    const rows = Array.from({ length: total }, (_, i) => ({
      accountId, mailboxId, bodyHash: "h", dedupKey: `w:${i}`,
      subject: `s${i}`, fromAddress: "f@x.example",
      date: new Date(old - i * 1000),
    }));
    for (let i = 0; i < rows.length; i += 1000) await db.insert(messages).values(rows.slice(i, i + 1000));

    // `limit` is clamped to the service's page ceiling, so the floor is met at a PAGE boundary
    // rather than to the row. That is deliberate: `minRows` is a floor and trimming a page to
    // land exactly on it would drop rows the query has already paid for.
    const limit = 2000;
    const pages = await drain(ctx, limit);
    const delivered = pages.flatMap((p) => idsOf(p, "message"));

    expect(delivered.length).toBeGreaterThanOrEqual(SNAPSHOT_WINDOW.minRows);
    expect(delivered.length).toBeLessThan(SNAPSHOT_WINDOW.minRows + limit);
    // THE TRUNCATION IS THE CLAIM. Without it this whole case would pass by draining the mailbox,
    // which is what an unbounded snapshot does and exactly what the window exists to stop.
    expect(delivered.length).toBeLessThan(total);
    expect(new Set(delivered).size).toBe(delivered.length);
    // …and the rows it served are the NEWEST ones. A truncated window that dropped the wrong end
    // would satisfy every count above and be useless.
    const served = await db.select({ id: messages.id, date: messages.date }).from(messages)
      .where(eq(messages.accountId, accountId));
    const newest = served
      .sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0))
      .slice(0, delivered.length).map((r) => r.id);
    expect(new Set(delivered)).toEqual(new Set(newest));
  }, 300_000);
});


const DRAFT_PAGE = SNAPSHOT_DRAFT_PAGE;
const enc = (o: unknown): string => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
const dec = (c: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as Record<string, unknown>;

/** `n` drafts one minute apart, newest first; returns their ids in that order. Distinct
 *  `updatedAt`s on purpose — a fixture with ties measures the keyset's tiebreak, not its walk. */
async function addDrafts(db: Db, accountId: string, mailboxId: string, n: number): Promise<string[]> {
  const made: string[] = [];
  for (let base = 0; base < n; base += 500) {
    const rows = Array.from({ length: Math.min(500, n - base) }, (_, k) => ({
      accountId, mailboxId, subject: `d${base + k}`,
      updatedAt: new Date(NOW.getTime() - (base + k) * 60_000),
    }));
    const out = await db.insert(drafts).values(rows).returning({ id: drafts.id });
    made.push(...out.map((r) => r.id));
  }
  return made;
}

describe("drafts ride the pages instead of filling page 1", () => {
  it("page 1 carries the NEWEST page of drafts, never the whole set", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const newestFirst = await addDrafts(db, accountId, mailboxId, DRAFT_PAGE + 37);
    const page = await svc.getSnapshot(ctx, { limit: 500 });
    // THE TRUNCATION IS THE CLAIM: page 1 used to emit every row, so a drain that still did
    // would satisfy every "the drafts arrive" assertion below and bound nothing.
    expect(idsOf(page, "draft")).toHaveLength(DRAFT_PAGE);
    expect(idsOf(page, "draft")).toEqual(newestFirst.slice(0, DRAFT_PAGE));
    expect(page.nextCursor).not.toBeNull();
  });

  it("a full drain delivers every draft exactly once, newest first — with NO messages at all", async () => {
    // No mail, so the message walk ends on page 1 and the drafts phase is the only thing keeping
    // the drain alive. That phase carries no message keyset, which is the shape an account with
    // more drafts than mail produces and the reason the cursor can be in two shapes.
    const { db, accountId, mailboxId, ctx } = await setup();
    const newestFirst = await addDrafts(db, accountId, mailboxId, DRAFT_PAGE * 2 + 9);
    const pages = await drain(ctx, 500);
    expect(idsOf(pages[0]!, "message")).toHaveLength(0);
    expect(pages.flatMap((p) => idsOf(p, "draft"))).toEqual(newestFirst);
    expect(dec(pages[0]!.nextCursor!).p).toBe("drafts");
  });

  it("drafts outlive the message walk rather than being dropped at its end", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const m = await addMessage(db, accountId, mailboxId, { date: new Date(NOW.getTime() - DAY) });
    const newestFirst = await addDrafts(db, accountId, mailboxId, DRAFT_PAGE + 4);
    const pages = await drain(ctx, 500);
    expect(idsOf(pages[0]!, "message")).toEqual([m]);   // the walk ran off the end on page 1
    expect(pages.flatMap((p) => idsOf(p, "draft"))).toEqual(newestFirst);
  });

  it("a cursor with NO draft position means finished, not restart", async () => {
    // The cross-deploy property: a cursor issued before drafts were paged carries no draft
    // position, and the client holding it already took every draft from its page 1. Reading
    // that absence as "start at the newest" would re-send the whole set on every such cursor.
    const { db, accountId, mailboxId, ctx } = await setup();
    const newestFirst = await addDrafts(db, accountId, mailboxId, DRAFT_PAGE + 5);
    for (let i = 0; i < 4; i += 1) {
      await addMessage(db, accountId, mailboxId, { date: new Date(NOW.getTime() - i * DAY) });
    }
    const page1 = await svc.getSnapshot(ctx, { limit: 2 });
    expect(idsOf(page1, "draft")).toHaveLength(DRAFT_PAGE);
    // The positive control for the strip below: the ordinary next page carries the rest.
    const page2 = await svc.getSnapshot(ctx, { limit: 2, cursor: page1.nextCursor! });
    expect(idsOf(page2, "draft")).toEqual(newestFirst.slice(DRAFT_PAGE));

    const raw = dec(page1.nextCursor!);
    expect(raw.da, "page 1 issued no draft position, so this case measures nothing").toBeDefined();
    delete raw.da;
    delete raw.di;
    const stripped = await svc.getSnapshot(ctx, { limit: 2, cursor: enc(raw) });
    expect(idsOf(stripped, "draft")).toEqual([]);
  });

  it("the widest cursor it can issue still fits the wire ceiling", () => {
    // A cursor over SNAPSHOT_CURSOR_MAX_CHARS is a 410 on the page after the one that issued it,
    // which restarts the bootstrap for ever in silence. Widest case: a nineteen-digit seq, the
    // emitted ceiling, a `Date`-range keyset, the phase, the draft keyset beside it, and the run.
    const worst = svc.encodeSnapshotCursor({
      asOfSeq: 9_223_372_036_854_775_807n,
      generation: Number.MAX_SAFE_INTEGER,
      date: 8_640_000_000_000_000,
      id: randomUUID(),
      emitted: 10_000_000,
      phase: "tail",
      draft: { updatedAt: 8_640_000_000_000_000, id: randomUUID() },
    });
    expect(worst.length).toBeLessThanOrEqual(SNAPSHOT_CURSOR_MAX_CHARS);
    expect(() => svc.decodeSnapshotCursor(worst)).not.toThrow();
  });

  it("refuses half a draft keyset, and a drafts cursor that is not one", async () => {
    const { ctx } = await setup();
    const base = { v: SNAPSHOT_CURSOR_VERSION, s: "5", d: NOW.getTime(), i: randomUUID(), n: 1 };
    const draftPos = { da: NOW.getTime(), di: randomUUID() };
    for (const bad of [
      { ...base, da: NOW.getTime() },                       // half a keyset: no id
      { ...base, di: randomUUID() },                        // half a keyset: no date
      { ...base, ...draftPos, di: "not-a-uuid" },           // an id Postgres would answer 22P02 to
      { ...base, ...draftPos, da: 1e308 },                  // finite, and not a date
      { v: SNAPSHOT_CURSOR_VERSION, s: "5", n: 1, p: "drafts" },                  // a drafts cursor with nowhere to resume
      { ...base, ...draftPos, p: "drafts" },                // a drafts cursor carrying a message keyset
    ]) {
      await expect(svc.getSnapshot(ctx, { cursor: enc(bad) }), JSON.stringify(bad))
        .rejects.toMatchObject({ code: "cursor_expired", httpStatus: 410 });
    }
    // The positive control: the well-formed drafts cursor those five are malformed versions of.
    const ok = await svc.getSnapshot(ctx, { cursor: enc({ v: SNAPSHOT_CURSOR_VERSION, s: "5", n: 1, p: "drafts", ...draftPos }) });
    expect(ok.nextCursor).toBeNull();
  });
});

describe("the window has a CEILING as well as its two floors", () => {
  it("refuses a ceiling below the floor, and admits the one that ships", () => {
    expect(() => assertSnapshotWindow({ days: 90, minRows: 5000, maxRows: 4999 }))
      .toThrow(/below minRows/);
    // Three positive controls: the shipped constant, a ceiling exactly ON the floor, and a window
    // that states no ceiling at all — what a deployment older than the field serves.
    expect(() => assertSnapshotWindow(SNAPSHOT_WINDOW)).not.toThrow();
    expect(() => assertSnapshotWindow({ days: 90, minRows: 5000, maxRows: 5000 })).not.toThrow();
    expect(() => assertSnapshotWindow({ days: 90, minRows: 5000 })).not.toThrow();
  });

  it("serves the ceiling beside the floors, and never serves fewer rows than a client keeps", async () => {
    const { ctx } = await setup();
    const page = await svc.getSnapshot(ctx, {});
    expect(page.window).toEqual(SNAPSHOT_WINDOW);
    // The rule the number exists under: at least the largest windowed client's own ceiling
    // (browser, desktop and phone all keep the same row ceiling), never less.
    expect(SNAPSHOT_WINDOW.maxRows).toBeGreaterThanOrEqual(10_000);
  });

  it("stops the window at the ceiling, and the labeled tail still reaches below it", async () => {
    // EVERY row is inside ninety days, so the recency floor alone would page the whole mailbox —
    // which is the defect: a mailbox dense inside `days` bootstrapped entirely, floor and all.
    // One tagged message sits below where the ceiling cuts; tagged mail is the one thing that
    // must survive the ceiling exactly as it survives the floor.
    const { db, accountId, mailboxId, ctx } = await setup();
    const total = SNAPSHOT_WINDOW.maxRows + 600;
    const rows = Array.from({ length: total }, (_, i) => ({
      accountId, mailboxId, bodyHash: "h", dedupKey: `c:${i}`,
      subject: `s${i}`, fromAddress: "f@x.example",
      date: new Date(NOW.getTime() - i * 60_000),   // 10 600 minutes ≈ 7 days: all inside 90
    }));
    for (let i = 0; i < rows.length; i += 1000) await db.insert(messages).values(rows.slice(i, i + 1000));
    // Below every filler row and still inside ninety days: the ceiling is what excludes it.
    const tagged = await addMessage(db, accountId, mailboxId, { date: new Date(NOW.getTime() - 20 * DAY) });
    const untaggedBelow = await addMessage(db, accountId, mailboxId, { date: new Date(NOW.getTime() - 21 * DAY) });
    const [tag] = await db.insert(tags).values({ accountId, name: "Invoices", hue: "moss" }).returning();
    await db.insert(messageTags).values({ accountId, messageId: tagged, tagId: tag!.id });

    const limit = 2000;
    const delivered = (await drain(ctx, limit)).flatMap((p) => idsOf(p, "message"));

    // 1. THE CEILING. Without it every one of these rows is inside the recency floor and the
    //    whole mailbox arrives, which is what this bound exists to stop.
    expect(delivered.length).toBeLessThan(total);
    expect(delivered.length).toBeGreaterThanOrEqual(SNAPSHOT_WINDOW.maxRows);
    // The stop is read at a page boundary, like the floor: at most the ceiling plus one page.
    expect(delivered.length).toBeLessThan(SNAPSHOT_WINDOW.maxRows + limit);
    expect(new Set(delivered).size).toBe(delivered.length);
    // 2. …and it kept the NEWEST rows. A ceiling that dropped the wrong end satisfies every
    //    count above and is useless.
    const kept = new Set(delivered);
    const newestIds = (await db.select({ id: messages.id, date: messages.date }).from(messages)
      .where(eq(messages.accountId, accountId)))
      .sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0))
      .slice(0, SNAPSHOT_WINDOW.maxRows).map((r) => r.id);
    expect(newestIds.every((id) => kept.has(id))).toBe(true);
    // 3. THE TAIL SURVIVES THE CEILING. The tagged row below the cut arrives; its untagged
    //    neighbour, one minute older, does not — so the tail is still bounded by tagged mail.
    expect(kept.has(tagged)).toBe(true);
    expect(kept.has(untaggedBelow)).toBe(false);
  }, 300_000);
});

/**
 * THE TAIL ON ITS OWN — `?phase=tail`.
 *
 * The labeled tail exists because a tagged message below the window is otherwise unreachable, and
 * the ordinary walk reaches it only after paging the whole window. That is the wrong shape for the
 * one client that needs it: a windowed mirror whose OLD retention policy evicted its tagged mail
 * already holds the window and is missing only the tail. `phase=tail` starts the walk there — no
 * page-1 live state, no window ahead of it — so the cost is what somebody tagged by hand.
 */
describe("the labeled tail, asked for on its own", () => {
  /**
   * WATCHED RED three ways in `sync-service.ts#getSnapshot`:
   *   · `const tailOnly = false;`                      → the untagged rows arrive, the live state too
   *   · `const inTail = cursor?.phase === "tail";`     → the untagged rows arrive
   *   · `if (cursor === null) {` for the page-1 block  → the tag and rule rows ride along
   */
  it("carries every tagged message and nothing else", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const old = NOW.getTime() - 400 * DAY;
    const tagged: string[] = [];
    const untagged: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      tagged.push(await addMessage(db, accountId, mailboxId, { date: new Date(old - i * 1000), subject: `t${String(i)}` }));
      untagged.push(await addMessage(db, accountId, mailboxId, { date: new Date(old - (10 + i) * 1000), subject: `u${String(i)}` }));
    }
    const [tag] = await db.insert(tags).values({ accountId, name: "Invoices", hue: "moss" }).returning();
    for (const messageId of tagged) {
      await db.insert(messageTags).values({ accountId, messageId, tagId: tag!.id });
    }
    // A rule, so the page-1 live state has something to leak if the tail ever carried it.
    await db.insert(rules).values({
      accountId, kind: "sender", match: "f@x.example", destination: "INBOX",
    });

    const page = await svc.getSnapshot(ctx, { phase: "tail" });

    // Newest first, the window's own order, and nothing untagged.
    expect(idsOf(page, "message")).toEqual(tagged);
    expect(untagged.some((id) => idsOf(page, "message").includes(id))).toBe(false);
    // NO PAGE-1 LIVE STATE: this walk is a repair of one gap, not a second bootstrap.
    expect(idsOf(page, "rule")).toEqual([]);
    expect(idsOf(page, "tag")).toEqual([]);
    expect(idsOf(page, "settings")).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  /**
   * THE POSITIVE CONTROL: without the parameter the SAME account gets the ordinary walk — page 1
   * live state and every message, tagged or not. A tail that carried everything, or an ordinary
   * page that carried nothing, would both satisfy the case above on its own.
   *
   * WATCHED RED by `const tailOnly = cursor === null;` (every ordinary page 1 becomes a tail).
   */
  it("is the ordinary walk when the parameter is absent", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const old = NOW.getTime() - 400 * DAY;
    const tagged = await addMessage(db, accountId, mailboxId, { date: new Date(old), subject: "t" });
    const untagged = await addMessage(db, accountId, mailboxId, { date: new Date(old - 1000), subject: "u" });
    const [tag] = await db.insert(tags).values({ accountId, name: "Invoices", hue: "moss" }).returning();
    await db.insert(messageTags).values({ accountId, messageId: tagged, tagId: tag!.id });
    await db.insert(rules).values({
      accountId, kind: "sender", match: "f@x.example", destination: "INBOX",
    });

    const page = await svc.getSnapshot(ctx, {});

    expect(idsOf(page, "message").sort()).toEqual([tagged, untagged].sort());
    expect(idsOf(page, "rule")).toHaveLength(1);
    expect(idsOf(page, "tag")).toEqual([tag!.id]);
  });
});
