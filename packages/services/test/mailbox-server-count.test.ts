import { accountOfMailbox } from "@trafficflow/db";
import { describe, it, expect } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxes, mailboxFolders } from "@trafficflow/db";
import { StaticKeyProvider } from "@trafficflow/core";
import { makeMailboxService, type ServiceContext } from "@trafficflow/services";

/**
 * HOW MUCH MAIL THE SERVER SAYS IS IN A MAILBOX — `MailboxDTO.serverMessageCount`, the first
 * pull's denominator, reaching a client for the first time.
 *
 * ── WHY THIS NUMBER DID NOT EXIST ────────────────────────────────────────────────────────
 *
 * The import strip has always had a numerator — how much this install has mirrored — and never a
 * denominator. `mailbox_folders` held cursors only, and the IMAP adapter read `EXISTS` off every
 * SELECT and threw it away, so the one "how long is left" figure the product ever showed was a
 * literal somebody guessed. Mail 0083 added `mailbox_folders.server_exists`, written by every
 * cycle that opens a folder — and READ BY NOTHING for the whole of its life until this
 * projection. That is the built-tested-unreachable shape the onboarding rulings name outright,
 * and it is why the tests below are about a PROJECTION rather than about arithmetic.
 *
 * ── THE ONE RULE, IN THREE DIRECTIONS ────────────────────────────────────────────────────
 *
 * Absent and zero are different answers, and every test here is one direction of that:
 *
 *  · every folder uncounted  → the field is ABSENT, never `0`. A `0` is the sentence "your mail
 *    server holds nothing", printed underneath a pull that is running.
 *  · one folder counted at 0 → the field is `0`. An EMPTY folder has an answer and it is zero,
 *    and collapsing this into the case above would hide a genuinely empty mailbox.
 *  · some folders counted    → the sum over the counted ones, with the NULLs contributing
 *    nothing rather than being read as zeroes.
 *
 * PGlite deliberately: this is a projection over rows the transaction already read, with no
 * concurrency in it. `list`'s own opt-in aggregate is a different question and has its own
 * real-Postgres test (`mailbox-message-counts.pg.test.ts`).
 */

const NOW = new Date("2026-09-02T12:00:00.000Z");
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 11), 1);
const svc = makeMailboxService({ keyProvider: KP });

type Db = Awaited<ReturnType<typeof makeTestDb>>;
const ctxFor = (db: Db, accountId: string): ServiceContext =>
  ({ db, accountId, userId: null, now: () => NOW, requestId: "r" });

async function seed(db: Db): Promise<{ accountId: string; mailboxId: string }> {
  const [a] = await db.insert(accounts).values({ name: "server-count" }).returning();
  const [mb] = await db.insert(mailboxes).values({
    accountId: a!.id, provider: "imap", address: "person@example.test",
  }).returning();
  return { accountId: a!.id, mailboxId: mb!.id };
}

const folder = (
  ids: { mailboxId: string }, name: string, serverExists: number | null,
) => ({
  mailboxId: ids.mailboxId, accountId: accountOfMailbox(ids.mailboxId), folder: name,
  ...(serverExists === null ? {} : { serverExists }),
});

describe("the first pull's denominator reaches the DTO", () => {
  it("is ABSENT when no folder has been counted — never zero", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    // Two folders a cycle has opened for their CURSORS and never counted: the state of every
    // mailbox on an install that has not yet run a build which writes the column, and of every
    // mailbox for the first minute of its life.
    await db.insert(mailboxFolders).values([
      folder(ids, "INBOX", null), folder(ids, "ohmail/News", null),
    ]);
    const dto = await svc.get(ctxFor(db, ids.accountId), ids.mailboxId);
    expect("serverMessageCount" in dto, "an uncounted mailbox claimed a total").toBe(false);
  });

  it("is ABSENT when the mailbox has no folder rows at all", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    const dto = await svc.get(ctxFor(db, ids.accountId), ids.mailboxId);
    expect("serverMessageCount" in dto).toBe(false);
  });

  it("is ZERO when a folder HAS been counted and holds nothing", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    await db.insert(mailboxFolders).values([folder(ids, "INBOX", 0)]);
    const dto = await svc.get(ctxFor(db, ids.accountId), ids.mailboxId);
    // The distinction the whole field turns on: this mailbox HAS an answer, and it is nothing.
    expect(dto.serverMessageCount).toBe(0);
  });

  it("sums the folders that carry a count, and NULLs contribute nothing", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    await db.insert(mailboxFolders).values([
      folder(ids, "INBOX", 1_800),
      folder(ids, "ohmail/News", 402),
      // Opened for its cursor, never counted. Reading this as a zero would be harmless here and
      // is the same mistake that makes the "no folder counted" case above answer `0`.
      folder(ids, "ohmail/Receipts", null),
      folder(ids, "ohmail/Screener", 83),
    ]);
    const dto = await svc.get(ctxFor(db, ids.accountId), ids.mailboxId);
    expect(dto.serverMessageCount).toBe(2_285);
  });

  it("counts only THIS mailbox's folders", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    const [other] = await db.insert(mailboxes).values({
      accountId: ids.accountId, provider: "imap", address: "second@example.test",
    }).returning();
    await db.insert(mailboxFolders).values([
      folder(ids, "INBOX", 100),
      { mailboxId: other!.id, accountId: accountOfMailbox(other!.id), folder: "INBOX", serverExists: 9_999 },
    ]);
    const dto = await svc.get(ctxFor(db, ids.accountId), ids.mailboxId);
    expect(dto.serverMessageCount).toBe(100);
  });

  it("rides EVERY response, not only the opt-in counts variant", async () => {
    // Unlike `messageCount`, which is an aggregate over the account's whole `messages` table and
    // is therefore opt-in on a polled route, this sum is taken over folder rows the projection
    // was already reading. There is nothing to opt out of, and putting it behind the flag would
    // have kept it off the one read that matters — the shell's own 30 s poll, which is what
    // carries the first pull's counters while the flow is on screen.
    const db = await makeTestDb();
    const ids = await seed(db);
    await db.insert(mailboxFolders).values([folder(ids, "INBOX", 42)]);
    const [bare] = await svc.list(ctxFor(db, ids.accountId));
    expect(bare!.serverMessageCount).toBe(42);
    expect("messageCount" in bare!, "the opt-in aggregate rode a bare list").toBe(false);
  });
});
