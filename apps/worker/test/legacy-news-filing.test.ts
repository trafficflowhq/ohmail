import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import {
  accounts, auditLog, folderState, mailboxFolders, mailboxes, messageInstances, messages, type Tx,
} from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { MessageService, type ServiceContext } from "@trafficflow/services";
import { reconcileMailbox } from "../src/sync.js";
import { legacyNewsRepairPass } from "../src/news-repair.js";
import { RECONCILE_BACKOFF_MINUTES } from "../src/reconcile-refusal.js";
import { FIXTURE_LEASE } from "./_door.js";
import { ORGANIZER_CONSENT } from "./_workerdb.js";

/**
 * SIX LEGACY FILINGS, AND THE FILING PATH AROUND THEM — the real adapter over an in-memory IMAP
 * server, the real store. The six are older News letters a rule filed out of News whose locator
 * still names `ohmail/Reads` under the folder's old UIDVALIDITY; News came back renumbered, so
 * every move refused at the epoch check and nothing was written: no move, no audit, no end. A
 * dropped connection then read as "your mail server refused it", and a refused batched `UID MOVE`
 * read as moved.
 */

type Msg = { uid: number; messageId: string; source: Buffer };
type Folder = { uidValidity: bigint; uidNext: number; msgs: Map<number, Msg> };

const eml = (id: string) => Buffer.from(
  `From: sender@example.com\r\nTo: person@example.com\r\nSubject: receipt ${id}\r\n`
  + `Message-ID: <${id}>\r\nDate: Thu, 23 Oct 2026 10:00:00 +0000\r\n\r\nbody of ${id}\r\n`);

class Server {
  folders = new Map<string, Folder>();
  imap: string[] = [];
  moveAnswer: "ok" | "false" = "ok";
  /** Destinations whose `UID MOVE` the server answers NO. */
  refuseInto = new Set<string>();
  lockFault: (() => Error) | null = null;
  /** A lock on a folder that is not there fails as imapflow 1.7.8 measured: NO, no code, `mailboxMissing`. */
  measuredMissing = false;
  /** The server answers a CREATE with a bare NO. */
  refuseCreate = false;
  folder(path: string, uidValidity: bigint): Folder {
    const f = { uidValidity, uidNext: 1, msgs: new Map<number, Msg>() };
    this.folders.set(path, f);
    return f;
  }
  put(path: string, uid: number, messageId: string): void {
    const f = this.folders.get(path)!;
    f.msgs.set(uid, { uid, messageId, source: eml(messageId) });
    f.uidNext = Math.max(f.uidNext, uid + 1);
  }
  count(path: string): number { return this.folders.get(path)?.msgs.size ?? 0; }
}

function clientOver(s: Server) {
  const capabilities = new Map<string, boolean>([["IDLE", true], ["MOVE", true], ["UIDPLUS", true]]);
  const cur = (): Folder => s.folders.get((client.mailbox as { path: string }).path)!;
  const uidsOf = (range: string | number[] | number): number[] =>
    Array.isArray(range) ? range : String(range).split(",").map(Number);
  const client = {
    usable: true,
    capabilities,
    mailbox: false as unknown,
    async list() {
      return [...s.folders.keys()].map((path) => ({ path, name: path, delimiter: "/", flags: new Set<string>() }));
    },
    async getMailboxLock(path: string) {
      if (s.lockFault) throw s.lockFault();
      const f = s.folders.get(path);
      if (!f && s.measuredMissing) throw Object.assign(new Error("Command failed"), { responseStatus: "NO", mailboxMissing: true });
      if (!f) throw Object.assign(new Error("Mailbox doesn't exist"), { serverResponseCode: "NONEXISTENT" });
      client.mailbox = { path, exists: f.msgs.size, uidValidity: f.uidValidity, uidNext: f.uidNext };
      return { path, release() { /* nothing */ } };
    },
    async status(path: string) {
      const f = s.folders.get(path)!;
      return { path, messages: f.msgs.size, uidValidity: f.uidValidity, uidNext: f.uidNext };
    },
    async fetchOne(range: string, q: { source?: boolean }) {
      const m = cur().msgs.get(Number(range));
      if (!m) return false;
      return { uid: m.uid, envelope: { messageId: `<${m.messageId}>` }, ...(q?.source ? { source: m.source } : {}) };
    },
    async fetchAll(range: string) {
      return uidsOf(range).filter((u) => cur().msgs.has(u))
        .map((u) => ({ uid: u, envelope: { messageId: `<${cur().msgs.get(u)!.messageId}>` } }));
    },
    async search(q: { header?: Record<string, string>; or?: Array<{ header: Record<string, string> }> }) {
      const ids = q.or ? q.or.map((o) => o.header["message-id"]!) : [q.header!["message-id"]!];
      return [...cur().msgs.values()].filter((m) => ids.includes(m.messageId)).map((m) => m.uid);
    },
    async download(range: string) {
      const m = cur().msgs.get(Number(range));
      if (!m) return { meta: {}, content: null };
      return { meta: {}, content: Readable.from([m.source]) };
    },
    async messageMove(range: number[] | number, to: string) {
      const list = uidsOf(range);
      s.imap.push(`messageMove ${JSON.stringify(list)} ${(client.mailbox as { path: string }).path} -> ${to}`);
      // imapflow 1.7.8: a tagged NO is caught and answered false
      if (s.moveAnswer === "false" || s.refuseInto.has(to)) return false;
      const src = cur();
      const dst = s.folders.get(to)!;
      const uidMap = new Map<number, number>();
      for (const u of list) {
        const m = src.msgs.get(u);
        if (!m) continue;
        src.msgs.delete(u);
        const nu = dst.uidNext++;
        dst.msgs.set(nu, { ...m, uid: nu });
        uidMap.set(u, nu);
      }
      return { path: (client.mailbox as { path: string }).path, destination: to, uidValidity: dst.uidValidity, uidMap };
    },
    async messageDelete(range: number[] | number) {
      s.imap.push(`messageDelete ${JSON.stringify(uidsOf(range))} in ${(client.mailbox as { path: string }).path}`);
      for (const u of uidsOf(range)) cur().msgs.delete(u);
      return true;
    },
    async mailboxCreate(path: string) {
      s.imap.push(`mailboxCreate ${path}`);
      if (s.refuseCreate) throw Object.assign(new Error("Command failed"), { responseStatus: "NO" });
      s.folder(path, 9n);
      return { path, created: true };
    },
    async messageFlagsAdd() { return true; },
    async messageFlagsRemove() { return true; },
    async noop() { /* nothing */ },
    async logout() { /* nothing */ },
    close() { /* nothing */ },
  };
  return client;
}

/** News renumbered to epoch 4 after the rename; six older letters at News uids 101-106. */
function renamedServer(): Server {
  const s = new Server();
  s.folder("INBOX", 1n);
  s.folder("ohmail/News", 4n);
  s.folder("ohmail/Receipts", 3n);
  for (let i = 1; i <= 6; i++) s.put("ohmail/News", 100 + i, `old-news-${i}@example.com`);
  return s;
}

interface Seed { desired?: string; observed?: string; attempts?: number; errorClass?: string | null; newsCopy?: boolean }

/** The store as production holds the six: locator and primary at Reads under epoch 1, News copies under 4. */
async function world(n: number, seed: Seed = {}) {
  const db = (await makeTestDb()) as unknown as Tx;
  const [a] = await db.insert(accounts).values({ name: "legacy-news-filing" }).returning();
  const accountId = a!.id;
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `t-${accountId.slice(0, 8)}@example.test` }).returning();
  const mailboxId = mb!.id;
  await db.insert(mailboxFolders).values([
    { mailboxId, folder: "ohmail/News", uidvalidity: 4n, uidnext: 107n, highestmodseq: 1n },
    { mailboxId, folder: "ohmail/Reads", uidvalidity: 1n, uidnext: 7n, highestmodseq: 1n },
    { mailboxId, folder: "ohmail/Receipts", uidvalidity: 3n, uidnext: 1n, highestmodseq: 1n },
  ]);
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    const id = `old-news-${i}@example.com`;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId, messageIdHeader: id, bodyHash: `h${i}`, dedupKey: `mid:<${id}>`,
      subject: `receipt ${i}`, fromAddress: "sender@example.com", nativeLocator: { folder: "ohmail/Reads", ref: `1:${i}` },
    }).returning();
    ids.push(m!.id);
    await db.insert(messageInstances).values({ accountId, mailboxId, messageId: m!.id, folder: "ohmail/Reads", uidvalidity: 1n, uid: i, isPrimary: true });
    if (seed.newsCopy !== false) {
      await db.insert(messageInstances).values({ accountId, mailboxId, messageId: m!.id, folder: "ohmail/News", uidvalidity: 4n, uid: 100 + i, isPrimary: false });
    }
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: seed.desired ?? "ohmail/Receipts", observedFolder: seed.observed ?? "ohmail/Reads",
      lastSetBy: "us", reconcileStatus: "pending", conflict: true, attempts: seed.attempts ?? 1,
      lastErrorClass: seed.errorClass === undefined ? "refused" : seed.errorClass, nextAttemptAt: null,
    });
  }
  const repo = makeDrizzleRepo(db);
  const states = async () => (await db.select({
    id: folderState.messageId, status: folderState.reconcileStatus, observed: folderState.observedFolder,
    attempts: folderState.attempts, next: folderState.nextAttemptAt, cls: folderState.lastErrorClass,
  }).from(folderState)).filter((r) => ids.includes(r.id));
  const locators = async () => (await db.select({ loc: messages.nativeLocator }).from(messages)
    .where(eq(messages.mailboxId, mailboxId))).map((r) => (r.loc as { folder: string }).folder).sort();
  const audits = async () => (await db.select({ action: auditLog.action, payload: auditLog.payload }).from(auditLog)
    .where(eq(auditLog.accountId, accountId)));
  return { db, accountId, mailboxId, ids, repo, states, locators, audits };
}

async function adapterOver(s: Server) {
  const adapter = new ImapAdapter({ host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } }, { client: clientOver(s) as never });
  await adapter.connect();
  return adapter;
}

/** The commands as sets of uids: the queue's order follows `updated_at`, which ties on the device store. */
const commands = (s: Server) => s.imap.map((c) => c.replace(/\[([0-9,]+)\]/, (_, l: string) =>
  `[${l.split(",").map(Number).sort((a, b) => a - b).join(",")}]`));

const pass = (w: Awaited<ReturnType<typeof world>>, adapter: ImapAdapter) => reconcileMailbox({
  writeAuthority: FIXTURE_LEASE, repo: w.repo, adapter, accountId: w.accountId, mailboxId: w.mailboxId,
} as never);

const noConnection = () => Object.assign(new Error("Connection not available"), { code: "NoConnection" });

/** The ladder's top rung: the longest a failed filing waits before it is tried again. */
const TOP_RUNG_MS = RECONCILE_BACKOFF_MINUTES[RECONCILE_BACKOFF_MINUTES.length - 1]! * 60_000;

describe("six legacy filings: locators under News's old epoch", () => {
  it("the repair re-points them onto the News copies on record, and one pass files them in one UID MOVE", async () => {
    const s = renamedServer();
    const w = await world(6);
    const adapter = await adapterOver(s);
    const out = await legacyNewsRepairPass({
      repo: w.repo, adapter, accountId: w.accountId, mailboxId: w.mailboxId, write: (fn) => w.repo.transaction(fn),
    });
    expect(out.repair?.repointed).toBe(6);
    await pass(w, adapter);

    expect(commands(s)).toEqual(["messageMove [101,102,103,104,105,106] ohmail/News -> ohmail/Receipts"]);
    expect(s.count("ohmail/Receipts")).toBe(6);
    expect((await w.states()).map((r) => [r.status, r.observed, r.cls])).toEqual(Array(6).fill(["reconciled", "ohmail/Receipts", null]));
    expect(await w.locators()).toEqual(Array(6).fill("ohmail/Receipts"));
  });

  it("without the repair, the stale epoch moves each locator onto its live copy, and the next pass files them", async () => {
    const s = renamedServer();
    const w = await world(6);
    const adapter = await adapterOver(s);
    await pass(w, adapter);
    await pass(w, adapter);

    expect(commands(s)).toEqual(["messageMove [101,102,103,104,105,106] ohmail/News -> ohmail/Receipts"]);
    expect((await w.states()).every((r) => r.status === "reconciled" && r.observed === "ohmail/Receipts")).toBe(true);
    // No letter lost on the way, and nothing expunged.
    expect(s.count("ohmail/News") + s.count("ohmail/Receipts")).toBe(6);
  });

  it("with no copy on record the stale epoch is never silent: an audit row and a deferral that is not a refusal, on the ladder", async () => {
    const s = renamedServer();
    const w = await world(1, { newsCopy: false });
    const adapter = await adapterOver(s);
    await pass(w, adapter);

    const [row] = await w.states();
    expect(row).toMatchObject({ status: "pending", attempts: 2, cls: "stale_locator" });
    expect(row!.next!.getTime()).toBeGreaterThan(Date.now());
    expect((await w.audits()).map((a) => [a.action, (a.payload as { errorClass?: string }).errorClass]))
      .toEqual([["reconcile.move.failed", "stale_locator"]]);

    // Long past the climb it keeps the top rung: listed, and due again when that wait ends.
    await w.db.update(folderState).set({ attempts: 12, nextAttemptAt: null }).where(eq(folderState.messageId, w.ids[0]!));
    await pass(w, adapter);
    const [later] = await w.states();
    expect(later).toMatchObject({ status: "pending", attempts: 13, cls: "stale_locator" });
    expect(later!.next!.getTime()).toBeLessThanOrEqual(Date.now() + TOP_RUNG_MS);
    expect((await w.audits()).map((a) => a.action)).toEqual(["reconcile.move.failed", "reconcile.move.failed"]);
    expect(await w.repo.listPendingFolderStates(w.mailboxId)).toEqual([]);
    vi.useFakeTimers({ toFake: ["Date"], now: later!.next! });
    try {
      expect(await w.repo.listPendingFolderStates(w.mailboxId)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
    expect(s.imap).toEqual([]);
  });
});

describe("honest classes on the filing path", () => {
  it("a dropped connection leaves the row due with no class, no attempt and no audit row", async () => {
    const s = renamedServer();
    const w = await world(2, { observed: "ohmail/News", attempts: 0, errorClass: null });
    for (const [i, id] of w.ids.entries()) {
      await w.db.update(messages).set({ nativeLocator: { folder: "ohmail/News", ref: `4:${101 + i}` } }).where(eq(messages.id, id));
    }
    const adapter = await adapterOver(s);
    s.lockFault = noConnection;
    await pass(w, adapter);

    expect((await w.states()).map((r) => [r.attempts, r.cls, r.next])).toEqual([[0, null, null], [0, null, null]]);
    expect(await w.audits()).toEqual([]);
  });

  it("a refused batched UID MOVE is a refusal per letter, never a move", async () => {
    const s = renamedServer();
    s.moveAnswer = "false";
    const w = await world(2, { observed: "ohmail/News", attempts: 0, errorClass: null });
    await w.db.delete(messageInstances).where(and(eq(messageInstances.mailboxId, w.mailboxId), eq(messageInstances.folder, "ohmail/Reads")));
    for (const [i, id] of w.ids.entries()) {
      await w.db.update(messages).set({ nativeLocator: { folder: "ohmail/News", ref: `4:${101 + i}` } }).where(eq(messages.id, id));
      await w.db.update(messageInstances).set({ isPrimary: true }).where(eq(messageInstances.messageId, id));
    }
    const adapter = await adapterOver(s);
    await pass(w, adapter);

    expect(commands(s)).toEqual(["messageMove [101,102] ohmail/News -> ohmail/Receipts"]);
    expect(s.count("ohmail/News")).toBe(6);
    expect((await w.states()).map((r) => [r.status, r.attempts, r.cls])).toEqual([["pending", 1, "refused"], ["pending", 1, "refused"]]);
    expect((await w.audits()).map((a) => a.action)).toEqual(["reconcile.move.failed", "reconcile.move.failed"]);
  });

  it("a refusal long past the ladder stays refused on the top rung, and the person's next move and delete reach the server", async () => {
    // The server keeps refusing Receipts; the person then files one letter to the Inbox and deletes the other.
    const s = renamedServer();
    s.folder("Trash", 5n);
    s.refuseInto.add("ohmail/Receipts");
    const w = await world(2, { observed: "ohmail/News", attempts: 12, errorClass: "refused" });
    await w.db.delete(messageInstances).where(and(eq(messageInstances.mailboxId, w.mailboxId), eq(messageInstances.folder, "ohmail/Reads")));
    for (const [i, id] of w.ids.entries()) {
      await w.db.update(messages).set({ nativeLocator: { folder: "ohmail/News", ref: `4:${101 + i}` } }).where(eq(messages.id, id));
      await w.db.update(messageInstances).set({ isPrimary: true }).where(eq(messageInstances.messageId, id));
    }
    await w.db.update(mailboxes).set({ ...ORGANIZER_CONSENT, trashFolder: "Trash" }).where(eq(mailboxes.id, w.mailboxId));
    const adapter = await adapterOver(s);
    await pass(w, adapter);
    const refused = await w.states();
    const rungEnds = Date.now() + TOP_RUNG_MS;

    const ctx: ServiceContext = { db: w.db as never, accountId: w.accountId, userId: null, now: () => new Date(), requestId: "refused" };
    expect(await new MessageService().move(ctx, w.ids[0]!, { folder: "INBOX" })).not.toHaveProperty("pending");
    expect(await new MessageService().delete(ctx, w.ids[1]!)).not.toHaveProperty("pending");
    // Sent at once under #206's fresh intent (mail 0163), else when the rung ends; never later.
    await pass(w, adapter);
    vi.useFakeTimers({ toFake: ["Date"], now: rungEnds + 60_000 });
    try {
      await pass(w, adapter);
    } finally {
      vi.useRealTimers();
    }
    expect(commands(s).slice(1).sort(), "the person's move and delete never reached the server").toEqual([
      "messageMove [101] ohmail/News -> INBOX", "messageMove [102] ohmail/News -> Trash",
    ]);
    expect([s.count("INBOX"), s.count("Trash")]).toEqual([1, 1]);
    expect((await w.states()).map((r) => r.status)).toEqual(["reconciled", "reconciled"]);
    // The refusal itself stayed listed with its class, on the top rung: retried, never stopped.
    for (const r of refused) {
      expect(r).toMatchObject({ status: "pending", attempts: 13, cls: "refused" });
      expect(r.next!.getTime()).toBeLessThanOrEqual(rungEnds);
    }
    expect((await w.audits()).filter((a) => a.action === "reconcile.move.failed")).toHaveLength(2);
  });
});

/* FOLDER-MISSING-FILINGS: another client deleted ohmail/Receipts under two groups of waiting
   filings (one from the Inbox, one from News). One CREATE per pass, whatever the server answers. */
describe("ohmail's own folder deleted under waiting filings", () => {
  async function gone(refuseCreate: boolean) {
    const s = renamedServer();
    s.folders.delete("ohmail/Receipts");
    s.measuredMissing = true;
    s.refuseCreate = refuseCreate;
    s.put("INBOX", 7, "old-news-1@example.com");
    const w = await world(2, { observed: "ohmail/News", attempts: 0, errorClass: null });
    await w.db.delete(messageInstances).where(and(eq(messageInstances.mailboxId, w.mailboxId), eq(messageInstances.folder, "ohmail/Reads")));
    const at = [{ folder: "INBOX", ref: "1:7" }, { folder: "ohmail/News", ref: "4:102" }];
    for (const [i, id] of w.ids.entries()) {
      await w.db.update(messages).set({ nativeLocator: at[i]! }).where(eq(messages.id, id));
      await w.db.update(messageInstances).set({ isPrimary: true }).where(eq(messageInstances.messageId, id));
    }
    const adapter = await adapterOver(s);
    await pass(w, adapter);
    return { s, w };
  }

  it("a CREATE the server refuses is asked once across both groups, and every row reads `no_such_folder`", async () => {
    const { s, w } = await gone(true);
    expect(commands(s).filter((c) => c.startsWith("mailboxCreate"))).toEqual(["mailboxCreate ohmail/Receipts"]);
    expect(commands(s).some((c) => c.startsWith("messageMove")), "a move into a folder that is not there").toBe(false);
    expect((await w.states()).map((r) => [r.status, r.attempts, r.cls]))
      .toEqual([["pending", 1, "no_such_folder"], ["pending", 1, "no_such_folder"]]);
    expect((await w.audits()).map((a) => a.action).sort()).toEqual(["reconcile.move.failed", "reconcile.move.failed"]);
  });

  it("a CREATE the server takes: one CREATE, one audit row, and both groups filed", async () => {
    const { s, w } = await gone(false);
    expect(commands(s).filter((c) => c.startsWith("mailboxCreate"))).toEqual(["mailboxCreate ohmail/Receipts"]);
    expect(s.count("ohmail/Receipts")).toBe(2);
    expect((await w.states()).map((r) => r.status)).toEqual(["reconciled", "reconciled"]);
    expect((await w.audits()).filter((a) => a.action === "reconcile.folder.remade").map((a) => a.payload))
      .toEqual([{ mailboxId: w.mailboxId, folder: "ohmail/Receipts" }]);
  });
});

