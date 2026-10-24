import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import {
  accounts, auditLog, changeLog, folderState, graduations, learningSignals, mailboxes, messageInstances, messages, rules, type Tx,
} from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeDrizzleRepo, type WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { Change, ChangeBatch, MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { DELETE_EVIDENCE_PER_CYCLE, runSyncCycle } from "../src/sync.js";

/**
 * A FOLDER THE SERVER SAYS DOES NOT EXIST IS FORGOTTEN WHOLE, IN ONE TRANSACTION.
 *
 * The adapter names the folder in `foldersGone` with a delete per remembered letter; the cycle
 * forgets them in one fenced write and outside the per-cycle delete cap, then the reaper takes the
 * rows. A fault on the second forget leaves every instance; a folder past the cap goes in one
 * cycle. Mutation: route those deletes through the ordinary capped loop and both arms go red.
 * A reset's proved deletes ride the same door at their old epoch.
 */

const EPOCH = "7";

async function seeded(n: number) {
  const db = (await makeTestDb()) as unknown as Tx;
  const [a] = await db.insert(accounts).values({ name: "folder-gone-one-transaction" }).returning();
  const accountId = a!.id;
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `t-${accountId.slice(0, 8)}@example.test` }).returning();
  const mailboxId = mb!.id;
  const plant = async (uid: number, folder: string) => {
    const key = `g${uid}-${folder}@example.test`;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId, messageIdHeader: key, bodyHash: key, dedupKey: `mid:<${key}>`,
      subject: "filed", fromAddress: "anna@example.test", nativeLocator: { folder, ref: `${EPOCH}:${uid}` },
    }).returning();
    await db.insert(messageInstances).values({
      accountId, mailboxId, messageId: m!.id, folder, uidvalidity: BigInt(EPOCH), uid, isPrimary: true,
    });
  };
  for (let uid = 1; uid <= n; uid++) await plant(uid, "Projects");
  await plant(1, "INBOX");
  const instancesIn = async (folder: string) => (await db.select({ id: messageInstances.id }).from(messageInstances)
    .where(and(eq(messageInstances.mailboxId, mailboxId), eq(messageInstances.folder, folder)))).length;
  const uidsIn = async (folder: string) => (await db.select({ uid: messageInstances.uid }).from(messageInstances)
    .where(and(eq(messageInstances.mailboxId, mailboxId), eq(messageInstances.folder, folder)))).map((r) => r.uid).sort();
  const live = async () => (await db.select({ id: messages.id }).from(messages)
    .where(and(eq(messages.mailboxId, mailboxId), isNull(messages.deletedAt)))).length;
  return { db, accountId, mailboxId, repo: makeDrizzleRepo(db), instancesIn, uidsIn, live };
}

function goneBatch(n: number): MailboxAdapter {
  const deletes: Change[] = Array.from({ length: n }, (_, i) => ({
    type: "delete", locator: { folder: "Projects", ref: `${EPOCH}:${i + 1}` },
  }));
  const batch: ChangeBatch = {
    creates: [], moves: [], flagChanges: [], deletes, hasBacklog: false, foldersGone: ["Projects"],
    newCursor: { folders: { Projects: { uidValidity: EPOCH, uidNext: n + 1, highestModseq: "0" } } },
  };
  return { changesSince: async () => batch } as unknown as MailboxAdapter;
}

/** The repo, with `method` failing on its `nth` call wherever the cycle makes it. */
function failingCall<R extends object>(repo: R, method: string, nth: number, message: string): R {
  let calls = 0;
  const wrap = (target: R): R => new Proxy(target, {
    get(t, prop, recv) {
      const v = Reflect.get(t, prop, recv) as unknown;
      if (typeof v !== "function") return v;
      if (prop === method) {
        return async (...args: unknown[]) => {
          if (++calls === nth) throw new Error(message);
          return (v as (...a: unknown[]) => unknown).apply(t, args);
        };
      }
      if (prop === "transaction") {
        return (fn: (r: R) => Promise<unknown>): unknown =>
          (v as (f: (r: R) => Promise<unknown>) => unknown).call(t, (inner) => fn(wrap(inner)));
      }
      return (v as (...a: unknown[]) => unknown).bind(t);
    },
  }) as R;
  return wrap(repo);
}

const cycle = (
  repo: WorkerRepo, adapter: MailboxAdapter, s: { accountId: string; mailboxId: string },
  role: "reader" | "organizer" = "reader",
) => runSyncCycle({
  repo, adapter, accountId: s.accountId, mailboxId: s.mailboxId, role,
  writeAuthority: { noLease: role === "reader" ? "reader" as const : "not_supplied" as const },
  storageCap: UNMETERED_STORAGE_CAP, trustedAuthservIds: new Set<string>(),
});

describe("a folder the server says does not exist", () => {
  it("is forgotten in one transaction: a fault on the second letter leaves every instance", async () => {
    const s = await seeded(3);
    await expect(cycle(failingCall(s.repo, "forgetInstanceAt", 2, "the second forget failed"), goneBatch(3), s))
      .rejects.toThrow(/second forget/);
    expect(await s.instancesIn("Projects"), "a fault mid-folder left the folder half forgotten").toBe(3);
    // Positive control: the same batch with no fault forgets the folder and reaps its rows.
    await cycle(s.repo, goneBatch(3), s);
    expect(await s.instancesIn("Projects")).toBe(0);
    expect(await s.live(), "the letter in INBOX was taken with the folder").toBe(1);
  });

  it("a reset's proved delete is believed at its old epoch; the ordinary one there is not", async () => {
    const s = await seeded(2);
    const at = (ref: string): Change => ({ type: "delete", locator: { folder: "Projects", ref } });
    const batch: ChangeBatch = {
      creates: [], moves: [], flagChanges: [], deletes: [at(`${EPOCH}:2`)], resetGone: [at(`${EPOCH}:1`)], hasBacklog: false,
      newCursor: { folders: { Projects: { uidValidity: "8", uidNext: 1, highestModseq: "0" } } },
    };
    await cycle(s.repo, { changesSince: async () => batch } as unknown as MailboxAdapter, s);
    expect(await s.uidsIn("Projects"), "the proved letter stayed, or the epoch guard let the other one go").toEqual([2]);
  });

  it("is forgotten whole in one cycle, past the per-cycle delete cap", async () => {
    const n = DELETE_EVIDENCE_PER_CYCLE + 3;
    const s = await seeded(n);
    await cycle(s.repo, goneBatch(n), s);
    expect(await s.instancesIn("Projects"), "the cap stranded part of a folder the server said is gone").toBe(0);
    expect(await s.instancesIn("INBOX")).toBe(1);
  }, 120_000);
});

/**
 * A LETTER WHOSE INBOX COPY VANISHED IS WHERE ITS OTHER COPY IS. Seen as a second copy first (the
 * phone filed it between this pass's INBOX and News reads), the INBOX expunge promotes that copy,
 * and a settled row follows it: the person's placement, one `move` delta, no IMAP command.
 */
type Placement = { desired: string; observed: string; lastSetBy: "us" | "peer" | "external" };
type Copies = { tombstoned?: boolean; copyIn?: string; primaryIn?: string };
async function promoted(state: Placement, opts: Copies = {}) {
  const db = (await makeTestDb()) as unknown as Tx;
  const [a] = await db.insert(accounts).values({ name: "promoted-copy" }).returning();
  const accountId = a!.id;
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `p-${accountId.slice(0, 8)}@example.test` }).returning();
  const mailboxId = mb!.id;
  const [m] = await db.insert(messages).values({
    accountId, mailboxId, messageIdHeader: "k@example.test", bodyHash: "k", dedupKey: "mid:<k@example.test>",
    subject: "digest", fromAddress: "anna@example.test", nativeLocator: { folder: opts.primaryIn ?? "INBOX", ref: `${EPOCH}:7` },
    ...(opts.tombstoned === true ? { deletedAt: new Date() } : {}),
  }).returning();
  const messageId = m!.id;
  await db.insert(messageInstances).values([
    { accountId, mailboxId, messageId, folder: opts.primaryIn ?? "INBOX", uidvalidity: BigInt(EPOCH), uid: 7, isPrimary: true },
    { accountId, mailboxId, messageId, folder: opts.copyIn ?? "ohmail/News", uidvalidity: 9n, uid: 3, isPrimary: false },
  ]);
  await db.insert(folderState).values({
    messageId, desiredFolder: state.desired, observedFolder: state.observed, lastSetBy: state.lastSetBy,
    reconcileStatus: state.desired === state.observed ? "reconciled" : "pending", conflict: true,
  });
  const placement = async () => {
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
    const moves = await db.select({ meta: changeLog.meta }).from(changeLog)
      .where(and(eq(changeLog.entityId, messageId), eq(changeLog.op, "move")));
    const held = await db.select({ folder: messageInstances.folder }).from(messageInstances)
      .where(eq(messageInstances.messageId, messageId));
    return {
      desired: fs!.desiredFolder, observed: fs!.observedFolder, lastSetBy: fs!.lastSetBy, conflict: fs!.conflict,
      status: fs!.reconcileStatus, moves: moves.map((r) => r.meta), held: held.map((i) => i.folder).sort(),
    };
  };
  return { db, accountId, mailboxId, repo: makeDrizzleRepo(db), placement };
}

/** The server's account of one folder this pass: UID 7 is gone. Counts every move it is asked for. */
function expunged(opts: { folder?: string; sentFolder?: string; reset?: boolean } = {}) {
  const asked = { moves: 0 };
  const folder = opts.folder ?? "INBOX";
  const gone: Change = { type: "delete", locator: { folder, ref: `${EPOCH}:7` } };
  const batch: ChangeBatch = {
    creates: [], moves: [], flagChanges: [], hasBacklog: false,
    ...(opts.reset === true ? { deletes: [], resetGone: [gone] } : { deletes: [gone] }),
    newCursor: { folders: { [folder]: { uidValidity: opts.reset === true ? "8" : EPOCH, uidNext: 8, highestModseq: "0" } } },
  };
  const adapter = {
    changesSince: async () => batch,
    capabilities: async () => ({ sentFolder: opts.sentFolder ?? null }),
    move: async () => { asked.moves += 1; throw new Error("no IMAP command belongs on this path"); },
    moveMany: async () => { asked.moves += 1; throw new Error("no IMAP command belongs on this path"); },
  } as unknown as MailboxAdapter;
  return { adapter, asked };
}

const ADOPTED = {
  desired: "ohmail/News", observed: "ohmail/News", lastSetBy: "external", conflict: false, status: "reconciled",
  moves: [{ from: "INBOX", to: "ohmail/News" }], held: ["ohmail/News"],
};

describe("a letter whose INBOX copy vanished while a copy sits elsewhere", () => {
  it.each(["reader", "organizer"] as const)("a %s adopts the promoted copy of a settled row", async (role) => {
    const s = await promoted({ desired: "INBOX", observed: "INBOX", lastSetBy: role === "reader" ? "peer" : "us" });
    const { adapter, asked } = expunged();
    await cycle(s.repo, adapter, s, role);
    expect(await s.placement(), "the row kept INBOX after its only INBOX copy vanished").toEqual(ADOPTED);
    expect(asked.moves).toBe(0);
  });

  it("adopts on a reset's proved disappearance too", async () => {
    const s = await promoted({ desired: "INBOX", observed: "INBOX", lastSetBy: "peer" });
    await cycle(s.repo, expunged({ reset: true }).adapter, s);
    expect(await s.placement()).toEqual(ADOPTED);
  });

  it.each([
    ["a pending filing of ours", { desired: "ohmail/Screener", observed: "INBOX", lastSetBy: "us" }, {}],
    ["a deleted letter", { desired: "INBOX", observed: "INBOX", lastSetBy: "us" }, { tombstoned: true }],
    ["a copy in Sent", { desired: "INBOX", observed: "INBOX", lastSetBy: "peer" }, { copyIn: "Sent" }],
    // The 0.30.1 incident's two spellings of one folder: a promotion there is no move.
    ["a News copy under the legacy name", { desired: "ohmail/News", observed: "ohmail/News", lastSetBy: "peer" },
      { primaryIn: "ohmail/News", copyIn: "ohmail/Reads" }],
  ] as Array<[string, Placement, Copies]>)("adopts nothing for %s", async (_name, state, opts) => {
    const s = await promoted(state, opts);
    const { adapter, asked } = expunged({ folder: opts.primaryIn ?? "INBOX", sentFolder: "Sent" });
    await cycle(s.repo, adapter, s);
    const after = await s.placement();
    expect([after.desired, after.observed, after.lastSetBy, after.moves]).toEqual([state.desired, state.observed, state.lastSetBy, []]);
    expect(after.held, "the disappearance was not recorded").toEqual([opts.copyIn ?? "ohmail/News"]);
    expect(asked.moves).toBe(0);
  });

  it("adopts in the forget's own transaction: a failed adoption leaves the INBOX copy to be reported again", async () => {
    const s = await promoted({ desired: "INBOX", observed: "INBOX", lastSetBy: "peer" });
    await expect(cycle(failingCall(s.repo, "adoptFolderState", 1, "the adoption failed"), expunged().adapter, s))
      .rejects.toThrow(/adoption failed/);
    expect((await s.placement()).held, "the forget committed without its adoption").toEqual(["INBOX", "ohmail/News"]);
  });

  it("an organizer's filing to the legacy News name settles on the promoted News copy without a move", async () => {
    const s = await promoted({ desired: "ohmail/Reads", observed: "INBOX", lastSetBy: "us" });
    const { adapter, asked } = expunged();
    await cycle(s.repo, adapter, s, "organizer");
    const after = await s.placement();
    expect(asked.moves, "a same-folder filing issued an IMAP move").toBe(0);
    expect([after.desired, after.lastSetBy, after.status, after.moves, after.held])
      .toEqual(["ohmail/Reads", "us", "reconciled", [], ["ohmail/News"]]);
  });
});

/**
 * A LETTER DELETED ON THE SERVER IS NOT MOVED TO ITS OTHER COPY. A learned News route's letter also
 * sits under a passive label; a delete takes both copies in one pass, News first. Adopting the label
 * copy there would count each deletion as an override and two of them demote the route.
 */
describe("a letter whose every copy vanishes in one pass", () => {
  it.each(["reader", "organizer"] as const)("a %s adopts nothing, records no override and reaps the row", async (role) => {
    const db = (await makeTestDb()) as unknown as Tx;
    const [a] = await db.insert(accounts).values({ name: "deleted-with-its-copy" }).returning();
    const accountId = a!.id;
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `d-${accountId.slice(0, 8)}@example.test` }).returning();
    const mailboxId = mb!.id;
    await db.insert(graduations).values({
      accountId, patternKey: "sender:anna@example.test→ohmail/News", action: "route", positives: 3, negatives: 0,
      graduated: true, graduatedAt: new Date(Date.now() - 30 * 24 * 3600_000),
    });
    const [rule] = await db.insert(rules).values({
      accountId, kind: "sender", match: "anna@example.test", destination: "ohmail/News", provenance: "promoted", enabled: true,
    }).returning({ id: rules.id });
    const deletes: Change[] = [];
    for (const uid of [1, 2]) {
      const key = `d${uid}@example.test`;
      const [m] = await db.insert(messages).values({
        accountId, mailboxId, messageIdHeader: key, bodyHash: key, dedupKey: `mid:<${key}>`,
        subject: "digest", fromAddress: "anna@example.test", nativeLocator: { folder: "ohmail/News", ref: `${EPOCH}:${uid}` },
      }).returning();
      await db.insert(messageInstances).values([
        { accountId, mailboxId, messageId: m!.id, folder: "ohmail/News", uidvalidity: BigInt(EPOCH), uid, isPrimary: true },
        { accountId, mailboxId, messageId: m!.id, folder: "Newsletters", uidvalidity: 9n, uid: 10 + uid, isPrimary: false },
      ]);
      await db.insert(folderState).values({
        messageId: m!.id, desiredFolder: "ohmail/News", observedFolder: "ohmail/News",
        lastSetBy: role === "reader" ? "peer" : "us", reconcileStatus: "reconciled", conflict: false,
      });
      deletes.push({ type: "delete", locator: { folder: "ohmail/News", ref: `${EPOCH}:${uid}` } });
    }
    for (const uid of [1, 2]) deletes.push({ type: "delete", locator: { folder: "Newsletters", ref: `9:${10 + uid}` } });
    const batch: ChangeBatch = {
      creates: [], moves: [], flagChanges: [], deletes, hasBacklog: false,
      newCursor: { folders: {
        "ohmail/News": { uidValidity: EPOCH, uidNext: 3, highestModseq: "0" },
        Newsletters: { uidValidity: "9", uidNext: 13, highestModseq: "0" },
      } },
    };
    const adapter = { changesSince: async () => batch, capabilities: async () => ({ sentFolder: "Sent" }) } as unknown as MailboxAdapter;
    const s = { accountId, mailboxId };
    await cycle(makeDrizzleRepo(db), adapter, s, role);
    const ops = (await db.select({ op: changeLog.op, entity: changeLog.entityType }).from(changeLog)
      .where(eq(changeLog.accountId, accountId))).filter((c) => c.entity === "message").map((c) => c.op);
    const audits = (await db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.accountId, accountId))).map((r) => r.action);
    const [after] = await db.select({ enabled: rules.enabled }).from(rules).where(eq(rules.id, rule!.id));
    expect(ops, "a deletion was recorded as a move").toEqual(["delete", "delete"]);
    expect(audits).not.toContain("adopt_external");
    expect(await db.select({ id: learningSignals.id }).from(learningSignals).where(eq(learningSignals.accountId, accountId)),
      "a deletion was counted as an override of the learned route").toEqual([]);
    expect(after!.enabled, "two deletions demoted the learned route").toBe(true);
    expect(await db.select({ id: messages.id }).from(messages).where(and(eq(messages.mailboxId, mailboxId), isNull(messages.deletedAt))))
      .toEqual([]);
  });
});
