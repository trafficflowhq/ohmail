import { describe, it, expect } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxes, messages, folderState } from "@trafficflow/db";
import { StaticKeyProvider } from "@trafficflow/core";
import { makeMailboxService, type ServiceContext } from "@trafficflow/services";

/**
 * HOW MANY OF OUR OWN FILINGS THIS MAILBOX HAS NOT APPLIED YET.
 *
 * ── WHY THE WIRE NEEDED A NEW NUMBER ─────────────────────────────────────────────────────
 *
 * Invariant #3: the serverless API never opens IMAP. A Screener decision, a bulk apply and a
 * move all write `folder_state` and return; the WORKER performs the IMAP move on its next
 * cycle. That is deliberate and it leaves a window in which ohmail has filed the user's mail
 * and their own server has not — a window that does not close at all while the mail host is
 * refusing connections.
 *
 * Nothing else on this DTO can say so. `status` is `connected` (one refused cycle is far short
 * of the failure streak that earns `error`), `errorCode` is null, and `syncBlockedSince` is
 * null because a sync block is OUR infrastructure declining rather than theirs. So the client
 * had every field it needed to report a healthy mailbox and none to report the backlog.
 *
 * ── WHAT THE COUNT MUST AND MUST NOT INCLUDE ─────────────────────────────────────────────
 *
 * Three predicates, and each of the tests below removes exactly one of them. A row is ours to
 * apply only when it is `pending`, only when WE set it (`last_set_by = 'us'`), and only when
 * the two folders actually disagree. Each excluded shape is real: an external pending row is
 * the user tidying in their own client, which we ADOPT rather than push; a pending row whose
 * folders agree is a no-op the reconciler retires without touching IMAP; and `reconciled` is
 * the state this whole number is counting down to.
 *
 * PGlite deliberately: this is about which rows one aggregate counts, not about concurrency.
 * The convergence half — an adapter that throws mid-reconcile, re-run, no duplicate copies —
 * needs real Postgres and lives in `apps/worker/test/reconcile-resume.pg.test.ts`.
 */

const NOW = new Date("2026-08-06T12:00:00.000Z");
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7), 1);
const svc = makeMailboxService({ keyProvider: KP });

type Db = Awaited<ReturnType<typeof makeTestDb>>;

const ctxFor = (db: Db, accountId: string): ServiceContext =>
  ({ db, accountId, userId: null, now: () => NOW, requestId: "r" });

async function seed(db: Db): Promise<{ accountId: string; mailboxId: string }> {
  const [a] = await db.insert(accounts).values({ name: "pending moves" }).returning();
  const [mb] = await db.insert(mailboxes).values({
    accountId: a!.id, provider: "imap", address: "person@example.test",
  }).returning();
  return { accountId: a!.id, mailboxId: mb!.id };
}

/** One message plus the `folder_state` row that says where it is going and where it is. */
async function seedFiling(
  db: Db,
  ids: { accountId: string; mailboxId: string },
  n: number,
  fs: { desired: string; observed: string; status: "pending" | "reconciled" | "failed"; by: "us" | "external" },
): Promise<void> {
  const [m] = await db.insert(messages).values({
    accountId: ids.accountId,
    mailboxId: ids.mailboxId,
    dedupKey: `mid:<bc7-${n}@example.test>`,
    messageIdHeader: `<bc7-${n}@example.test>`,
    fromAddress: "stranger@example.test",
    subject: `s${n}`,
    date: NOW,
    bodyHash: `bc7-hash-${n}`,
  }).returning();
  await db.insert(folderState).values({
    messageId: m!.id, accountId: m!.accountId,
    desiredFolder: fs.desired,
    observedFolder: fs.observed,
    reconcileStatus: fs.status,
    lastSetBy: fs.by,
  });
}

const OURS_PENDING = { desired: "ohmail/News", observed: "INBOX", status: "pending", by: "us" } as const;

describe("MailboxDTO.pendingMoves — the filings the mail server has not applied", () => {
  it("is 0 on a mailbox with nothing outstanding, and 0 is a real answer", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    const dto = await svc.get(ctxFor(db, ids.accountId), ids.mailboxId);
    // NOT absent and not null. `undefined` on this wire means "a server older than the column",
    // which the client renders as silence; `0` means "we looked, and there is nothing".
    expect(dto.pendingMoves).toBe(0);
  });

  it("counts our own pending filings, and the number is the work the reconciler will do", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    for (let i = 0; i < 3; i++) await seedFiling(db, ids, i, OURS_PENDING);
    const dto = await svc.get(ctxFor(db, ids.accountId), ids.mailboxId);
    expect(dto.pendingMoves).toBe(3);
  });

  it("EXCLUDES rows the user set in their own client — their tidying is not our backlog", async () => {
    // `last_set_by = 'external'` is a move the user made on their own server, which the
    // reconciler ADOPTS rather than pushes. Counting it would report the user's own filing back
    // to them as work ohmail owes them.
    const db = await makeTestDb();
    const ids = await seed(db);
    await seedFiling(db, ids, 0, OURS_PENDING);
    await seedFiling(db, ids, 1, { ...OURS_PENDING, by: "external" });
    const dto = await svc.get(ctxFor(db, ids.accountId), ids.mailboxId);
    expect(dto.pendingMoves).toBe(1);
  });

  it("EXCLUDES a pending row whose folders already agree — a no-op is not work", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    await seedFiling(db, ids, 0, OURS_PENDING);
    await seedFiling(db, ids, 1, { ...OURS_PENDING, observed: "ohmail/News" });
    const dto = await svc.get(ctxFor(db, ids.accountId), ids.mailboxId);
    expect(dto.pendingMoves).toBe(1);
  });

  it("EXCLUDES reconciled and failed rows — both are terminal, and failed is a different sentence", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    await seedFiling(db, ids, 0, OURS_PENDING);
    await seedFiling(db, ids, 1, { ...OURS_PENDING, status: "reconciled" });
    await seedFiling(db, ids, 2, { ...OURS_PENDING, status: "failed" });
    const dto = await svc.get(ctxFor(db, ids.accountId), ids.mailboxId);
    expect(dto.pendingMoves).toBe(1);
  });

  it("is SCOPED TO THE MAILBOX — a second mailbox's backlog is not this one's", async () => {
    // `folder_state` has no mailbox column; the count reaches it through `messages`. Drop that
    // join predicate and one mailbox reports the account's whole backlog as its own.
    const db = await makeTestDb();
    const ids = await seed(db);
    const [other] = await db.insert(mailboxes).values({
      accountId: ids.accountId, provider: "imap", address: "second@example.test",
    }).returning();
    await seedFiling(db, ids, 0, OURS_PENDING);
    await seedFiling(db, { accountId: ids.accountId, mailboxId: other!.id }, 1, OURS_PENDING);
    await seedFiling(db, { accountId: ids.accountId, mailboxId: other!.id }, 2, OURS_PENDING);

    expect((await svc.get(ctxFor(db, ids.accountId), ids.mailboxId)).pendingMoves).toBe(1);
    expect((await svc.get(ctxFor(db, ids.accountId), other!.id)).pendingMoves).toBe(2);
  });

  it("is on the LIST projection too, which is the one the shell strip actually reads", async () => {
    // `GET /mailboxes` is what `CloudShell#mailboxFacts` calls. A field present on `get` and
    // absent from `list` would be a column nothing on screen can ever see — the shape of the
    // three gaps this DTO's own comments already record.
    const db = await makeTestDb();
    const ids = await seed(db);
    for (let i = 0; i < 2; i++) await seedFiling(db, ids, i, OURS_PENDING);
    const items = await svc.list(ctxFor(db, ids.accountId));
    expect(items.map((m) => m.pendingMoves)).toEqual([2]);
  });
});
