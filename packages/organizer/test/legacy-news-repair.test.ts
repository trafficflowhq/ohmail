import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  accounts, auditLog, changeLog, folderState, mailboxFolders, mailboxes, messageBodies, messageInstances, messages, type Tx,
  passProgress,
} from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { ChangeBatch, MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { runSyncCycle } from "../src/sync.js";
import { legacyNewsRepairPass } from "../src/news-repair.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * THE LEGACY NEWS REPAIR, AND THE LETTERS IT MUST NEVER LOSE. A pre-0.22 store spells News
 * `ohmail/Reads` on locators, instances and `folder_state`. Asked by its own name that folder is
 * gone, and the folder-gone path forgot every instance spelled there: a letter whose ONLY record
 * was that spelling (a letter whose server copy a same-folder move had expunged) became
 * instance-less, and the reaper emptied its body as expunged — the mirror's copy was the last one.
 */

const READS = "ohmail/Reads";
const NEWS = "ohmail/News";

async function store() {
  const db = (await makeTestDb()) as unknown as Tx;
  const repo = makeDrizzleRepo(db);
  const account = async (name: string) => {
    const [a] = await db.insert(accounts).values({ name }).returning();
    const accountId = a!.id;
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `t-${accountId.slice(0, 8)}@example.test` }).returning();
    const mailboxId = mb!.id;
    await db.insert(mailboxFolders).values([
      { mailboxId, accountId, folder: NEWS, uidvalidity: 4n, uidnext: 90n, highestmodseq: 1n },
      { mailboxId, accountId, folder: READS, uidvalidity: 1n, uidnext: 9n, highestmodseq: 1n },
    ]);
    /** A letter, its instances (`[folder, epoch, uid, primary]`) and, when given, its folder_state. */
    const letter = async (
      key: string, loc: string, inst: Array<[string, number, number, boolean]>,
      fs?: { desired: string; observed: string; conflict?: boolean },
    ) => {
      const [m] = await db.insert(messages).values({
        accountId, mailboxId, messageIdHeader: `${key}@example.test`, bodyHash: key, dedupKey: `mid:<${key}@example.test>`,
        subject: `letter ${key}`, fromAddress: "news@letters.example", nativeLocator: { folder: loc.split("#")[0]!, ref: loc.split("#")[1]! },
      }).returning();
      await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: `the only copy of ${key}` });
      for (const [folder, epoch, uid, isPrimary] of inst) {
        await db.insert(messageInstances).values({ accountId, mailboxId, messageId: m!.id, folder, uidvalidity: BigInt(epoch), uid, isPrimary });
      }
      if (fs) {
        await db.insert(folderState).values({
          messageId: m!.id, accountId: m!.accountId, desiredFolder: fs.desired, observedFolder: fs.observed, lastSetBy: "us",
          reconcileStatus: fs.desired === fs.observed ? "reconciled" : "pending", conflict: fs.conflict ?? false,
        });
      }
      return m!.id;
    };
    return { accountId, mailboxId, letter };
  };
  const row = async (id: string) => {
    const [m] = await db.select({ loc: messages.nativeLocator, deletedAt: messages.deletedAt, missingAt: messages.serverMissingAt })
      .from(messages).where(eq(messages.id, id));
    const [b] = await db.select({ text: messageBodies.text, withheld: messageBodies.withheldReason })
      .from(messageBodies).where(eq(messageBodies.messageId, id));
    const inst = (await db.select({ f: messageInstances.folder, e: messageInstances.uidvalidity, u: messageInstances.uid, p: messageInstances.isPrimary })
      .from(messageInstances).where(eq(messageInstances.messageId, id)))
      .map((i) => `${i.f}#${String(i.e)}:${i.u}${i.p ? "*" : ""}`).sort();
    const [fs] = await db.select({ d: folderState.desiredFolder, o: folderState.observedFolder, c: folderState.conflict })
      .from(folderState).where(eq(folderState.messageId, id));
    return { loc: m!.loc as { folder: string; ref: string }, deletedAt: m!.deletedAt, missingAt: m!.missingAt, body: b, inst, fs };
  };
  /** One chunk, inside a transaction as the pass's fenced group runs it. */
  const repair = (accountId: string, mailboxId: string, limit = 50) =>
    repo.transaction((r) => r.repairLegacyNews!(accountId, mailboxId, { limit }));
  return { db, repo, account, row, repair };
}

/** The organizer's adapter after the rename: the pile at News, no Reads beside it. */
const adapterOf = (batches: ChangeBatch[]): MailboxAdapter => {
  let i = 0;
  return {
    legacyNewsRepairGate: () => ({ attach: 1 }),
    changesSince: async () => batches[Math.min(i++, batches.length - 1)]!,
  } as unknown as MailboxAdapter;
};
const quiet = (): ChangeBatch => ({
  creates: [], moves: [], flagChanges: [], deletes: [], hasBacklog: false, unchanged: true, newCursor: { folders: {} },
});
/** The adapter's own statement for the legacy row: asked by its name, the folder does not exist. */
const readsGone = (refs: string[]): ChangeBatch => ({
  creates: [], moves: [], flagChanges: [], hasBacklog: false, foldersGone: [READS],
  deletes: refs.map((ref) => ({ type: "delete" as const, locator: { folder: READS, ref } })),
  newCursor: { folders: { [READS]: { uidValidity: "1", uidNext: 9, highestModseq: "1" } } },
});

const organizerCycle = (s: Awaited<ReturnType<typeof store>>, a: { accountId: string; mailboxId: string }, adapter: MailboxAdapter) =>
  runSyncCycle({
    repo: s.repo, adapter, accountId: a.accountId, mailboxId: a.mailboxId, role: "organizer",
    writeAuthority: FIXTURE_LEASE, storageCap: UNMETERED_STORAGE_CAP, trustedAuthservIds: new Set<string>(), signatures: null,
  });

describe("a letter whose only record is the legacy spelling", () => {
  it("is kept with its body, marked missing on the server, and never reaped when the old row retires", async () => {
    const s = await store();
    const a = await s.account("only-copy");
    // The server copy is gone, and the store's last instance names ohmail/Reads.
    const lost = await a.letter("lost", `${READS}#1:5`, [[READS, 1, 5, true]], { desired: READS, observed: READS });
    // Control: a letter whose re-read recorded its News copy.
    const kept = await a.letter("kept", `${READS}#1:6`, [[READS, 1, 6, true], [NEWS, 4, 60, false]], { desired: READS, observed: READS, conflict: true });
    const adapter = adapterOf([readsGone(["1:5", "1:6"]), quiet(), quiet()]);
    await organizerCycle(s, a, adapter);
    await organizerCycle(s, a, adapter);
    await organizerCycle(s, a, adapter);

    const l = await s.row(lost);
    expect(l.deletedAt, "the reaper took the mirror's only copy").toBeNull();
    expect(l.body).toEqual({ text: "the only copy of lost", withheld: null });
    expect(l.missingAt).not.toBeNull();
    expect(l.loc.folder).toBe(NEWS);
    expect(l.fs).toEqual({ d: NEWS, o: NEWS, c: false });
    const audits = await s.db.select({ action: auditLog.action, payload: auditLog.payload }).from(auditLog)
      .where(eq(auditLog.accountId, a.accountId));
    expect(audits.filter((r) => r.action === "sync.message_missing").map((r) => (r.payload as { messageId: string }).messageId))
      .toEqual([lost]);

    const k = await s.row(kept);
    expect(k).toMatchObject({ deletedAt: null, missingAt: null, loc: { folder: NEWS, ref: "4:60" } });
    expect(k.inst).toEqual([`${NEWS}#4:60*`]);
    expect(k.fs).toEqual({ d: NEWS, o: NEWS, c: false });
    // The old row retires once nothing is spelled there.
    const folders = await s.db.select({ f: mailboxFolders.folder }).from(mailboxFolders).where(eq(mailboxFolders.mailboxId, a.mailboxId));
    expect(folders.map((f) => f.f)).toEqual([NEWS]);
  });
});

describe("the repair's three shapes, content-matched", () => {
  it("renamed (one epoch): the News copy a re-read recorded takes the primary; all four spellings read News", async () => {
    const s = await store();
    const a = await s.account("renamed");
    // A RENAME kept UIDVALIDITY 4: the legacy instance and the re-read's News copy share epoch and uid.
    await s.db.update(mailboxFolders).set({ uidvalidity: 4n }).where(and(eq(mailboxFolders.mailboxId, a.mailboxId), eq(mailboxFolders.folder, READS)));
    const id = await a.letter("r", `${READS}#4:7`, [[READS, 4, 7, true], [NEWS, 4, 7, false]], { desired: READS, observed: READS, conflict: true });
    const out = await s.repair(a.accountId, a.mailboxId, 50);
    expect(out).toMatchObject({ examined: 1, repointed: 1, forgotten: 1, missing: [], spellings: 1, more: false });
    const r = await s.row(id);
    expect(r).toMatchObject({ loc: { folder: NEWS, ref: "4:7" }, missingAt: null, fs: { d: NEWS, o: NEWS, c: false } });
    expect(r.inst).toEqual([`${NEWS}#4:7*`]);
  });

  it("merged (new uids): the copy recorded under News's epoch wins and the Reads row is forgotten", async () => {
    const s = await store();
    const a = await s.account("merged");
    const id = await a.letter("m", `${READS}#1:3`, [[READS, 1, 3, true], [NEWS, 4, 40, false]], { desired: "ohmail/Receipts", observed: READS });
    await s.repair(a.accountId, a.mailboxId, 50);
    const r = await s.row(id);
    expect(r.loc).toEqual({ folder: NEWS, ref: "4:40" });
    expect(r.inst).toEqual([`${NEWS}#4:40*`]);
    // The filing stands, spelled the one way: still owed, from the live copy.
    expect(r.fs).toEqual({ d: "ohmail/Receipts", o: NEWS, c: false });
  });

  it("a RENAME that stamped a new UIDVALIDITY: the live-epoch copy wins over the old-epoch one, never a bare uid", async () => {
    const s = await store();
    const a = await s.account("new-epoch");
    // Reads@1:3 and the first re-read's News@1:3 are both dead epochs; News@4:12 is the live copy.
    const id = await a.letter("e", `${READS}#1:3`, [[READS, 1, 3, true], [NEWS, 1, 3, false], [NEWS, 4, 12, false]], { desired: READS, observed: READS, conflict: true });
    // A stranger at News@4:3 — the same uid as the legacy row, under the live epoch.
    const stranger = await a.letter("x", `${NEWS}#4:3`, [[NEWS, 4, 3, true]]);
    const out = await s.repair(a.accountId, a.mailboxId, 50);
    expect(out.forgotten).toBe(2);
    const r = await s.row(id);
    expect(r.loc).toEqual({ folder: NEWS, ref: "4:12" });
    expect(r.inst).toEqual([`${NEWS}#4:12*`]);
    expect((await s.row(stranger)).inst).toEqual([`${NEWS}#4:3*`]);
  });

  it("is idempotent, stays inside its account, and waits for a News cursor", async () => {
    const s = await store();
    const a = await s.account("one");
    const b = await s.account("two");
    const mine = await a.letter("a1", `${READS}#1:3`, [[READS, 1, 3, true], [NEWS, 4, 30, false]]);
    const theirs = await b.letter("b1", `${READS}#1:3`, [[READS, 1, 3, true], [NEWS, 4, 30, false]]);
    expect((await s.repair(a.accountId, a.mailboxId, 50)).repointed).toBe(1);
    expect(await s.repair(a.accountId, a.mailboxId, 50))
      .toMatchObject({ examined: 0, repointed: 0, forgotten: 0, missing: [], more: false });
    expect((await s.row(mine)).loc.folder).toBe(NEWS);
    expect((await s.row(theirs)).inst).toEqual([`${NEWS}#4:30`, `${READS}#1:3*`]);
    // Another account's mailbox id under this account answers nothing.
    expect((await s.repair(a.accountId, b.mailboxId, 50)).examined).toBe(0);
    await s.db.delete(mailboxFolders).where(and(eq(mailboxFolders.mailboxId, b.mailboxId), eq(mailboxFolders.folder, NEWS)));
    expect((await s.repair(b.accountId, b.mailboxId, 50)).skipped).toBe("no_news_cursor");
    expect((await s.row(theirs)).loc.folder).toBe(READS);
  });

  it("works in chunks and says when more is owed", async () => {
    const s = await store();
    const a = await s.account("chunks");
    for (const k of ["c1", "c2", "c3"]) await a.letter(k, `${READS}#1:${k.length}`, [[NEWS, 4, Number(k.slice(1)) + 70, true]], { desired: READS, observed: READS });
    expect(await s.repair(a.accountId, a.mailboxId, 2)).toMatchObject({ examined: 2, more: true });
    expect(await s.repair(a.accountId, a.mailboxId, 2)).toMatchObject({ examined: 1, more: false });
    expect((await s.repair(a.accountId, a.mailboxId, 2)).examined).toBe(0);
  });
});

describe("the pass around the repair", () => {
  /** The mailbox's recorded clean mark: the repair's done mark for it. */
  const cleanAt = async (s: Awaited<ReturnType<typeof store>>, mailboxId: string) =>
    (await s.db.select({ at: passProgress.doneAt }).from(passProgress)
      .where(and(eq(passProgress.job, "news_repair"), eq(passProgress.subjectId, mailboxId))))[0]?.at ?? null;
  const gateAt = (attach: number) => ({ legacyNewsRepairGate: () => ({ attach }) }) as unknown as MailboxAdapter;
  const passOf = (s: Awaited<ReturnType<typeof store>>, a: { accountId: string; mailboxId: string }) =>
    (adapter: MailboxAdapter) => legacyNewsRepairPass({
      repo: s.repo, adapter, accountId: a.accountId, mailboxId: a.mailboxId, write: (fn) => s.repo.transaction(fn),
    });

  it("runs while the gate is open, stops once the store is clean, and records it once", async () => {
    const s = await store();
    const a = await s.account("gate");
    await a.letter("g", `${READS}#1:3`, [[READS, 1, 3, true], [NEWS, 4, 30, false]]);
    const walks = vi.spyOn(s.repo, "hasLegacyNewsRows");
    // Each chunk and each mark is one fenced group: counting the groups counts the writes.
    let calls = 0;
    let gate: { attach: number } | null = null;
    const adapter = { legacyNewsRepairGate: () => gate } as unknown as MailboxAdapter;
    const visit = () => legacyNewsRepairPass({
      repo: s.repo, adapter, accountId: a.accountId, mailboxId: a.mailboxId,
      write: (fn) => { calls++; return s.repo.transaction(fn); },
    });
    expect((await visit()).repair, "a closed gate (Reads still beside News) repairs nothing").toBeNull();
    expect(walks).not.toHaveBeenCalled();
    gate = { attach: 1 };
    expect((await visit()).repair?.repointed).toBe(1);
    expect(await cleanAt(s, a.mailboxId), "a dirty mailbox is never marked").toBeNull();
    expect((await visit()).repair, "a clean store is found by a read, and recorded once").toBeNull();
    expect(await cleanAt(s, a.mailboxId)).not.toBeNull();
    expect((await visit()).repair, "clean under this attach: not asked again").toBeNull();
    gate = { attach: 2 };
    // The attach re-arm is retired: a mailbox recorded clean is not walked on the next attach.
    expect((await visit()).repair, "recorded clean: the next attach walks nothing").toBeNull();
    expect(walks).toHaveBeenCalledTimes(2);
    expect(calls).toBe(2);
  });

  it("a clean mailbox is walked once, on its first connection, and never on a later one", async () => {
    const s = await store();
    const a = await s.account("clean");
    await a.letter("n", `${NEWS}#4:30`, [[NEWS, 4, 30, true]], { desired: NEWS, observed: NEWS });
    const walks = vi.spyOn(s.repo, "hasLegacyNewsRows");
    const pass = passOf(s, a);
    const first = gateAt(1);
    expect((await pass(first)).repair).toBeNull();
    expect(walks).toHaveBeenCalledTimes(1);
    expect(await cleanAt(s, a.mailboxId)).not.toBeNull();
    // A worker restart or a re-attach after a dropped connection: a new adapter, and the same one at its next attach.
    expect((await pass(gateAt(1))).repair).toBeNull();
    expect((await pass(gateAt(2))).repair).toBeNull();
    expect(walks).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["(a) a legacy instance beside a News primary", `${NEWS}#4:30`, [[READS, 1, 3, false], [NEWS, 4, 30, true]], undefined],
    ["(b) a locator spelled the old way, with a News instance", `${READS}#1:3`, [[NEWS, 4, 30, true]], undefined],
    ["(c1) a folder_state desired spelled the old way", `${NEWS}#4:30`, [[NEWS, 4, 30, true]], { desired: READS, observed: NEWS }],
    ["(c2) a folder_state observed spelled the old way", `${NEWS}#4:30`, [[NEWS, 4, 30, true]], { desired: NEWS, observed: READS }],
  ] as const)("%s is still found and repaired, and marked only after", async (_name, loc, inst, fs) => {
    const s = await store();
    const a = await s.account("shape");
    const id = await a.letter("s", loc, inst.map((i) => [...i] as [string, number, number, boolean]), fs);
    const pass = passOf(s, a);
    const first = await pass(gateAt(1));
    expect(first.repair?.examined).toBe(1);
    const r = await s.row(id);
    expect(r.loc.folder).toBe(NEWS);
    expect(r.inst).toEqual([`${NEWS}#4:30*`]);
    if (fs) expect([r.fs?.d, r.fs?.o]).toEqual([NEWS, NEWS]);
    expect(await cleanAt(s, a.mailboxId), "a mailbox the walk found dirty is not marked").toBeNull();
    expect((await pass(gateAt(1))).repair).toBeNull();
    expect(await cleanAt(s, a.mailboxId)).not.toBeNull();
    const walks = vi.spyOn(s.repo, "hasLegacyNewsRows");
    expect((await pass(gateAt(1))).repair).toBeNull();
    expect(walks).not.toHaveBeenCalled();
  });

  it("the mark is read and written inside its own account", async () => {
    const s = await store();
    const a = await s.account("mine");
    const b = await s.account("theirs");
    await s.repo.markLegacyNewsClean!(a.accountId, b.mailboxId);
    expect(await cleanAt(s, b.mailboxId)).toBeNull();
    await s.repo.markLegacyNewsClean!(b.accountId, b.mailboxId);
    expect(await s.repo.isLegacyNewsClean!(b.accountId, b.mailboxId)).toBe(true);
    expect(await s.repo.isLegacyNewsClean!(a.accountId, b.mailboxId)).toBe(false);
  });
});

describe("one folder under two names: ingest and completion compare them canonically", () => {
  const raw = Buffer.from("Message-ID: <reread@example.test>\r\nFrom: news@letters.example\r\nTo: me@x.example\r\nSubject: reread\r\nDate: Thu, 23 Oct 2026 10:00:00 +0000\r\n\r\nhello\r\n");
  const create = (ref: string): ChangeBatch => ({
    creates: [{ type: "create", locator: { folder: NEWS, ref }, raw, seen: true }], moves: [], flagChanges: [], deletes: [],
    hasBacklog: false, newCursor: { folders: { [NEWS]: { uidValidity: ref.split(":")[0]!, uidNext: 99, highestModseq: "1" } } },
  });

  it("a re-read in renumbered News of a letter stored as ohmail/Reads re-points it, and the pair settles", async () => {
    const s = await store();
    const a = await s.account("reread");
    const readerCycle = (batch: ChangeBatch) => runSyncCycle({
      repo: s.repo, adapter: { changesSince: async () => batch } as unknown as MailboxAdapter,
      accountId: a.accountId, mailboxId: a.mailboxId, role: "reader", writeAuthority: { noLease: "reader" as const },
      storageCap: UNMETERED_STORAGE_CAP, trustedAuthservIds: new Set<string>(), signatures: null,
    });
    await readerCycle(create("1:50"));
    const [m] = await s.db.select({ id: messages.id }).from(messages).where(eq(messages.subject, "reread"));
    // The store as a pre-0.22 build left it: every spelling the old name, under the old epoch.
    await s.db.update(messageInstances).set({ folder: READS }).where(eq(messageInstances.messageId, m!.id));
    await s.db.update(messages).set({ nativeLocator: { folder: READS, ref: "1:50" } }).where(eq(messages.id, m!.id));
    await s.db.update(folderState).set({ desiredFolder: READS, observedFolder: READS }).where(eq(folderState.messageId, m!.id));
    await readerCycle(create("4:7"));

    const r = await s.row(m!.id);
    expect(r.loc).toEqual({ folder: NEWS, ref: "4:7" });
    expect(r.inst).toEqual([`${NEWS}#4:7*`]);
    expect(r.fs?.c, "a re-read is not a second delivery").toBe(false);
    const [st] = await s.db.select({ status: folderState.reconcileStatus }).from(folderState).where(eq(folderState.messageId, m!.id));
    expect(st!.status).toBe("reconciled");
  });

  it("a completion spelled either way settles the row and clears the refusal's class with its schedule", async () => {
    const s = await store();
    const a = await s.account("complete");
    const id = await a.letter("c", `${NEWS}#4:9`, [[NEWS, 4, 9, true]], { desired: READS, observed: "INBOX" });
    await s.db.update(folderState).set({ attempts: 3, lastErrorClass: "refused", nextAttemptAt: new Date(Date.now() + 3_600_000) })
      .where(eq(folderState.messageId, id));
    expect(await s.repo.completeFolderState(id, {
      expectDesiredFolder: READS, observedFolder: NEWS, lastSetBy: "us", physicalObservation: true,
    })).toBe(true);
    const [st] = await s.db.select({
      status: folderState.reconcileStatus, attempts: folderState.attempts, next: folderState.nextAttemptAt, cls: folderState.lastErrorClass,
    }).from(folderState).where(eq(folderState.messageId, id));
    expect(st).toEqual({ status: "reconciled", attempts: 0, next: null, cls: null });
  });
});

describe("the mark ends when a copy is seen again", () => {
  it("an arrival of a letter marked missing clears it", async () => {
    const s = await store();
    const a = await s.account("seen-again");
    const raw = Buffer.from("Message-ID: <back@example.test>\r\nFrom: news@letters.example\r\nTo: me@x.example\r\nSubject: back\r\nDate: Thu, 23 Oct 2026 10:00:00 +0000\r\n\r\nhello\r\n");
    const create = (ref: string): ChangeBatch => ({
      creates: [{ type: "create", locator: { folder: NEWS, ref }, raw, seen: true }], moves: [], flagChanges: [], deletes: [],
      hasBacklog: false, newCursor: { folders: { [NEWS]: { uidValidity: "4", uidNext: 99, highestModseq: "1" } } },
    });
    const readerCycle = (batch: ChangeBatch) => runSyncCycle({
      repo: s.repo, adapter: { changesSince: async () => batch } as unknown as MailboxAdapter,
      accountId: a.accountId, mailboxId: a.mailboxId, role: "reader", writeAuthority: { noLease: "reader" as const },
      storageCap: UNMETERED_STORAGE_CAP, trustedAuthservIds: new Set<string>(), signatures: null,
    });
    await readerCycle(create("4:50"));
    const [m] = await s.db.select({ id: messages.id }).from(messages).where(eq(messages.subject, "back"));
    await s.db.delete(messageInstances).where(eq(messageInstances.messageId, m!.id));
    await s.db.update(messages).set({ serverMissingAt: new Date() }).where(eq(messages.id, m!.id));
    const updates = async () => (await s.db.select({ op: changeLog.op }).from(changeLog)
      .where(and(eq(changeLog.entityId, m!.id), eq(changeLog.op, "update")))).length;
    const before = await updates();
    await readerCycle(create("4:51"));

    const r = await s.row(m!.id);
    expect(r.missingAt).toBeNull();
    expect(r.loc).toEqual({ folder: NEWS, ref: "4:51" });
    expect(await updates(), "clients are told the mark went").toBe(before + 1);
  });
});
