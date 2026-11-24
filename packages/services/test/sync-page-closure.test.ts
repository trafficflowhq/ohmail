import type { SyncChange } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { mailboxes, messages, threads } from "@trafficflow/db";
import { DraftsService, MessageService, SyncService, TagsService, ThreadService } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * A `/sync` PAGE NEVER NAMES A HARD-DELETED HOLDER BESIDE ITS OWN TOMBSTONE — the reading that closes
 * MIRROR-PAGE-ORDER-IS-PER-ENTITY-NOT-PER-FEED as NOT-REACHABLE. The desktop mirror applies a page by
 * kind, not by feed order; the two can differ only when a non-delete names an entity the same page
 * tombstones. Every non-delete is materialized from current rows AFTER the page's change-log read,
 * so the server's own keys keep it off a hard-deleted thread or tag. The real writers are driven into
 * ONE page; the one crossing is a Trash-deleted (soft) message named by its reply draft, and the
 * mirror's pin (`apps/sidecar/test/mirror-page-order-converges.test.ts`) shows that one converges.
 */
const refsOf = (c: SyncChange): string[] => {
  const e = (c.entity ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ["threadId", "messageId", "inReplyToMessageId", "forwardOfMessageId", "routingDecisionId"]) {
    if (typeof e[k] === "string") out.push(e[k] as string);
  }
  if (Array.isArray(e.labels)) for (const l of e.labels as unknown[]) if (typeof l === "string") out.push(l);
  if (Array.isArray(e.tags)) for (const l of e.tags as unknown[]) if (typeof l === "string") out.push(l);
  return out;
};

describe("the crossings a real page can carry", () => {
  it("no page carries a live referrer of an entity the same page tombstones, except a soft-deleted message", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    await db.update(mailboxes).set({ trashFolder: "Trash" }).where(eq(mailboxes.id, mailboxId));
    const [t1] = await db.insert(threads).values({ accountId, subject: "one" }).returning();
    const [t2] = await db.insert(threads).values({ accountId, subject: "two" }).returning();
    const m1 = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", subject: "m1" });
    const m2 = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", subject: "m2" });
    await db.update(messages).set({ threadId: t1!.id }).where(eq(messages.id, m1));
    await db.update(messages).set({ threadId: t2!.id }).where(eq(messages.id, m2));
    const tags = new TagsService();
    const { dto: tag } = await tags.create(ctx, { name: "probe", hue: "moss" } as never);
    await tags.assign(ctx, m1, tag.id, true);
    const sync = new SyncService();
    const [{ max }] = (await db.execute(sql`select coalesce(max(seq), 0)::text as max from change_log where account_id = ${accountId}`) as { rows: Array<{ max: string }> }).rows;
    const since = sync.encodeCursor(BigInt(max));
    const drafts = new DraftsService();
    const { draft } = await drafts.create(ctx, { mailboxId, subject: "re", inReplyToMessageId: m1 } as never);
    await new ThreadService().merge(ctx, { threadIds: [t1!.id, t2!.id] } as never);
    await tags.remove(ctx, tag.id);
    const del = await new MessageService().delete(ctx, m1).catch((e: unknown) => `refused:${String((e as Error).message)}`);
    await drafts.update(ctx, draft.id, { subject: "re: after the delete" } as never);
    const page = await sync.getChanges(ctx, { since, limit: 500 });
    const all = [...page.changes.creates, ...page.changes.updates, ...page.changes.moves, ...page.changes.deletes];
    const tomb = new Map(page.changes.deletes.map((d) => [d.id, d.type]));
    const crossings: string[] = [];
    for (const c of all) {
      if (c.op === "delete") continue;
      for (const r of refsOf(c)) if (tomb.has(r)) crossings.push(`${c.type}:${c.id.slice(0, 8)}(seq ${c.seq}) names ${tomb.get(r)}:${r.slice(0, 8)}`);
    }
    expect(typeof del, "the Trash delete ran rather than refusing").toBe("object");
    // The page carries every tombstone it was driven to carry: the merged thread, the tag, the message.
    expect([...new Set(tomb.values())].sort()).toEqual(["message", "tag", "thread"]);
    // No live row names the hard-deleted thread or tag; the one crossing is the reply draft (create
    // and edit) naming the soft-deleted message, which kind and feed order apply to one state.
    expect(crossings.filter((c) => !/^draft:.* names message:/.test(c)), "a page named a hard-deleted holder").toEqual([]);
    expect(crossings.filter((c) => /^draft:.* names message:/.test(c))).toHaveLength(2);
  });
});
