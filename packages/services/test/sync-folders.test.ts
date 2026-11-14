import { accountOfMailbox, accountOfMessage } from "@trafficflow/db";
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { changeLog, mailboxes, mailboxFolders, messages } from "@trafficflow/db";
import {
  MessageService, SyncService, consentSettings, mailboxFoldersOff, setFoldersEnabled,
  setMailboxFoldersEnabled, userFolderExclusion,
  type FolderDTO, type ServiceContext,
} from "../src/index.js";
import { folderState } from "@trafficflow/db";
import { isSentFolderPath } from "@trafficflow/core/folder-name";

/**
 * THE FOLDERS FOUNDATION'S SERVER HALF — the `folder` entity on `/sync` and the flag that gates
 * it (the folders design notes; the first two stages' guards):
 *
 *  · FLAG-OFF PARITY: with `folders_enabled_at` NULL the snapshot and the delta carry not one
 *    `folder` change — an account that never asked sees the pre-feature wire byte for byte.
 *  · THE EXCLUSIONS: the organized six, the Sent folder and the `ohmail` namespace are never
 *    emitted, whatever `mailbox_folders` holds. Pinned row by row, because the failure mode is
 *    a Sent folder appearing in somebody's rail as a place to browse.
 *  · THE TRANSITION RIDES THE DELTA: enabling writes one `folder` CREATE per user folder in the
 *    same transaction as the column, disabling writes DELETE tombstones — a live client's rail
 *    fills and empties without a re-bootstrap.
 *  · AFTER A DISABLE, HISTORY IS SAFE: the enable's old create rows re-materialize as
 *    tombstones, never as live entities, so a full replay of a disabled account's log ends with
 *    no folder in the mirror.
 */

const svc = new SyncService();

type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function setup() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: "own@example.com" }).returning();
  const ctx: ServiceContext = {
    db, accountId, userId: null,
    now: () => new Date("2026-08-23T00:00:00.000Z"), requestId: "r",
  };
  return { db, accountId, mailboxId: mb.id, ctx };
}

/** A cursor row as the worker's discovery writes it — the inventory the feature reads. */
async function addFolder(db: Db, mailboxId: string, folder: string): Promise<string> {
  const [row] = await db.insert(mailboxFolders)
    .values({ mailboxId, accountId: accountOfMailbox(mailboxId), folder, uidvalidity: 1n, uidnext: 1n, highestmodseq: 1n })
    .returning();
  return row.id;
}

/** Every folder the worker scans on a real mailbox: the six, the Sent, and the user's own. */
async function seedInventory(db: Db, mailboxId: string): Promise<{ acme: string; inv: string }> {
  for (const f of [
    "INBOX", "ohmail/Screener", "ohmail/News", "ohmail/Receipts", "ohmail/Screened",
    "ohmail/Quarantine", "INBOX/Sent",
  ]) await addFolder(db, mailboxId, f);
  const acme = await addFolder(db, mailboxId, "Projects/Acme");
  const inv = await addFolder(db, mailboxId, "Invoices 2026");
  return { acme, inv };
}

type AnyChange = { type: string; op: string; id: string; entity?: FolderDTO };
/** The delta's four buckets, or the snapshot's flat page — one reader for both wires. */
const folderChanges = (page: {
  changes: AnyChange[] | { creates: AnyChange[]; updates: AnyChange[]; moves: AnyChange[]; deletes: AnyChange[] };
}) => {
  const all = Array.isArray(page.changes)
    ? page.changes
    : [...page.changes.creates, ...page.changes.updates, ...page.changes.moves, ...page.changes.deletes];
  return all.filter((c) => c.type === "folder");
};

describe("the exclusion, pinned row by row", () => {
  it("refuses the six, the ohmail namespace and every Sent shape; admits the user's tree", () => {
    for (const p of [
      "INBOX", "ohmail/Screener", "ohmail/News", "ohmail/Receipts", "ohmail/Screened",
      "ohmail/Quarantine", "ohmail/_meta", "INBOX/ohmail/_meta",
      "INBOX/Sent", "Sent", "Sent Messages", "INBOX/Sent Messages", "Sent Items", "Sent Mail",
      "Gesendet", "Gesendete Objekte", "INBOX/Gesendete Elemente",
    ]) {
      expect(userFolderExclusion(p, null), p).not.toBeNull();
    }
    for (const p of [
      "Projects/Acme", "Invoices 2026", "Archiv/Steuern 2010", "_archive/Clients/Anna",
      // A NESTED Sent-named folder is the user's own stash, not the resolved Sent — the
      // resolver never picks it, and hiding it would hide real mail (measured in production:
      // a user's own nested `…/Sent Messages`, holding mail they filed).
      "Alternativen/Sent Messages",
    ]) {
      expect(userFolderExclusion(p, null), p).toBeNull();
    }
  });
});

describe("the Sent folder the attach recorded", () => {
  for (const recorded of ["Envoyés", "INBOX/Verzonden", "INBOX.Verzonden"]) {
    it(`a recorded '${recorded}' is never listed or announced as a user folder`, async () => {
      const { db, ctx, mailboxId, accountId } = await setup();
      await addFolder(db, mailboxId, recorded);
      const acme = await addFolder(db, mailboxId, "Projects/Acme");
      await db.update(mailboxes).set({ sentFolder: recorded }).where(eq(mailboxes.id, mailboxId));
      await setFoldersEnabled(ctx, true);
      const rows = await db.select().from(changeLog).where(eq(changeLog.accountId, accountId));
      expect(rows.filter((r) => r.entityType === "folder").map((r) => r.entityId)).toEqual([acme]);
      expect(folderChanges((await svc.getSnapshot(ctx)) as never).map((c) => c.entity?.name)).toEqual(["Projects/Acme"]);
      expect(folderChanges((await svc.getChanges(ctx, { since: "0" })) as never).map((c) => [c.op, c.entity?.name]))
        .toEqual([["create", "Projects/Acme"]]);
    });
  }

  it("CONTROL: with nothing recorded, an 'Envoyés' the name rule does not know is the user's", async () => {
    const { db, ctx, mailboxId } = await setup();
    await addFolder(db, mailboxId, "Envoyés");
    await setFoldersEnabled(ctx, true);
    expect(folderChanges((await svc.getSnapshot(ctx)) as never).map((c) => c.entity?.name)).toEqual(["Envoyés"]);
  });

  it("a recorded INBOX is never read as Sent", () => {
    expect(userFolderExclusion("Projects/Acme", "INBOX")).toBeNull();
    expect(userFolderExclusion("Envoyés", "Envoyés")).toBe("it is the mailbox's Sent folder");
  });
});

describe("flag off — the pre-feature wire, byte for byte", () => {
  it("snapshot and delta carry no folder change whatever the inventory holds", async () => {
    const { db, ctx, mailboxId } = await setup();
    await seedInventory(db, mailboxId);

    const snap = await svc.getSnapshot(ctx);
    expect(folderChanges(snap)).toEqual([]);

    const delta = await svc.getChanges(ctx, { since: "0" });
    expect(folderChanges(delta)).toEqual([]);

    expect((await consentSettings(ctx)).foldersEnabledAt).toBeNull();
  });
});

describe("the enable transition", () => {
  it("stamps the column and appends one folder CREATE per user folder — never the six, never Sent", async () => {
    const { db, ctx, mailboxId, accountId } = await setup();
    const { acme, inv } = await seedInventory(db, mailboxId);

    const echo = await setFoldersEnabled(ctx, true);
    expect(echo.foldersEnabledAt).toBe("2026-08-23T00:00:00.000Z");
    expect((await consentSettings(ctx)).foldersEnabledAt).toBe(echo.foldersEnabledAt);

    const rows = await db.select().from(changeLog).where(eq(changeLog.accountId, accountId));
    const folderRows = rows.filter((r) => r.entityType === "folder");
    expect(folderRows.map((r) => [r.op, r.entityId]).sort()).toEqual(
      [["create", inv], ["create", acme]].sort(),
    );

    // The delta materializes them live, with the full entity shape.
    const delta = await svc.getChanges(ctx, { since: "0" });
    const folders = folderChanges(delta);
    expect(folders.every((c) => c.op === "create")).toBe(true);
    const acmeEntity = folders.find((c) => c.id === acme)?.entity;
    expect(acmeEntity).toMatchObject({
      id: acme, name: "Projects/Acme", mailboxId, mailbox: "own@example.com",
    });
    expect(typeof acmeEntity?.updatedAt).toBe("string");

    // And the snapshot's page 1 carries the same two, as creates at the snapshot seq.
    const snap = await svc.getSnapshot(ctx);
    expect(folderChanges(snap).map((c) => c.id).sort()).toEqual([acme, inv].sort());
  });

  it("an account with mailboxes but no user folders enables cleanly: a flag, zero change rows", async () => {
    const { db, ctx, mailboxId, accountId } = await setup();
    await addFolder(db, mailboxId, "INBOX");
    await setFoldersEnabled(ctx, true);
    const rows = await db.select().from(changeLog).where(eq(changeLog.accountId, accountId));
    expect(rows.filter((r) => r.entityType === "folder")).toEqual([]);
  });
});

describe("the disable transition", () => {
  it("clears the column, appends DELETE tombstones, and the enable's old creates drain dead", async () => {
    const { db, ctx, mailboxId } = await setup();
    const { acme, inv } = await seedInventory(db, mailboxId);
    await setFoldersEnabled(ctx, true);
    const off = await setFoldersEnabled(ctx, false);
    expect(off.foldersEnabledAt).toBeNull();

    const delta = await svc.getChanges(ctx, { since: "0" });
    const folders = folderChanges(delta);
    // The enable's creates and the disable's deletes are FOUR rows — and every one of them
    // drains as a delete: the creates re-materialize against a flag that is off, which is the
    // tombstone branch. A full replay of this account's log ends with no folder in the mirror.
    expect(folders).toHaveLength(4);
    expect(folders.every((c) => c.op === "delete")).toBe(true);
    expect(new Set(folders.map((c) => c.id))).toEqual(new Set([acme, inv]));

    const snap = await svc.getSnapshot(ctx);
    expect(folderChanges(snap)).toEqual([]);
  });
});

describe("account scoping", () => {
  it("another account's folder row materializes as a tombstone, never as an entity", async () => {
    const { db, ctx, mailboxId } = await setup();
    await seedInventory(db, mailboxId);
    await setFoldersEnabled(ctx, true);

    // A second account with its own inventory and its own flag.
    const otherId = randomUUID();
    const [otherMb] = await db.insert(mailboxes)
      .values({ accountId: otherId, provider: "imap", address: "other@example.com" }).returning();
    const otherFolder = await addFolder(db, otherMb.id, "Their Project");
    const otherCtx: ServiceContext = { ...ctx, accountId: otherId };
    await setFoldersEnabled(otherCtx, true);

    // The first account's snapshot never carries the second's folder…
    const snap = await svc.getSnapshot(ctx);
    expect(folderChanges(snap).some((c) => c.id === otherFolder)).toBe(false);
    // …and the second account's delta carries exactly its own.
    const otherDelta = await svc.getChanges(otherCtx, { since: "0" });
    expect(folderChanges(otherDelta).map((c) => c.id)).toEqual([otherFolder]);
  });
});

describe("the folder page — the reach past a windowed mirror (GET /messages?view=folder)", () => {
  const msgSvc = new MessageService();

  async function fileInto(db: Db, accountId: string, mailboxId: string, folder: string, subject: string, date: Date) {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId, bodyHash: "h", dedupKey: randomUUID(), subject,
      fromAddress: "s@example.com", date,
    }).returning();
    await db.insert(folderState).values({
      messageId: m.id, accountId: accountOfMessage(m.id), desiredFolder: folder, observedFolder: folder, lastSetBy: "external",
    });
    return m.id;
  }

  it("pages the folder's own mail, newest first, mailbox-scoped, and honours the flag", async () => {
    const { db, ctx, mailboxId, accountId } = await setup();
    const { acme } = await seedInventory(db, mailboxId);
    await setFoldersEnabled(ctx, true);
    const older = await fileInto(db, accountId, mailboxId, "Projects/Acme", "older", new Date("2020-01-02T00:00:00Z"));
    const newer = await fileInto(db, accountId, mailboxId, "Projects/Acme", "newer", new Date("2024-01-02T00:00:00Z"));
    // A same-named folder in ANOTHER mailbox must never leak into this one's page.
    const [mb2] = await db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: "second@example.com" }).returning();
    await fileInto(db, accountId, mb2.id, "Projects/Acme", "other mailbox", new Date("2025-01-02T00:00:00Z"));

    const page1 = await msgSvc.list(ctx, { view: "folder", folderId: acme, limit: 1 });
    expect(page1.items.map((m) => m.id)).toEqual([newer]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await msgSvc.list(ctx, { view: "folder", folderId: acme, limit: 1, cursor: page1.nextCursor! });
    expect(page2.items.map((m) => m.id)).toEqual([older]);
    expect(page2.nextCursor).toBeNull();

    // Flag OFF: the surface is gone, so the source answers an empty FINAL page — never an error
    // a mid-transition view would have to render.
    await setFoldersEnabled(ctx, false);
    const off = await msgSvc.list(ctx, { view: "folder", folderId: acme });
    expect(off).toEqual({ items: [], nextCursor: null });
  });

  it("the mirror boundary starts page one below the client's oldest held row", async () => {
    const { db, ctx, mailboxId, accountId } = await setup();
    const { acme } = await seedInventory(db, mailboxId);
    await setFoldersEnabled(ctx, true);
    const oldest = await fileInto(db, accountId, mailboxId, "Projects/Acme", "below", new Date("2019-01-02T00:00:00Z"));
    const boundaryRow = await fileInto(db, accountId, mailboxId, "Projects/Acme", "boundary", new Date("2022-01-02T00:00:00Z"));
    await fileInto(db, accountId, mailboxId, "Projects/Acme", "held", new Date("2024-01-02T00:00:00Z"));

    // The client holds down to `boundary` — page one must begin strictly BELOW it, never
    // re-serving the newest rows the mirror already renders (the duplicated-window finding).
    const page = await msgSvc.list(ctx, {
      view: "folder", folderId: acme,
      before: { date: "2022-01-02T00:00:00.000Z", id: boundaryRow },
    });
    expect(page.items.map((m) => m.id)).toEqual([oldest]);
    expect(page.nextCursor).toBeNull();
  });

  it("a malformed boundary is refused, never a 500 and never the wrong page", async () => {
    const { db, ctx, mailboxId } = await setup();
    const { acme } = await seedInventory(db, mailboxId);
    await setFoldersEnabled(ctx, true);
    await expect(msgSvc.list(ctx, {
      view: "folder", folderId: acme, before: { date: null, id: "not-a-uuid" },
    })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(msgSvc.list(ctx, {
      view: "folder", folderId: acme, before: { date: "yesterday-ish", id: randomUUID() },
    })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("another account's folder id answers the same empty final page", async () => {
    const { db, ctx, mailboxId } = await setup();
    const { acme } = await seedInventory(db, mailboxId);
    await setFoldersEnabled(ctx, true);
    const otherCtx: ServiceContext = { ...ctx, accountId: randomUUID() };
    await setFoldersEnabled(otherCtx, true);
    expect(await msgSvc.list(otherCtx, { view: "folder", folderId: acme }))
      .toEqual({ items: [], nextCursor: null });
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   PER-MAILBOX ENABLEMENT (the folders design notes; ruling 2026-08-25) — the second dial,
   and the batch materialization a bug report forced.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("per-mailbox enablement (§17)", () => {
  /** Two mailboxes, each with one user folder — the smallest account the ruling is about. */
  async function twoMailboxSetup() {
    const base = await setup();
    const { acme } = await seedInventory(base.db, base.mailboxId);
    const [mb2] = await base.db.insert(mailboxes)
      .values({ accountId: base.accountId, provider: "imap", address: "second@example.com" })
      .returning();
    const theirs = await addFolder(base.db, mb2.id, "Clients/Anna");
    return { ...base, acme, mb2: mb2.id, theirs };
  }

  it("switching one mailbox off tombstones ITS folders only, and the snapshot follows", async () => {
    const { db, ctx, accountId, mb2, acme, theirs } = await twoMailboxSetup();
    await setFoldersEnabled(ctx, true);

    const echo = await setMailboxFoldersEnabled(ctx, mb2, false);
    expect(echo.mailboxId).toBe(mb2);
    expect(echo.foldersDisabledAt).toBe("2026-08-23T00:00:00.000Z");

    // Exactly one new tombstone, and it names the switched-off mailbox's folder.
    const rows = await db.select().from(changeLog).where(eq(changeLog.accountId, accountId));
    const deletes = rows.filter((r) => r.entityType === "folder" && r.op === "delete");
    expect(deletes.map((r) => r.entityId)).toEqual([theirs]);

    // The snapshot carries the participating mailbox's folder and not the other's…
    const snap = await svc.getSnapshot(ctx);
    const ids = folderChanges(snap).map((c) => c.id);
    expect(ids).toContain(acme);
    expect(ids).not.toContain(theirs);
    // …and GET /consent's exceptions map names exactly the switched-off mailbox.
    expect(await mailboxFoldersOff(db, accountId)).toEqual({ [mb2]: "2026-08-23T00:00:00.000Z" });
  });

  it("a switched-off mailbox's straggler CREATE drains as a tombstone; opt-in revives it", async () => {
    const { db, ctx, mb2, theirs } = await twoMailboxSetup();
    await setFoldersEnabled(ctx, true);           // wrote a create for `theirs`
    await setMailboxFoldersEnabled(ctx, mb2, false);

    // The enable's old create re-materializes against a switched-off mailbox: tombstone.
    let delta = await svc.getChanges(ctx, { since: "0" });
    let theirsRows = folderChanges(delta).filter((c) => c.id === theirs);
    expect(theirsRows.length).toBeGreaterThan(0);
    expect(theirsRows.every((c) => c.op === "delete")).toBe(true);

    // Opt back in: a fresh CREATE rides the delta and materializes live. The buckets are a
    // formality (`flattenResponse` + seq is the apply order), so LAST means highest seq.
    const on = await setMailboxFoldersEnabled(ctx, mb2, true);
    expect(on.foldersDisabledAt).toBeNull();
    delta = await svc.getChanges(ctx, { since: "0" });
    theirsRows = folderChanges(delta)
      .filter((c) => c.id === theirs)
      .sort((a, b) => (a as { seq: number }).seq - (b as { seq: number }).seq);
    const last = theirsRows[theirsRows.length - 1]!;
    expect(last.op).toBe("create");
    expect(last.entity).toMatchObject({ id: theirs, name: "Clients/Anna", mailboxId: mb2 });
  });

  it("with the master OFF the switch stamps the column but puts nothing on the wire", async () => {
    const { db, ctx, accountId, mb2 } = await twoMailboxSetup();
    const echo = await setMailboxFoldersEnabled(ctx, mb2, false);
    expect(echo.foldersDisabledAt).not.toBeNull();
    const rows = await db.select().from(changeLog).where(eq(changeLog.accountId, accountId));
    expect(rows.filter((r) => r.entityType === "folder")).toEqual([]);
  });

  it("the master enable after an opt-out emits creates for PARTICIPATING mailboxes only", async () => {
    const { db, ctx, accountId, mb2, acme, theirs } = await twoMailboxSetup();
    await setMailboxFoldersEnabled(ctx, mb2, false);   // master still off — column only
    await setFoldersEnabled(ctx, true);
    const rows = await db.select().from(changeLog).where(eq(changeLog.accountId, accountId));
    const creates = rows.filter((r) => r.entityType === "folder" && r.op === "create");
    // The participating mailbox's WHOLE inventory (seedInventory's two user folders), and
    // nothing of the switched-off one's.
    expect(creates.map((r) => r.entityId)).toContain(acme);
    expect(creates.map((r) => r.entityId)).not.toContain(theirs);
    expect(creates).toHaveLength(2);
  });

  it("a mailbox of ANOTHER account is a 404, and nothing persists", async () => {
    const { db, ctx, accountId, mb2 } = await twoMailboxSetup();
    const otherCtx: ServiceContext = { ...ctx, accountId: randomUUID() };
    await expect(setMailboxFoldersEnabled(otherCtx, mb2, false))
      .rejects.toMatchObject({ httpStatus: 404 });
    // The refused write left the column untouched for the real owner.
    expect(await mailboxFoldersOff(db, accountId)).toEqual({});
  });
});

describe("the delta's folder page is BATCH-materialized (the empty-rail case)", () => {
  it("the reported scenario: mirror bootstrapped first, folders enabled after, two mailboxes — every create arrives live", async () => {
    const { db, ctx, accountId, mailboxId } = await setup();
    const { acme, inv } = await seedInventory(db, mailboxId);
    const [mb2] = await db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: "second@example.com" }).returning();
    const theirs = await addFolder(db, mb2.id, "Clients/Anna");

    // The mirror bootstraps BEFORE the account enables folders: page 1 carries none.
    const boot = await svc.getSnapshot(ctx);
    expect(folderChanges(boot)).toEqual([]);

    // The enable, after — the user's toggle. The live tab drains from its held cursor.
    await setFoldersEnabled(ctx, true);
    const delta = await svc.getChanges(ctx, { since: "0" });
    const folders = folderChanges(delta);
    expect(folders.map((c) => c.id).sort()).toEqual([acme, inv, theirs].sort());
    for (const c of folders) {
      expect(c.op).toBe("create");
      expect(c.entity).not.toBeNull();   // an entity, not a tombstone — the rail can render it
    }
  });

  it("a page of N folder creates costs a BOUNDED number of queries, not O(N)", async () => {
    const { db, ctx, mailboxId } = await setup();
    // A folder-heavy mailbox — the scale the feature exists for, small enough for PGlite.
    for (let i = 0; i < 40; i++) await addFolder(db, mailboxId, `Projects/Client ${i}`);
    await setFoldersEnabled(ctx, true);

    // Count QUERIES by counting `select` chain starts on the handle getChanges reads with.
    // The per-row materializer opened two per folder row (measured at seconds for one
    // page on the deployed API — spec §17.1); the batch path opens two per PAGE.
    let selects = 0;
    const counting = new Proxy(db as object, {
      get(target, prop, receiver) {
        if (prop === "select") selects++;
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;
    const delta = await svc.getChanges({ ...ctx, db: counting }, { since: "0" });
    expect(folderChanges(delta)).toHaveLength(40);
    // The bound is deliberately loose (page read, seq bounds, prefetches, flag read, bulk
    // folder read, and headroom) — what it must never be is proportional to the 40 rows.
    expect(selects).toBeLessThan(15);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   ONE SENT SHAPE, TWO GRAPHS — the server's user-folder exclusion and the client mirrors'
   own-sent test are the SAME regex (`@trafficflow/core/types#SENT_SHAPED_CANONICAL`), reached
   here through the server's `userFolderExclusion` and there through
   `@trafficflow/core/folder-name#isSentFolderPath`.

   This is a drift census, not a tautology. The engine cannot import
   `@trafficflow/core/adapters/imap-types` (its bundle gate refuses that graph), which is the
   pressure that produces a second copy of the pattern — and a second copy is how the two halves
   come to disagree about what a Sent folder is. The consequence of disagreement is asymmetric and
   both directions are bad: a path the client calls Sent but the server calls a user folder is
   mail presented twice; a path the server calls Sent but the client does not is the account's own
   sent mail missing from its Ohbox.
   ══════════════════════════════════════════════════════════════════════════════════════════ */
describe("the Sent shape is one value, shared by the server's inventory and the client mirrors", () => {
  it("agrees path by path, in both directions", () => {
    const sent = [
      "Sent", "Sent Items", "Sent Messages", "Sent Mail",
      "INBOX/Sent", "INBOX/Sent Messages",
      "[Gmail]/Sent Mail", "[Google Mail]/Gesendet",
      "Gesendete Objekte", "Gesendete Elemente",
    ];
    const notSent = [
      "Promotions", "SocialNetworks", "Calendar", "News", "Team",
      "INBOX/Random", "Alternativen/Sent Messages", "INBOX/_archive/Sent old",
    ];
    for (const path of sent) {
      expect(isSentFolderPath(path), `client, ${path}`).toBe(true);
      expect(userFolderExclusion(path, null), `server, ${path}`).toBe("it is the mailbox's Sent folder");
    }
    for (const path of notSent) {
      expect(isSentFolderPath(path), `client, ${path}`).toBe(false);
      expect(userFolderExclusion(path, null), `server, ${path}`).not.toBe("it is the mailbox's Sent folder");
    }
  });
});
