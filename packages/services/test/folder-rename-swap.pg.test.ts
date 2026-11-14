import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  accounts, accountSyncState, changeLog, folderOps, folderState,
  mailboxFolders, mailboxes, messageFailures, messageInstances, messages,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { FolderOpsService, ServiceError, type ServiceContext } from "../src/index.js";
import { setFoldersEnabled } from "../src/consent-seed.js";

/**
 * THE RENAME SWAP IS ONE TRANSACTION, PROVEN BY KILLING IT — mail 0074 (FOLDERS-SPEC.md
 * stage 2).
 *
 * ── WHY `.pg.test.ts` ────────────────────────────────────────────────────────────────────
 *
 * `applyFolderRename` re-spells one canonical path across FIVE tables plus the change log in a
 * single transaction, with SQL fragments PGlite is exactly the wrong oracle for (three
 * production bugs were invisible to PGlite — CLAUDE.md): `jsonb_set` over `native_locator`,
 * `left(col, n) = path || '/'` subtree membership, `to || substr(col, n)` swaps, and the
 * `recordChanges` seq-range allocation under the account row lock. The kill test is the
 * brief's own sentence: a crash mid-rename must not leave half a swap — so the abort arm
 * asserts EVERY table still wears the OLD spelling and the command is still owed.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ACCOUNT = randomUUID();

describe.skipIf(!PG_UP)("mail 0074 — the rename swap on real Postgres", () => {
  let mb: string;
  let fSub: string;      // "Proj" — the subject
  let fChild: string;    // "Proj/Sub" — rides along
  let fOther: string;    // "Elsewhere" — must not move
  let fSquat: string;    // "Neu" — a PHANTOM squatting the target path
  let opId: string;
  let m1: string;        // locator+instance in "Proj", no folder_state
  let m2: string;        // in "Proj/Sub", folder_state desired=observed
  let m3: string;        // observed "Elsewhere", desired "Proj/Sub" — a pending move INTO the subtree
  let m4: string;        // tombstoned row in "Proj" — strings swap, NO change row

  // The cases' fixed uids stay below 1000, so msg()'s never meet them at (folder, 7).
  let nextUid = 1000;
  const msg = async (folder: string, opts: { deleted?: boolean } = {}): Promise<string> => {
    const id = randomUUID();
    const uid = nextUid++;
    await db.insert(messages).values({
      id, accountId: ACCOUNT, mailboxId: mb,
      bodyHash: `h-${id.slice(0, 8)}`, dedupKey: `d-${id}`,
      nativeLocator: { folder, ref: `7:${uid}` },
      ...(opts.deleted ? { deletedAt: new Date() } : {}),
    });
    await db.insert(messageInstances).values({
      accountId: ACCOUNT, mailboxId: mb, messageId: id,
      folder, uidvalidity: 7n, uid, isPrimary: true,
    });
    return id;
  };

  beforeAll(async () => {
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
    await runMigrations(PG_TEST_URL);
    await db.insert(accounts).values({ id: ACCOUNT, name: `frs-${ACCOUNT.slice(0, 8)}` });
    const [box] = await db.insert(mailboxes)
      .values({ id: randomUUID(), accountId: ACCOUNT, provider: "imap", address: `frs-${ACCOUNT.slice(0, 8)}@x.example` })
      .returning();
    mb = box!.id;
    const folder = async (path: string): Promise<string> => {
      const [r] = await db.insert(mailboxFolders)
        .values({ mailboxId: mb, accountId: ACCOUNT, folder: path, uidvalidity: 7n, uidnext: 9n, highestmodseq: 3n })
        .returning();
      return r!.id;
    };
    fSub = await folder("Proj");
    fChild = await folder("Proj/Sub");
    fOther = await folder("Elsewhere");
    fSquat = await folder("Neu");
    const [op] = await db.insert(folderOps)
      .values({ accountId: ACCOUNT, mailboxId: mb, folderId: fSub, op: "rename", toFolder: "Neu" })
      .returning();
    opId = op!.id;

    m1 = await msg("Proj");
    m2 = await msg("Proj/Sub");
    await db.insert(folderState).values({
      messageId: m2, accountId: ACCOUNT, desiredFolder: "Proj/Sub", observedFolder: "Proj/Sub", lastSetBy: "external",
    });
    m3 = await msg("Elsewhere");
    await db.insert(folderState).values({
      messageId: m3, accountId: ACCOUNT, desiredFolder: "Proj/Sub", observedFolder: "Elsewhere", lastSetBy: "us",
    });
    m4 = await msg("Proj", { deleted: true });
    await db.insert(messageFailures).values({
      accountId: ACCOUNT, mailboxId: mb, folder: "Proj/Sub", uidvalidity: 7n, uid: 41,
      code: "mime_too_large",
    });
  });

  afterAll(async () => {
    await db.delete(changeLog).where(eq(changeLog.accountId, ACCOUNT));
    await db.delete(accountSyncState).where(eq(accountSyncState.accountId, ACCOUNT));
    await db.delete(messageFailures).where(eq(messageFailures.accountId, ACCOUNT));
    await db.execute(sql`delete from folder_state where message_id in (select id from messages where account_id = ${ACCOUNT})`);
    await db.delete(messageInstances).where(eq(messageInstances.accountId, ACCOUNT));
    await db.delete(messages).where(eq(messages.accountId, ACCOUNT));
    await db.delete(folderOps).where(eq(folderOps.accountId, ACCOUNT));
    await db.delete(mailboxFolders).where(eq(mailboxFolders.mailboxId, mb));
    await db.delete(mailboxes).where(eq(mailboxes.accountId, ACCOUNT));
    await db.delete(accounts).where(eq(accounts.id, ACCOUNT));
    await client.end();
  });

  it("a kill mid-rename leaves the OLD spelling everywhere and the command still owed", async () => {
    const repo = makeDrizzleRepo(db as never);
    await expect(
      repo.transaction(async (r) => {
        await r.applyFolderRename({ id: opId, accountId: ACCOUNT, mailboxId: mb, folder: "Proj", toFolder: "Neu" });
        // The kill — after every statement of the swap has run, before COMMIT.
        throw new Error("kill mid-rename");
      }),
    ).rejects.toThrow("kill mid-rename");

    // NOTHING moved: the inventory, both folder_state columns, the locator json, the
    // instances, the failure ledger, the squatter, the command row and the log are all
    // exactly as seeded — half a swap is not a state this design has.
    const paths = (await db.select({ f: mailboxFolders.folder }).from(mailboxFolders)
      .where(eq(mailboxFolders.mailboxId, mb))).map((r) => r.f).sort();
    expect(paths).toEqual(["Elsewhere", "Neu", "Proj", "Proj/Sub"]);
    const [fs2] = await db.select().from(folderState).where(eq(folderState.messageId, m2));
    expect(fs2!.desiredFolder).toBe("Proj/Sub");
    expect(fs2!.observedFolder).toBe("Proj/Sub");
    const [row1] = await db.select({ loc: messages.nativeLocator }).from(messages).where(eq(messages.id, m1));
    expect((row1!.loc as { folder: string }).folder).toBe("Proj");
    const [opRow] = await db.select().from(folderOps).where(eq(folderOps.id, opId));
    expect(opRow).toBeDefined();
    expect(opRow!.status).toBe("pending");
    const log = await db.select().from(changeLog).where(eq(changeLog.accountId, ACCOUNT));
    expect(log).toHaveLength(0);
  });

  it("listFolderSubtree answers leaf-deepest FIRST — the folder delete's children-before-parents order", async () => {
    const repo = makeDrizzleRepo(db as never);
    const rows = await repo.listFolderSubtree(mb, "Proj");
    expect(rows.map((r) => r.folder)).toEqual(["Proj/Sub", "Proj"]);
    expect(rows.map((r) => r.id)).toEqual([fChild, fSub]);
  });

  it("the committed swap re-spells every table, tombstones the squatter, retires the command, and batches the change rows", async () => {
    const repo = makeDrizzleRepo(db as never);
    const out = await repo.transaction(async (r) =>
      r.applyFolderRename({ id: opId, accountId: ACCOUNT, mailboxId: mb, folder: "Proj", toFolder: "Neu" }));
    expect(out.folders).toBe(2);   // Proj + Proj/Sub
    expect(out.messages).toBe(3);  // m1, m2, m3 — m4 is tombstoned and travels no row

    // Inventory: subject and child re-spelt with cursors intact; the squatter is GONE.
    const rows = await db.select().from(mailboxFolders).where(eq(mailboxFolders.mailboxId, mb));
    const byPath = new Map(rows.map((r) => [r.folder, r]));
    expect([...byPath.keys()].sort()).toEqual(["Elsewhere", "Neu", "Neu/Sub"]);
    expect(byPath.get("Neu")!.id).toBe(fSub);
    expect(byPath.get("Neu/Sub")!.id).toBe(fChild);
    expect(byPath.get("Neu")!.uidvalidity).toBe(7n);
    expect(byPath.get("Elsewhere")!.id).toBe(fOther);

    // folder_state: desired and observed move INDEPENDENTLY — m2 both, m3 desired only.
    const [fs2] = await db.select().from(folderState).where(eq(folderState.messageId, m2));
    expect(fs2!.desiredFolder).toBe("Neu/Sub");
    expect(fs2!.observedFolder).toBe("Neu/Sub");
    const [fs3] = await db.select().from(folderState).where(eq(folderState.messageId, m3));
    expect(fs3!.desiredFolder).toBe("Neu/Sub");
    expect(fs3!.observedFolder).toBe("Elsewhere");

    // Locators and instances: the exact subject maps to the target (substr past the end), the
    // child keeps its relative path; the tombstoned row's strings swap too.
    const locOf = async (id: string) => {
      const [r] = await db.select({ loc: messages.nativeLocator }).from(messages).where(eq(messages.id, id));
      return (r!.loc as { folder: string }).folder;
    };
    expect(await locOf(m1)).toBe("Neu");
    expect(await locOf(m2)).toBe("Neu/Sub");
    expect(await locOf(m3)).toBe("Elsewhere");
    expect(await locOf(m4)).toBe("Neu");
    const inst = await db.select({ f: messageInstances.folder }).from(messageInstances)
      .where(eq(messageInstances.messageId, m1));
    expect(inst[0]!.f).toBe("Neu");

    // The failure ledger follows, so the retry probe keeps addressing the real folder.
    const [fail] = await db.select({ f: messageFailures.folder }).from(messageFailures)
      .where(eq(messageFailures.accountId, ACCOUNT));
    expect(fail!.f).toBe("Neu/Sub");

    // The command retired WITH the swap — same transaction.
    expect(await db.select().from(folderOps).where(eq(folderOps.id, opId))).toHaveLength(0);

    // The change rows: one batch — gap-free seqs; folder updates for subject+child, a delete
    // tombstone for the squatter, one message update per LIVING message whose rendered folder
    // moved (m1, m2, m3 — never m4), and nothing for the untouched folder.
    const log = await db.select().from(changeLog)
      .where(eq(changeLog.accountId, ACCOUNT)).orderBy(changeLog.seq);
    const seqs = log.map((r) => Number(r.seq));
    expect(seqs[seqs.length - 1]! - seqs[0]!).toBe(seqs.length - 1);
    const folderUpdates = log.filter((r) => r.entityType === "folder" && r.op === "update").map((r) => r.entityId);
    expect(folderUpdates.sort()).toEqual([fSub, fChild].sort());
    const folderDeletes = log.filter((r) => r.entityType === "folder" && r.op === "delete").map((r) => r.entityId);
    expect(folderDeletes).toEqual([fSquat]);
    const messageUpdates = log.filter((r) => r.entityType === "message").map((r) => r.entityId);
    expect(messageUpdates.sort()).toEqual([m1, m2, m3].sort());
    expect(log.some((r) => r.entityId === fOther || r.entityId === m4)).toBe(false);
  });

  it("the swap counts CHARACTERS, not UTF-16 units — an astral character in the path cannot shear the prefix", async () => {
    const repo = makeDrizzleRepo(db as never);
    const folder = async (path: string): Promise<string> => {
      const [r] = await db.insert(mailboxFolders)
        .values({ mailboxId: mb, accountId: ACCOUNT, folder: path, uidvalidity: 9n, uidnext: 1n, highestmodseq: 1n })
        .returning();
      return r!.id;
    };
    const root = await folder("P\u{1F4C1}");        // "P📁" — 2 PG characters, 3 UTF-16 units
    const kid = await folder("P\u{1F4C1}/S");
    const m = await msg("P\u{1F4C1}/S");
    const [opRow] = await db.insert(folderOps)
      .values({ accountId: ACCOUNT, mailboxId: mb, folderId: root, op: "rename", toFolder: "Q" })
      .returning();
    await repo.transaction(async (r) =>
      r.applyFolderRename({ id: opRow!.id, accountId: ACCOUNT, mailboxId: mb, folder: "P\u{1F4C1}", toFolder: "Q" }));
    const rows = await db.select({ id: mailboxFolders.id, f: mailboxFolders.folder })
      .from(mailboxFolders).where(inArray(mailboxFolders.id, [root, kid]));
    expect(new Map(rows.map((r) => [r.id, r.f]))).toEqual(new Map([[root, "Q"], [kid, "Q/S"]]));
    const [row] = await db.select({ loc: messages.nativeLocator }).from(messages).where(eq(messages.id, m));
    expect((row!.loc as { folder: string }).folder).toBe("Q/S");
  });

  it("the delete's tombstone PROMOTES a surviving watched copy instead of hiding the message", async () => {
    const repo = makeDrizzleRepo(db as never);
    await db.insert(mailboxFolders)
      .values({ mailboxId: mb, accountId: ACCOUNT, folder: "Sweep", uidvalidity: 11n, uidnext: 1n, highestmodseq: 1n });
    // One message, primary copy in the swept folder, a second WATCHED copy elsewhere.
    const twin = randomUUID();
    await db.insert(messages).values({
      id: twin, accountId: ACCOUNT, mailboxId: mb,
      bodyHash: "h-twin", dedupKey: `d-${twin}`,
      nativeLocator: { folder: "Sweep", ref: "11:5" },
    });
    await db.insert(messageInstances).values([
      { accountId: ACCOUNT, mailboxId: mb, messageId: twin, folder: "Sweep", uidvalidity: 11n, uid: 5, isPrimary: true },
      { accountId: ACCOUNT, mailboxId: mb, messageId: twin, folder: "Elsewhere", uidvalidity: 7n, uid: 91, isPrimary: false },
    ]);
    // And one loner whose only copy is in the swept folder — the tombstone case.
    const loner = await msg("Sweep");

    const took = await repo.transaction(async (r) =>
      r.tombstoneFolderMessages(ACCOUNT, mb, "Sweep", 200));
    expect(took).toBe(2);

    // The twin LIVES: not tombstoned, locator promoted to the survivor, swept instance gone.
    const [t] = await db.select({ deletedAt: messages.deletedAt, loc: messages.nativeLocator })
      .from(messages).where(eq(messages.id, twin));
    expect(t!.deletedAt).toBeNull();
    expect((t!.loc as { folder: string; ref: string })).toEqual({ folder: "Elsewhere", ref: "7:91" });
    const twinInstances = await db.select({ f: messageInstances.folder, p: messageInstances.isPrimary })
      .from(messageInstances).where(eq(messageInstances.messageId, twin));
    expect(twinInstances).toEqual([{ f: "Elsewhere", p: true }]);

    // The loner is the delete verb's tombstone: gone from every view, locator dropped.
    const [l] = await db.select({ deletedAt: messages.deletedAt, loc: messages.nativeLocator })
      .from(messages).where(eq(messages.id, loner));
    expect(l!.deletedAt).not.toBeNull();
    expect(l!.loc).toBeNull();

    // The wire: an UPDATE for the survivor (its rendered folder moved), a DELETE for the loner.
    const log = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, ACCOUNT), inArray(changeLog.entityId, [twin, loner])));
    expect(log.find((r) => r.entityId === twin)!.op).toBe("update");
    expect(log.find((r) => r.entityId === loner)!.op).toBe("delete");
  });

  it("a pending-move-out straggler keeps its message: swept instances go, the survivor question is asked, never a bulk delete", async () => {
    const repo = makeDrizzleRepo(db as never);
    await db.insert(mailboxFolders)
      .values({ mailboxId: mb, accountId: ACCOUNT, folder: "Sweep2", uidvalidity: 21n, uidnext: 1n, highestmodseq: 1n });
    // Renders ELSEWHERE (desired points away) so the victims pick never sees it — but its
    // PRIMARY copy physically lived in the swept folder, with a watched twin elsewhere whose
    // dead-epoch sibling must be vetoed by the inventory's current UIDVALIDITY.
    const out = randomUUID();
    await db.insert(messages).values({
      id: out, accountId: ACCOUNT, mailboxId: mb, bodyHash: "h-out", dedupKey: `d-${out}`,
      nativeLocator: { folder: "Sweep2", ref: "21:9" },
    });
    await db.insert(folderState).values({
      messageId: out, accountId: ACCOUNT, desiredFolder: "Elsewhere", observedFolder: "Sweep2", lastSetBy: "us",
    });
    await db.insert(messageInstances).values([
      { accountId: ACCOUNT, mailboxId: mb, messageId: out, folder: "Sweep2", uidvalidity: 21n, uid: 9, isPrimary: true },
      // The dead epoch: same folder+uid as the live row — the by-row-id promotion's subject.
      { accountId: ACCOUNT, mailboxId: mb, messageId: out, folder: "Elsewhere", uidvalidity: 5n, uid: 44, isPrimary: false },
      { accountId: ACCOUNT, mailboxId: mb, messageId: out, folder: "Elsewhere", uidvalidity: 7n, uid: 44, isPrimary: false },
    ]);

    const took = await repo.transaction(async (r) =>
      r.tombstoneFolderMessages(ACCOUNT, mb, "Sweep2", 200));
    expect(took).toBe(1);

    // Alive, promoted to the CURRENT-epoch twin (Elsewhere's inventory is 7n — the 5n row is
    // reset residue and must never become the locator), exactly one primary.
    const [m] = await db.select({ deletedAt: messages.deletedAt, loc: messages.nativeLocator })
      .from(messages).where(eq(messages.id, out));
    expect(m!.deletedAt).toBeNull();
    expect((m!.loc as { folder: string; ref: string })).toEqual({ folder: "Elsewhere", ref: "7:44" });
    const inst = await db.select({ f: messageInstances.folder, v: messageInstances.uidvalidity, p: messageInstances.isPrimary })
      .from(messageInstances).where(eq(messageInstances.messageId, out));
    expect(inst.filter((i) => i.f === "Sweep2")).toHaveLength(0);
    expect(inst.filter((i) => i.p)).toEqual([{ f: "Elsewhere", v: 7n, p: true }]);
    // The pending row RETIRES with the copy it was about: kept, it would drive a same-folder
    // move against the promoted survivor on the next reconcile — whose destination precheck
    // expunges the "old" copy, i.e. the survivor itself.
    expect(await db.select().from(folderState).where(eq(folderState.messageId, out))).toHaveLength(0);
  });

  it("a cursor-less copy DEMOTES to tier 2 but never tombstones — a missing cursor is unknown, not deletion", async () => {
    const repo = makeDrizzleRepo(db as never);
    await db.insert(mailboxFolders)
      .values({ mailboxId: mb, accountId: ACCOUNT, folder: "Sweep3", uidvalidity: 31n, uidnext: 1n, highestmodseq: 1n });
    const ghost = randomUUID();
    await db.insert(messages).values({
      id: ghost, accountId: ACCOUNT, mailboxId: mb, bodyHash: "h-g", dedupKey: `d-${ghost}`,
      nativeLocator: { folder: "Sweep3", ref: "31:2" },
    });
    await db.insert(messageInstances).values([
      { accountId: ACCOUNT, mailboxId: mb, messageId: ghost, folder: "Sweep3", uidvalidity: 31n, uid: 2, isPrimary: true },
      // A copy in a folder with NO cursor row — real during ingest's crash window (instances
      // commit per message; the cursor lands after the batch). UNKNOWN, never deleted: a
      // tombstone here would hide a message the server still shows, for ever.
      { accountId: ACCOUNT, mailboxId: mb, messageId: ghost, folder: "Fresh", uidvalidity: 3n, uid: 8, isPrimary: false },
    ]);
    const took = await repo.transaction(async (r) =>
      r.tombstoneFolderMessages(ACCOUNT, mb, "Sweep3", 200));
    expect(took).toBe(1);
    // ALIVE, promoted to the unconfirmed copy — the self-healing direction (a locator that
    // turns out dead answers MessageGoneError; enumeration adopts the real copy).
    const [g] = await db.select({ deletedAt: messages.deletedAt, loc: messages.nativeLocator })
      .from(messages).where(eq(messages.id, ghost));
    expect(g!.deletedAt).toBeNull();
    expect((g!.loc as { folder: string; ref: string })).toEqual({ folder: "Fresh", ref: "3:8" });
  });

  it("a pending move whose survivor is NOT the destination CONTINUES from the survivor — user moves are never discarded", async () => {
    const repo = makeDrizzleRepo(db as never);
    await db.insert(mailboxFolders).values([
      { mailboxId: mb, accountId: ACCOUNT, folder: "Sweep4", uidvalidity: 41n, uidnext: 1n, highestmodseq: 1n },
      { mailboxId: mb, accountId: ACCOUNT, folder: "Ziel", uidvalidity: 43n, uidnext: 1n, highestmodseq: 1n },
    ]);
    // Pending S→Ziel; S ("Sweep4") is deleted first; a confirmed copy lives at "Elsewhere".
    const mover = randomUUID();
    await db.insert(messages).values({
      id: mover, accountId: ACCOUNT, mailboxId: mb, bodyHash: "h-m", dedupKey: `d-${mover}`,
      nativeLocator: { folder: "Sweep4", ref: "41:3" },
    });
    await db.insert(folderState).values({
      messageId: mover, accountId: ACCOUNT, desiredFolder: "Ziel", observedFolder: "Sweep4", lastSetBy: "us",
    });
    await db.insert(messageInstances).values([
      { accountId: ACCOUNT, mailboxId: mb, messageId: mover, folder: "Sweep4", uidvalidity: 41n, uid: 3, isPrimary: true },
      { accountId: ACCOUNT, mailboxId: mb, messageId: mover, folder: "Elsewhere", uidvalidity: 7n, uid: 77, isPrimary: false },
    ]);
    const took = await repo.transaction(async (r) =>
      r.tombstoneFolderMessages(ACCOUNT, mb, "Sweep4", 200));
    expect(took).toBe(1);
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, mover));
    expect(fs).toBeDefined();
    expect(fs!.desiredFolder).toBe("Ziel");
    expect(fs!.observedFolder).toBe("Elsewhere");
    const [m] = await db.select({ deletedAt: messages.deletedAt, loc: messages.nativeLocator })
      .from(messages).where(eq(messages.id, mover));
    expect(m!.deletedAt).toBeNull();
    expect((m!.loc as { folder: string }).folder).toBe("Elsewhere");
  });

  it("a KNOWN-stale epoch is rejected even as the last candidate — tier 2 admits only missing cursors", async () => {
    const repo = makeDrizzleRepo(db as never);
    await db.insert(mailboxFolders)
      .values({ mailboxId: mb, accountId: ACCOUNT, folder: "Sweep5", uidvalidity: 51n, uidnext: 1n, highestmodseq: 1n });
    const stale = randomUUID();
    await db.insert(messages).values({
      id: stale, accountId: ACCOUNT, mailboxId: mb, bodyHash: "h-s", dedupKey: `d-${stale}`,
      nativeLocator: { folder: "Sweep5", ref: "51:4" },
    });
    await db.insert(messageInstances).values([
      { accountId: ACCOUNT, mailboxId: mb, messageId: stale, folder: "Sweep5", uidvalidity: 51n, uid: 4, isPrimary: true },
      // The ONLY other copy: reset residue in a folder whose cursor names a DIFFERENT epoch
      // (Elsewhere's inventory is 7n) — known dead, never a promotion target.
      { accountId: ACCOUNT, mailboxId: mb, messageId: stale, folder: "Elsewhere", uidvalidity: 5n, uid: 66, isPrimary: false },
    ]);
    const took = await repo.transaction(async (r) =>
      r.tombstoneFolderMessages(ACCOUNT, mb, "Sweep5", 200));
    expect(took).toBe(1);
    const [m] = await db.select({ deletedAt: messages.deletedAt, loc: messages.nativeLocator })
      .from(messages).where(eq(messages.id, stale));
    // Rendered here, no admissible survivor, no move in flight ⇒ the tombstone — and NEVER a
    // locator into the dead epoch.
    expect(m!.deletedAt).not.toBeNull();
    expect(m!.loc).toBeNull();
  });

  it("an in-flight move with no survivor DEFERS — locator kept, primaries gone: the exact adoption evidence", async () => {
    const repo = makeDrizzleRepo(db as never);
    await db.insert(mailboxFolders)
      .values({ mailboxId: mb, accountId: ACCOUNT, folder: "Sweep6", uidvalidity: 61n, uidnext: 1n, highestmodseq: 1n });
    const flight = randomUUID();
    await db.insert(messages).values({
      id: flight, accountId: ACCOUNT, mailboxId: mb, bodyHash: "h-f", dedupKey: `d-${flight}`,
      nativeLocator: { folder: "Sweep6", ref: "61:7" },
    });
    await db.insert(folderState).values({
      messageId: flight, accountId: ACCOUNT, desiredFolder: "Elsewhere", observedFolder: "Sweep6", lastSetBy: "us",
    });
    await db.insert(messageInstances).values([
      { accountId: ACCOUNT, mailboxId: mb, messageId: flight, folder: "Sweep6", uidvalidity: 61n, uid: 7, isPrimary: true },
    ]);
    const took = await repo.transaction(async (r) =>
      r.tombstoneFolderMessages(ACCOUNT, mb, "Sweep6", 200));
    expect(took).toBe(1);
    // NOT tombstoned; the locator and the pending row survive; the primary rows are gone —
    // which is precisely what `primaryInstanceVanished` reads as adoption evidence, so a move
    // whose IMAP half landed before the crash is adopted as its own completion on ingest.
    const [m] = await db.select({ deletedAt: messages.deletedAt, loc: messages.nativeLocator })
      .from(messages).where(eq(messages.id, flight));
    expect(m!.deletedAt).toBeNull();
    expect((m!.loc as { folder: string }).folder).toBe("Sweep6");
    expect(await db.select().from(folderState).where(eq(folderState.messageId, flight))).toHaveLength(1);
    expect(await db.select().from(messageInstances).where(eq(messageInstances.messageId, flight))).toHaveLength(0);
    expect(await repo.primaryInstanceVanished(flight)).toBe(true);
  });

  it("the deferral retires KNOWN-STALE residue too — a dead-epoch row must not block the terminal checks for ever", async () => {
    const repo = makeDrizzleRepo(db as never);
    await db.insert(mailboxFolders)
      .values({ mailboxId: mb, accountId: ACCOUNT, folder: "Sweep7", uidvalidity: 71n, uidnext: 1n, highestmodseq: 1n });
    const parked = randomUUID();
    await db.insert(messages).values({
      id: parked, accountId: ACCOUNT, mailboxId: mb, bodyHash: "h-p", dedupKey: `d-${parked}`,
      nativeLocator: { folder: "Sweep7", ref: "71:6" },
    });
    await db.insert(folderState).values({
      messageId: parked, accountId: ACCOUNT, desiredFolder: "Elsewhere", observedFolder: "Sweep7", lastSetBy: "us",
    });
    await db.insert(messageInstances).values([
      { accountId: ACCOUNT, mailboxId: mb, messageId: parked, folder: "Sweep7", uidvalidity: 71n, uid: 6, isPrimary: true },
      // Dead-epoch residue (Elsewhere's cursor is 7n): rejected by both survivor tiers, and —
      // left behind — the exact row that keeps `tombstoneInstanceless` from ever selecting
      // this message once the move turns out to have been trashed.
      { accountId: ACCOUNT, mailboxId: mb, messageId: parked, folder: "Elsewhere", uidvalidity: 5n, uid: 99, isPrimary: false },
    ]);
    const took = await repo.transaction(async (r) =>
      r.tombstoneFolderMessages(ACCOUNT, mb, "Sweep7", 200));
    expect(took).toBe(1);
    // The deferral stands (alive, locator kept, pending row kept) AND the residue is gone, so
    // every instance row of this message has left the table.
    const [m] = await db.select({ deletedAt: messages.deletedAt, loc: messages.nativeLocator })
      .from(messages).where(eq(messages.id, parked));
    expect(m!.deletedAt).toBeNull();
    expect((m!.loc as { folder: string }).folder).toBe("Sweep7");
    expect(await db.select().from(folderState).where(eq(folderState.messageId, parked))).toHaveLength(1);
    expect(await db.select().from(messageInstances).where(eq(messageInstances.messageId, parked))).toHaveLength(0);
    expect(await repo.primaryInstanceVanished(parked)).toBe(true);
  });

  it("…but a stale SENT row is KEPT — the watermark scan never re-teaches old Sent copies", async () => {
    const repo = makeDrizzleRepo(db as never);
    await db.insert(mailboxFolders).values([
      { mailboxId: mb, accountId: ACCOUNT, folder: "Sweep8", uidvalidity: 81n, uidnext: 1n, highestmodseq: 1n },
      // The resolved Sent folder, whose cursor names a NEWER epoch than the instance below —
      // the exact "stale" shape, and the one place staleness is the last evidence there is.
      { mailboxId: mb, accountId: ACCOUNT, folder: "INBOX/Sent Messages", uidvalidity: 9n, uidnext: 1n, highestmodseq: 1n },
    ]);
    const sentKept = randomUUID();
    await db.insert(messages).values({
      id: sentKept, accountId: ACCOUNT, mailboxId: mb, bodyHash: "h-sk", dedupKey: `d-${sentKept}`,
      nativeLocator: { folder: "Sweep8", ref: "81:3" },
    });
    await db.insert(folderState).values({
      messageId: sentKept, accountId: ACCOUNT, desiredFolder: "Elsewhere", observedFolder: "Sweep8", lastSetBy: "us",
    });
    await db.insert(messageInstances).values([
      { accountId: ACCOUNT, mailboxId: mb, messageId: sentKept, folder: "Sweep8", uidvalidity: 81n, uid: 3, isPrimary: true },
      { accountId: ACCOUNT, mailboxId: mb, messageId: sentKept, folder: "INBOX/Sent Messages", uidvalidity: 2n, uid: 12, isPrimary: false },
    ]);
    const took = await repo.transaction(async (r) =>
      r.tombstoneFolderMessages(ACCOUNT, mb, "Sweep8", 200));
    expect(took).toBe(1);
    const rows = await db.select({ f: messageInstances.folder })
      .from(messageInstances).where(eq(messageInstances.messageId, sentKept));
    expect(rows).toEqual([{ f: "INBOX/Sent Messages" }]);
    const [m] = await db.select({ deletedAt: messages.deletedAt })
      .from(messages).where(eq(messages.id, sentKept));
    expect(m!.deletedAt).toBeNull();
  });

  it("…and the RESOLVED Sent path is preserved even under a custom name no belt could know", async () => {
    const repo = makeDrizzleRepo(db as never);
    await db.insert(mailboxFolders).values([
      { mailboxId: mb, accountId: ACCOUNT, folder: "Sweep9", uidvalidity: 91n, uidnext: 1n, highestmodseq: 1n },
      // A \\Sent that resolved to a custom path — supported, and invisible to any spelling.
      { mailboxId: mb, accountId: ACCOUNT, folder: "Archive/Outgoing", uidvalidity: 9n, uidnext: 1n, highestmodseq: 1n },
    ]);
    const custom = randomUUID();
    await db.insert(messages).values({
      id: custom, accountId: ACCOUNT, mailboxId: mb, bodyHash: "h-c", dedupKey: `d-${custom}`,
      nativeLocator: { folder: "Sweep9", ref: "91:5" },
    });
    await db.insert(folderState).values({
      messageId: custom, accountId: ACCOUNT, desiredFolder: "Elsewhere", observedFolder: "Sweep9", lastSetBy: "us",
    });
    await db.insert(messageInstances).values([
      { accountId: ACCOUNT, mailboxId: mb, messageId: custom, folder: "Sweep9", uidvalidity: 91n, uid: 5, isPrimary: true },
      { accountId: ACCOUNT, mailboxId: mb, messageId: custom, folder: "Archive/Outgoing", uidvalidity: 2n, uid: 31, isPrimary: false },
    ]);
    const took = await repo.transaction(async (r) =>
      r.tombstoneFolderMessages(ACCOUNT, mb, "Sweep9", 200, "Archive/Outgoing"));
    expect(took).toBe(1);
    const rows = await db.select({ f: messageInstances.folder })
      .from(messageInstances).where(eq(messageInstances.messageId, custom));
    expect(rows).toEqual([{ f: "Archive/Outgoing" }]);
  });

  it("an enqueue HOLDS the mailbox row — a concurrent overlapping command waits it out and then refuses", async () => {
    // Deterministic, not a timing race: transaction A takes the enqueue's own FOR UPDATE on
    // the mailbox row and inserts a parent-rename command WITHOUT committing; a concurrent
    // child-delete enqueue must BLOCK at that same lock (its overlap read cannot run yet),
    // and, once A commits, see A's row and refuse. Without the lock the second enqueue reads
    // "no sibling" while A's insert is uncommitted and BOTH commands land — different
    // folder_ids, so UNIQUE stops neither, and the worker would run the loser against a tree
    // the winner had reshaped.
    const svc = new FolderOpsService();
    const ctx = (): ServiceContext => ({
      db: db as unknown as ServiceContext["db"], accountId: ACCOUNT, userId: null,
      now: () => new Date(), requestId: `race-${randomUUID()}`,
    } as ServiceContext);
    await setFoldersEnabled(ctx(), true);
    await db.update(mailboxes).set({ trashFolder: "Trash", status: "connected" })
      .where(eq(mailboxes.id, mb));
    const folder = async (path: string): Promise<string> => {
      const [r] = await db.insert(mailboxFolders)
        .values({ mailboxId: mb, accountId: ACCOUNT, folder: path, uidvalidity: 13n, uidnext: 1n, highestmodseq: 1n })
        .returning();
      return r!.id;
    };
    const parent = await folder("Race");
    const child = await folder("Race/Kid");

    let secondSettled = false;
    let second!: Promise<unknown>;
    await db.transaction(async (tx) => {
      // The enqueue's own lock, taken by hand.
      await tx.execute(sql`select id from mailboxes where id = ${mb} for update`);
      // Fire the competing enqueue NOW — it must park at the lock, not proceed.
      second = svc.remove(ctx(), child).then(
        () => { secondSettled = true; return "admitted"; },
        (e: unknown) => { secondSettled = true; return e instanceof ServiceError ? e.code : "other"; },
      );
      await new Promise((r) => setTimeout(r, 400));
      expect(secondSettled, "the concurrent enqueue ran through the held lock").toBe(false);
      // A's command lands while the lock is held.
      await tx.insert(folderOps).values({
        accountId: ACCOUNT, mailboxId: mb, folderId: parent, op: "rename", toFolder: "Raced",
      });
    });
    // A committed; the parked enqueue resumes, reads A's row, and refuses.
    expect(await second).toBe("conflict");
    const ops = await db.select().from(folderOps)
      .where(inArray(folderOps.folderId, [parent, child]));
    expect(ops).toHaveLength(1);
    expect(ops[0]!.folderId).toBe(parent);
  });
});
