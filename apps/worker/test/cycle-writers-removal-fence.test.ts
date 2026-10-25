import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  accounts, accountStorage, auditLog, bodyBytesOf, changeLog, evictOldestBodies, folderState, mailboxes,
  messageBodies, messageInstances, messages, type Tx,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  createLogger, UNMETERED_STORAGE_CAP, fingerprintDedupKey, messageFingerprint, normalizeMime,
  type NativeLocator,
} from "@trafficflow/core";
import { makeDrizzleRepo, type DrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { MailboxRemovedError, runSyncCycle } from "../src/sync.js";
import { FakeAdapterFleet, rawOf } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * EVERY WRITER IN THE CYCLE ASKS THE ONE REMOVAL FENCE. The ingest commit and the targeted retry already
 * did; two whole passes running after them did not — `junkRestorePass` rewrites husked bodies and
 * `reconcileMailbox` writes locators, `folder_state`, `flag_state` and audit rows, both planning from
 * reads taken outside every transaction, so a removal in that gap was written into a mailbox just
 * removed. EACH DEFECT WAS WATCHED FAIL ON THE BASE (2026-09-14, before `fencedLiveGroup`): the junk
 * case restored a body and the reconcile case wrote locator, converged state and audit row into a
 * `disabled` mailbox, both cycles RESOLVED. On PGlite this measures the DECISION, not the LOCK ORDER —
 * that is `removal-mid-ingest.pg.test.ts`'s, and it is the same statement either way.
 */
const BUILD = "cycle-writers-test-build";

/** One account and one live mailbox, each test its own. */
async function seedMailbox(db: Tx, tag: string): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `cw-${tag}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `cw-${tag}-${randomUUID().slice(0, 8)}@x.test`,
    status: "connected",
  }).returning();
  return { accountId, mailboxId: mb!.id };
}

const LOC = (folder: string, ref: string): NativeLocator => ({ folder, ref });

/**
 * A message whose body a spam verdict husked, alive at a watched locator again — the candidate
 * `listJunkFiledHusks` answers. The identity is derived from the bytes the FAKE will serve
 * (`rawOf`, exported for exactly this), because the rewrite refuses a body whose fingerprint does
 * not match the row: a husk seeded from different bytes would be refused for the wrong reason and
 * the positive control would prove nothing.
 */
async function seedHusk(
  db: Tx, repo: DrizzleRepo, accountId: string, mailboxId: string,
  held: { from: string; subject: string; messageId: string }, uid: number,
): Promise<string> {
  const norm = await normalizeMime(rawOf(held));
  const [m] = await db.insert(messages).values({
    accountId, mailboxId,
    dedupKey: fingerprintDedupKey(messageFingerprint(norm)),
    messageIdHeader: norm.canonical.messageIdHeader,
    fromAddress: norm.from.address, subject: norm.subject,
    bodyHash: norm.canonical.bodyHash,
    nativeLocator: LOC("INBOX", `1:${uid}`),
  }).returning();
  await db.insert(messageInstances).values({
    accountId, messageId: m!.id, mailboxId, folder: "INBOX", uid, uidvalidity: 1n, isPrimary: true,
  });
  await db.insert(messageBodies).values({ messageId: m!.id, text: norm.textBody, html: null });
  await db.insert(accountStorage).values({
    accountId, bytes: bodyBytesOf({ text: norm.textBody, html: null }),
  });
  // The filing's own husk — the production write, so the marker and the released bytes are real.
  const husked = await repo.huskBody!(accountId, m!.id, "junk_filed");
  expect(husked, "the fixture never husked the body — there is no candidate to restore").toBe(true);
  return m!.id;
}

/**
 * A letter stored through the counted writer and then emptied by the production trim, on a mailbox
 * past its first import: the candidate the storage refill fills once there is room.
 */
async function seedEmptied(
  db: Tx, repo: DrizzleRepo, accountId: string, mailboxId: string,
  held: { from: string; subject: string; messageId: string }, uid: number,
): Promise<string> {
  const norm = await normalizeMime(rawOf(held));
  await db.update(mailboxes).set({ initialImportCompletedAt: new Date() }).where(eq(mailboxes.id, mailboxId));
  const [m] = await db.insert(messages).values({
    accountId, mailboxId,
    dedupKey: fingerprintDedupKey(messageFingerprint(norm)),
    messageIdHeader: norm.canonical.messageIdHeader,
    fromAddress: norm.from.address, subject: norm.subject,
    bodyHash: norm.canonical.bodyHash,
    nativeLocator: LOC("INBOX", `1:${uid}`),
  }).returning();
  await db.insert(messageInstances).values({
    accountId, messageId: m!.id, mailboxId, folder: "INBOX", uid, uidvalidity: 1n, isPrimary: true,
  });
  await repo.insertMessageBody(m!.id, { text: norm.textBody, html: null, headers: {} }, { accountId, capBytes: null });
  const trimmed = await db.transaction(async (tx) =>
    evictOldestBodies(tx as unknown as Tx, dialect(db), accountId, { targetBytes: 0, maxBodies: 10 }));
  expect(trimmed.evicted, "the fixture never emptied the letter — there is nothing to refill").toBe(1);
  return m!.id;
}

/** A message the user filed, waiting for the reconciler to carry the move to the server. */
async function seedPendingMove(
  db: Tx, accountId: string, mailboxId: string, uid: number,
): Promise<string> {
  const [m] = await db.insert(messages).values({
    accountId, mailboxId, dedupKey: `mid:<cw-move-${randomUUID()}@x>`,
    fromAddress: "stranger@elsewhere.test", subject: "file me",
    bodyHash: `cw-move-hash-${uid}`,
    nativeLocator: LOC("INBOX", `1:${uid}`),
  }).returning();
  await db.insert(messageInstances).values({
    accountId, messageId: m!.id, mailboxId, folder: "INBOX", uid, uidvalidity: 1n, isPrimary: true,
  });
  await db.insert(folderState).values({
    messageId: m!.id, desiredFolder: "ohmail/Feed", observedFolder: "INBOX",
    lastSetBy: "us", reconcileStatus: "pending",
  });
  return m!.id;
}

/** An adapter that can be asked by UID, holding one message behind every watermark. */
function fleetFor(mailboxId: string, held?: { from: string; subject: string; messageId: string }, uid = 0): {
  fleet: FakeAdapterFleet; adapter: ReturnType<FakeAdapterFleet["factory"]>;
} {
  const fleet = new FakeAdapterFleet();
  fleet.targetedRetry = true;
  const adapter = fleet.factory(
    { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId: "unused", mailboxId, onConnectionError: () => { /* nothing dials here */ } },
  );
  if (held) fleet.behave(mailboxId, { behindWatermark: [{ ...held, uid }] });
  return { fleet, adapter };
}

/** Every event the cycle logged, in order. */
function recorder(): { events: string[]; log: ReturnType<typeof createLogger> } {
  const events: string[] = [];
  const log = createLogger({
    service: "worker", level: "debug", sink: (line: string) => {
      events.push(String((JSON.parse(line) as { event?: unknown }).event ?? ""));
    },
  });
  return { events, log };
}

/**
 * A repo that tombstones the mailbox the first time one named PLAN-PHASE read is answered — the
 * removal lands in the gap between what the pass planned from and what it is about to write. The
 * read is answered from the LIVE mailbox first, so the pass has genuine work: a removal that
 * landed before the read would make the pass find nothing and the case would measure itself.
 */
function removingAt(real: DrizzleRepo, db: Tx, mailboxId: string, method: string): {
  repo: DrizzleRepo; removed: () => boolean;
} {
  let removed = false;
  const repo = new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== method || typeof value !== "function") return value;
      return async (...args: unknown[]): Promise<unknown> => {
        const out = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        if (!removed) {
          removed = true;
          await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mailboxId));
        }
        return out;
      };
    },
  }) as DrizzleRepo;
  return { repo, removed: () => removed };
}

/** What a removed mailbox must have gained from the pass: nothing. */
async function writesIn(db: Tx, accountId: string, messageId: string): Promise<{
  bodyWithheld: string | null; folder: string; status: string; audits: number; changes: number;
}> {
  const [body] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, messageId));
  const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
  return {
    bodyWithheld: body?.withheldReason ?? null,
    folder: fs?.observedFolder ?? "-",
    status: fs?.reconcileStatus ?? "-",
    audits: (await db.select().from(auditLog).where(eq(auditLog.accountId, accountId))).length,
    changes: (await db.select().from(changeLog).where(eq(changeLog.accountId, accountId))).length,
  };
}

const cycle = (over: Record<string, unknown>): Promise<unknown> => runSyncCycle({
  buildVersion: BUILD, storageCap: UNMETERED_STORAGE_CAP, role: "organizer",
  trustedAuthservIds: new Set<string>(),
  ...over,
} as never);

describe("every writer in the sync cycle asks the removal fence", () => {
  it("restores a junk-filed husk on a live mailbox", async () => {
    /* THE POSITIVE CONTROL for the junk case, and the only thing that proves the pass writes at
       all: without it the refusal below is satisfied by a pass that never reached its door. */
    const db = (await makeTestDb()) as unknown as Tx;
    const { accountId, mailboxId } = await seedMailbox(db, "jr-ok");
    const held = { from: "stranger@elsewhere.test", subject: "back from junk", messageId: `jr-ok-${randomUUID()}@x` };
    const repo = makeDrizzleRepo(db as never);
    const messageId = await seedHusk(db, repo, accountId, mailboxId, held, 41);
    const { adapter } = fleetFor(mailboxId, held, 41);

    await cycle({ writeAuthority: FIXTURE_LEASE, repo, adapter, accountId, mailboxId });

    const [body] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, messageId));
    expect({ withheld: body?.withheldReason ?? null, hasText: (body?.text ?? "").length > 0 },
      "the husk was not refilled — the junk restore pass does not write on a live mailbox")
      .toEqual({ withheld: null, hasText: true });
  }, 60_000);

  it("REFUSES the junk restore's rewrite when the mailbox is removed under the pass", async () => {
    /* THE DEFECT. `listJunkFiledHusks` is the pass's plan-phase read, outside every transaction,
       and the rewrite commits well after it — so tombstoning from that read puts the removal
       exactly in the gap. WATCHED FAIL on the base: the body was refilled, its bytes reserved
       against the account and its `update` change emitted, all inside a removed mailbox. */
    const db = (await makeTestDb()) as unknown as Tx;
    const { accountId, mailboxId } = await seedMailbox(db, "jr-gone");
    const held = { from: "stranger@elsewhere.test", subject: "back from junk", messageId: `jr-gone-${randomUUID()}@x` };
    const real = makeDrizzleRepo(db as never);
    const messageId = await seedHusk(db, real, accountId, mailboxId, held, 42);
    const { adapter } = fleetFor(mailboxId, held, 42);
    const { repo, removed } = removingAt(real, db, mailboxId, "listJunkFiledHusks");

    const { events, log } = recorder();
    await expect(cycle({ writeAuthority: FIXTURE_LEASE, repo, adapter, accountId, mailboxId, log }),
      "the junk restore rewrote a body inside a removed mailbox")
      .rejects.toBeInstanceOf(MailboxRemovedError);
    expect(removed(), "the removal never happened — the case measured nothing").toBe(true);

    expect(await writesIn(db, accountId, messageId),
      "a removed mailbox had a body refilled, an audit row or a change emitted").toMatchObject({
      bodyWithheld: "junk_filed", audits: 0, changes: 0,
    });
    expect(events.filter((e) => e === "junk_restore_mailbox_removed"),
      "the refusal was silent, or was reported more than once")
      .toEqual(["junk_restore_mailbox_removed"]);
    expect(events.filter((e) => e === "junk_restore_pass_failed"),
      "a removed mailbox was reported as a pass that failed").toEqual([]);
  }, 60_000);

  it("gives an emptied letter its text back on a live mailbox with room", async () => {
    /* THE POSITIVE CONTROL for the storage refill: a metered cycle with room writes the text back. */
    const db = (await makeTestDb()) as unknown as Tx;
    const { accountId, mailboxId } = await seedMailbox(db, "sr-ok");
    const held = { from: "stranger@elsewhere.test", subject: "emptied for space", messageId: `sr-ok-${randomUUID()}@x` };
    const repo = makeDrizzleRepo(db as never);
    const messageId = await seedEmptied(db, repo, accountId, mailboxId, held, 61);
    const { adapter } = fleetFor(mailboxId, held, 61);

    await cycle({ writeAuthority: FIXTURE_LEASE, repo, adapter, accountId, mailboxId, storageCap: 10_000_000 });

    const [body] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, messageId));
    expect({ withheld: body?.withheldReason ?? null, hasText: (body?.text ?? "").length > 0 },
      "the letter's text did not come back — the storage refill does not write on a live mailbox")
      .toEqual({ withheld: null, hasText: true });
  }, 60_000);

  it("inside a trial's storage floor the cycle's refill stops at the plan's own limit", async () => {
    const db = (await makeTestDb()) as unknown as Tx;
    const { accountId, mailboxId } = await seedMailbox(db, "sr-plan");
    const held = { from: "stranger@elsewhere.test", subject: "emptied for space", messageId: `sr-plan-${randomUUID()}@x` };
    const repo = makeDrizzleRepo(db as never);
    const messageId = await seedEmptied(db, repo, accountId, mailboxId, held, 63);
    const { adapter } = fleetFor(mailboxId, held, 63);

    // The floor has room for the letter's five bytes; the plan's own limit, five bytes, keeps four.
    await cycle({ writeAuthority: FIXTURE_LEASE, repo, adapter, accountId, mailboxId, storageCap: 10_000_000, storagePlanLimit: 5 });

    const [body] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, messageId));
    expect(body?.withheldReason ?? null, "the cycle's refill filled past the plan's own limit").toBe("storage_cap");
  }, 60_000);

  it("REFUSES the storage refill's rewrite when the mailbox is removed under the pass", async () => {
    const db = (await makeTestDb()) as unknown as Tx;
    const { accountId, mailboxId } = await seedMailbox(db, "sr-gone");
    const held = { from: "stranger@elsewhere.test", subject: "emptied for space", messageId: `sr-gone-${randomUUID()}@x` };
    const real = makeDrizzleRepo(db as never);
    const messageId = await seedEmptied(db, real, accountId, mailboxId, held, 62);
    const { adapter } = fleetFor(mailboxId, held, 62);
    const { repo, removed } = removingAt(real, db, mailboxId, "listStorageCapHusks");

    const { events, log } = recorder();
    await expect(cycle({ writeAuthority: FIXTURE_LEASE, repo, adapter, accountId, mailboxId, log, storageCap: 10_000_000 }),
      "the storage refill wrote a letter's text into a removed mailbox")
      .rejects.toBeInstanceOf(MailboxRemovedError);
    expect(removed(), "the removal never happened — the case measured nothing").toBe(true);
    expect(await writesIn(db, accountId, messageId)).toMatchObject({ bodyWithheld: "storage_cap", changes: 0 });
    expect(events.filter((e) => e === "storage_refill_mailbox_removed")).toEqual(["storage_refill_mailbox_removed"]);
    expect(events.filter((e) => e === "storage_refill_pass_failed")).toEqual([]);
  }, 60_000);

  it("files a pending move on a live mailbox", async () => {
    /* THE POSITIVE CONTROL for the reconcile case: the move reaches the server AND its three
       bookkeeping writes land. Without it the refusal below is a pass that found no work. */
    const db = (await makeTestDb()) as unknown as Tx;
    const { accountId, mailboxId } = await seedMailbox(db, "rc-ok");
    const messageId = await seedPendingMove(db, accountId, mailboxId, 51);
    const { fleet, adapter } = fleetFor(mailboxId);
    const repo = makeDrizzleRepo(db as never);

    await cycle({ writeAuthority: FIXTURE_LEASE, repo, adapter, accountId, mailboxId });

    expect(fleet.movesFor(mailboxId), "the reconciler never carried the move to the server")
      .toEqual(["ohmail/Feed"]);
    const after = await writesIn(db, accountId, messageId);
    expect({ folder: after.folder, status: after.status, audited: after.audits > 0 },
      "the move landed and its bookkeeping did not")
      .toEqual({ folder: "ohmail/Feed", status: "reconciled", audited: true });
  }, 60_000);

  it("REFUSES reconcileMailbox's bookkeeping when the mailbox is removed under the pass", async () => {
    /* THE DEFECT, one pass along. `listPendingFolderStates` is the plan-phase read; the IMAP move
       and then the locator / `folder_state` / audit group follow it. WATCHED FAIL on the base:
       all three committed into a `disabled` mailbox and the cycle resolved normally.

       THE MOVE ITSELF STILL HAPPENS — the server is asked before the group opens, and that is
       right: IMAP is the master and this refusal is about what WE write down. The mailbox is the
       user's and keeps the mail wherever the server put it. */
    const db = (await makeTestDb()) as unknown as Tx;
    const { accountId, mailboxId } = await seedMailbox(db, "rc-gone");
    const messageId = await seedPendingMove(db, accountId, mailboxId, 52);
    const { adapter } = fleetFor(mailboxId);
    const real = makeDrizzleRepo(db as never);
    const { repo, removed } = removingAt(real, db, mailboxId, "listPendingFolderStates");

    const { events, log } = recorder();
    await expect(cycle({ writeAuthority: FIXTURE_LEASE, repo, adapter, accountId, mailboxId, log }),
      "reconcileMailbox wrote a move's bookkeeping into a removed mailbox")
      .rejects.toBeInstanceOf(MailboxRemovedError);
    expect(removed(), "the removal never happened — the case measured nothing").toBe(true);

    expect(await writesIn(db, accountId, messageId),
      "a removed mailbox had its folder_state converged, an audit row or a change emitted")
      .toMatchObject({ folder: "INBOX", status: "pending", audits: 0, changes: 0 });
    const [row] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect((row?.nativeLocator as NativeLocator | null)?.folder,
      "the new locator was written into a mailbox that is gone").toBe("INBOX");
    expect(events.filter((e) => e === "reconcile_mailbox_removed"),
      "the refusal was silent, or was reported more than once")
      .toEqual(["reconcile_mailbox_removed"]);
    expect(events.filter((e) => e === "reconcile_move_uncommitted"),
      "a removed mailbox was reported as bookkeeping that failed to commit").toEqual([]);
  }, 60_000);
});
