import { accountOfMailbox, accountOfMessage } from "@trafficflow/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  ImapAdapter, type FolderPage, type FolderSearchPage,
} from "@trafficflow/core/adapters/imap";
import {
  accountSettings, folderState, mailboxes, mailboxCredentials, messageBodies, messages,
} from "@trafficflow/db";
import { acquireImapSlot, releaseImapSlot } from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  listServerTrash, searchServerTrash, serverTrashBody, TRASH_SEARCH_MAX_CHARS,
  TRASH_READ_TIMEOUT_MS,
} from "../src/trash-window.js";
import { IMAP_DOOR_DEADLINE_MS, isImapDoorTimeout } from "../src/imap-door.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * THE TRASH WINDOW — the API half, over a real (PGlite) database and a spied adapter.
 *
 * The guards this file owns, each watched red under a mutation before landing:
 *
 *  · the window's READS create NO `messages`/`message_bodies` rows — asserted by COUNTING both
 *    tables across every read (mutation: persist a row inside the list read, watch red). This is
 *    the DEFINING property: deleted mail never enters the mirror, so it never enters somebody's
 *    history or their search results;
 *  · origin attribution — a live Trash row whose message-id matches a mirror row DESIRED at the
 *    mailbox's Trash path is `ohmail` (the client already shows it, from the mirror, with its
 *    restore), everything else is `provider`;
 *  · the degrade — a mailbox with NO native \Trash answers a stated `no_trash_folder`, never an
 *    error and never an empty list pretending to be one; a dial failure answers `unreachable`;
 *    a STOOD-DOWN (`status='disabled'`) mailbox is not Cloud's and is never dialled at all;
 *  · the flag gate — all three doors answer 409 `folders_disabled` until "Use folders" is on;
 *  · EPOCHS — the body read 410s on a UIDVALIDITY mismatch and refuses an epoch that is not one;
 *    the pagination cursor states `reset` for a renumbered mailbox instead of continuing;
 *  · ONE account-level page — two mailboxes with a page each answer at most 50 merged rows, and
 *    the per-mailbox cursors resume EXACTLY below what was returned;
 *  · NO VERB — the module exports three reads and nothing else.
 *
 * The page bound itself (50, newest-first, seq-window) is the adapter's and is pinned in
 * `packages/core/test/adapters/imap.folderpage.test.ts`.
 */

const NOW = new Date("2026-09-10T12:00:00.000Z");
const TRASH_PATH = "INBOX/Gelöschte Elemente";

interface Seeded {
  deps: ApiDeps;
  db: Awaited<ReturnType<typeof makeTestDb>>;
  accountId: string;
  mailboxId: string;
}

async function seed(opts: {
  foldersOn?: boolean; trashFolder?: string | null; status?: string;
  db?: Seeded["db"]; accountId?: string;
} = {}): Promise<Seeded> {
  const db = opts.db ?? await makeTestDb();
  if (opts.db === undefined) {
    vi.restoreAllMocks();
    vi.spyOn(ImapAdapter.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);
  }
  const accountId = opts.accountId ?? randomUUID();
  if ((opts.foldersOn ?? true) && opts.accountId === undefined) {
    await db.insert(accountSettings).values({ accountId, foldersEnabledAt: NOW });
  }
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `trash-${randomUUID().slice(0, 8)}@example.invalid`,
    trashFolder: opts.trashFolder === undefined ? TRASH_PATH : opts.trashFolder,
    ...(opts.status !== undefined ? { status: opts.status } : {}),
  }).returning({ id: mailboxes.id });
  await db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: accountOfMailbox(mb!.id), transport: "imap", secretEnc: "enc", keyVersion: 1,
    meta: { host: "imap.example.invalid", port: 993, secure: true, user: "u" },
  });
  const deps = {
    db,
    keyProvider: { decrypt: async () => "not-printed" },
    services: { imapAdmission: { acquire: acquireImapSlot, release: releaseImapSlot } },
    now: () => NOW,
  } as unknown as ApiDeps;
  return { deps, db, accountId, mailboxId: mb!.id };
}

function pageOf(
  items: Array<{ uid: number; seq: number; mid?: string | null; date?: string }>,
  over: Partial<FolderPage> = {},
): FolderPage {
  return {
    uidValidity: "7",
    total: items.length,
    items: items.map((i) => ({
      uid: i.uid,
      seq: i.seq,
      subject: `deleted ${i.uid}`,
      from: { name: null, address: `s${i.uid}@example.invalid` },
      date: i.date ?? new Date(Date.UTC(2026, 8, 1) + i.seq * 60_000).toISOString(),
      messageIdHeader: i.mid === undefined ? `<mid-${i.uid}@x>` : i.mid,
      seen: false,
    })),
    nextBeforeSeq: null,
    ...over,
  };
}

const searchPageOf = (page: FolderPage, truncated = false): FolderSearchPage =>
  ({ uidValidity: page.uidValidity, items: page.items, truncated });

/** Both mirror tables' row counts — the no-writes guard reads them before and after. */
async function mirrorCounts(db: Seeded["db"]): Promise<[number, number]> {
  const m = await db.select({ id: messages.id }).from(messages);
  const b = await db.select({ messageId: messageBodies.messageId }).from(messageBodies);
  return [m.length, b.length];
}

/** A mirror row ohmail's own delete would have left: desired = the mailbox's Trash path. */
async function seedOhmailDelete(
  s: Seeded, opts: { mid: string; observed?: string },
): Promise<string> {
  const [row] = await s.db.insert(messages).values({
    accountId: s.accountId, mailboxId: s.mailboxId, messageIdHeader: opts.mid,
    bodyHash: `h-${opts.mid}`, dedupKey: `d-${opts.mid}`, subject: "deleted here",
    fromAddress: "s@example.invalid", snippet: "", unread: false, deletedAt: NOW,
  }).returning({ id: messages.id });
  await s.db.insert(folderState).values({
    messageId: row!.id, accountId: accountOfMessage(row!.id), desiredFolder: TRASH_PATH,
    observedFolder: opts.observed ?? "INBOX", lastSetBy: "us", reconcileStatus: "pending",
  });
  return row!.id;
}

beforeEach(() => vi.restoreAllMocks());

describe("the flag gate", () => {
  it("all three doors answer 409 folders_disabled until “Use folders” is on", async () => {
    const { deps, accountId, mailboxId } = await seed({ foldersOn: false });
    await expect(listServerTrash(deps, accountId))
      .rejects.toMatchObject({ httpStatus: 409, code: "folders_disabled" });
    await expect(searchServerTrash(deps, accountId, "anything"))
      .rejects.toMatchObject({ httpStatus: 409, code: "folders_disabled" });
    await expect(serverTrashBody(deps, accountId, { mailboxId, uid: 1, uidValidity: "7" }))
      .rejects.toMatchObject({ httpStatus: 409, code: "folders_disabled" });
  });
});

describe("the list window", () => {
  it("reads the live folder, attributes origin, and WRITES NO MIRROR ROW", async () => {
    const s = await seed();
    // The mirror knows mid-2 as a message OHMAIL deleted (desired = the Trash path) and mid-9 as
    // an ordinary message that was never deleted here.
    await seedOhmailDelete(s, { mid: "<mid-2@x>" });
    const [other] = await s.db.insert(messages).values({
      accountId: s.accountId, mailboxId: s.mailboxId, messageIdHeader: "<mid-9@x>",
      bodyHash: "h9", dedupKey: "d9", subject: "still in the inbox",
      fromAddress: "s9@example.invalid", snippet: "", unread: false,
    }).returning({ id: messages.id });
    await s.db.insert(folderState).values({
      messageId: other!.id, accountId: accountOfMessage(other!.id), desiredFolder: "INBOX", observedFolder: "INBOX",
      lastSetBy: "external", reconcileStatus: "reconciled",
    });

    const list = vi.spyOn(ImapAdapter.prototype, "listFolderPage")
      .mockResolvedValue(pageOf([{ uid: 9, seq: 3 }, { uid: 2, seq: 2 }, { uid: 1, seq: 1, mid: null }]));

    const before = await mirrorCounts(s.db);
    const page = await listServerTrash(s.deps, s.accountId);
    expect(list).toHaveBeenCalledWith(TRASH_PATH, expect.objectContaining({ limit: 50 }));

    expect(page.mailboxes).toEqual([
      expect.objectContaining({ id: s.mailboxId, window: "ok" }),
    ]);
    const byUid = new Map(page.items.map((i) => [i.uid, i]));
    // mid-2 matches a mirror row desired at the Trash path → ohmail deleted it.
    expect(byUid.get(2)!.origin).toBe("ohmail");
    // mid-9 exists in the mirror and is NOT desired at the Trash path — deleted somewhere else.
    expect(byUid.get(9)!.origin).toBe("provider");
    // No message-id at all → nothing to match → the provider's.
    expect(byUid.get(1)!.origin).toBe("provider");
    // Newest first, epoch carried per row.
    expect(page.items.map((i) => i.uid)).toEqual([9, 2, 1]);
    for (const i of page.items) expect(i.uidValidity).toBe("7");
    // THE DEFINING PROPERTY.
    expect(await mirrorCounts(s.db), "the window wrote a mirror row").toEqual(before);
  });

  it("a mailbox with NO native Trash is a stated degrade, not an error and not an empty list", async () => {
    const s = await seed({ trashFolder: null });
    const list = vi.spyOn(ImapAdapter.prototype, "listFolderPage");
    const page = await listServerTrash(s.deps, s.accountId);
    expect(page.mailboxes).toEqual([
      expect.objectContaining({ id: s.mailboxId, window: "no_trash_folder" }),
    ]);
    expect(page.items).toEqual([]);
    expect(list, "a mailbox with no Trash folder was dialled anyway").not.toHaveBeenCalled();
  });

  it("a dial that fails is `unreachable` — never an empty list standing in for it", async () => {
    const s = await seed();
    vi.spyOn(ImapAdapter.prototype, "listFolderPage")
      .mockRejectedValue(new Error("connection reset"));
    const page = await listServerTrash(s.deps, s.accountId);
    expect(page.mailboxes).toEqual([
      expect.objectContaining({ id: s.mailboxId, window: "unreachable" }),
    ]);
    expect(page.items).toEqual([]);
  });

  it("a STOOD-DOWN mailbox is not Cloud's to read and is never dialled", async () => {
    const s = await seed({ status: "disabled" });
    const list = vi.spyOn(ImapAdapter.prototype, "listFolderPage");
    const page = await listServerTrash(s.deps, s.accountId);
    expect(page.mailboxes, "a stood-down mailbox appeared in the window").toEqual([]);
    expect(list, "a stood-down mailbox was dialled").not.toHaveBeenCalled();
  });

  it("an EMPTIED-AND-RECREATED folder states `reset` rather than continuing a dead cursor", async () => {
    const s = await seed();
    vi.spyOn(ImapAdapter.prototype, "listFolderPage")
      .mockResolvedValue(pageOf([{ uid: 4, seq: 1 }], { uidValidity: "9" }));
    const stale = Buffer.from(JSON.stringify({ [s.mailboxId]: { v: "7", s: 3 } }), "utf8")
      .toString("base64url");
    const page = await listServerTrash(s.deps, s.accountId, { cursor: stale });
    expect(page.mailboxes).toEqual([
      expect.objectContaining({ id: s.mailboxId, window: "ok", reset: true }),
    ]);
  });

  it("a cursor that is not one of ours is a 400, before any decode work", async () => {
    const s = await seed();
    for (const bad of ["not-base64-json", Buffer.from("[]", "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ "not-a-uuid": { v: "7", s: 1 } }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ [s.mailboxId]: { v: "0", s: 1 } }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ [s.mailboxId]: { v: "7", s: 0 } }), "utf8").toString("base64url"),
      "x".repeat(128 * 1024 + 1)]) {
      await expect(listServerTrash(s.deps, s.accountId, { cursor: bad }), JSON.stringify(bad.slice(0, 24)))
        .rejects.toMatchObject({ httpStatus: 400 });
    }
  });

  it("TWO mailboxes merge into ONE bounded page, and each cursor resumes below what was returned", async () => {
    const a = await seed();
    const b = await seed({ db: a.db, accountId: a.accountId });
    // 30 rows each: the merged page is capped at 50, so 10 are cut and must not be skipped.
    const rowsFor = (base: number) =>
      Array.from({ length: 30 }, (_, k) => ({ uid: base + k, seq: 30 - k }));
    vi.spyOn(ImapAdapter.prototype, "listFolderPage").mockImplementation(async (folder) => {
      void folder;
      return pageOf(rowsFor(100));
    });
    const page = await listServerTrash(a.deps, a.accountId);
    expect(page.items.length, "the account-level page bound").toBe(50);
    expect(page.nextCursor, "a page that cut rows must offer a cursor").not.toBeNull();
    const resumed = JSON.parse(
      Buffer.from(page.nextCursor!, "base64url").toString("utf8"),
    ) as Record<string, { v: string; s: number }>;
    // BOTH mailboxes carry an entry with the epoch, and each watermark is a seq the page RETURNED
    // — never below the lowest row it cut, which is what would skip mail.
    expect(Object.keys(resumed).sort()).toEqual([a.mailboxId, b.mailboxId].sort());
    for (const id of [a.mailboxId, b.mailboxId]) {
      expect(resumed[id]!.v).toBe("7");
      expect(resumed[id]!.s).toBeGreaterThan(0);
    }
  });
});

describe("the search", () => {
  it("searches every mailbox's Trash, merges the newest hits, and writes nothing", async () => {
    const s = await seed();
    await seedOhmailDelete(s, { mid: "<mid-2@x>" });
    const search = vi.spyOn(ImapAdapter.prototype, "searchFolderPage")
      .mockResolvedValue(searchPageOf(pageOf([{ uid: 2, seq: 2 }, { uid: 1, seq: 1 }])));
    const before = await mirrorCounts(s.db);
    const page = await searchServerTrash(s.deps, s.accountId, "invoice");
    expect(search).toHaveBeenCalledWith(TRASH_PATH, "invoice", expect.objectContaining({ limit: 50 }));
    expect(page.items.map((i) => i.uid)).toEqual([2, 1]);
    expect(page.items.find((i) => i.uid === 2)!.origin).toBe("ohmail");
    expect(page.truncated).toBe(false);
    expect(await mirrorCounts(s.db), "the search wrote a mirror row").toEqual(before);
  });

  it("refuses an empty or over-long term, and states `unreachable` for a failed search", async () => {
    const s = await seed();
    await expect(searchServerTrash(s.deps, s.accountId, "   "))
      .rejects.toMatchObject({ httpStatus: 400 });
    await expect(searchServerTrash(s.deps, s.accountId, "x".repeat(TRASH_SEARCH_MAX_CHARS + 1)))
      .rejects.toMatchObject({ httpStatus: 400 });
    vi.spyOn(ImapAdapter.prototype, "searchFolderPage").mockRejectedValue(new Error("timed out"));
    const page = await searchServerTrash(s.deps, s.accountId, "invoice");
    expect(page.mailboxes).toEqual([
      expect.objectContaining({ id: s.mailboxId, window: "unreachable" }),
    ]);
    expect(page.items, "an empty answer stood in for a failed search").toEqual([]);
  });
});

describe("the body on open", () => {
  it("returns TEXT, persists nothing, and 410s when the folder was renumbered under the row", async () => {
    const s = await seed();
    const raw = Buffer.from(
      "From: s@example.invalid\r\nSubject: deleted thing\r\n"
      + "Content-Type: text/plain\r\n\r\nthe body\r\n",
      "utf8",
    );
    const fetch = vi.spyOn(ImapAdapter.prototype, "fetchByUid").mockResolvedValue({
      uidValidity: "7", oversize: [], creates: [{ raw } as never], deletes: [], seen: [],
    } as never);
    const before = await mirrorCounts(s.db);
    const body = await serverTrashBody(s.deps, s.accountId, {
      mailboxId: s.mailboxId, uid: 2, uidValidity: "7",
    });
    expect(body.subject).toBe("deleted thing");
    expect(body.text).toContain("the body");
    expect(await mirrorCounts(s.db), "the body read wrote a mirror row").toEqual(before);
    expect(fetch).toHaveBeenCalledWith(TRASH_PATH, [2], expect.objectContaining({ maxBytes: 2_000_000 }));

    // …and the epoch: the folder answers a DIFFERENT UIDVALIDITY than the row claimed.
    fetch.mockResolvedValue({
      uidValidity: "9", oversize: [], creates: [{ raw } as never], deletes: [], seen: [],
    } as never);
    await expect(serverTrashBody(s.deps, s.accountId, {
      mailboxId: s.mailboxId, uid: 2, uidValidity: "7",
    })).rejects.toMatchObject({ httpStatus: 410, code: "trash_message_gone" });
  });

  it("refuses an epoch that is not one, and a uid outside the protocol range", async () => {
    const s = await seed();
    const dial = vi.spyOn(ImapAdapter.prototype, "fetchByUid");
    // `"0"` is refused because the adapter's guard reads zero as "no epoch claimed" — which
    // would switch the guard off for this caller. The rest are values `Number(v) > 0` admits.
    for (const v of ["0", "1e9", " 7 ", "0x7", "Infinity", "-1", "07", "4294967296",
      "1".repeat(11)]) {
      await expect(serverTrashBody(s.deps, s.accountId, {
        mailboxId: s.mailboxId, uid: 2, uidValidity: v,
      }), `uidValidity ${JSON.stringify(v)}`).rejects.toMatchObject({ httpStatus: 400 });
    }
    await expect(serverTrashBody(s.deps, s.accountId, {
      mailboxId: s.mailboxId, uid: 4_294_967_296, uidValidity: "7",
    })).rejects.toMatchObject({ httpStatus: 400 });
    expect(dial, "a refused epoch or uid still opened a connection").not.toHaveBeenCalled();
  });

  it("a mailbox with no Trash folder answers 404, and a malformed id 400 — never a 500", async () => {
    const s = await seed({ trashFolder: null });
    await expect(serverTrashBody(s.deps, s.accountId, {
      mailboxId: s.mailboxId, uid: 2, uidValidity: "7",
    })).rejects.toMatchObject({ httpStatus: 404, code: "no_trash_folder" });
    await expect(serverTrashBody(s.deps, s.accountId, {
      mailboxId: "not-a-uuid", uid: 2, uidValidity: "7",
    })).rejects.toMatchObject({ httpStatus: 400 });
  });
});

describe("the budget is the API's ONE door budget, not a second copy", () => {
  /*
   * The module's own docblock says these reads "go through {@link withinDoorBudget} — the same
   * admission-capped, budget-counted door every other API dial uses". It said that while the
   * module carried its OWN dial: a local `dialWithinBudget` over a local `withDeadline`, correct
   * on the day it was written and a second copy of the door's budget for ever after. This case is
   * the sentence, asserted.
   *
   * TWO readings, for `imap-door.test.ts`'s reason — the VALUE and the BEHAVIOUR are different
   * claims. The value is an alias, so a change to the door's deadline cannot leave this door on
   * an older number. The behaviour is that a read which never answers is refused by the DOOR's
   * own timeout: the deleted copy threw a bare `Error("trash window read timed out")`, which
   * `isImapDoorTimeout` refuses, so this arm cannot pass against a returning local dial.
   */
  it("is ONE literal: the Trash window's name for the budget IS the door's budget", () => {
    expect(TRASH_READ_TIMEOUT_MS).toBe(IMAP_DOOR_DEADLINE_MS);
    expect(IMAP_DOOR_DEADLINE_MS).toBeGreaterThan(0);
    expect(IMAP_DOOR_DEADLINE_MS).toBeLessThan(60_000);
  });

  it("a read past the deadline is refused by the DOOR's own timeout, and the socket is destroyed", async () => {
    const s = await seed();
    let settle: (() => void) | undefined;
    // A read that never answers. The door races it and DISARMS the loser — the `work.catch()`
    // the deleted local copy omitted — so this promise is resolved at the end rather than left
    // to reject into nobody's hands.
    vi.spyOn(ImapAdapter.prototype, "fetchByUid")
      .mockImplementation(() => new Promise((resolve) => { settle = () => resolve(undefined as never); }));
    const closed = vi.spyOn(ImapAdapter.prototype, "close");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // The refusal is CAUGHT before the clock moves: awaiting the call first would block on the
      // very hang this drives, which is a five-second test timeout and says nothing.
      const settling = serverTrashBody(s.deps, s.accountId, {
        mailboxId: s.mailboxId, uid: 5, uidValidity: "7",
      }).then(() => null, (e: unknown) => e);
      await vi.advanceTimersByTimeAsync(TRASH_READ_TIMEOUT_MS + 50);
      const settled = await settling;
      expect(settled, "the hung read was not refused at all").not.toBeNull();
      expect(isImapDoorTimeout(settled), "refused by something other than the door's deadline")
        .toBe(true);
      // The door ends the socket on the failing arm; a polite close would queue behind the hang.
      expect(closed, "a hung read was closed politely instead of destroyed").not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      settle?.();
    }
  });
});

describe("the module is READ-ONLY by construction", () => {
  it("exports three reads and no verb", async () => {
    // A guard against the shape rather than the behaviour, and it is the honest one to have: the
    // no-writes counts above prove the three reads write nothing, and this proves nobody added a
    // fourth export that does. A "put it back" for server-trashed mail has no destination — see
    // the module header — so its absence is a decision, not an omission.
    const mod = await import("../src/trash-window.js");
    const fns = Object.entries(mod)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k)
      .sort();
    expect(fns).toEqual(["listServerTrash", "searchServerTrash", "serverTrashBody"]);
  });
});
