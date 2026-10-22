import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  accountSettings, accounts, folderState, mailboxes, messages, organizerRequests, rules,
} from "@trafficflow/db";
import { ScreenerService } from "../src/screener-service.js";
import type { ServiceContext } from "../src/context.js";

/**
 * THE FIXTURE BOTH WAITING-COUNT TWINS READ (pglite and Postgres). Two mailboxes this account
 * organizes, `m1` and `m2`, a 30-day window from a baseline at NOW, and seven senders:
 *
 *   a  held in m1, recent                         -> counts in m1
 *   b  held in m2, recent                         -> counts in m2
 *   c  held in both, recent                       -> counts in each
 *   d  held in m1, 200 days old (dormant)         -> neither
 *   e  held in m1, recent, decided by a rule      -> neither
 *   f  held in m1, recent, decision in flight     -> neither
 *   g  held in m1, 200 days old, but recent INBOX mail in m2 (active through the other mailbox) -> m1
 *
 * So m1 counts 3 (a, c, g) and m2 counts 2 (b, c); the account's queue is 4 (a, b, c, g).
 */
export const NOW = new Date("2026-10-20T09:00:00.000Z");
const DAY = 86_400_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/** `single`: one mailbox holds everything `m2` would, the single-mailbox control. */
export async function waitingFixture(db: Db, opts: { single?: boolean } = {}) {
  const accountId = randomUUID();
  const tag = accountId.slice(0, 8);
  await db.insert(accounts).values({ id: accountId, name: `swc-${tag}` });
  const [m1] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `one-${tag}@example.test`, organizerRole: "organizer", organizeConsentedAt: NOW,
  }).returning();
  const [m2] = opts.single ? [m1] : await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `two-${tag}@example.test`, organizerRole: "organizer", organizeConsentedAt: NOW,
  }).returning();
  await db.insert(accountSettings).values({
    accountId, dormancyDays: 30, screeningScope: "window", screeningBaselineAt: NOW, updatedAt: NOW,
  });
  let k = 0;
  const put = async (mailboxId: string, from: string, ageDays: number, folder: string) => {
    const n = k++;
    const at = new Date(NOW.getTime() - ageDays * DAY - n * 60_000);
    const [m] = await db.insert(messages).values({
      accountId, mailboxId, bodyHash: `h${n}`, dedupKey: `swc:${randomUUID()}`,
      subject: `Note ${n}`, fromAddress: from, date: at, createdAt: at, unread: false,
      nativeLocator: { folder, ref: `1:${n}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: folder, observedFolder: folder,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
  };
  const held = (mailboxId: string, from: string, ageDays = 2) => put(mailboxId, from, ageDays, "ohmail/Screener");
  await held(m1!.id, "a@x.test");
  await held(m2!.id, "b@x.test");
  await held(m1!.id, "c@x.test");
  await held(m2!.id, "c@x.test");
  await held(m1!.id, "d@x.test", 200);
  await held(m1!.id, "e@x.test");
  await held(m1!.id, "f@x.test");
  await held(m1!.id, "g@x.test", 200);
  await put(m2!.id, "g@x.test", 3, "INBOX");
  await db.insert(rules).values({
    accountId, kind: "sender", match: "e@x.test", destination: "INBOX",
    provenance: "manual", enabled: true, priority: 0, retroRequestedAt: null,
  });
  await db.insert(organizerRequests).values({
    accountId, mailboxId: m1!.id, kind: "screener.decide",
    payload: { scope: "sender", match: "f@x.test" }, decidedAt: NOW, state: "pending",
  });
  const ctx = (who = accountId): ServiceContext => ({
    db: db as ServiceContext["db"], accountId: who, userId: null, now: () => NOW, requestId: `swc-${tag}`,
  });
  const svc = new ScreenerService({});
  /** Every sender the queue lists, walking all pages. */
  const listed = async (): Promise<string[]> => {
    const out: string[] = [];
    let page = await svc.list(ctx(), { limit: 2 });
    out.push(...page.items.map((x) => x.sender.address.toLowerCase()));
    while (page.nextCursor !== null) {
      page = await svc.list(ctx(), { limit: 2, cursor: page.nextCursor });
      out.push(...page.items.map((x) => x.sender.address.toLowerCase()));
    }
    return out;
  };
  /** Does this sender have held mail in this mailbox. */
  const heldIn = async (mailboxId: string, sender: string): Promise<boolean> => (await db.select({ id: messages.id })
    .from(messages).innerJoin(folderState, eq(folderState.messageId, messages.id))
    .where(and(eq(messages.mailboxId, mailboxId), eq(messages.fromAddress, sender),
      eq(folderState.desiredFolder, "ohmail/Screener")))).length > 0;
  return { accountId, m1: m1!.id, m2: m2!.id, ctx, svc, listed, heldIn };
}
