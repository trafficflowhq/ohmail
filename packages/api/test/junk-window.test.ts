import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ImapAdapter, type FolderPage, type FolderSearchPage } from "@trafficflow/core/adapters/imap";
import {
  accountSettings, changeLog, contacts, folderState, junkRescues, mailboxes,
  mailboxCredentials, messageBodies, messages, rules as rulesTbl,
} from "@trafficflow/db";
import { acquireImapSlot, releaseImapSlot } from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import { and, eq, sql } from "drizzle-orm";
import {
  listJunk, junkBody, rescueJunk, searchJunk, junkSweepPreview, requestJunkSweep,
  JUNK_HELD_MAX, JUNK_SEARCH_MAX_CHARS,
} from "../src/junk-window.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * THE JUNK WINDOW (FOLDERS-SPEC.md §16.2) — the API half, over a real (PGlite) database and a
 * spied adapter.
 *
 * The junk-window guards this file owns, each watched red under a mutation before landing:
 *
 *  · the window's READS create NO `messages`/`message_bodies` rows — asserted by COUNTING both
 *    tables across every read (mutation: persist a row inside `listJunk`, watch red);
 *  · origin attribution — a live junk row whose message-id matches a mirror row parked at the
 *    junk path (`native_locator`, the verdict's completion) is "verdict", everything else is
 *    "filed by your mail server";
 *  · the degrade — a mailbox with NO native \Junk answers a stated `no_junk_folder`, never an
 *    error and never an empty list pretending to be one; a dial failure answers `unreachable`;
 *    a STOOD-DOWN (`status='disabled'`) mailbox is not Cloud's and is never dialled at all;
 *  · the flag gate — everything answers 409 `folders_disabled` until "Use folders" is on;
 *  · EPOCHS everywhere — the body read 410s on a UIDVALIDITY mismatch, the rescue RECORDS the
 *    epoch it was pressed under (so the organizer's move is refused by the adapter's own
 *    unconditional guard if the folder was rebuilt since), the pagination cursor restarts a
 *    renumbered mailbox instead of skipping;
 *  · ONE account-level page — two mailboxes with a page each still answer at most 50 merged
 *    rows, and the per-mailbox cursors resume EXACTLY below what was returned (never skipping
 *    a row the cap cut);
 *  · the rescue — the RECORDED command, its locator, the doorbell, the re-press that resets one
 *    row rather than queueing a second move, and the standing command read back onto the window's
 *    own rows. The move itself, the husk's restoration and the honest gone/refused endings are the
 *    WORKER's (`apps/worker/test/junk-rescue.test.ts`), which is the whole change: the API opens
 *    no socket here, and the spies in the first case prove it by never being called.
 *
 * The page bound itself (50, newest-first, seq-window, no SEARCH) is the adapter's and is
 * pinned in `packages/core/test/adapters/imap.folderpage.test.ts`.
 */

const NOW = new Date("2026-08-24T12:00:00.000Z");
const JUNK_PATH = "INBOX/Spamverdacht";

interface Seeded {
  deps: ApiDeps;
  db: Awaited<ReturnType<typeof makeTestDb>>;
  accountId: string;
  mailboxId: string;
}

async function seed(opts: {
  foldersOn?: boolean; junkFolder?: string | null; status?: string;
  db?: Seeded["db"]; accountId?: string; foldersDisabled?: boolean;
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
    accountId, provider: "imap", address: `junk-${randomUUID().slice(0, 8)}@example.invalid`,
    junkFolder: opts.junkFolder === undefined ? JUNK_PATH : opts.junkFolder,
    ...(opts.status !== undefined ? { status: opts.status } : {}),
    ...(opts.foldersDisabled ? { foldersDisabledAt: NOW } : {}),
  }).returning({ id: mailboxes.id });
  await db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, transport: "imap", secretEnc: "enc", keyVersion: 1,
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
      subject: `junk ${i.uid}`,
      from: { name: null, address: `s${i.uid}@example.invalid` },
      date: i.date ?? new Date(Date.UTC(2026, 7, 1) + i.seq * 60_000).toISOString(),
      messageIdHeader: i.mid === undefined ? `<mid-${i.uid}@x>` : i.mid,
      seen: false,
    })),
    nextBeforeSeq: null,
    ...over,
  };
}

/** The ServiceContext shape the rescue takes — the tests mint it from the account id. */
const ctxOf = (accountId: string) =>
  ({ accountId, now: () => NOW }) as unknown as Parameters<typeof rescueJunk>[1];

/**
 * The two mirror tables, `folder_state` and `junk_rescues` — read before and after every window
 * verb. The first three must NEVER move: Junk is outside the mirror (§16.2), and `folder_state`
 * in particular is the desired-state table the rescue deliberately does NOT use, because it is
 * `messages`-row-bound and a provider-filed junk message has no row. `junk_rescues` is the one
 * table a press may add to.
 */
async function mirrorCounts(db: Seeded["db"]): Promise<[number, number, number, number]> {
  const m = await db.select({ id: messages.id }).from(messages);
  const b = await db.select({ messageId: messageBodies.messageId }).from(messageBodies);
  const f = await db.select({ id: folderState.id }).from(folderState);
  const r = await db.select({ id: junkRescues.id }).from(junkRescues);
  return [m.length, b.length, f.length, r.length];
}

beforeEach(() => vi.restoreAllMocks());

describe("the flag gate", () => {
  it("everything answers 409 folders_disabled until “Use folders” is on", async () => {
    const { deps, accountId, mailboxId } = await seed({ foldersOn: false });
    await expect(listJunk(deps, accountId)).rejects.toMatchObject({ httpStatus: 409, code: "folders_disabled" });
    await expect(junkBody(deps, accountId, { mailboxId, uid: 1, uidValidity: "7" }))
      .rejects.toMatchObject({ httpStatus: 409 });
    await expect(rescueJunk(deps, ctxOf(accountId), { mailboxId, uid: 1, uidValidity: "7" }))
      .rejects.toMatchObject({ httpStatus: 409 });
  });
});

describe("the list window", () => {
  it("reads the live folder, attributes origin per verdict locator, and WRITES NO MIRROR ROW", async () => {
    const { deps, db, accountId, mailboxId } = await seed();
    // The mirror knows mid-2 as a row OUR verdict parked at the junk path (the filing
    // completion's `native_locator`), and mid-9 as ordinary mail living in the INBOX.
    await db.insert(messages).values([
      {
        accountId, mailboxId, messageIdHeader: "<mid-2@x>", bodyHash: "h1", dedupKey: "d1",
        subject: "husk", fromAddress: "s2@example.invalid",
        nativeLocator: { folder: JUNK_PATH, ref: "7:2" }, snippet: "", unread: false,
      },
      {
        accountId, mailboxId, messageIdHeader: "<mid-9@x>", bodyHash: "h2", dedupKey: "d2",
        subject: "inbox twin", fromAddress: "s9@example.invalid",
        nativeLocator: { folder: "INBOX", ref: "1:9" }, snippet: "", unread: false,
      },
    ]);
    const list = vi.spyOn(ImapAdapter.prototype, "listFolderPage")
      .mockResolvedValue(pageOf([{ uid: 9, seq: 3 }, { uid: 2, seq: 2 }, { uid: 1, seq: 1, mid: null }]));

    const before = await mirrorCounts(db);
    const page = await listJunk(deps, accountId);
    expect(list).toHaveBeenCalledWith(JUNK_PATH, expect.objectContaining({ limit: 50 }));

    expect(page.mailboxes).toEqual([
      expect.objectContaining({ id: mailboxId, window: "ok" }),
    ]);
    const byUid = new Map(page.items.map((i) => [i.uid, i]));
    // mid-2 matches the verdict husk parked AT THE JUNK PATH → ours.
    expect(byUid.get(2)!.origin).toBe("verdict");
    // mid-9 exists in the mirror but its locator is the INBOX — the provider filed the junk copy.
    expect(byUid.get(9)!.origin).toBe("provider");
    // No message-id at all → nothing to match → the provider's.
    expect(byUid.get(1)!.origin).toBe("provider");
    // Newest first, epoch carried per row.
    expect(page.items.map((i) => i.uid)).toEqual([9, 2, 1]);
    expect(page.items[0]!.uidValidity).toBe("7");

    // THE DEFINING PROPERTY: the read persisted nothing, in either mirror table.
    expect(await mirrorCounts(db)).toEqual(before);
  });

  it("a mailbox with NO native \\Junk degrades to a stated no_junk_folder — and never dials", async () => {
    const { deps, accountId, mailboxId } = await seed({ junkFolder: null });
    const list = vi.spyOn(ImapAdapter.prototype, "listFolderPage");
    const page = await listJunk(deps, accountId);
    expect(page.mailboxes).toEqual([expect.objectContaining({ id: mailboxId, window: "no_junk_folder" })]);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it("a STOOD-DOWN mailbox is not Cloud's window — absent from the answer, never dialled", async () => {
    const { deps, accountId } = await seed({ status: "disabled" });
    const list = vi.spyOn(ImapAdapter.prototype, "listFolderPage");
    const page = await listJunk(deps, accountId);
    expect(page.mailboxes).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });

  it("a dial that fails answers `unreachable` — a failed window is never an empty list", async () => {
    const { deps, accountId, mailboxId } = await seed();
    vi.spyOn(ImapAdapter.prototype, "connect").mockRejectedValue(new Error("ECONNREFUSED"));
    const page = await listJunk(deps, accountId);
    expect(page.mailboxes).toEqual([expect.objectContaining({ id: mailboxId, window: "unreachable" })]);
    expect(page.items).toEqual([]);
  });

  it("the older-page cursor round-trips into beforeSeq WITH its epoch", async () => {
    const { deps, accountId } = await seed();
    const list = vi.spyOn(ImapAdapter.prototype, "listFolderPage")
      .mockResolvedValue(pageOf([{ uid: 60, seq: 60 }], { nextBeforeSeq: 60 }));
    const page1 = await listJunk(deps, accountId);
    expect(page1.nextCursor).not.toBeNull();

    list.mockResolvedValue(pageOf([{ uid: 59, seq: 59 }]));
    await listJunk(deps, accountId, { cursor: page1.nextCursor! });
    expect(list).toHaveBeenLastCalledWith(
      JUNK_PATH, expect.objectContaining({ beforeSeq: 60, expectUidValidity: "7" }),
    );
  });

  it("TWO mailboxes still answer ONE bounded page, and the cut mailbox's cursor resumes exactly", async () => {
    const first = await seed();
    const second = await seed({ db: first.db, accountId: first.accountId, junkFolder: "Junk/Second" });
    const { deps, accountId } = first;
    // Mailbox A's rows are all newer than mailbox B's, 30 each: the merge takes all 30 of A
    // and only 20 of B before the account-level cap; B's other 10 must NOT be skipped.
    const pageA = pageOf(Array.from({ length: 30 }, (_, i) => ({
      uid: 100 + i, seq: 30 - i, date: new Date(Date.UTC(2026, 7, 20) + (30 - i) * 60_000).toISOString(),
    })));
    const pageB = pageOf(Array.from({ length: 30 }, (_, i) => ({
      uid: 200 + i, seq: 30 - i, date: new Date(Date.UTC(2026, 7, 10) + (30 - i) * 60_000).toISOString(),
    })));
    const list = vi.spyOn(ImapAdapter.prototype, "listFolderPage");
    // The reads run in PARALLEL, so call order is not the mailbox order — key the fake on the
    // folder each mailbox resolved, which is deterministic.
    list.mockImplementation(async (folder: string) => (folder === JUNK_PATH ? pageA : pageB));

    const page = await listJunk(deps, accountId);
    expect(page.items).toHaveLength(50);
    // A's 30 (newest dates) all made it; B contributed 20, newest-first prefix.
    expect(page.items.filter((i) => i.uid >= 200).map((i) => i.uid))
      .toEqual(Array.from({ length: 20 }, (_, i) => 200 + i));
    // The cursor resumes B strictly below its lowest RETURNED seq (11), skipping nothing.
    const cursor = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf8")) as
      Record<string, { v: string; s: number }>;
    expect(cursor[second.mailboxId]).toEqual({ v: "7", s: 11 });
    // A is fully drained — but WHILE B still paginates, A keeps an EPOCH entry (round 4): a
    // folder recreated between pages must be detectable, and the flag needs a held `v` to
    // compare against. Its watermark sits below everything served, so nothing repeats.
    expect(cursor[first.mailboxId]).toEqual({ v: "7", s: 1 });
  });

  it("a DRAINED mailbox recreated mid-pagination still gets its reset STATED (round 4)", async () => {
    const first = await seed();
    const second = await seed({ db: first.db, accountId: first.accountId, junkFolder: "Junk/Second" });
    const { deps, accountId } = first;
    const pageA = pageOf([{ uid: 100, seq: 1 }]); // drains on page one
    const pageB = pageOf(
      Array.from({ length: 60 }, (_, i) => ({ uid: 200 + i, seq: 60 - i })),
      { nextBeforeSeq: 11 },
    );
    const list = vi.spyOn(ImapAdapter.prototype, "listFolderPage");
    list.mockImplementation(async (folder: string) =>
      folder === JUNK_PATH ? pageA : pageB);
    const page1 = await listJunk(deps, accountId);
    expect(page1.nextCursor).not.toBeNull();

    // A's folder is purged and recreated before "Show older" — new epoch, EMPTY.
    list.mockImplementation(async (folder: string, opts?: { expectUidValidity?: string }) =>
      folder === JUNK_PATH
        ? pageOf([], { uidValidity: "9", total: 0 })
        : pageOf([{ uid: 210, seq: 10 }], opts?.expectUidValidity === "7" ? {} : { uidValidity: "9" }));
    const page2 = await listJunk(deps, accountId, { cursor: page1.nextCursor! });
    const aState = page2.mailboxes.find((m) => m.id === first.mailboxId)!;
    expect(aState.reset).toBe(true);
  });

  it("a DISCARDED cursor is STATED — the mailbox row says reset, so an empty new epoch is detectable", async () => {
    const { deps, accountId, mailboxId } = await seed();
    const list = vi.spyOn(ImapAdapter.prototype, "listFolderPage")
      .mockResolvedValue(pageOf([{ uid: 60, seq: 60 }], { nextBeforeSeq: 60 }));
    const page1 = await listJunk(deps, accountId);
    // The folder was recreated: the adapter answers the NEW epoch (and, being reset, its top).
    list.mockResolvedValue(pageOf([], { uidValidity: "9", total: 0 }));
    const page2 = await listJunk(deps, accountId, { cursor: page1.nextCursor! });
    expect(page2.mailboxes).toEqual([
      expect.objectContaining({ id: mailboxId, window: "ok", reset: true }),
    ]);
    // …and a same-epoch continuation says NO such thing.
    list.mockResolvedValue(pageOf([{ uid: 59, seq: 59 }]));
    const page3 = await listJunk(deps, accountId, { cursor: page1.nextCursor! });
    expect(page3.mailboxes[0]).not.toHaveProperty("reset");
  });

  it("a malformed cursor is a 400, not a crash and not page one", async () => {
    const { deps, accountId } = await seed();
    await expect(listJunk(deps, accountId, { cursor: "not-a-cursor" }))
      .rejects.toMatchObject({ httpStatus: 400 });
  });
});

describe("the body on open", () => {
  it("fetches live, parses to TEXT, persists nothing", async () => {
    const { deps, db, accountId, mailboxId } = await seed();
    const raw = Buffer.from(
      "From: s2@example.invalid\r\nTo: you@example.invalid\r\nSubject: cheap glaze\r\n" +
      "Message-ID: <mid-2@x>\r\nContent-Type: text/plain\r\n\r\nBuy now.\r\n",
    );
    vi.spyOn(ImapAdapter.prototype, "fetchByUid").mockResolvedValue({
      uidValidity: "7",
      creates: [{ type: "create", locator: { folder: JUNK_PATH, ref: "7:2" }, raw, seen: false }],
      absent: [], oversize: [],
    });
    const before = await mirrorCounts(db);
    const body = await junkBody(deps, accountId, { mailboxId, uid: 2, uidValidity: "7" });
    expect(body.subject).toBe("cheap glaze");
    expect(body.text).toContain("Buy now.");
    expect(await mirrorCounts(db)).toEqual(before);
  });

  it("an EPOCH mismatch answers 410 — never the body of whatever now wears the UID", async () => {
    const { deps, accountId, mailboxId } = await seed();
    vi.spyOn(ImapAdapter.prototype, "fetchByUid").mockResolvedValue({
      uidValidity: "9",
      creates: [{ type: "create", locator: { folder: JUNK_PATH, ref: "9:2" }, raw: Buffer.from("x"), seen: false }],
      absent: [], oversize: [],
    });
    await expect(junkBody(deps, accountId, { mailboxId, uid: 2, uidValidity: "7" }))
      .rejects.toMatchObject({ httpStatus: 410, code: "junk_message_gone" });
  });

  it("a message the provider already removed answers 410; an oversize one answers 413", async () => {
    const { deps, accountId, mailboxId } = await seed();
    const spy = vi.spyOn(ImapAdapter.prototype, "fetchByUid").mockResolvedValue({
      uidValidity: "7", creates: [], absent: [2], oversize: [],
    });
    await expect(junkBody(deps, accountId, { mailboxId, uid: 2, uidValidity: "7" }))
      .rejects.toMatchObject({ httpStatus: 410, code: "junk_message_gone" });
    spy.mockResolvedValue({ uidValidity: "7", creates: [], absent: [], oversize: [2] });
    await expect(junkBody(deps, accountId, { mailboxId, uid: 2, uidValidity: "7" }))
      .rejects.toMatchObject({ httpStatus: 413, code: "junk_body_too_large" });
  });
});

describe("a CALLER-SUPPLIED epoch must be a real one", () => {
  /**
   * The adapter's epoch guard treats `"0"` as "this locator never claimed an epoch" and lets it
   * through — right for the worker's cold-drain sentinels, which are minted internally, and wrong
   * for a number a request chose. `rescueJunk` builds the ref from this value, so `uidValidity=0`
   * would switch the guard off for that caller's own rescue and move whatever message now wears
   * the UID in a renumbered folder. Nothing crosses an account boundary; it defeats the one check
   * the rescue exists behind, which is enough.
   *
   * Mutation watched red and restored (2026-08-31): drop `requireRealEpoch` from `rescueJunk` and
   * the `"0"` case goes green on a recorded command — a coordinate with no epoch, which the
   * organizer's move then applies with the adapter's guard switched off.
   */
  for (const bad of ["0", "00", "-1", "1e9", " 7", "0x7", "Infinity", "", "seven"]) {
    it(`refuses uidValidity ${JSON.stringify(bad)} with 400, on BOTH verbs`, async () => {
      const { deps, accountId, mailboxId } = await seed();
      await expect(rescueJunk(deps, ctxOf(accountId), { mailboxId, uid: 2, uidValidity: bad }))
        .rejects.toMatchObject({ httpStatus: 400, code: "validation_failed" });
      await expect(junkBody(deps, accountId, { mailboxId, uid: 2, uidValidity: bad }))
        .rejects.toMatchObject({ httpStatus: 400, code: "validation_failed" });
    });
  }

  it("and a real epoch is NOT refused here — the guard is on the shape, not on the verb", async () => {
    // Reaching the ORDINARY ANSWER is the proof this rejects only what it means to: the `7` case
    // gets past the shape check and records its command.
    const { deps, accountId, mailboxId } = await seed();
    await expect(rescueJunk(deps, ctxOf(accountId), { mailboxId, uid: 2, uidValidity: "7" }))
      .resolves.toMatchObject({ status: "queued" });
  });
});

describe("the rescue — Not junk", () => {
  it("RECORDS the command, rings the doorbell, and touches no mirror table", async () => {
    const { deps, db, accountId, mailboxId } = await seed();
    // Every adapter verb the old route reached for, spied. None may be called: the API no longer
    // opens IMAP to apply organization, and a spy that was never called is the whole claim.
    const move = vi.spyOn(ImapAdapter.prototype, "move");
    const connect = vi.spyOn(ImapAdapter.prototype, "connect");
    const fetchByUid = vi.spyOn(ImapAdapter.prototype, "fetchByUid");
    const before = await mirrorCounts(db);

    const out = await rescueJunk(deps, ctxOf(accountId), { mailboxId, uid: 2, uidValidity: "7" });
    expect(out).toEqual({ status: "queued", rescueId: expect.any(String) });
    for (const spy of [move, connect, fetchByUid]) expect(spy).not.toHaveBeenCalled();

    // The command carries the coordinate the press named, and the junk path AS IT STOOD.
    const [row] = await db.select().from(junkRescues).where(eq(junkRescues.accountId, accountId));
    expect({
      folder: row!.folder, uidvalidity: String(row!.uidvalidity), uid: row!.uid,
      status: row!.status, attempts: row!.attempts, nextAttemptAt: row!.nextAttemptAt,
      lastErrorClass: row!.lastErrorClass,
    }).toEqual({
      folder: JUNK_PATH, uidvalidity: "7", uid: 2,
      status: "pending", attempts: 0, nextAttemptAt: null, lastErrorClass: null,
    });

    // The doorbell: the worker's ~3 s kick pass runs the rescue and then ingests the arrival.
    const [mb] = await db.select({ at: mailboxes.syncRequestedAt }).from(mailboxes)
      .where(eq(mailboxes.id, mailboxId));
    expect(mb!.at?.toISOString()).toBe(NOW.toISOString());

    // NO MIRROR ROW, and no `folder_state` either — the second half of the §16.2 claim. Junk is
    // outside the mirror, so the command is a coordinate and nothing else; `junk_rescues` is the
    // only table that gained anything.
    expect(await mirrorCounts(db)).toEqual([...before.slice(0, 3), before[3] + 1]);
  });

  it("a RE-PRESS resets the one command — never a second move for one message", async () => {
    const { deps, db, accountId, mailboxId } = await seed();
    const first = await rescueJunk(deps, ctxOf(accountId), { mailboxId, uid: 2, uidValidity: "7" });
    // The organizer refused it five times and the row reached its terminal state.
    await db.update(junkRescues)
      .set({ status: "refused", attempts: 5, lastErrorClass: "read_only", nextAttemptAt: NOW })
      .where(eq(junkRescues.id, first.rescueId));

    const again = await rescueJunk(deps, ctxOf(accountId), { mailboxId, uid: 2, uidValidity: "7" });
    expect(again.rescueId, "the UNIQUE locator is one command, not one per press").toBe(first.rescueId);
    const rows = await db.select().from(junkRescues).where(eq(junkRescues.accountId, accountId));
    expect(rows).toHaveLength(1);
    // Due again, with the refusal's class cleared beside its schedule — one group, `folder_state`'s
    // rule. `attempts` STAYS: a second press buys the next rung of the ladder, not a fresh one.
    expect({ status: rows[0]!.status, nextAttemptAt: rows[0]!.nextAttemptAt, lastErrorClass: rows[0]!.lastErrorClass, attempts: rows[0]!.attempts })
      .toEqual({ status: "pending", nextAttemptAt: null, lastErrorClass: null, attempts: 5 });
  });

  it("the SAME uid under a different epoch is a different command", async () => {
    // A UID means nothing outside its UIDVALIDITY, which is why the epoch is in the key. A folder
    // the provider rebuilt hands the same numbers to other messages.
    const { deps, db, accountId, mailboxId } = await seed();
    await rescueJunk(deps, ctxOf(accountId), { mailboxId, uid: 2, uidValidity: "7" });
    await rescueJunk(deps, ctxOf(accountId), { mailboxId, uid: 2, uidValidity: "8" });
    const rows = await db.select({ v: junkRescues.uidvalidity }).from(junkRescues)
      .where(eq(junkRescues.accountId, accountId));
    expect(rows.map((r) => String(r.v)).sort()).toEqual(["7", "8"]);
  });

  it("a cross-account mailbox id is a 404, and writes nothing", async () => {
    const { deps, db, accountId } = await seed();
    const other = await seed();
    await expect(rescueJunk(deps, ctxOf(accountId), { mailboxId: other.mailboxId, uid: 2, uidValidity: "7" }))
      .rejects.toMatchObject({ httpStatus: 404 });
    expect(await db.select().from(junkRescues)).toEqual([]);
  });

  it("the standing command is attributed back onto the window's own rows", async () => {
    const { deps, accountId, mailboxId } = await seed();
    vi.spyOn(ImapAdapter.prototype, "listFolderPage")
      .mockResolvedValue(pageOf([{ uid: 2, seq: 2 }, { uid: 1, seq: 1 }]));
    // Nothing pressed yet: `rescue` is ABSENT, never null — "no command" and "moved" are the same
    // fact from the window's side and the client needs one shape for it.
    const before = await listJunk(deps, accountId);
    expect(before.items.map((i) => i.rescue)).toEqual([undefined, undefined]);

    await rescueJunk(deps, ctxOf(accountId), { mailboxId, uid: 2, uidValidity: "7" });
    const after = await listJunk(deps, accountId);
    expect(after.items.find((i) => i.uid === 2)!.rescue).toBe("queued");
    expect(after.items.find((i) => i.uid === 1)!.rescue).toBeUndefined();

    // …and the search-append reads the same key, or the verb would be offered twice for one row.
    vi.spyOn(ImapAdapter.prototype, "searchFolderPage")
      .mockResolvedValue(searchPageOf([{ uid: 2, seq: 2 }]));
    const found = await searchJunk(deps, accountId, "junk");
    expect(found.items[0]!.rescue).toBe("queued");
  });

  it("a REFUSED command renders as refused, not as queued", async () => {
    const { deps, db, accountId, mailboxId } = await seed();
    const out = await rescueJunk(deps, ctxOf(accountId), { mailboxId, uid: 2, uidValidity: "7" });
    await db.update(junkRescues).set({ status: "refused" }).where(eq(junkRescues.id, out.rescueId));
    vi.spyOn(ImapAdapter.prototype, "listFolderPage")
      .mockResolvedValue(pageOf([{ uid: 2, seq: 2 }]));
    const page = await listJunk(deps, accountId);
    expect(page.items[0]!.rescue).toBe("refused");
    // The command's id rides beside it: clearing a refused command names it.
    expect(page.items[0]!.rescueId).toBe(out.rescueId);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE §16.2 EXTRAS (2026-08-27): the search-append, the second rescue verb, the sweep offer.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

function searchPageOf(
  items: Array<{ uid: number; seq: number; mid?: string | null; date?: string; subject?: string }>,
  over: Partial<FolderSearchPage> = {},
): FolderSearchPage {
  return {
    uidValidity: "7",
    items: items.map((i) => ({
      uid: i.uid, seq: i.seq,
      subject: i.subject ?? `junk ${i.uid}`,
      from: { name: null, address: `s${i.uid}@example.invalid` },
      date: i.date ?? new Date(Date.UTC(2026, 7, 1) + i.seq * 60_000).toISOString(),
      messageIdHeader: i.mid === undefined ? `<mid-${i.uid}@x>` : i.mid,
      seen: false,
    })),
    truncated: false,
    ...over,
  };
}

describe("the search-append", () => {
  it("searches each junk folder ONCE with the term, merges newest-first, attributes origin, writes NOTHING", async () => {
    const { deps, db, accountId, mailboxId } = await seed();
    await db.insert(messages).values({
      accountId, mailboxId, messageIdHeader: "<mid-2@x>", bodyHash: "h1", dedupKey: "d1",
      subject: "husk", fromAddress: "s2@example.invalid",
      nativeLocator: { folder: JUNK_PATH, ref: "7:2" }, snippet: "", unread: false,
    });
    const search = vi.spyOn(ImapAdapter.prototype, "searchFolderPage")
      .mockResolvedValue(searchPageOf([{ uid: 9, seq: 3 }, { uid: 2, seq: 2 }]));
    const before = await mirrorCounts(db);

    const page = await searchJunk(deps, accountId, "  lottery ");
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith(JUNK_PATH, "lottery", { limit: 50 });
    expect(page.mailboxes).toEqual([expect.objectContaining({ id: mailboxId, window: "ok" })]);
    expect(page.items.map((i) => i.uid)).toEqual([9, 2]);
    expect(page.items.find((i) => i.uid === 2)!.origin).toBe("verdict");
    expect(page.items.find((i) => i.uid === 9)!.origin).toBe("provider");
    expect(page.truncated).toBe(false);
    expect(await mirrorCounts(db)).toEqual(before);
  });

  it("a mailbox that cannot be searched is STATED unreachable — never an empty answer pretending", async () => {
    const { deps, accountId, mailboxId } = await seed();
    vi.spyOn(ImapAdapter.prototype, "searchFolderPage").mockRejectedValue(new Error("SEARCH timed out"));
    const page = await searchJunk(deps, accountId, "lottery");
    expect(page.items).toEqual([]);
    expect(page.mailboxes).toEqual([expect.objectContaining({ id: mailboxId, window: "unreachable" })]);
  });

  it("truncation is carried — the server matched more than the page holds", async () => {
    const { deps, accountId } = await seed();
    vi.spyOn(ImapAdapter.prototype, "searchFolderPage")
      .mockResolvedValue(searchPageOf([{ uid: 9, seq: 3 }], { truncated: true }));
    expect((await searchJunk(deps, accountId, "x")).truncated).toBe(true);
  });

  it("a blank or over-long term is a 400 before any dial; the flag gate holds", async () => {
    const { deps, accountId } = await seed();
    const search = vi.spyOn(ImapAdapter.prototype, "searchFolderPage");
    await expect(searchJunk(deps, accountId, "   ")).rejects.toMatchObject({ httpStatus: 400 });
    await expect(searchJunk(deps, accountId, "a".repeat(JUNK_SEARCH_MAX_CHARS + 1))).rejects.toMatchObject({ httpStatus: 400 });
    expect(search).not.toHaveBeenCalled();
    const off = await seed({ foldersOn: false });
    await expect(searchJunk(off.deps, off.accountId, "x")).rejects.toMatchObject({ code: "folders_disabled", httpStatus: 409 });
  });
});

describe("the second verb — Not junk, always allow", () => {
  const SENDER = "Spammer@Example.invalid";
  /**
   * A POSITIONAL `toEqual` NEEDS A TOTAL ORDER, and `destination` alone is not one: the rescue
   * leaves the disabled `sender` rule and the untouched `domain` rule BOTH at ohmail/Quarantine,
   * and which of the two a store hands back for that tie is its own business — measured at this
   * file's own base, alone, 2 green and 3 red in five runs. A rule's identity here is
   * (destination, kind, match) and it separates every row these fixtures write, so the query
   * states the order the assertions read. The assertion stays positional on purpose: a set-wise
   * one would pass whatever the store did. A fixture adding two rules equal in all three must
   * order on the key that tells them apart rather than on the store's goodwill.
   */
  const ruleRows = (db: Seeded["db"], accountId: string) =>
    db.select({ kind: rulesTbl.kind, match: rulesTbl.match, destination: rulesTbl.destination, enabled: rulesTbl.enabled, provenance: rulesTbl.provenance })
      .from(rulesTbl).where(eq(rulesTbl.accountId, accountId))
      .orderBy(rulesTbl.destination, rulesTbl.kind, rulesTbl.match);

  it("DISABLES the sender's spam rule, MINTS the allow, marks them known — all before the move — and announces both", async () => {
    const { deps, db, accountId, mailboxId } = await seed();
    const [spamRule] = await db.insert(rulesTbl).values({
      accountId, kind: "sender", match: SENDER.toLowerCase(), destination: "ohmail/Quarantine", provenance: "promoted", enabled: true,
    }).returning({ id: rulesTbl.id });
    // A DOMAIN spam rule must NOT be touched by a press about one address.
    await db.insert(rulesTbl).values({
      accountId, kind: "domain", match: "example.invalid", destination: "ohmail/Quarantine", provenance: "promoted", enabled: true,
    });
    const out = await rescueJunk(deps, ctxOf(accountId), {
      mailboxId, uid: 2, uidValidity: "7", allow: { sender: SENDER },
    });
    expect(out.status).toBe("queued");
    // The switched-off spam rule IS the sender's key, so it is the row that becomes the allow.
    expect(out.allowed).toEqual({ disabledRuleIds: [spamRule!.id], createdRuleId: spamRule!.id });
    // BOTH HALVES IN ONE TRANSACTION: the rules and the command are visible together, and the
    // organizer's move happens after both — so the arrival is routed under the rules whatever
    // order the cycle runs in.
    const [cmd] = await db.select({ status: junkRescues.status }).from(junkRescues)
      .where(eq(junkRescues.accountId, accountId));
    expect(cmd!.status).toBe("pending");

    const rows = await ruleRows(db, accountId);
    expect(rows).toEqual([
      // The allow is the person's own rule: the learned spam row it converges onto becomes `manual`.
      { kind: "sender", match: "spammer@example.invalid", destination: "INBOX", enabled: true, provenance: "manual" },
      { kind: "domain", match: "example.invalid", destination: "ohmail/Quarantine", enabled: true, provenance: "promoted" },
    ]);
    const known = await db.select({ address: contacts.address }).from(contacts).where(eq(contacts.accountId, accountId));
    expect(known).toEqual([{ address: "spammer@example.invalid" }]);
    // Both halves reach every mirror: the disable, then the same row's allow — two UPDATEs of one rule.
    const changes = await db.select({ entityType: changeLog.entityType, op: changeLog.op, entityId: changeLog.entityId })
      .from(changeLog).where(eq(changeLog.accountId, accountId));
    expect(changes.filter((c) => c.entityType === "rule").map((c) => [c.op, c.entityId])).toEqual([["update", spamRule!.id], ["update", spamRule!.id]]);
  });

  /**
   * ── THE RESCUE ASKS FOR THE BACKLOG ──────────────────────────────────────────
   *
   * "Not junk" says this sender's mail belongs in the Ohbox, and the message being rescued is
   * rarely their only one. The allow rule was created with `retro_requested_at` NULL, which every
   * reader takes as "nobody asked" — so the rest of that sender's mail stayed wherever the spam
   * verdict put it and nothing ever revisited it. Stamped in the rescue's own transaction.
   */
  it("the allow rule asks for this sender's backlog, in the same write", async () => {
    const { deps, db, accountId, mailboxId } = await seed();
    const rescued = await rescueJunk(deps, ctxOf(accountId), {
      mailboxId, uid: 2, uidValidity: "7", allow: { sender: SENDER },
    });
    const out = rescued.allowed!;
    expect(out.createdRuleId).not.toBeNull();
    const [row] = await db.select().from(rulesTbl)
      .where(and(eq(rulesTbl.accountId, accountId), eq(rulesTbl.id, out.createdRuleId!)));
    expect(row!.retroRequestedAt, "the rescue's allow rule never asked for the backlog").not.toBeNull();
    expect(row!.retroDoneAt, "the request is OWED, not already finished").toBeNull();
  });

  it("a spam rule saved with spaces around the address is switched off, and it is the row that allows", async () => {
    // The router names the sender by `ruleMatchKey`, so a padded deny left enabled outranks the
    // allow. RED at the base: nothing disabled, the next message still quarantined. The padded row
    // is the sender's key, so the press converges onto it: one rule, into the Ohbox.
    const { deps, db, accountId, mailboxId } = await seed();
    const [spam] = await db.insert(rulesTbl).values({
      accountId, kind: "sender", match: " spammer@example.invalid ", destination: "ohmail/Quarantine", provenance: "manual", enabled: true,
    }).returning({ id: rulesTbl.id });
    const out = (await rescueJunk(deps, ctxOf(accountId), {
      mailboxId, uid: 2, uidValidity: "7", allow: { sender: SENDER },
    })).allowed!;
    expect(out.disabledRuleIds).toEqual([spam!.id]);
    expect(out.createdRuleId).toBe(spam!.id);
    expect(await ruleRows(db, accountId)).toEqual([
      { kind: "sender", match: " spammer@example.invalid ", destination: "INBOX", enabled: true, provenance: "manual" },
    ]);
  });

  it("an already-standing sender allow is NOT duplicated — the disable still happens", async () => {
    const { deps, db, accountId, mailboxId } = await seed();
    const [reads] = await db.insert(rulesTbl).values({
      accountId, kind: "sender", match: "spammer@example.invalid", destination: "ohmail/News", provenance: "manual", enabled: true,
    }).returning({ id: rulesTbl.id });
    await db.insert(rulesTbl).values({
      accountId, kind: "sender", match: "spammer@example.invalid", destination: "ohmail/Quarantine", provenance: "promoted", enabled: true,
    });
    // Driven THROUGH the route, which is the only door `allowSender` has now: it takes the
    // caller's transaction, so there is no second way to run it and no second answer it can give.
    const out = (await rescueJunk(deps, ctxOf(accountId), {
      mailboxId, uid: 2, uidValidity: "7", allow: { sender: SENDER },
    })).allowed!;
    expect(out.createdRuleId).toBeNull();
    expect(out.disabledRuleIds).toHaveLength(1);
    const rows = await ruleRows(db, accountId);
    expect(rows.filter((r) => r.enabled)).toEqual([
      { kind: "sender", match: "spammer@example.invalid", destination: "ohmail/News", enabled: true, provenance: "manual" },
    ]);
    void reads;
    // Pressing twice mints nothing more and announces nothing more.
    const again = (await rescueJunk(deps, ctxOf(accountId), {
      mailboxId, uid: 2, uidValidity: "7", allow: { sender: SENDER },
    })).allowed!;
    expect(again).toEqual({ disabledRuleIds: [], createdRuleId: null });
  });

  it("the plain rescue touches NO rule — the two verbs are different statements", async () => {
    const { deps, db, accountId, mailboxId } = await seed();
    await db.insert(rulesTbl).values({
      accountId, kind: "sender", match: "s2@example.invalid", destination: "ohmail/Quarantine", provenance: "promoted", enabled: true,
    });
    const out = await rescueJunk(deps, ctxOf(accountId), { mailboxId, uid: 2, uidValidity: "7" });
    expect(out).toEqual({ status: "queued", rescueId: expect.any(String) });
    const rows = await ruleRows(db, accountId);
    expect(rows).toEqual([expect.objectContaining({ destination: "ohmail/Quarantine", enabled: true })]);
    expect(await db.select().from(contacts).where(eq(contacts.accountId, accountId))).toEqual([]);
  });

  /**
   * ── CONTROL 1: THE RULE AND THE COMMAND ARE ONE TRANSACTION ─────────────────────────────
   *
   * This is the defect the lane closed, driven rather than described. `allowSender` used to open
   * its OWN transaction and commit before the move ran, so an interruption between the two left a
   * sender allowed with nothing behind it — the state the retired 410 and 502 sentences existed to
   * describe. One transaction makes it unrepresentable.
   *
   * THE INTERRUPT IS A REAL ONE, not a double: a trigger makes the database raise 22003 at the
   * `junk_rescues` INSERT — after the allow has written its rows. (It was a uid above 2^31
   * overflowing an `integer` column until mail 0131 made that uid storable.) Watched red by moving
   * the `junk_rescues` insert into a second `withAccountTx`: the rule then survives and this case
   * names it.
   */
  it("an INTERRUPT after the allow leaves NEITHER the rule nor the command", async () => {
    const { deps, db, accountId, mailboxId } = await seed();
    await db.execute(sql.raw(`create function jr_interrupt() returns trigger language plpgsql as $$
      begin raise exception 'interrupted after the allow' using errcode = '22003'; end $$`));
    await db.execute(sql.raw(`create trigger jr_interrupt before insert on junk_rescues
      for each row execute function jr_interrupt()`));
    await expect(rescueJunk(deps, ctxOf(accountId), {
      mailboxId, uid: 2, uidValidity: "7", allow: { sender: SENDER },
    })).rejects.toThrow(/interrupted after the allow/);
    await db.execute(sql.raw(`drop trigger jr_interrupt on junk_rescues`));
    expect(await ruleRows(db, accountId), "a rule survived a rescue that did not record").toEqual([]);
    expect(await db.select().from(contacts).where(eq(contacts.accountId, accountId))).toEqual([]);
    expect(await db.select().from(junkRescues)).toEqual([]);
    expect(await db.select().from(changeLog).where(eq(changeLog.accountId, accountId))).toEqual([]);
    // THE POSITIVE CONTROL: the same press with the trigger gone writes BOTH halves, so the case
    // above is the rollback and not a refusal at the door.
    const ok = await rescueJunk(deps, ctxOf(accountId), {
      mailboxId, uid: 2, uidValidity: "7", allow: { sender: SENDER },
    });
    expect(ok.allowed!.createdRuleId).not.toBeNull();
    expect(await db.select().from(junkRescues)).toHaveLength(1);
  });

  it("an address-less sender is refused 422 before any write or dial", async () => {
    const { deps, db, accountId, mailboxId } = await seed();
    const move = vi.spyOn(ImapAdapter.prototype, "move");
    await expect(rescueJunk(deps, ctxOf(accountId), {
      mailboxId, uid: 2, uidValidity: "7", allow: { sender: "not an address" },
    })).rejects.toMatchObject({ httpStatus: 422 });
    expect(move).not.toHaveBeenCalled();
    expect(await ruleRows(db, accountId)).toEqual([]);
  });
});

describe("the one-time sweep offer", () => {
  async function quarantined(
    db: Seeded["db"], accountId: string, mailboxId: string, n: number,
    folder = "ohmail/Quarantine", desired = "ohmail/Quarantine",
  ) {
    for (let i = 0; i < n; i++) {
      const key = `${mailboxId}-${folder}-${desired}-${i}`;
      const [m] = await db.insert(messages).values({
        accountId, mailboxId, messageIdHeader: `<q-${key}@x>`, bodyHash: `q${i}`, dedupKey: `q-${key}`,
        subject: `old spam ${i}`, fromAddress: "spammer@example.invalid",
        nativeLocator: { folder, ref: `1:${50 + i}` }, snippet: "", unread: false,
      }).returning({ id: messages.id });
      await db.insert(folderState).values({
        messageId: m!.id, desiredFolder: desired, observedFolder: folder, lastSetBy: "us", reconcileStatus: "reconciled",
      });
    }
  }

  it("the preview counts what still sits in Quarantine per mailbox, and whether it can move", async () => {
    const a = await seed();
    const b = await seed({ db: a.db, accountId: a.accountId, junkFolder: null });
    await quarantined(a.db, a.accountId, a.mailboxId, 3);
    await quarantined(a.db, a.accountId, b.mailboxId, 2);
    // Mail elsewhere is not a candidate; nor is a member the USER has since moved (a newer
    // desired folder the reconciler has not executed yet — the sweep must not overwrite it).
    await quarantined(a.db, a.accountId, a.mailboxId, 1, "INBOX");
    await quarantined(a.db, a.accountId, a.mailboxId, 2, "ohmail/Quarantine", "INBOX");
    // A mailbox switched OFF under "Use folders" is not the feature's to sweep — absent entirely.
    const off = await seed({ db: a.db, accountId: a.accountId, foldersDisabled: true });
    await quarantined(a.db, a.accountId, off.mailboxId, 5);
    const pv = await junkSweepPreview(a.deps, a.accountId);
    expect(pv.mailboxes.map((m) => m.id)).not.toContain(off.mailboxId);
    expect(pv.mailboxes).toEqual(expect.arrayContaining([
      { id: a.mailboxId, address: expect.any(String), candidates: 3, hasJunkFolder: true, pending: false },
      { id: b.mailboxId, address: expect.any(String), candidates: 2, hasJunkFolder: false, pending: false },
    ]));
    // Only the mailbox WITH a junk folder counts toward the offer's number.
    expect(pv.movable).toBe(3);
    expect(pv.pending).toBe(false);
  });

  it("the press stamps ONLY movable mailboxes, rings the doorbell, and reads back as pending; nothing to move is a 409", async () => {
    const a = await seed();
    const b = await seed({ db: a.db, accountId: a.accountId, junkFolder: null });
    await quarantined(a.db, a.accountId, a.mailboxId, 2);
    await quarantined(a.db, a.accountId, b.mailboxId, 2);
    const after = await requestJunkSweep(a.deps, ctxOf(a.accountId));
    expect(after.pending).toBe(true);
    expect(after.mailboxes.find((m) => m.id === a.mailboxId)!.pending).toBe(true);
    expect(after.mailboxes.find((m) => m.id === b.mailboxId)!.pending).toBe(false);
    const [row] = await a.db.select({ at: mailboxes.junkSweepRequestedAt, kick: mailboxes.syncRequestedAt })
      .from(mailboxes).where(eq(mailboxes.id, a.mailboxId));
    expect(row!.at?.toISOString()).toBe(NOW.toISOString());
    expect(row!.kick?.toISOString()).toBe(NOW.toISOString());

    // A swept pile has no candidates — the offer is gone and a press is refused, not repeated.
    const empty = await seed();
    await expect(requestJunkSweep(empty.deps, ctxOf(empty.accountId))).rejects.toMatchObject({ code: "nothing_to_sweep", httpStatus: 409 });
  });

  it("both answer 409 folders_disabled with the flag off, and never dial", async () => {
    const off = await seed({ foldersOn: false });
    const connect = vi.spyOn(ImapAdapter.prototype, "connect");
    await expect(junkSweepPreview(off.deps, off.accountId)).rejects.toMatchObject({ code: "folders_disabled" });
    await expect(requestJunkSweep(off.deps, ctxOf(off.accountId))).rejects.toMatchObject({ code: "folders_disabled" });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("the held list", () => {
  /** One mirror letter with its locator, desired folder and reconcile state. */
  async function letter(
    db: Seeded["db"], accountId: string, mailboxId: string, tag: string,
    at: { loc: string; desired: string; status?: string; deleted?: boolean; date?: Date; createdAt?: Date },
  ): Promise<string> {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId, messageIdHeader: `<h-${tag}@x>`, bodyHash: `h-${tag}`, dedupKey: `h-${tag}`,
      subject: tag, fromAddress: "spammer@example.invalid",
      nativeLocator: { folder: at.loc, ref: "7:1" }, snippet: "", unread: false,
      ...(at.deleted ? { deletedAt: NOW } : {}),
      ...(at.date ? { date: at.date, arrivedAt: at.date } : {}),
      ...(at.createdAt ? { createdAt: at.createdAt } : {}),
    }).returning({ id: messages.id });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: at.desired, observedFolder: at.loc, lastSetBy: "us",
      reconcileStatus: at.status ?? "reconciled",
    });
    return m!.id;
  }
  const Q = "ohmail/Quarantine";

  it("lists the letter sitting in Quarantine, not one filed to Junk, on its way, moved by the user or deleted", async () => {
    const a = await seed();
    const held = await letter(a.db, a.accountId, a.mailboxId, "held", { loc: Q, desired: Q });
    await letter(a.db, a.accountId, a.mailboxId, "filed", { loc: JUNK_PATH, desired: Q });
    await letter(a.db, a.accountId, a.mailboxId, "transit", { loc: "INBOX", desired: Q, status: "pending" });
    await letter(a.db, a.accountId, a.mailboxId, "moved", { loc: Q, desired: "INBOX", status: "pending" });
    await letter(a.db, a.accountId, a.mailboxId, "gone", { loc: Q, desired: Q, deleted: true });
    const pv = await junkSweepPreview(a.deps, a.accountId);
    expect(pv.held).toEqual({ ids: [held], truncated: false });
  });

  it("a mailbox with no Junk folder and an opted-out one are included; a stood-down one is not; the offer is unchanged", async () => {
    const a = await seed();
    const noJunk = await seed({ db: a.db, accountId: a.accountId, junkFolder: null });
    const off = await seed({ db: a.db, accountId: a.accountId, foldersDisabled: true });
    const down = await seed({ db: a.db, accountId: a.accountId, status: "disabled" });
    const t0 = Date.UTC(2026, 7, 1);
    // Ingest time runs opposite to the letters' dates, as on an imported pile.
    const at = (s: number) => ({ date: new Date(t0 + s * 1_000), createdAt: new Date(t0 + (10 - s) * 1_000) });
    const ha = await letter(a.db, a.accountId, a.mailboxId, "a", { loc: Q, desired: Q, ...at(3) });
    const hb = await letter(a.db, a.accountId, noJunk.mailboxId, "b", { loc: Q, desired: Q, ...at(2) });
    const hc = await letter(a.db, a.accountId, off.mailboxId, "c", { loc: Q, desired: Q, ...at(1) });
    await letter(a.db, a.accountId, down.mailboxId, "d", { loc: Q, desired: Q, ...at(4) });
    const pv = await junkSweepPreview(a.deps, a.accountId);
    // Newest first across mailboxes, by arrival key.
    expect(pv.held).toEqual({ ids: [ha, hb, hc], truncated: false });
    expect(pv.mailboxes.map((m) => m.id).sort()).toEqual([a.mailboxId, noJunk.mailboxId].sort());
    expect(pv.movable).toBe(1);
  });

  it("two accounts each see only their own ids", async () => {
    const a = await seed();
    const b = await seed({ db: a.db });
    const ha = await letter(a.db, a.accountId, a.mailboxId, "mine", { loc: Q, desired: Q });
    const hb = await letter(a.db, b.accountId, b.mailboxId, "theirs", { loc: Q, desired: Q });
    expect((await junkSweepPreview(a.deps, a.accountId)).held.ids).toEqual([ha]);
    expect((await junkSweepPreview(b.deps, b.accountId)).held.ids).toEqual([hb]);
  });

  it("501 held letters answer the 500 newest, cut; exactly 500 is not cut", async () => {
    const a = await seed();
    const t0 = Date.UTC(2026, 7, 1);
    const values = Array.from({ length: 501 }, (_, i) => ({
      accountId: a.accountId, mailboxId: a.mailboxId, messageIdHeader: `<bulk-${i}@x>`, bodyHash: `b${i}`,
      dedupKey: `bulk-${i}`, subject: `bulk ${i}`, fromAddress: "spammer@example.invalid",
      nativeLocator: { folder: Q, ref: `7:${i + 1}` }, snippet: "", unread: false,
      date: new Date(t0 + i * 1_000), arrivedAt: new Date(t0 + i * 1_000),
    }));
    const rows = await a.db.insert(messages).values(values).returning({ id: messages.id, subject: messages.subject });
    await a.db.insert(folderState).values(rows.map((r) => ({
      messageId: r.id, desiredFolder: Q, observedFolder: Q, lastSetBy: "us" as const, reconcileStatus: "reconciled" as const,
    })));
    const oldest = rows.find((r) => r.subject === "bulk 0")!.id;
    const newest = rows.find((r) => r.subject === "bulk 500")!.id;
    const cut = await junkSweepPreview(a.deps, a.accountId);
    expect(cut.held.ids).toHaveLength(JUNK_HELD_MAX);
    expect(cut.held.truncated).toBe(true);
    expect(cut.held.ids[0]).toBe(newest);
    expect(cut.held.ids).not.toContain(oldest);
    await a.db.update(messages).set({ deletedAt: NOW }).where(eq(messages.id, oldest));
    const whole = await junkSweepPreview(a.deps, a.accountId);
    expect(whole.held.ids).toHaveLength(500);
    expect(whole.held.truncated).toBe(false);
  });

  it("an imported pile over 500 keeps its 500 newest-dated letters, whatever order it was ingested in", async () => {
    const a = await seed();
    const t0 = Date.UTC(2026, 7, 1);
    // A first sync reads newest first: letter i is dated i days back and ingested i seconds in.
    const values = Array.from({ length: 600 }, (_, i) => ({
      accountId: a.accountId, mailboxId: a.mailboxId, messageIdHeader: `<pile-${i}@x>`, bodyHash: `p${i}`,
      dedupKey: `pile-${i}`, subject: `pile ${i}`, fromAddress: "spammer@example.invalid",
      nativeLocator: { folder: Q, ref: `7:${600 - i}` }, snippet: "", unread: false,
      date: new Date(t0 - i * 86_400_000), arrivedAt: new Date(t0 - i * 86_400_000), createdAt: new Date(t0 + i * 1_000),
    }));
    const rows = await a.db.insert(messages).values(values).returning({ id: messages.id, subject: messages.subject });
    await a.db.insert(folderState).values(rows.map((r) => ({
      messageId: r.id, desiredFolder: Q, observedFolder: Q, lastSetBy: "us" as const, reconcileStatus: "reconciled" as const,
    })));
    const idOf = (i: number) => rows.find((r) => r.subject === `pile ${i}`)!.id;
    const pv = await junkSweepPreview(a.deps, a.accountId);
    expect(pv.held.truncated).toBe(true);
    expect(pv.held.ids).toEqual(Array.from({ length: JUNK_HELD_MAX }, (_, i) => idOf(i)));
  });

  it("the press answers the held list too; folders off is still 409 and never dials", async () => {
    const a = await seed();
    const held = await letter(a.db, a.accountId, a.mailboxId, "pressed", { loc: Q, desired: Q });
    const after = await requestJunkSweep(a.deps, ctxOf(a.accountId));
    expect(after.held).toEqual({ ids: [held], truncated: false });
    // No participating mailbox still carries the list (a mailbox opted out keeps its letters held).
    const off = await seed({ foldersDisabled: true });
    const offHeld = await letter(off.db, off.accountId, off.mailboxId, "opted-out", { loc: Q, desired: Q });
    const pv = await junkSweepPreview(off.deps, off.accountId);
    expect(pv.mailboxes).toEqual([]);
    expect(pv.held).toEqual({ ids: [offHeld], truncated: false });
    const flagOff = await seed({ foldersOn: false });
    const connect = vi.spyOn(ImapAdapter.prototype, "connect");
    await expect(junkSweepPreview(flagOff.deps, flagOff.accountId)).rejects.toMatchObject({ code: "folders_disabled", httpStatus: 409 });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("review round (client r1 / live proof) — attribution spelling and the partial allow outcome", () => {
  it("a live row whose envelope Message-ID carries angle brackets still matches the mirror's bare id → verdict", async () => {
    const { deps, db, accountId, mailboxId } = await seed();
    // The mirror stores the bare id (the parser's), parked at the junk path by the sweep/verdict.
    await db.insert(messages).values({
      accountId, mailboxId, messageIdHeader: "seed-1@seed.invalid", bodyHash: "h1", dedupKey: "d1",
      subject: "husk", fromAddress: "s2@example.invalid",
      nativeLocator: { folder: JUNK_PATH, ref: "7:2" }, snippet: "", unread: false,
    });
    vi.spyOn(ImapAdapter.prototype, "listFolderPage")
      .mockResolvedValue(pageOf([{ uid: 2, seq: 2, mid: "<seed-1@seed.invalid>" }, { uid: 1, seq: 1, mid: "<other@x>" }]));
    const page = await listJunk(deps, accountId);
    expect(page.items.find((i) => i.uid === 2)!.origin).toBe("verdict");
    expect(page.items.find((i) => i.uid === 1)!.origin).toBe("provider");
    // And the search's attribution reads the same key.
    vi.spyOn(ImapAdapter.prototype, "searchFolderPage")
      .mockResolvedValue(searchPageOf([{ uid: 2, seq: 2, mid: "<seed-1@seed.invalid>" }]));
    const found = await searchJunk(deps, accountId, "husk");
    expect(found.items[0]!.origin).toBe("verdict");
  });

  /**
   * ── THE PARTIAL-OUTCOME ROUNDS ARE GONE, AND THE ABSENCE IS THE POINT ────────────────────
   *
   * Three review rounds (client r1, client r2, round 5) drove three ways for the move to fail
   * AFTER the allow had committed — a provider `NO`, a refused dial, a typed `mailbox_busy` — and
   * each asserted a 502 `junk_rescue_move_failed` carrying the standing allow. None of those
   * sequences exists now: the press opens no socket at all, and the allow shares the command's
   * transaction, so there is no instant at which one half stands without the other. The state
   * they described is checked for its ABSENCE by the interrupt case above, which is the same
   * question asked of a failure that can still happen.
   */
});
