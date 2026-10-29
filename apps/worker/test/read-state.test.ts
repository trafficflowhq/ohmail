import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLog, changeLog, flagState, mailboxes, messageInstances, messages, upsertDesiredSeen, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeDrizzleRepo, type WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { runSyncCycle, reconcileMailbox } from "../src/sync.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * READ-STATE, BOTH DIRECTIONS — the worker half.
 *
 * Before this slice `flagChanges` was produced by the adapter and consumed by nothing, and
 * `MailboxAdapter` had no way to WRITE a flag at all. So read state never crossed the boundary
 * in either direction: a message read in Apple Mail stayed bold in ohmail forever, and a message
 * read in ohmail was still unread in every other client the user owns — including after they
 * leave, which is the claim the project's design notes §6.A makes.
 *
 * PGlite, deliberately: nothing here is concurrent. The race between the API's `desired_seen`
 * write and the worker's `observed_seen` write is the one thing PGlite cannot host, and it has
 * its own file (`packages/api/test/read-state-concurrency.pg.test.ts`) against real Postgres on :5433.
 */

const ACCOUNT = "00000000-0000-4000-8000-00000000a11e";

async function world(): Promise<{
  db: Tx; repo: WorkerRepo; fleet: FakeAdapterFleet; adapter: MailboxAdapter;
  accountId: string; mailboxId: string;
}> {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = ACCOUNT;
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `mb-${randomUUID().slice(0, 8)}@lichtgrat.example` })
    .returning();
  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory(
    { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId, mailboxId: mb!.id },
  );
  return { db, repo: makeDrizzleRepo(db), fleet, adapter, accountId, mailboxId: mb!.id };
}

/**
 * Seed a message row directly at a known locator, with an optional flag_state intent.
 *
 * The PRIMARY `message_instances` row is part of the seed (skippable via `expunged`), because a
 * live message HAS one — `primaryInstanceVanished` is how the reconciler now distinguishes a
 * stale locator (mid-move: instance still on record, row stays pending) from a message expunged
 * outright (disappearance on record: the intent is voided). A seed without the instance is the
 * EXPUNGED shape, not a shorthand for a live message.
 */
async function seedMessage(
  db: Tx, o: {
    accountId: string; mailboxId: string; unread: boolean; ref?: string; folder?: string;
    flag?: { desiredSeen: boolean; observedSeen: boolean; lastSetBy: "us" | "external" };
    expunged?: boolean;
  },
): Promise<string> {
  const folder = o.folder ?? "INBOX";
  const ref = o.ref ?? "1:5000";
  const [m] = await db.insert(messages).values({
    accountId: o.accountId, mailboxId: o.mailboxId, bodyHash: "h",
    dedupKey: `seed:${randomUUID()}`, subject: "s", fromAddress: "a@b.example",
    unread: o.unread, nativeLocator: { folder, ref },
  }).returning();
  if (!o.expunged) {
    const [uidvalidity, uid] = ref.split(":");
    await db.insert(messageInstances).values({
      accountId: o.accountId, mailboxId: o.mailboxId, messageId: m!.id,
      folder, uidvalidity: BigInt(uidvalidity!), uid: Number(uid!), isPrimary: true,
    });
  }
  if (o.flag) {
    await db.insert(flagState).values({
      messageId: m!.id, desiredSeen: o.flag.desiredSeen, observedSeen: o.flag.observedSeen,
      lastSetBy: o.flag.lastSetBy,
      reconcileStatus: o.flag.desiredSeen === o.flag.observedSeen ? "reconciled" : "pending",
    });
  }
  return m!.id;
}

const flagRowOf = async (db: Tx, messageId: string) =>
  (await db.select().from(flagState).where(eq(flagState.messageId, messageId)))[0];
const unreadOf = async (db: Tx, messageId: string) =>
  (await db.select().from(messages).where(eq(messages.id, messageId)))[0]!.unread;

describe("ingest writes the SERVER's read-state into the row", () => {
  it("a delivered message the server reports as \\Seen lands with unread=false", async () => {
    // The database-level half of the "everything is New" guard: `packages/core`'s pipeline test
    // proves the plan carries it, this proves the column does.
    const w = await world();
    w.fleet.behave(w.mailboxId, {
      deliver: [
        { from: "anna@x.example", subject: "old news", messageId: "seen-1@x", seen: true },
        { from: "anna@x.example", subject: "fresh", messageId: "unseen-1@x", seen: false },
      ],
    });
    await runSyncCycle({ writeAuthority: FIXTURE_LEASE, repo: w.repo, adapter: w.adapter, accountId: w.accountId, mailboxId: w.mailboxId, storageCap: UNMETERED_STORAGE_CAP });

    const rows = await w.db.select({ h: messages.messageIdHeader, unread: messages.unread })
      .from(messages).where(eq(messages.mailboxId, w.mailboxId));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.h === "seen-1@x")!.unread).toBe(false);
    expect(rows.find((r) => r.h === "unseen-1@x")!.unread).toBe(true);
  });
});

describe("reconcileFlags — OUR intent reaches IMAP", () => {
  it("a pending row we authored is pushed with setFlags and marked observed", async () => {
    const w = await world();
    const id = await seedMessage(w.db, {
      accountId: w.accountId, mailboxId: w.mailboxId, unread: false, ref: "1:77",
      flag: { desiredSeen: true, observedSeen: false, lastSetBy: "us" },
    });

    await reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo: w.repo, adapter: w.adapter, accountId: w.accountId, mailboxId: w.mailboxId });

    expect(w.fleet.flagWrites).toEqual([
      { mailboxId: w.mailboxId, locator: { folder: "INBOX", ref: "1:77" }, seen: true },
    ]);
    expect(await flagRowOf(w.db, id)).toMatchObject({
      desiredSeen: true, observedSeen: true, lastSetBy: "us", reconcileStatus: "reconciled",
    });
  });

  it("marking UNREAD again is pushed too — the reconciler is not one-directional", async () => {
    const w = await world();
    await seedMessage(w.db, {
      accountId: w.accountId, mailboxId: w.mailboxId, unread: true, ref: "1:78",
      flag: { desiredSeen: false, observedSeen: true, lastSetBy: "us" },
    });
    await reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo: w.repo, adapter: w.adapter, accountId: w.accountId, mailboxId: w.mailboxId });
    expect(w.fleet.flagWrites.map((f) => f.seen)).toEqual([false]);
  });

  it("a second pass pushes NOTHING — convergence is idempotent, not a per-cycle STORE", async () => {
    const w = await world();
    await seedMessage(w.db, {
      accountId: w.accountId, mailboxId: w.mailboxId, unread: false, ref: "1:79",
      flag: { desiredSeen: true, observedSeen: false, lastSetBy: "us" },
    });
    const deps = { writeAuthority: FIXTURE_LEASE, repo: w.repo, adapter: w.adapter, accountId: w.accountId, mailboxId: w.mailboxId };
    await reconcileMailbox(deps);
    await reconcileMailbox(deps);
    expect(w.fleet.flagWrites).toHaveLength(1);
  });

  it("a message that left its locator leaves the row PENDING and does not abort the pass", async () => {
    // The crash-safety branch: `MessageGoneError` means the locator is stale, so the intent is
    // kept and the next `changesSince` refreshes the UID. Throwing here would take the whole
    // reconcile pass — including every folder move — down with one moved message.
    const w = await world();
    const gone = await seedMessage(w.db, {
      accountId: w.accountId, mailboxId: w.mailboxId, unread: false, ref: "1:80",
      flag: { desiredSeen: true, observedSeen: false, lastSetBy: "us" },
    });
    const fine = await seedMessage(w.db, {
      accountId: w.accountId, mailboxId: w.mailboxId, unread: false, ref: "1:81",
      flag: { desiredSeen: true, observedSeen: false, lastSetBy: "us" },
    });
    w.fleet.goneFlagRefs.add("1:80");

    await reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo: w.repo, adapter: w.adapter, accountId: w.accountId, mailboxId: w.mailboxId });

    expect(await flagRowOf(w.db, gone)).toMatchObject({ reconcileStatus: "pending", observedSeen: false });
    expect(await flagRowOf(w.db, fine)).toMatchObject({ reconcileStatus: "reconciled" });
  });

  it("a message EXPUNGED OUTRIGHT has its \\Seen intent voided, not retried for ever", async () => {
    // The other reading of MessageGoneError. The seed above keeps its instance row (the mid-move
    // race — the locator refresh is coming); this one has none, which is the on-disk shape
    // `forgetInstanceAt` leaves once the server's DELETE has been observed. No refresh is ever
    // coming, so before the void this row was one IMAP STORE per cycle for the rest of time.
    const w = await world();
    const id = await seedMessage(w.db, {
      accountId: w.accountId, mailboxId: w.mailboxId, unread: false, ref: "1:82",
      flag: { desiredSeen: true, observedSeen: false, lastSetBy: "us" },
      expunged: true,
    });
    w.fleet.goneFlagRefs.add("1:82");

    await reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo: w.repo, adapter: w.adapter, accountId: w.accountId, mailboxId: w.mailboxId });

    expect(await flagRowOf(w.db, id)).toMatchObject({
      desiredSeen: true, observedSeen: true, reconcileStatus: "reconciled",
    });
    expect(w.fleet.flagWrites, "the void must not write to a server that no longer holds the message").toEqual([]);
  });
});

describe("user always wins — an EXTERNAL \\Seen is never reverted by us", () => {
  it("a divergent row marked 'external' is left alone: no setFlags, nothing rewritten", async () => {
    // THE GUARD. Delete `if (p.lastSetBy !== "us") continue;` from `reconcileFlags` in
    // `apps/worker/src/sync.ts` and this goes red: the fake records a write, and the row is
    // stamped reconciled — i.e. the product overrules a decision its owner made in Apple Mail,
    // every cycle, forever.
    const w = await world();
    const id = await seedMessage(w.db, {
      accountId: w.accountId, mailboxId: w.mailboxId, unread: true, ref: "1:90",
      flag: { desiredSeen: true, observedSeen: false, lastSetBy: "external" },
    });

    await reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo: w.repo, adapter: w.adapter, accountId: w.accountId, mailboxId: w.mailboxId });

    expect(w.fleet.flagWrites, "an external divergence must never be pushed").toEqual([]);
    expect(await flagRowOf(w.db, id)).toMatchObject({
      desiredSeen: true, observedSeen: false, lastSetBy: "external", reconcileStatus: "pending",
    });
  });
});

describe("inbound flagChanges — a message read elsewhere converges here", () => {
  it("adopts the server's \\Seen, records it as external, and emits ONE delta", async () => {
    const w = await world();
    const id = await seedMessage(w.db, {
      accountId: w.accountId, mailboxId: w.mailboxId, unread: true, ref: "1:1000",
    });
    w.fleet.behave(w.mailboxId, { flagChanges: [{ ref: "1:1000", seen: true }] });

    await runSyncCycle({ writeAuthority: FIXTURE_LEASE, repo: w.repo, adapter: w.adapter, accountId: w.accountId, mailboxId: w.mailboxId, storageCap: UNMETERED_STORAGE_CAP });

    expect(await unreadOf(w.db, id)).toBe(false);
    expect(await flagRowOf(w.db, id)).toMatchObject({
      desiredSeen: true, observedSeen: true, lastSetBy: "external", reconcileStatus: "reconciled",
    });
    const changes = await w.db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.entityId, id)));
    expect(changes, "the client learns about it through the delta feed").toHaveLength(1);

    // …and having adopted it, we do NOT then push it back: `lastSetBy` is external.
    expect(w.fleet.flagWrites).toEqual([]);
  });

  it("an inbound change that says what we already believe emits NO delta", async () => {
    const w = await world();
    const id = await seedMessage(w.db, {
      accountId: w.accountId, mailboxId: w.mailboxId, unread: false, ref: "1:1001",
    });
    w.fleet.behave(w.mailboxId, { flagChanges: [{ ref: "1:1001", seen: true }] });
    await runSyncCycle({ writeAuthority: FIXTURE_LEASE, repo: w.repo, adapter: w.adapter, accountId: w.accountId, mailboxId: w.mailboxId, storageCap: UNMETERED_STORAGE_CAP });

    expect(await w.db.select().from(changeLog).where(eq(changeLog.entityId, id))).toHaveLength(0);
  });

  it("OUR pending write outranks the stale value the server is still reporting", async () => {
    // The user clicked "read" a second ago; IMAP has not been told yet and still answers unseen.
    // Adopting that would snap the optimistic flip back and then push it again next cycle — the
    // row would oscillate. The pending intent wins, and the SAME cycle then writes it out.
    const w = await world();
    const id = await seedMessage(w.db, {
      accountId: w.accountId, mailboxId: w.mailboxId, unread: false, ref: "1:1002",
      flag: { desiredSeen: true, observedSeen: false, lastSetBy: "us" },
    });
    w.fleet.behave(w.mailboxId, { flagChanges: [{ ref: "1:1002", seen: false }] });

    await runSyncCycle({ writeAuthority: FIXTURE_LEASE, repo: w.repo, adapter: w.adapter, accountId: w.accountId, mailboxId: w.mailboxId, storageCap: UNMETERED_STORAGE_CAP });

    expect(await unreadOf(w.db, id), "the user's intent must stand").toBe(false);
    expect(w.fleet.flagWrites.map((f) => f.seen)).toEqual([true]);
    expect(await flagRowOf(w.db, id)).toMatchObject({ lastSetBy: "us", reconcileStatus: "reconciled" });
  });

  it("a locator with no message behind it is skipped, not an error", async () => {
    const w = await world();
    w.fleet.behave(w.mailboxId, { flagChanges: [{ ref: "1:404404", seen: true }] });
    await expect(runSyncCycle({ writeAuthority: FIXTURE_LEASE,
      repo: w.repo, adapter: w.adapter, accountId: w.accountId, mailboxId: w.mailboxId,
    })).resolves.toBeTruthy();
  });

  it("one mailbox's locator cannot dictate ANOTHER mailbox's read state", async () => {
    // `(folder, uid)` is not unique across mailboxes — every IMAP server in the world hands out
    // `INBOX` UID 1. Without the `mailbox_id` predicate in `applyExternalFlag`, one account's
    // server would be flipping another account's mail. The "Account isolation is absolute, and it binds staff too" invariant.
    const w = await world();
    const [other] = await w.db.insert(mailboxes)
      .values({ accountId: "00000000-0000-4000-8000-00000000b22e", provider: "imap", address: `x-${randomUUID().slice(0, 8)}@e.example` })
      .returning();
    const victim = await seedMessage(w.db, {
      accountId: "00000000-0000-4000-8000-00000000b22e", mailboxId: other!.id, unread: true, ref: "1:1",
    });
    w.fleet.behave(w.mailboxId, { flagChanges: [{ ref: "1:1", seen: true }] });

    await runSyncCycle({ writeAuthority: FIXTURE_LEASE, repo: w.repo, adapter: w.adapter, accountId: w.accountId, mailboxId: w.mailboxId, storageCap: UNMETERED_STORAGE_CAP });

    expect(await unreadOf(w.db, victim)).toBe(true);
  });
});

describe("a read whose STORE answer was lost — the next press is still sent", () => {
  type W = Awaited<ReturnType<typeof world>>;
  const pass = (w: W) => reconcileMailbox({ writeAuthority: FIXTURE_LEASE, repo: w.repo, adapter: w.adapter, accountId: w.accountId, mailboxId: w.mailboxId });
  const cycle = (w: W) => runSyncCycle({ writeAuthority: FIXTURE_LEASE, repo: w.repo, adapter: w.adapter, accountId: w.accountId, mailboxId: w.mailboxId, storageCap: UNMETERED_STORAGE_CAP });
  /** The person's press, as the door writes it: the read model and the intent. */
  const press = async (w: W, id: string, seen: boolean) => {
    await w.db.update(messages).set({ unread: !seen }).where(eq(messages.id, id));
    await upsertDesiredSeen(w.db, id, !seen, seen, new Date());
  };
  /** A read pressed and not yet on the server. */
  const readPending = (w: W, ref: string) => seedMessage(w.db, {
    accountId: w.accountId, mailboxId: w.mailboxId, unread: false, ref,
    flag: { desiredSeen: true, observedSeen: false, lastSetBy: "us" },
  });
  const seenWrites = (w: W) => w.fleet.flagWrites.map((f) => f.seen);
  const audits = async (w: W) => (await w.db.select({ action: auditLog.action }).from(auditLog)
    .where(eq(auditLog.accountId, w.accountId))).map((a) => a.action);

  it("lost answer, unread, then the walk reports \\Seen: the unread reaches the server and stands", async () => {
    const w = await world();
    const id = await readPending(w, "1:2001");
    w.fleet.flagStoreFaults.set("1:2001", [{ answer: "unanswered" }]);
    await pass(w);
    expect(await flagRowOf(w.db, id), "the doubt is recorded").toMatchObject({ conflict: true, reconcileStatus: "pending", observedSeen: false });
    await press(w, id, false);
    w.fleet.behave(w.mailboxId, { flagChanges: [{ ref: "1:2001", seen: true }] });

    await cycle(w);

    expect(await unreadOf(w.db, id), "the last press stands in the app").toBe(true);
    expect(seenWrites(w)).toEqual([true, false]);
    expect(await flagRowOf(w.db, id)).toMatchObject({
      desiredSeen: false, observedSeen: false, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
  });

  it("lost answer, unread, no walk: the unread is sent at desired = observed", async () => {
    const w = await world();
    const id = await readPending(w, "1:2002");
    w.fleet.flagStoreFaults.set("1:2002", [{ answer: "unanswered" }]);
    await pass(w);
    await press(w, id, false);
    await pass(w);
    expect(seenWrites(w)).toEqual([true, false]);
    expect(await flagRowOf(w.db, id)).toMatchObject({ reconcileStatus: "reconciled", conflict: false, observedSeen: false });
  });

  it("an unread pressed while the read's STORE is on the wire is still sent", async () => {
    const w = await world();
    const id = await readPending(w, "1:2003");
    w.fleet.flagStoreFaults.set("1:2003", [{ answer: "unanswered", during: () => press(w, id, false) }]);
    await pass(w);
    expect(await flagRowOf(w.db, id)).toMatchObject({ desiredSeen: false, conflict: true, reconcileStatus: "pending" });
    await pass(w);
    expect(seenWrites(w)).toEqual([true, false]);
    expect(await flagRowOf(w.db, id)).toMatchObject({ reconcileStatus: "reconciled", conflict: false });
  });

  it("a read taken back before its STORE ever left adopts another client's read, and sends nothing", async () => {
    const w = await world();
    const id = await readPending(w, "1:2004");
    w.fleet.flagStoreFaults.set("1:2004", [{ answer: "unsent" }]);
    await pass(w);
    await press(w, id, false);
    expect(await flagRowOf(w.db, id)).toMatchObject({ conflict: false, reconcileStatus: "reconciled" });
    w.fleet.behave(w.mailboxId, { flagChanges: [{ ref: "1:2004", seen: true }] });

    await cycle(w);

    expect(await unreadOf(w.db, id), "another client's read is adopted").toBe(false);
    expect(seenWrites(w)).toEqual([]);
    expect(await flagRowOf(w.db, id)).toMatchObject({ lastSetBy: "external", observedSeen: true });
  });

  it("a refused read, then undo: the row settles and no unread is sent", async () => {
    const w = await world();
    const id = await readPending(w, "1:2005");
    w.fleet.flagStoreFaults.set("1:2005", [{ answer: "refused" }]);
    await pass(w);
    expect(await audits(w)).toEqual(["reconcile.flags.failed"]);
    expect(await flagRowOf(w.db, id)).toMatchObject({ conflict: false, attempts: 1 });
    await press(w, id, false);
    await pass(w);
    expect(seenWrites(w)).toEqual([true]);
    expect(await flagRowOf(w.db, id)).toMatchObject({ desiredSeen: false, observedSeen: false, reconcileStatus: "reconciled" });
  });

  it("lost answer, unread, and the server refuses the re-send: the row retires and the walk's \\Seen is adopted", async () => {
    const w = await world();
    const id = await readPending(w, "1:2006");
    w.fleet.flagStoreFaults.set("1:2006", [{ answer: "unanswered" }, { answer: "refused" }]);
    await pass(w);
    await press(w, id, false);
    await pass(w);
    expect(seenWrites(w)).toEqual([true, false]);
    expect(await audits(w)).toEqual(["reconcile.flags.retired"]);
    expect(await flagRowOf(w.db, id)).toMatchObject({ reconcileStatus: "reconciled", conflict: false, attempts: 0 });

    w.fleet.behave(w.mailboxId, { flagChanges: [{ ref: "1:2006", seen: true }] });
    await cycle(w);
    expect(await unreadOf(w.db, id), "the server's state is adopted").toBe(false);
    expect(await flagRowOf(w.db, id)).toMatchObject({ lastSetBy: "external", observedSeen: true, reconcileStatus: "reconciled" });
    expect(seenWrites(w)).toEqual([true, false]);
  });

  it("lost answer and no press: the walk's \\Seen settles the row without a second STORE", async () => {
    const w = await world();
    const id = await readPending(w, "1:2007");
    w.fleet.flagStoreFaults.set("1:2007", [{ answer: "unanswered" }]);
    await pass(w);
    w.fleet.behave(w.mailboxId, { flagChanges: [{ ref: "1:2007", seen: true }] });

    await cycle(w);

    expect(seenWrites(w)).toEqual([true]);
    expect(await unreadOf(w.db, id)).toBe(false);
    expect(await flagRowOf(w.db, id)).toMatchObject({
      desiredSeen: true, observedSeen: true, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
  });
});
