import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  FILING_DOORBELL_MIN_GAP_MS, accounts, folderState, mailboxes, messages,
} from "@trafficflow/db";
import { MessageService, dbFor, type ServiceContext } from "@trafficflow/services";
import { eq } from "drizzle-orm";

/**
 * ═══ A FILING DECISION DID NOT RING THE WORKER'S DOORBELL ════════════════════════════════════
 *
 * The reported wait, measured at its cause. The API never opens IMAP: a press writes
 * `folder_state` and returns, and the worker performs the move. What decides HOW LONG that takes
 * is the rotation — a 60 s tick queues one serialized pass, each mailbox gets one bounded turn in
 * it, and `reconcileFolders` runs on that turn. One pending move therefore waits the rest of the
 * running pass plus its own turn, which is minutes.
 *
 * `mailboxes.sync_requested_at` (mail 0049) is the lever that skips that wait: the worker's ~3 s
 * kick scan notices the stamp and serves the mailbox one ordinary bounded turn out of rotation.
 * Folder operations wrote it, a send wrote it, the pull verb wrote it, the Not-junk rescue wrote
 * it — and the move door, the most common write in the product, did not. It was the one user
 * action whose result waited for a rotation.
 *
 * ── MUTATIONS WATCHED ───────────────────────────────────────────────────────────────────────
 *
 *  · remove the call from `move` ⇒ "a move rings it" red at `null`;
 *  · drop the age predicate ⇒ "a young stamp is left standing" red (the second decision moves a
 *    stamp that is already being answered, i.e. one worker visit per press);
 *  · drop `isNull` from the predicate ⇒ "a move rings it" red — the mailbox that has never been
 *    rung is the one mailbox an instant comparison alone cannot ring;
 *  · drop the `disabled` narrowing ⇒ "a disabled mailbox is not rung" red.
 */

const messageSvc = new MessageService();

type Db = Awaited<ReturnType<typeof makeTestDb>>;

const ctxAt = (db: Db, accountId: string, now: Date): ServiceContext =>
  ({ db: dbFor(db, accountId), accountId, userId: null, now: () => now, requestId: "r" });

const t0 = new Date("2026-09-08T12:00:00.000Z");

async function seed(db: Db, over: { status?: string } = {}): Promise<{
  accountId: string; mailboxId: string; messageId: string;
}> {
  const [a] = await db.insert(accounts).values({ name: "doorbell" }).returning();
  const [mb] = await db.insert(mailboxes).values({
    accountId: a!.id, provider: "imap", address: "person@example.test",
    // The organizer role's own gate refuses a reader's move; these tests are about the doorbell,
    // so the mailbox is this install's to organize.
    organizeConsentedAt: t0,
    ...(over.status ? { status: over.status } : {}),
  }).returning();
  const [m] = await db.insert(messages).values({
    accountId: a!.id, mailboxId: mb!.id,
    dedupKey: "mid:<doorbell@example.test>",
    messageIdHeader: "<doorbell@example.test>",
    fromAddress: "stranger@example.test", subject: "s", date: t0,
    bodyHash: "doorbell-hash",
    nativeLocator: { folder: "INBOX", ref: "1:9" },
  }).returning();
  return { accountId: a!.id, mailboxId: mb!.id, messageId: m!.id };
}

const stampOf = async (db: Db, mailboxId: string): Promise<Date | null> => {
  const [row] = await db.select({ at: mailboxes.syncRequestedAt })
    .from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);
  return row?.at ?? null;
};

describe("a filing decision rings the worker's doorbell", () => {
  it("a MOVE rings it — the decision does not wait for the next rotation", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    expect(await stampOf(db, ids.mailboxId), "nothing has rung yet").toBeNull();

    await messageSvc.move(ctxAt(db, ids.accountId, t0), ids.messageId, { folder: "ohmail/News" });

    // The row the worker will file, and the stamp that brings it forward.
    const [fs] = await db.select({ desired: folderState.desiredFolder })
      .from(folderState).where(eq(folderState.messageId, ids.messageId)).limit(1);
    expect(fs?.desired, "the decision itself must still land").toBe("ohmail/News");
    expect(
      await stampOf(db, ids.mailboxId),
      "a filing decision left the mail waiting for the worker's rotation",
    ).toEqual(t0);
  });

  it("a YOUNG stamp is left standing — fifty presses are not fifty worker visits", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    await messageSvc.move(ctxAt(db, ids.accountId, t0), ids.messageId, { folder: "ohmail/News" });

    // A second decision one second later. The standing stamp is already being answered — the
    // kick clears it within seconds of acting on it — so re-stamping is noise.
    const soon = new Date(t0.getTime() + 1_000);
    await messageSvc.move(ctxAt(db, ids.accountId, soon), ids.messageId, { folder: "ohmail/Receipts" });
    expect(await stampOf(db, ids.mailboxId)).toEqual(t0);
  });

  it("a stamp OLDER than the gap is re-rung — a worker that missed the scan is asked again", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    await messageSvc.move(ctxAt(db, ids.accountId, t0), ids.messageId, { folder: "ohmail/News" });

    const later = new Date(t0.getTime() + FILING_DOORBELL_MIN_GAP_MS + 1_000);
    await messageSvc.move(ctxAt(db, ids.accountId, later), ids.messageId, { folder: "ohmail/Receipts" });
    expect(await stampOf(db, ids.mailboxId)).toEqual(later);
  });

  it("a DISABLED mailbox is not rung — nothing is owed a visit it will decline", async () => {
    const db = await makeTestDb();
    const ids = await seed(db, { status: "disabled" });
    // The move door refuses on a disabled mailbox, so the doorbell is proven at its own seam:
    // the shared writer, driven directly, declines the row.
    const { ringFilingDoorbell } = await import("@trafficflow/db");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await ringFilingDoorbell(db as any, ids.mailboxId, t0)).toBe(false);
    expect(await stampOf(db, ids.mailboxId)).toBeNull();
  });

  it("the gap MATCHES the pull verb's — one decision about how often, not two", () => {
    // `PULL_MIN_GAP_MS` is a private static, so it cannot be imported and compared. It is read
    // out of the source instead, which is the honest form of this census: the two constants are
    // ONE decision about how often this column may be re-stamped, and moving either without the
    // other would give the same column two rates. A rename this regex stops matching reddens
    // here, which is the correct outcome for a census over a name.
    const src = readFileSync(
      fileURLToPath(new URL("../src/mailbox-service.ts", import.meta.url)), "utf8",
    );
    const m = /PULL_MIN_GAP_MS\s*=\s*([0-9_]+)/.exec(src);
    expect(m, "PULL_MIN_GAP_MS is no longer spelled this way in mailbox-service.ts").toBeTruthy();
    expect(Number(m![1]!.replaceAll("_", ""))).toBe(FILING_DOORBELL_MIN_GAP_MS);
  });
});
