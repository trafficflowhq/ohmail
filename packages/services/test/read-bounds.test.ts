import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxFolders, mailboxes } from "@trafficflow/db";
import { MailboxService } from "../src/mailbox-service.js";
import { IMAP_LIST_MAX_FOLDERS } from "@trafficflow/core/adapters/imap";
import {
  FolderOpsService, ReadBoundExceeded, FOLDER_INVENTORY_MAX, ACCOUNT_MAILBOXES_MAX_READ,
  setFoldersEnabled, type ServiceContext,
} from "../src/index.js";

/**
 * ═══ THE THIRD AXIS: STORED CARDINALITY ════════════════════════════════════════════════════
 *
 * A request carrying one folder id read every folder row its mailbox has, turned the array into an
 * `IN` list, and counted messages against it. Nothing on that path bounds anything: the input
 * census sees a scalar path parameter and correctly says it is bounded; the IMAP census sees no
 * server read at all. The collection is sized by the user's own mail server and grows.
 *
 * What the ceiling has to be is a REFUSAL and not a truncation, because the answer is a COUNT: a
 * `LIMIT` with no refusal would answer "how many messages would this delete" from an arbitrary
 * subset of the subtree, which is a wrong number wearing a right one's clothes.
 */

const svc = new FolderOpsService();

async function setup() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: "own@example.com", trashFolder: "Trash" })
    .returning();
  const ctx: ServiceContext = {
    db, accountId, userId: null,
    now: () => new Date("2026-09-13T00:00:00.000Z"), requestId: "r",
  };
  await setFoldersEnabled(ctx, true);
  return { db, accountId, mailboxId: mb.id, ctx };
}

/** `n` folder rows under `Projects/`, plus the subject itself, inserted in one statement. */
async function inventory(
  db: Awaited<ReturnType<typeof makeTestDb>>, mailboxId: string, n: number,
): Promise<string> {
  const [subject] = await db.insert(mailboxFolders)
    .values({ mailboxId, folder: "Projects", uidvalidity: 1n, uidnext: 1n, highestmodseq: 1n })
    .returning();
  const rows = Array.from({ length: n }, (_, i) => ({
    mailboxId, folder: `Projects/p${i}`, uidvalidity: 1n, uidnext: 1n, highestmodseq: 1n,
  }));
  for (let i = 0; i < rows.length; i += 2_000) {
    await db.insert(mailboxFolders).values(rows.slice(i, i + 2_000));
  }
  return subject!.id;
}

describe("the folder summary is bounded at the read", () => {
  /**
   * THE CITATION, CHECKED. `FOLDER_INVENTORY_MAX` restates the adapter's LIST ceiling rather than
   * importing it — importing would pull the IMAP adapter into every request path — and a restated
   * number is only as good as the check that the two have not drifted. This is that check: the
   * mirror is filled from LIST, so a mirrored subtree may not be allowed more folders than one
   * LIST may name.
   */
  it("restates the adapter's LIST ceiling and has not drifted from it", () => {
    expect(FOLDER_INVENTORY_MAX).toBe(IMAP_LIST_MAX_FOLDERS);
  });

  /**
   * THE POSITIVE CONTROL, at the ceiling exactly — the expensive one, and the one that matters:
   * a ceiling that refused AT its own number would be an off-by-one nobody would find until a
   * real mailbox sat on it.
   */
  it("answers a subtree AT the ceiling", async () => {
    const { db, mailboxId, ctx } = await setup();
    // The subject plus `MAX - 1` children is exactly the ceiling of folders.
    const id = await inventory(db, mailboxId, FOLDER_INVENTORY_MAX - 1);

    const out = await svc.summary(ctx, id);

    expect(out.folders).toBe(FOLDER_INVENTORY_MAX);
    expect(out.messages).toBe(0);
  }, 120_000);

  it("refuses one folder past it, and says so rather than counting a subset", async () => {
    const { db, mailboxId, ctx } = await setup();
    // FIFTY past the ceiling, not one: the discriminating number is what the READ transferred,
    // and a `filter` over rows that already arrived would report all of them.
    const over = 50;
    const id = await inventory(db, mailboxId, FOLDER_INVENTORY_MAX + over);

    const err = await svc.summary(ctx, id).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ReadBoundExceeded);
    expect((err as ReadBoundExceeded).bound).toBe("folder_inventory");
    expect((err as ReadBoundExceeded).code).toBe("read_bound_exceeded");
    /* THE CEILING IS ON THE READ. The table holds fifty more rows than this number, and they were
     * never transferred — the probe row is the only one past the ceiling that crossed the wire.
     * A ceiling applied after the rows arrive would read `FOLDER_INVENTORY_MAX + over` here. */
    expect((err as ReadBoundExceeded).read).toBe(FOLDER_INVENTORY_MAX + 1);
    // A refusal a person can act on, and never a 500: nothing is broken, the collection is
    // larger than one answer may cover.
    expect((err as ReadBoundExceeded).httpStatus).toBe(409);
  }, 120_000);

  /** The ordinary mailbox — the shape every real one has — is untouched by any of it. */
  it("answers an ordinary subtree exactly as it did", async () => {
    const { db, mailboxId, ctx } = await setup();
    const id = await inventory(db, mailboxId, 4);

    const out = await svc.summary(ctx, id);

    expect(out.folders).toBe(5);
    expect(out.messages).toBe(0);
  });
});

/**
 * ── THE SECOND KIND: AN ACCOUNT'S CONNECTED MAILBOXES ──────────────────────────────────────
 *
 * `requestPull` locks every connected mailbox of the account with a `select … for update` that had
 * no `LIMIT`, and turns the ids into an `IN` list. The ceiling here is DECLARED rather than
 * measured — the reading is owed (MANUAL-STEPS 33) and the constant says so — so what these cases
 * are about is the SHAPE, which is what a declared number has to get right: it refuses by name
 * rather than truncating, because this answer has to cover every connected mailbox; and it is
 * applied at the read, so a runaway account never builds the parameter list at all.
 */
const pull = new MailboxService({ signatureChecks: false });

/** `n` connected mailboxes on one account. */
async function connected(
  db: Awaited<ReturnType<typeof makeTestDb>>, accountId: string, n: number,
): Promise<void> {
  const rows = Array.from({ length: n }, (_, i) => ({
    accountId, provider: "imap" as const, address: `m${i}@example.invalid`,
    status: "connected" as const,
  }));
  for (let i = 0; i < rows.length; i += 2_000) {
    await db.insert(mailboxes).values(rows.slice(i, i + 2_000));
  }
}

describe("the account-wide mailbox read is bounded at the read", () => {
  it("answers an ordinary account exactly as it did", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    await connected(db, accountId, 3);
    const ctx: ServiceContext = {
      db, accountId, userId: null,
      now: () => new Date("2026-09-13T00:00:00.000Z"), requestId: "r",
    };

    const out = await pull.requestPull(ctx);

    expect(out.requested).toBe(3);
    expect(out.mailboxes).toHaveLength(3);
  });

  it("refuses past the ceiling, and stamps nothing", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const over = 5;
    await connected(db, accountId, ACCOUNT_MAILBOXES_MAX_READ + over);
    const ctx: ServiceContext = {
      db, accountId, userId: null,
      now: () => new Date("2026-09-13T00:00:00.000Z"), requestId: "r",
    };

    const err = await pull.requestPull(ctx).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ReadBoundExceeded);
    expect((err as ReadBoundExceeded).bound).toBe("account_mailboxes");
    /* BOUNDED AT THE READ: the account holds five more than this number and they were never
     * transferred. A ceiling applied to rows that already arrived would report all of them. */
    expect((err as ReadBoundExceeded).read).toBe(ACCOUNT_MAILBOXES_MAX_READ + 1);
    // NOTHING WAS STAMPED — the refusal is a refusal, not a partial pass over a prefix.
    const stamped = await db.select({ id: mailboxes.id }).from(mailboxes)
      .where(eq(mailboxes.accountId, accountId));
    expect(stamped.length).toBe(ACCOUNT_MAILBOXES_MAX_READ + over);
    const anyStamp = await db.select({ at: mailboxes.syncRequestedAt }).from(mailboxes)
      .where(eq(mailboxes.accountId, accountId));
    expect(anyStamp.every((r) => r.at === null)).toBe(true);
  }, 120_000);
});
