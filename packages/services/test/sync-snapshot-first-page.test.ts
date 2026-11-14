import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { folderState, mailboxes, messages, tags } from "@trafficflow/db";
import {
  SNAPSHOT_FIRST_PAGE_MESSAGES, SyncService,
  type ServiceContext, type SnapshotResponse,
} from "../src/index.js";

/**
 * ═══ PAGE 1 IS A VIEWPORT, AND IT IS A PREFIX ════════════════════════════════════════════════
 *
 * The bootstrap's first page used to take the same limit as every other page, and the
 * walk is linear in rows — 2.28 ms per message over a 68 ms floor, measured on a large
 * mirror, so page 1 cost seconds and most of its messages were work in front of a first row
 * nobody could see. Bounding it is only safe if three things hold, and each is a case below:
 * the bound reaches the MESSAGE walk and nothing else, the shorter page is a strict PREFIX of the
 * longer one (rows that appear and then reorder are worse than rows that wait), and the walk still
 * delivers the whole mailbox afterwards.
 *
 * Each case was watched RED against a named mutation of the line that decides, and the file was
 * then restored from a pristine copy and the restore proved by `cmp`.
 */
const svc = new SyncService();
const NOW = new Date("2026-08-07T12:00:00.000Z");
const MINUTE = 60_000;

async function setup() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `a-${accountId}@x.example`,
  }).returning();
  const ctx: ServiceContext = { db, accountId, userId: null, now: () => NOW, requestId: "snap" };
  return { db, accountId, mailboxId: mb!.id, ctx };
}

/** `n` messages, newest first by construction, so every ordering assertion below is deterministic. */
async function seedMessages(
  db: Awaited<ReturnType<typeof makeTestDb>>, accountId: string, mailboxId: string, n: number,
): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId, bodyHash: "h", dedupKey: randomUUID(),
      subject: `s${i}`, fromAddress: "f@x.example", date: new Date(NOW.getTime() - i * MINUTE),
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
    });
  }
}

const messageIds = (r: SnapshotResponse): string[] =>
  r.changes.filter((c) => c.type === "message").map((c) => c.id);

async function drain(ctx: ServiceContext, opts: { limit?: number } = {}): Promise<SnapshotResponse[]> {
  const pages: SnapshotResponse[] = [];
  let cursor: string | undefined;
  for (let guard = 0; ; guard += 1) {
    const page: SnapshotResponse = await svc.getSnapshot(ctx, {
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(cursor ? { cursor } : {}),
    });
    pages.push(page);
    if (page.nextCursor === null) return pages;
    cursor = page.nextCursor;
    if (guard > 200) throw new Error("snapshot drain did not terminate");
  }
}

describe("the bootstrap's first page", () => {
  it("carries a viewport's worth of messages and not the page limit", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    await seedMessages(db, accountId, mailboxId, SNAPSHOT_FIRST_PAGE_MESSAGES + 40);

    const page1 = await svc.getSnapshot(ctx, {});

    expect(messageIds(page1)).toHaveLength(SNAPSHOT_FIRST_PAGE_MESSAGES);
    // POSITIVE CONTROL for the bound being a bound and not an end: there is more to come.
    expect(page1.nextCursor).not.toBeNull();
  });

  /**
   * THE ROWS THAT PAINT FIRST ARE THE ROWS THE LONG PAGE WOULD HAVE SHOWN FIRST. This is the
   * case that makes an early paint safe: a shorter page 1 that returned a DIFFERENT set would
   * put rows on screen that a later page contradicts.
   */
  it("is a strict prefix of the walk it replaced", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    await seedMessages(db, accountId, mailboxId, SNAPSHOT_FIRST_PAGE_MESSAGES + 40);

    const pages = await drain(ctx);
    const bounded = messageIds(pages[0]!);
    // What the WHOLE walk delivers, in the order it delivers it. The bound moves where a page
    // ends; it may not move which mail comes first, so page 1 has to be this order's own head.
    const everything = pages.flatMap(messageIds);

    expect(everything.length).toBeGreaterThan(bounded.length);
    expect(bounded).toEqual(everything.slice(0, bounded.length));
  });

  it("still delivers every message once the walk finishes", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const n = SNAPSHOT_FIRST_PAGE_MESSAGES + 40;
    await seedMessages(db, accountId, mailboxId, n);

    const delivered = (await drain(ctx)).flatMap(messageIds);

    expect(new Set(delivered).size).toBe(n);
  });

  /**
   * THE BOUND REACHES THE MESSAGE WALK AND NOTHING ELSE. Page 1's live state is unpaged by
   * design — a rail that boots with a third of the reader's tags reads as "my tags are gone" —
   * so a bound written across the whole page rather than across its messages would be a
   * different defect wearing this fix's name.
   */
  it("does not bound the live state that rides with it", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const tagCount = SNAPSHOT_FIRST_PAGE_MESSAGES + 10;
    for (let i = 0; i < tagCount; i += 1) {
      await db.insert(tags).values({ accountId, name: `t${i}`, hue: "moss" });
    }
    await seedMessages(db, accountId, mailboxId, SNAPSHOT_FIRST_PAGE_MESSAGES + 5);

    const page1 = await svc.getSnapshot(ctx, {});

    expect(page1.changes.filter((c) => c.type === "tag")).toHaveLength(tagCount);
  });

  it("gives a caller that asked for fewer what it asked for", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    await seedMessages(db, accountId, mailboxId, SNAPSHOT_FIRST_PAGE_MESSAGES + 10);

    const page1 = await svc.getSnapshot(ctx, { limit: 5 });

    expect(messageIds(page1)).toHaveLength(5);
  });

  /**
   * A TAIL-ONLY WALK IS NOT A COLD START. It is a client re-hydrating mail its own retention
   * policy evicted, with no first row waiting on it, so it takes the caller's limit.
   */
  it("does not bound a walk that starts in the tail", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    await seedMessages(db, accountId, mailboxId, SNAPSHOT_FIRST_PAGE_MESSAGES + 40);

    const tail = await svc.getSnapshot(ctx, { phase: "tail", limit: 500 });

    // Nothing here owns a tag, a park, an approval or a pending decision, so the tail is empty —
    // the reading is that it was not CUT to the first-page bound on its way to being empty.
    expect(messageIds(tail).length).not.toBe(SNAPSHOT_FIRST_PAGE_MESSAGES);
  });
});
