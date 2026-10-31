import { describe, expect, it } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
import { changeLog, flagState, messages } from "@trafficflow/db";
import { MessageService } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * A BATCH MARKED READ COSTS THE SAME STATEMENTS AT 1 ID AS AT 200. The per-id loop sent six
 * statements a message while the account's seq row was locked; the batch sends one update, one
 * intent upsert and one change block. The result is the loop's: every row flipped, every intent
 * written with its own observed flag, one change per message in the caller's order.
 */

interface Doors { query: (...a: unknown[]) => Promise<unknown>; exec: (...a: unknown[]) => Promise<unknown> }
type Client = Doors & { transaction: (cb: (tx: Doors) => Promise<unknown>) => Promise<unknown> };

/** Every statement the store runs from here on; null where the handle has no such door. */
function recordStatements(db: unknown): string[] | null {
  const client = (db as { $client?: Partial<Client> }).$client;
  if (typeof client?.query !== "function" || typeof client.transaction !== "function") return null;
  const c = client as Client;
  const seen: string[] = [];
  const instrument = <T extends Doors>(t: T): T => {
    for (const door of ["query", "exec"] as const) {
      const inner = t[door].bind(t);
      t[door] = (...a: unknown[]) => { if (typeof a[0] === "string") seen.push(a[0]); return inner(...(a as [])); };
    }
    return t;
  };
  instrument(c);
  const innerTx = c.transaction.bind(c);
  c.transaction = (cb) => innerTx((tx) => cb(instrument(tx)));
  return seen;
}

describe("batch mark-read", () => {
  it("issues the same statements for 1 id and for 200", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const one = await seedMessage(db, accountId, mailboxId, { unread: true });
    const many: string[] = [];
    for (let i = 0; i < 200; i++) many.push(await seedMessage(db, accountId, mailboxId, { unread: true }));
    const seen = recordStatements(db);
    expect(seen, "this file runs on the server store, whose client carries a text door").not.toBeNull();
    if (seen === null) return;
    const svc = new MessageService();

    const a = seen.length;
    await svc.markSeen(ctx, { ids: [one], unread: false });
    const forOne = seen.length - a;
    const b = seen.length;
    await svc.markSeen(ctx, { ids: many, unread: false });
    const forMany = seen.length - b;
    expect(forOne).toBeGreaterThan(0);
    expect(forMany, `1 id cost ${forOne} statements and 200 cost ${forMany}`).toBe(forOne);
  });

  it("an Undo restoring 1 open read and 200 at 200 instants issues the same statements, and restores each", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const one = await seedMessage(db, accountId, mailboxId, { unread: true });
    const many: string[] = [];
    for (let i = 0; i < 200; i++) many.push(await seedMessage(db, accountId, mailboxId, { unread: true }));
    const seen = recordStatements(db);
    if (seen === null) return;
    const svc = new MessageService();
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();

    const a = seen.length;
    await svc.markSeen(ctx, { ids: [one], unread: false, restoreOpenReadAt: { [one]: at(0) } });
    const forOne = seen.length - a;
    const b = seen.length;
    await svc.markSeen(ctx, { ids: many, unread: false, restoreOpenReadAt: Object.fromEntries(many.map((id, i) => [id, at(i)])) });
    expect(seen.length - b, `1 restore cost ${forOne} statements`).toBe(forOne);
    const rows = await db.select({ id: messages.id, openReadAt: messages.openReadAt }).from(messages).where(inArray(messages.id, many));
    const byId = new Map(rows.map((r) => [r.id, r.openReadAt?.toISOString() ?? null]));
    expect(many.map((id) => byId.get(id))).toEqual(many.map((_, i) => at(i)));
  });

  it("flips every row, writes each intent against its own observed flag, one change each in order", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await seedMessage(db, accountId, mailboxId, { unread: i % 2 === 0 }));
    const ordered = [ids[3]!, ids[0]!, ids[5]!, ids[1]!, ids[4]!, ids[2]!];

    const r = await new MessageService().markSeen(ctx, { ids: ordered, unread: false });

    const rows = await db.select({ id: messages.id, unread: messages.unread }).from(messages)
      .where(inArray(messages.id, ids));
    expect(rows.every((m) => !m.unread)).toBe(true);
    const intents = await db.select().from(flagState).where(inArray(flagState.messageId, ids));
    expect(intents).toHaveLength(6);
    for (const f of intents) {
      const wasRead = ids.indexOf(f.messageId) % 2 === 1;
      expect(f.desiredSeen).toBe(true);
      expect(f.observedSeen, "the intent's observed flag is its own row's").toBe(wasRead);
      expect(f.reconcileStatus).toBe(wasRead ? "reconciled" : "pending");
    }
    const changes = await db.select({ id: changeLog.entityId, seq: changeLog.seq }).from(changeLog)
      .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityType, "message"), inArray(changeLog.entityId, ids)))
      .orderBy(asc(changeLog.seq));
    const updates = changes.slice(-6);
    expect(updates.map((c) => c.id), "the deltas land in the caller's order").toEqual(ordered);
    expect(r.seq).toBe(Number(updates[5]!.seq));
    expect(r.items.map((m) => m.id)).toEqual(ordered);
  });
});
