import { expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { folderState, messageInstances, messages, messageStates } from "@trafficflow/db";
import { DrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { TriageService, type ServiceContext } from "../src/index.js";

/**
 * THE EXPUNGE-LEAVES-THE-PILE SCENARIO, one body for every store it is asked of.
 * Three letters in Answer Later; the server expunges one, so it has no watched instance left; the
 * reaper (`tombstoneInstanceless`, the sync's own pass) tombstones it. The pile and Reply Run then
 * list the two that exist, and a letter that comes back (the adopt path) is filed again — the
 * state row is kept on purpose so a returning letter keeps its pile.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

async function letter(db: AnyDb, accountId: string, mailboxId: string, n: number, watched: boolean): Promise<string> {
  const dedup = `mid:<pile-gone-${randomUUID()}@example.test>`;
  const [m] = await db.insert(messages).values({
    accountId, mailboxId, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
    subject: `letter ${n}`, fromAddress: "someone@example.test", nativeLocator: { folder: "INBOX", ref: `1:${n}` },
    date: new Date(Date.UTC(2026, 9, 1, n)), arrivedAt: new Date(Date.UTC(2026, 9, 1, n)),
  }).returning();
  await db.insert(folderState).values({
    messageId: m.id, accountId: m.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
    reconcileStatus: "reconciled", conflict: false,
  });
  if (watched) {
    await db.insert(messageInstances).values({
      accountId, mailboxId, messageId: m.id, folder: "INBOX", uidvalidity: 1n, uid: n, isPrimary: true,
    });
  }
  return m.id as string;
}

export async function expungeLeavesThePile(
  db: AnyDb, ctx: ServiceContext, mailboxId: string,
): Promise<void> {
  const svc = new TriageService();
  const gone = await letter(db, ctx.accountId, mailboxId, 1, false);
  const kept = await letter(db, ctx.accountId, mailboxId, 2, true);
  const third = await letter(db, ctx.accountId, mailboxId, 3, true);
  for (const id of [gone, kept, third]) await svc.setState(ctx, id, { state: "reply_later" });
  const pile = async () => (await svc.listByState(ctx, "reply_later")).items.map((m) => m.id);

  // The positive control: every parked letter is filed while it exists.
  expect(await pile()).toEqual([third, kept, gone]);

  const repo = new DrizzleRepo(db);
  expect(await repo.transaction((r) => r.tombstoneInstanceless!(ctx.accountId, mailboxId, 50))).toBe(1);
  expect(await pile(), "the expunged letter leaves Answer Later at the pass that sees it gone").toEqual([third, kept]);
  expect((await svc.focusReply(ctx)).items.map((i) => i.message.id), "and Reply Run").toEqual([third, kept]);

  // The state row is KEPT, so a letter that comes back is filed again.
  const [row] = await db.select({ state: messageStates.state }).from(messageStates)
    .where(and(eq(messageStates.messageId, gone), eq(messageStates.accountId, ctx.accountId)));
  expect(row?.state).toBe("reply_later");
  expect(await repo.clearDeletedOnAdopt(gone)).toBe(true);
  expect(await pile(), "a returning letter is in its pile again").toEqual([third, kept, gone]);
}
