import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, sql } from "drizzle-orm";
import {
  folderState, mailboxFolders, mailboxes, messages, messageInstances, accounts, changeLog, OrganizedElsewhereError,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import {
  MIGRATED_DB_SETUP_BUDGET_MS, MIGRATED_DB_TEARDOWN_BUDGET_MS, realPgAvailable, throwawayDb,
} from "@trafficflow/db/testing";
import { MessageService, type ServiceContext } from "../src/index.js";
import { brandDialect } from "@trafficflow/db/dialect";

/**
 * TRASH — WHERE A DELETED MESSAGE CAME FROM, THE LIST, AND RESTORE (mail 0099).
 *
 * ══ WHY `.pg.test.ts`, AND WHY ON A PRIVATE DATABASE ════════════════════════════════════════
 *
 * PGlite is the wrong oracle for every assertion here. The delete's origin write and the
 * restore's clear ride an `ON CONFLICT DO UPDATE` whose `set` clause decides whether an EXISTING
 * row's column moves; the list arm compares two columns from different tables in a raw `sql`
 * fragment (`folder_state.desired_folder = mailboxes.trash_folder`), which is exactly the shape
 * PGlite and postgres@3 have disagreed about before; and the keyset walks a `timestamptz`.
 *
 * The database is PRIVATE and created by this file, not the shared `trafficflow_test`. This lane
 * carries a migration, and a run against the shared box records its `when` there — after which
 * drizzle applies only a `when` strictly above it, so every LOWER migration in the release chain
 * is silently recorded as applied without running. That is measured, not theoretical: a filler
 * lane's twin blocked fourteen of another lane's box cases that way, and not one of the reds was
 * a defect in the lane they were reported against.
 */
const PG_UP = await realPgAvailable();

/* Built and removed by the hooks below, which name the budgets that work costs. */
const privateDb = throwawayDb("trafficflow_trash");

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ACCOUNT = randomUUID();
const TRASH = "Trash";

/** Fixed instants, so "ordered by deletion time" is asserted rather than raced. */
const t0 = new Date("2026-09-09T10:00:00.000Z");
const t1 = new Date("2026-09-09T11:00:00.000Z");
const t2 = new Date("2026-09-09T12:00:00.000Z");

function ctxAt(at: Date): ServiceContext {
  return {
    db: db as never,
    accountId: ACCOUNT,
    userId: null,
    now: () => at,
    requestId: `trash-${at.toISOString()}`,
  };
}

describe.skipIf(!PG_UP)("mail 0099 — Trash on real Postgres", () => {
  let mb: string;
  let mbNoTrash: string;
  const svc = () => new MessageService();

  /** A message with a server copy in `folder`; `watched` also records its instance, as ingest does. */
  const msg = async (
    folder: string, opts: { mailbox?: string; subject?: string; watched?: boolean } = {},
  ): Promise<string> => {
    const id = randomUUID();
    await db.insert(messages).values({
      id, accountId: ACCOUNT, mailboxId: opts.mailbox ?? mb,
      subject: opts.subject ?? `s-${id.slice(0, 8)}`,
      bodyHash: `h-${id.slice(0, 8)}`, dedupKey: `d-${id}`,
      nativeLocator: { folder, ref: `7:${Math.floor(Math.random() * 100000)}` },
      date: new Date("2026-01-01T00:00:00.000Z"),
    });
    await db.insert(folderState).values({
      messageId: id, desiredFolder: folder, observedFolder: folder, lastSetBy: "external",
    });
    if (opts.watched) {
      await db.insert(messageInstances).values({
        accountId: ACCOUNT, mailboxId: opts.mailbox ?? mb, messageId: id, folder,
        uidvalidity: 7n, uid: Math.floor(Math.random() * 100000), isPrimary: true,
      });
    }
    return id;
  };

  /** True once a backend waits on a row lock over `folder_state`: the press is parked behind the rival. */
  const waitForLockWait = async (deadlineMs = 10_000): Promise<boolean> => {
    const until = Date.now() + deadlineMs;
    while (Date.now() < until) {
      const [row] = await client<Array<{ n: number }>>`
        select count(*)::int as n from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock' and state = 'active'
           and query ilike '%folder_state%'`;
      if ((row?.n ?? 0) > 0) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };

  /** A restore pressed while a rival holds the row; `rivalWrites` runs on the rival before it commits. */
  const restoreBehindRival = async (id: string, rivalWrites: (rival: postgres.ReservedSql) => Promise<unknown>) => {
    const rival = await client.reserve();
    try {
      await rival`begin`;
      await rival`select 1 from folder_state where message_id = ${id}::uuid for update`;
      const pressed = svc().restore(ctxAt(t2), id);
      const blocked = await waitForLockWait();
      await rivalWrites(rival);
      await rival`commit`;
      return { out: await pressed, blocked };
    } finally {
      rival.release();
    }
  };

  const fsOf = async (id: string) => {
    const [r] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    return r!;
  };
  const deletedAtOf = async (id: string) => {
    const [r] = await db.select({ d: messages.deletedAt }).from(messages).where(eq(messages.id, id));
    return r!.d;
  };

  beforeAll(async () => {
    await privateDb.createFromTemplate();
    client = postgres(privateDb.url, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");

    await db.insert(accounts).values({ id: ACCOUNT, name: `trash-${ACCOUNT.slice(0, 8)}` });
    const [box] = await db.insert(mailboxes).values({
      id: randomUUID(), accountId: ACCOUNT, provider: "imap",
      address: `trash-${ACCOUNT.slice(0, 8)}@x.example`,
      trashFolder: TRASH,
      organizerRole: "organizer",
      organizeConsentedAt: t0,
    }).returning();
    mb = box!.id;
    // A SECOND mailbox with NO Trash path — the arm the list's join must exclude rather than
    // match against a null.
    const [box2] = await db.insert(mailboxes).values({
      id: randomUUID(), accountId: ACCOUNT, provider: "imap",
      address: `notrash-${ACCOUNT.slice(0, 8)}@x.example`,
      organizerRole: "organizer",
      organizeConsentedAt: t0,
    }).returning();
    mbNoTrash = box2!.id;
    // One LIVE user folder, and deliberately no row for "Gone" — the fallback's own case.
    await db.insert(mailboxFolders).values({
      mailboxId: mb, folder: "Projects", uidvalidity: 7n, uidnext: 9n, highestmodseq: 3n,
    });
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  beforeEach(async () => {
    /* Every case seeds its own rows. Cleared BETWEEN cases and not only at the end, because two
       cases that both list Trash would otherwise measure each other's fixtures — the shared-table
       poisoning shape, reproduced inside one file. */
    await db.execute(sql`delete from folder_state where message_id in (select id from messages where account_id = ${ACCOUNT})`);
    await db.delete(changeLog).where(eq(changeLog.accountId, ACCOUNT));
    await db.delete(messageInstances).where(eq(messageInstances.accountId, ACCOUNT));
    await db.delete(messages).where(eq(messages.accountId, ACCOUNT));
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await privateDb.drop();
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  it("delete records WHERE IT CAME FROM, and the change row carries from-and-to", async () => {
    const id = await msg("ohmail/News");
    await svc().delete(ctxAt(t1), id);

    const fs = await fsOf(id);
    expect(fs.desiredFolder, "desired is the mailbox's Trash path").toBe(TRASH);
    expect(fs.trashedFrom, "the origin, as observed at the press").toBe("ohmail/News");
    expect(await deletedAtOf(id), "and the row is tombstoned").not.toBeNull();

    const [row] = await db.select().from(changeLog)
      .where(eq(changeLog.entityId, id)).orderBy(sql`${changeLog.seq} desc`).limit(1);
    expect(row!.op).toBe("delete");
    expect(row!.meta, "history only — nothing reads it").toEqual({ from: "ohmail/News", to: TRASH });
  });

  it("a delete of a message ALREADY in Trash records NO origin — there is nothing to remember", async () => {
    const id = await msg(TRASH);
    await svc().delete(ctxAt(t1), id);
    expect((await fsOf(id)).trashedFrom).toBeNull();
  });

  it("EVERY non-Trash desired write CLEARS the origin, so a second delete cannot inherit the first's", async () => {
    const id = await msg("ohmail/News");
    await svc().delete(ctxAt(t1), id);
    expect((await fsOf(id)).trashedFrom).toBe("ohmail/News");

    // Filed somewhere else — a move, which is not a delete.
    await svc().move(ctxAt(t2), id, { folder: "ohmail/Receipts" });
    expect((await fsOf(id)).trashedFrom, "the move cleared it").toBeNull();

    /* And the SECOND delete records the NEW place. This is the assertion the mutation below
       reddens: with the clear dropped, this reads "ohmail/News" — the origin of a previous
       life — and a restore would put the message somewhere it had not been for hours. */
    await db.update(folderState).set({ observedFolder: "ohmail/Receipts" })
      .where(eq(folderState.messageId, id));
    await svc().delete(ctxAt(t2), id);
    expect((await fsOf(id)).trashedFrom).toBe("ohmail/Receipts");
  });

  it("list(view: trash) answers the TOMBSTONED rows, newest deletion first, with trashedAt and a resolved restoreTo", async () => {
    const older = await msg("ohmail/News");
    const newer = await msg("Projects");
    await svc().delete(ctxAt(t1), older);
    await svc().delete(ctxAt(t2), newer);

    const page = await svc().listTrash(ctxAt(t2), { view: "trash" });
    expect(page.items.map((m) => m.id), "deletion time desc").toEqual([newer, older]);
    expect(page.items[0]!.trashedAt).toBe(t2.toISOString());
    expect(page.items[0]!.restoreTo, "a live user folder resolves to itself").toBe("Projects");
    expect(page.items[1]!.restoreTo, "one of the six resolves to itself").toBe("ohmail/News");
    expect(page.nextCursor).toBeNull();
  });

  it("and it EXCLUDES a row the expunge reaper tombstoned — nobody deleted that one here", async () => {
    const deleted = await msg("ohmail/News");
    await svc().delete(ctxAt(t1), deleted);
    /* The reaper's shape: `deleted_at` stamped, `folder_state` untouched, so desired is still
       wherever the message last was. It is tombstoned and it is NOT in Trash. */
    const reaped = await msg("INBOX");
    await db.update(messages).set({ deletedAt: t1 }).where(eq(messages.id, reaped));

    const page = await svc().listTrash(ctxAt(t2), { view: "trash" });
    expect(page.items.map((m) => m.id)).toEqual([deleted]);
  });

  it("a mailbox with NO Trash path contributes nothing — its null is not a match", async () => {
    const orphan = await msg("INBOX", { mailbox: mbNoTrash });
    /* Written by hand: the delete verb refuses this mailbox 422 up front, so the only way this
       row could reach the list is a null comparing equal to something, which is the arm under
       test. `desired_folder` is set to the literal a single-mailbox implementation would have
       compared against. */
    await db.update(folderState).set({ desiredFolder: TRASH }).where(eq(folderState.messageId, orphan));
    await db.update(messages).set({ deletedAt: t1 }).where(eq(messages.id, orphan));

    const page = await svc().listTrash(ctxAt(t2), { view: "trash" });
    expect(page.items).toHaveLength(0);
  });

  it("the keyset walks the whole list — page two continues where page one stopped", async () => {
    const a = await msg("INBOX");
    const b = await msg("INBOX");
    const c = await msg("INBOX");
    await svc().delete(ctxAt(t0), a);
    await svc().delete(ctxAt(t1), b);
    await svc().delete(ctxAt(t2), c);

    const p1 = await svc().listTrash(ctxAt(t2), { view: "trash", limit: 2 });
    expect(p1.items.map((m) => m.id)).toEqual([c, b]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await svc().listTrash(ctxAt(t2), { view: "trash", limit: 2, cursor: p1.nextCursor! });
    expect(p2.items.map((m) => m.id)).toEqual([a]);
    expect(p2.nextCursor).toBeNull();
  });

  it("restore with NO watched copy on record writes desired = the origin, clears it, and does NOT clear deleted_at", async () => {
    const id = await msg("ohmail/News");
    await svc().delete(ctxAt(t1), id);

    const out = await svc().restore(ctxAt(t2), id);
    expect(out.restoreTo).toBe("ohmail/News");
    expect(out.pending).toBe(true);

    const fs = await fsOf(id);
    expect(fs.desiredFolder).toBe("ohmail/News");
    expect(fs.trashedFrom, "the origin has been spent").toBeNull();
    expect(fs.lastSetBy).toBe("us");
    expect(fs.reconcileStatus).toBe("pending");
    /* THE TOMBSTONE STAYS. The mirror says the message is back when the SERVER has it back —
       `clearDeletedOnAdopt` does that when the passive read observes it in the target. Clearing
       it here would show mail in a place the mail server does not have it. */
    expect(await deletedAtOf(id), "the mailbox is the master").not.toBeNull();

    const [row] = await db.select().from(changeLog)
      .where(eq(changeLog.entityId, id)).orderBy(sql`${changeLog.seq} desc`).limit(1);
    expect(row!.op).toBe("move");
    expect(row!.meta).toEqual({ from: TRASH, to: "ohmail/News" });

    // And the row has LEFT the Trash list, because its desired folder is no longer Trash.
    const page = await svc().listTrash(ctxAt(t2), { view: "trash" });
    expect(page.items).toHaveLength(0);
  });

  it("restore of a delete whose move has not landed CANCELS it: the letter is back at once", async () => {
    const id = await msg("ohmail/News", { watched: true });
    await svc().delete(ctxAt(t1), id);

    const out = await svc().restore(ctxAt(t2), id);
    expect(out).toMatchObject({ restoreTo: "ohmail/News", pending: false });
    expect(await deletedAtOf(id), "nothing reached the server, so nothing waits for it").toBeNull();
    expect(await fsOf(id)).toMatchObject({
      desiredFolder: "ohmail/News", observedFolder: "ohmail/News", reconcileStatus: "reconciled", trashedFrom: null,
    });
    const [row] = await db.select().from(changeLog)
      .where(eq(changeLog.entityId, id)).orderBy(sql`${changeLog.seq} desc`).limit(1);
    expect(row!.op).toBe("update");
    expect(Number(row!.seq)).toBe(out.seq);
  });

  it("a park that commits while the restore waits on the row sends the restore down the landed path", async () => {
    const id = await msg("ohmail/News", { watched: true });
    await svc().delete(ctxAt(t1), id);

    const { out, blocked } = await restoreBehindRival(id, (rival) => rival`
      update folder_state set observed_folder = ${TRASH}, reconcile_status = 'reconciled', last_set_by = 'us'
       where message_id = ${id}::uuid`);
    expect(blocked, "the restore never waited on the row, so this proved nothing").toBe(true);
    expect(out).toMatchObject({ restoreTo: "ohmail/News", pending: true });
    expect(await deletedAtOf(id), "the copy is in the server's Trash: the tombstone stands").not.toBeNull();
    expect(await fsOf(id)).toMatchObject({
      desiredFolder: "ohmail/News", observedFolder: TRASH, reconcileStatus: "pending",
    });
  }, 60_000);

  it("a rival that touches the row without landing the park leaves the cancel to the restore", async () => {
    const id = await msg("ohmail/News", { watched: true });
    await svc().delete(ctxAt(t1), id);

    const { out, blocked } = await restoreBehindRival(id, (rival) => rival`
      update folder_state set attempts = attempts + 1 where message_id = ${id}::uuid`);
    expect(blocked, "the restore never waited on the row, so this proved nothing").toBe(true);
    expect(out).toMatchObject({ restoreTo: "ohmail/News", pending: false });
    expect(await deletedAtOf(id)).toBeNull();
    expect(await fsOf(id)).toMatchObject({ desiredFolder: "ohmail/News", observedFolder: "ohmail/News" });
  }, 60_000);

  it("the target falls back to INBOX when the origin folder no longer exists", async () => {
    const id = await msg("Projects");
    await svc().delete(ctxAt(t1), id);
    expect((await fsOf(id)).trashedFrom).toBe("Projects");
    // The folder is deleted while its mail sits in Trash — the case the fallback exists for.
    await db.delete(mailboxFolders).where(eq(mailboxFolders.folder, "Projects"));

    const listed = await svc().listTrash(ctxAt(t2), { view: "trash" });
    expect(listed.items[0]!.restoreTo, "the row says so before the press").toBe("INBOX");
    const out = await svc().restore(ctxAt(t2), id);
    expect(out.restoreTo).toBe("INBOX");
    expect((await fsOf(id)).desiredFolder).toBe("INBOX");

    // Put it back for the cases that follow.
    await db.insert(mailboxFolders).values({
      mailboxId: mb, folder: "Projects", uidvalidity: 7n, uidnext: 9n, highestmodseq: 3n,
    });
  });

  it("a row with NO recorded origin restores to INBOX", async () => {
    const id = await msg(TRASH);
    await svc().delete(ctxAt(t1), id);
    expect((await fsOf(id)).trashedFrom).toBeNull();
    expect((await svc().restore(ctxAt(t2), id)).restoreTo).toBe("INBOX");
  });

  it("restore refuses 409 not_in_trash outside Trash — never deleted, and already restored", async () => {
    const never = await msg("INBOX");
    await expect(svc().restore(ctxAt(t2), never)).rejects.toMatchObject({
      code: "not_in_trash", httpStatus: 409,
    });

    const once = await msg("ohmail/News");
    await svc().delete(ctxAt(t1), once);
    await svc().restore(ctxAt(t2), once);
    /* THE SECOND PRESS. Not an error about a missing message and not a second move: the state
       itself is what makes this verb idempotent in the way that matters. */
    await expect(svc().restore(ctxAt(t2), once)).rejects.toMatchObject({
      code: "not_in_trash", httpStatus: 409,
    });
  });

  it("restore refuses a READER, and refuses it for the reason that is true", async () => {
    const id = await msg("ohmail/News");
    await svc().delete(ctxAt(t1), id);
    await db.update(mailboxes).set({ organizerRole: "reader" }).where(eq(mailboxes.id, mb));
    try {
      const err = await svc().restore(ctxAt(t2), id).then(() => null, (e: unknown) => e);
      /* `OrganizedElsewhereError` — the class `assertOrganizerRole` throws, NOT a `ServiceError`.
         Asserted by the class the production seam actually raises: a double that threw the
         generic one would measure the fixture, which is this repository's most-repeated defect. */
      expect(err).toBeInstanceOf(OrganizedElsewhereError);
      expect((err as OrganizedElsewhereError).code).toBe("organized_elsewhere");
      expect((err as OrganizedElsewhereError).httpStatus).toBe(409);
      /* NOT `not_in_trash`: the message IS in Trash, and a true sentence about the wrong thing
         is the failure this ordering exists to end. The role is asked first. */
      expect((err as { code: string }).code).not.toBe("not_in_trash");
      // Nothing was written.
      expect((await fsOf(id)).desiredFolder).toBe(TRASH);
      expect((await fsOf(id)).trashedFrom).toBe("ohmail/News");
    } finally {
      await db.update(mailboxes).set({ organizerRole: "organizer" }).where(eq(mailboxes.id, mb));
    }
  });

  it("restore answers 404 for a message this account does not own", async () => {
    await expect(svc().restore(ctxAt(t2), randomUUID())).rejects.toMatchObject({
      code: "not_found", httpStatus: 404,
    });
  });

  it("the body route answers for a TOMBSTONED row — a bin you cannot read is a bin you cannot decide about", async () => {
    const id = await msg("ohmail/News");
    await svc().delete(ctxAt(t1), id);
    // No body row was inserted; what is asserted is that ownership resolves and the route does
    // not 404 on the tombstone.
    const body = await svc().getBody(ctxAt(t2), id);
    expect(body.messageId).toBe(id);
    const dto = await svc().get(ctxAt(t2), id);
    expect(dto.id).toBe(id);
  });
});
