import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray, max } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import {
  accounts, applyMessageMove, changeLog, folderState, idempotencyKeys, mailboxes, messages, pressIsAged,
  validateMovePayload, type Tx,
} from "@trafficflow/db";
import { schema, closePooledDbs } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { DrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { MessageService, type ServiceContext } from "@trafficflow/services";

/**
 * A STALE PRESS WRITES NOTHING, ON REAL POSTGRES. A move replayed past its idempotency record over
 * a newer decision is refused inside its transaction before the desired write: no `folder_state`
 * change, no change row, no idempotency claim, no doorbell. And the stamp is the PRESS's floor, so
 * two devices' replays converge on the later press in either order. Scoped to each case's account.
 */
const PG_UP = await realPgAvailable();
const HOUR = 3_600_000;
const t0 = new Date("2026-10-01T08:00:00.000Z");
const svc = new MessageService();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
const made: string[] = [];

/** The API's reading of a press age: the floor, and whether it is old enough to be compared. */
const ctx = (accountId: string, now: Date, pressFloor?: Date): ServiceContext => ({
  db: db as unknown as ServiceContext["db"], accountId, userId: null, now: () => now,
  requestId: `stale-${randomUUID().slice(0, 8)}`,
  ...(pressFloor ? { pressFloor, pressAged: pressIsAged(pressFloor, now) } : {}),
});

async function world(): Promise<{ accountId: string; mailboxId: string; id: string; dedupKey: string }> {
  const accountId = randomUUID();
  made.push(accountId);
  await db.insert(accounts).values({ id: accountId, name: `stale-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `stale-${accountId.slice(0, 8)}@example.test`, trashFolder: "Trash",
  }).returning();
  const dedupKey = randomUUID();
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: randomUUID(), dedupKey, subject: "Invoice",
    fromAddress: "billing@example.test", nativeLocator: { folder: "INBOX", ref: "1:1" },
  }).returning();
  await db.insert(folderState).values({
    messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us", reconcileStatus: "reconciled",
  });
  return { accountId, mailboxId: mb!.id, id: m!.id, dedupKey };
}

/** One word, never a handle: a failed `.rejects` on a live pool prints the pool. */
const verdict = (p: Promise<unknown>): Promise<string> =>
  p.then(() => "applied", (e: unknown) => `refused:${(e as { code?: string }).code ?? (e as Error).message.slice(0, 40)}`);

async function snapshot(w: { accountId: string; mailboxId: string; id: string }) {
  const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, w.id));
  const [seq] = await db.select({ s: max(changeLog.seq) }).from(changeLog).where(eq(changeLog.accountId, w.accountId));
  const keys = await db.select({ key: idempotencyKeys.key }).from(idempotencyKeys).where(eq(idempotencyKeys.accountId, w.accountId));
  const [mb] = await db.select({ at: mailboxes.syncRequestedAt }).from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
  return JSON.stringify({ fs, seq: String(seq?.s ?? null), keys, mb: mb?.at ?? null });
}

describe.skipIf(!PG_UP)("a stale press writes nothing, and decisions meet in press order", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterEach(async () => {
    for (const accountId of made.splice(0)) {
      const ids = db.select({ id: messages.id }).from(messages).where(eq(messages.accountId, accountId));
      await db.delete(changeLog).where(eq(changeLog.accountId, accountId));
      await db.delete(idempotencyKeys).where(eq(idempotencyKeys.accountId, accountId));
      await db.delete(folderState).where(inArray(folderState.messageId, ids));
      await db.delete(messages).where(eq(messages.accountId, accountId));
    }
  });
  afterAll(async () => { await closePooledDbs(); await client?.end({ timeout: 5 }); });

  it("a move refused stale_press leaves folder_state, the change log, the key and the doorbell byte-equal", async () => {
    const w = await world();
    expect(await verdict(svc.move(ctx(w.accountId, new Date(t0.getTime() + 6 * HOUR), new Date(t0.getTime() + 6 * HOUR)), w.id, { folder: "ohmail/News" }))).toBe("applied");
    const before = await snapshot(w);
    const replay = svc.move(ctx(w.accountId, new Date(t0.getTime() + 25 * HOUR), t0), w.id, { folder: "ohmail/Receipts" }, {
      idempotency: { key: "k-a", requestHash: "h-a" },
    });
    expect(await verdict(replay)).toBe("refused:stale_press");
    expect(await snapshot(w)).toBe(before);
    // The positive control: the same replay with no age applies — the snapshot is a reading.
    expect(await verdict(svc.move(ctx(w.accountId, new Date(t0.getTime() + 25 * HOUR)), w.id, { folder: "ohmail/Receipts" }))).toBe("applied");
    expect(await snapshot(w)).not.toBe(before);
  });

  it("D: phone at t0 to Receipts, laptop at t0+1 h to News — either landing order ends in News, stamped with the laptop's press", async () => {
    for (const order of ["phone-first", "laptop-first"] as const) {
      const w = await world();
      const phone = () => svc.move(ctx(w.accountId, new Date(t0.getTime() + 25 * HOUR), t0), w.id, { folder: "ohmail/Receipts" });
      const laptop = () => svc.move(ctx(w.accountId, new Date(t0.getTime() + 26 * HOUR), new Date(t0.getTime() + HOUR)), w.id, { folder: "ohmail/News" });
      const answers = order === "phone-first"
        ? [await verdict(phone()), await verdict(laptop())]
        : [await verdict(laptop()), await verdict(phone())];
      expect([order, answers]).toEqual([order, order === "phone-first" ? ["applied", "applied"] : ["applied", "refused:stale_press"]]);
      const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, w.id));
      expect([order, fs!.desiredFolder, fs!.decidedAt?.getTime()]).toEqual([order, "ohmail/News", t0.getTime() + HOUR]);
    }
  });

  it("G: a move made in another mail client, adopted at +1 h, refuses a replay pressed before it at 25 h", async () => {
    const w = await world();
    const repo = new DrizzleRepo(db as never);
    // The bound the cycle passes: its previous success start, a lower bound of the external move.
    const bound = new Date(t0.getTime() + HOUR);
    const adopted = await repo.adoptFolderState(w.id, {
      desiredFolder: "Archive", observedFolder: "Archive", lastSetBy: "external", reconcileStatus: "reconciled", conflict: false,
    } as never, "INBOX", bound);
    expect(adopted).toBe(true);
    const [fs] = await db.select({ decidedAt: folderState.decidedAt }).from(folderState).where(eq(folderState.messageId, w.id));
    expect(fs!.decidedAt?.getTime()).toBe(bound.getTime());
    expect(await verdict(svc.move(ctx(w.accountId, new Date(t0.getTime() + 25 * HOUR), t0), w.id, { folder: "ohmail/News" }))).toBe("refused:stale_press");
  });

  it("the organizer refuses a reader's request decided before a newer placement, and writes nothing", async () => {
    const w = await world();
    expect(await verdict(svc.move(ctx(w.accountId, new Date(t0.getTime() + 6 * HOUR), new Date(t0.getTime() + 6 * HOUR)), w.id, { folder: "ohmail/News" }))).toBe("applied");
    const before = await snapshot(w);
    const pressed = (at: Date) => validateMovePayload({ dedupKey: w.dedupKey, destination: "receipts", pressedAt: at.toISOString() })!;
    const now = new Date(t0.getTime() + 31 * HOUR);
    const r = await db.transaction((tx) => applyMessageMove(tx as unknown as Tx, {
      accountId: w.accountId, mailboxId: w.mailboxId, payload: pressed(t0), now, decidedAt: now,
    }));
    expect(r).toEqual({ applied: false, refusal: "stale_press" });
    expect(await snapshot(w)).toBe(before);
    const fresh = await db.transaction((tx) => applyMessageMove(tx as unknown as Tx, {
      accountId: w.accountId, mailboxId: w.mailboxId, payload: pressed(new Date(t0.getTime() + 7 * HOUR)), now, decidedAt: now,
    }));
    expect(fresh.applied).toBe(true);
    const [fs] = await db.select({ d: folderState.decidedAt }).from(folderState).where(and(eq(folderState.messageId, w.id)));
    expect(fs!.d?.getTime()).toBe(t0.getTime() + 7 * HOUR);
  });
});
