import { accountOfMailbox } from "@trafficflow/db";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImapAdapter, ImapBoundExceeded, type FolderStatusAnswer } from "@trafficflow/core/adapters/imap";
import { mailboxCredentials, mailboxFolders, mailboxes, messageInstances, messages } from "@trafficflow/db";
import { acquireImapSlot, releaseImapSlot } from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import { createApp, apiRoutes } from "@trafficflow/api";
import {
  SELF_CHECK_FOLDERS_MAX, SELF_CHECK_FOLDER_CLASSES, SELF_CHECK_UNREADABLE, readSelfCheck,
} from "@trafficflow/core/diagnostics";
import {
  MAILBOX_CHECK_BUDGET_MS, MAILBOX_CHECK_FOLDER_DEADLINE_MS, MAILBOX_CHECK_FOLDERS_MAX, MAILBOX_CHECK_FOLDER_CLASSES,
  MAILBOX_CHECK_UNREADABLE, compareFolder,
  dialClass, selfCheckMailbox, worstOf, type MirrorFolder,
} from "../src/mailbox-self-check.js";
import { IMAP_DOOR_DEADLINE_MS } from "../src/imap-door.js";
import type { ApiDeps } from "../src/deps.js";
import { FIXED_NOW, makeDeps, req, seedSession } from "./helpers.js";
import { localRoutes } from "../src/routes/local.js";
import { selfHostRoutes } from "../src/routes/self-host.js";
import { matchRoute } from "../src/router.js";

/**
 * THE MAILBOX SELF-CHECK, the engine half: the comparison as a table, the verdict's order, and the
 * read over a real store with the adapter's one read spied — the budget threaded through the dial
 * and every folder, a hung folder and the folders after it, a failed dial, and the route's door.
 * The same read against real servers is in the `.greenmail` and `.dovecot` twins.
 */

const mirror = (epoch: string | null, counts: Record<string, number>, folder = "INBOX"): MirrorFolder =>
  ({ folder, epoch, counts: new Map(Object.entries(counts)) });
const status = (messages: number, uidValidity: string): FolderStatusAnswer =>
  ({ k: "status", messages, uidValidity, uidNext: messages + 1 });

describe("compareFolder — the comparison", () => {
  it("counts under the server's epoch decide in-step and both directions of difference", () => {
    expect(compareFolder(mirror("7", { "7": 3 }), status(3, "7"))).toEqual({ folder: "INBOX", k: "in_step", server: 3, mirror: 3 });
    expect(compareFolder(mirror("7", { "7": 2 }), status(3, "7"))).toMatchObject({ k: "server_more", server: 3, mirror: 2 });
    expect(compareFolder(mirror("7", { "7": 5 }), status(3, "7"))).toMatchObject({ k: "mirror_more", server: 3, mirror: 5 });
  });

  it("a recorded epoch the server contradicts is its own class, whatever the counts say", () => {
    expect(compareFolder(mirror("7", { "7": 3 }), status(3, "8"))).toEqual({ folder: "INBOX", k: "uidvalidity_changed", server: 3, mirror: 3 });
  });

  it("instances under a dead epoch are not counted as the folder's mail", () => {
    expect(compareFolder(mirror("8", { "7": 4, "8": 1 }), status(1, "8"))).toMatchObject({ k: "in_step", mirror: 1 });
  });

  it("a cold cursor (no epoch yet) compares by count, and the server's epoch picks the instances", () => {
    expect(compareFolder(mirror(null, {}), status(4, "9"))).toMatchObject({ k: "server_more", server: 4, mirror: 0 });
    expect(compareFolder(mirror("0", { "9": 4 }), status(4, "9"))).toMatchObject({ k: "in_step" });
  });

  it("a folder the server no longer has: the mirror's copy is `mirror_more`, an empty one in step", () => {
    expect(compareFolder(mirror("7", { "7": 2 }), { k: "absent" })).toMatchObject({ k: "mirror_more", server: 0, mirror: 2 });
    expect(compareFolder(mirror("0", {}), { k: "absent" })).toMatchObject({ k: "in_step", server: 0, mirror: 0 });
  });

  it("every unanswered shape is `unreadable` with its own class", () => {
    expect(compareFolder(mirror("7", {}), { k: "refused" })).toEqual({ folder: "INBOX", k: "unreadable", error: "refused" });
    expect(compareFolder(mirror("7", {}), { k: "short" })).toMatchObject({ error: "short_reply" });
    expect(compareFolder(mirror("7", {}), { k: "dropped" })).toMatchObject({ error: "dropped" });
    expect(compareFolder(mirror("7", {}), { k: "timeout" })).toMatchObject({ error: "timeout" });
    expect(compareFolder(mirror("7", {}), status(2, "0"))).toMatchObject({ error: "short_reply" });
  });
});

describe("worstOf and dialClass", () => {
  it("the verdict is the worst folder in the declared order, `empty` with none", () => {
    const f = (k: string) => ({ folder: k, k, server: 0, mirror: 0 }) as never;
    expect(worstOf([])).toBe("empty");
    expect(worstOf([f("in_step"), f("in_step")])).toBe("in_step");
    expect(worstOf([f("in_step"), f("server_more"), f("in_step")])).toBe("server_more");
    expect(worstOf([f("mirror_more"), f("server_more")])).toBe("mirror_more");
    expect(worstOf([f("server_more"), f("uidvalidity_changed")])).toBe("uidvalidity_changed");
    expect(worstOf([{ folder: "x", k: "unreadable", error: "timeout" }, f("uidvalidity_changed")])).toBe("unreadable");
    expect(MAILBOX_CHECK_FOLDER_CLASSES.at(-1)).toBe("unreadable");
  });

  it("a failed dial names its class and never quotes the server", () => {
    expect(dialClass(Object.assign(new Error("x"), { code: "mailbox_busy" }))).toBe("busy");
    // The shared credential reader's own refusal (`requireImapCredential`); consumer: the `no_login` sentence.
    expect(dialClass(Object.assign(new Error("x"), { code: "mailbox_not_signed_in" }))).toBe("no_login");
    expect(dialClass(Object.assign(new Error("x"), { authenticationFailed: true }))).toBe("auth");
    expect(dialClass(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe("connect");
    expect(dialClass(Object.assign(new Error("x"), { code: "CERT_HAS_EXPIRED" }))).toBe("tls");
    expect(dialClass(new Error("something else"))).toBe("unknown");
  });

  it("the whole-read budget is the one every API-side dial runs under", () => {
    expect(MAILBOX_CHECK_BUDGET_MS).toBe(IMAP_DOOR_DEADLINE_MS);
    // One folder that never answers costs a quarter of the read, never the whole of it.
    expect(MAILBOX_CHECK_FOLDER_DEADLINE_MS * 4).toBeLessThanOrEqual(MAILBOX_CHECK_BUDGET_MS);
  });
});

interface World { deps: ApiDeps; db: Awaited<ReturnType<typeof makeTestDb>>; accountId: string; mailboxId: string }

async function world(folders: Array<{ folder: string; epoch: bigint | null; held: number }>): Promise<World> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `rc-${randomUUID().slice(0, 8)}@example.invalid`,
  }).returning({ id: mailboxes.id });
  await db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: accountOfMailbox(mb!.id), transport: "imap", secretEnc: "enc", keyVersion: 1,
    meta: { host: "imap.example.invalid", port: 993, secure: true, user: "u" },
  });
  let n = 0;
  for (const f of folders) {
    await db.insert(mailboxFolders).values({ mailboxId: mb!.id, accountId: accountOfMailbox(mb!.id), folder: f.folder, uidvalidity: f.epoch });
    for (let i = 0; i < f.held; i++) {
      const key = `m-${n++}-${randomUUID()}`;
      const [m] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id, messageIdHeader: key, bodyHash: key, dedupKey: key,
        subject: "s", fromAddress: "a@example.invalid", snippet: "",
      }).returning({ id: messages.id });
      await db.insert(messageInstances).values({
        accountId, mailboxId: mb!.id, messageId: m!.id, folder: f.folder, uidvalidity: f.epoch ?? 1n, uid: i + 1,
      });
    }
  }
  const deps = {
    db,
    keyProvider: { decrypt: async () => "not-printed" },
    services: { imapAdmission: { acquire: acquireImapSlot, release: releaseImapSlot } },
    now: () => FIXED_NOW,
  } as unknown as ApiDeps;
  return { deps, db, accountId, mailboxId: mb!.id };
}

const breachAfter = (folder: string, ms: number): Promise<never> => new Promise((_ok, fail) => {
  setTimeout(() => fail(new ImapBoundExceeded("read_deadline", ms, ms, folder)), ms);
});

function stubDial(): { connect: ReturnType<typeof vi.spyOn>; forceClose: ReturnType<typeof vi.spyOn> } {
  const connect = vi.spyOn(ImapAdapter.prototype, "connect").mockResolvedValue(undefined);
  vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);
  const forceClose = vi.spyOn(ImapAdapter.prototype, "forceClose").mockImplementation(() => { /* down */ });
  return { connect, forceClose };
}

beforeEach(() => vi.restoreAllMocks());

describe("selfCheckMailbox — the read, over a real store", () => {
  it("a planted missing letter reads `server_more` for that folder, the rest in step, INBOX first", async () => {
    const w = await world([
      { folder: "Archive", epoch: 7n, held: 2 },
      { folder: "INBOX", epoch: 7n, held: 3 },
    ]);
    stubDial();
    const asked: string[] = [];
    vi.spyOn(ImapAdapter.prototype, "folderStatus").mockImplementation(async (folder) => {
      asked.push(folder);
      return status(3, "7");
    });
    const r = await selfCheckMailbox(w.deps, w.accountId, w.mailboxId);
    expect(asked).toEqual(["INBOX", "Archive"]);
    expect(r.folders).toEqual([
      { folder: "INBOX", k: "in_step", server: 3, mirror: 3 },
      { folder: "Archive", k: "server_more", server: 3, mirror: 2 },
    ]);
    expect(r.verdict).toBe("server_more");
    expect(r.mailboxId).toBe(w.mailboxId);
  });

  it("a mailbox with no folder in the mirror dials nothing and says `empty`", async () => {
    const w = await world([]);
    const { connect } = stubDial();
    const r = await selfCheckMailbox(w.deps, w.accountId, w.mailboxId);
    expect(r).toMatchObject({ verdict: "empty", folders: [] });
    expect(connect).not.toHaveBeenCalled();
  });

  it("another account's instances are never counted", async () => {
    const w = await world([{ folder: "INBOX", epoch: 7n, held: 1 }]);
    stubDial();
    vi.spyOn(ImapAdapter.prototype, "folderStatus").mockResolvedValue(status(1, "7"));
    const r = await selfCheckMailbox(w.deps, randomUUID(), w.mailboxId);
    expect(r.folders[0]).toMatchObject({ k: "server_more", mirror: 0 });
  });

  it("THE BUDGET: a hung folder reads `timeout` inside its own deadline, and the budget ends the read", async () => {
    const w = await world([
      { folder: "INBOX", epoch: 7n, held: 1 },
      { folder: "A", epoch: 7n, held: 0 },
      { folder: "B", epoch: 7n, held: 0 },
    ]);
    stubDial();
    const deadlines: number[] = [];
    vi.spyOn(ImapAdapter.prototype, "folderStatus").mockImplementation(async (folder, deadlineMs) => {
      deadlines.push(deadlineMs);
      if (folder === "A") return breachAfter(folder, deadlineMs);
      return status(folder === "INBOX" ? 1 : 0, "7");
    });
    const started = Date.now();
    const r = await selfCheckMailbox(w.deps, w.accountId, w.mailboxId, { budgetMs: 700, folderMs: 10_000 });
    const elapsed = Date.now() - started;
    expect(r.folders.map((f) => (f.k === "unreadable" ? f.error : f.k))).toEqual(["in_step", "timeout", "budget"]);
    expect(r.verdict).toBe("unreadable");
    // Each folder's clock is what is LEFT of the read, never its own ceiling alone.
    expect(Math.max(...deadlines)).toBeLessThanOrEqual(700);
    expect(elapsed).toBeLessThan(700 + 300);
  });

  it("…and a slow server spends the budget folder by folder: the tail reads `budget`, unasked", async () => {
    const w = await world(Array.from({ length: 12 }, (_, i) => ({ folder: `F${String(i).padStart(2, "0")}`, epoch: 7n, held: 0 })));
    stubDial();
    let asked = 0;
    vi.spyOn(ImapAdapter.prototype, "folderStatus").mockImplementation(async () => {
      asked += 1;
      await new Promise((ok) => setTimeout(ok, 100));
      return status(0, "7");
    });
    const started = Date.now();
    const r = await selfCheckMailbox(w.deps, w.accountId, w.mailboxId, { budgetMs: 600, folderMs: 5_000 });
    expect(Date.now() - started).toBeLessThan(600 + 250);
    const budget = r.folders.filter((f) => f.k === "unreadable" && f.error === "budget").length;
    expect(asked).toBeLessThan(12);
    expect(budget).toBe(12 - asked);
    expect(r.folders.filter((f) => f.k === "in_step")).toHaveLength(asked);
  });

  it("a dial that never comes up is bounded by the same budget, every folder naming it", async () => {
    const w = await world([{ folder: "INBOX", epoch: 7n, held: 0 }, { folder: "A", epoch: 7n, held: 0 }]);
    vi.spyOn(ImapAdapter.prototype, "connect").mockImplementation(() => new Promise<void>(() => { /* never */ }));
    vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);
    vi.spyOn(ImapAdapter.prototype, "forceClose").mockImplementation(() => { /* down */ });
    const started = Date.now();
    const r = await selfCheckMailbox(w.deps, w.accountId, w.mailboxId, { budgetMs: 300 });
    expect(Date.now() - started).toBeLessThan(300 + 250);
    expect(r.folders).toEqual([
      { folder: "INBOX", k: "unreadable", error: "timeout" },
      { folder: "A", k: "unreadable", error: "timeout" },
    ]);
  });

  it("a refused sign-in reads `auth` on every folder", async () => {
    const w = await world([{ folder: "INBOX", epoch: 7n, held: 0 }]);
    vi.spyOn(ImapAdapter.prototype, "connect").mockRejectedValue(Object.assign(new Error("no"), { authenticationFailed: true }));
    vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);
    const r = await selfCheckMailbox(w.deps, w.accountId, w.mailboxId);
    expect(r.folders).toEqual([{ folder: "INBOX", k: "unreadable", error: "auth" }]);
  });
});

describe("the surfaces read what the engine writes", () => {
  it("the diagnostic leaf's closed sets are the engine's, member for member and in order", () => {
    expect([...SELF_CHECK_FOLDER_CLASSES]).toEqual([...MAILBOX_CHECK_FOLDER_CLASSES]);
    expect([...SELF_CHECK_UNREADABLE]).toEqual([...MAILBOX_CHECK_UNREADABLE]);
    expect(SELF_CHECK_FOLDERS_MAX).toBe(MAILBOX_CHECK_FOLDERS_MAX);
  });

  it("a reading survives the wire whole, the verdict re-derived to the engine's own", async () => {
    const w = await world([{ folder: "INBOX", epoch: 7n, held: 1 }, { folder: "A", epoch: 7n, held: 2 }, { folder: "B", epoch: 7n, held: 0 }]);
    stubDial();
    vi.spyOn(ImapAdapter.prototype, "folderStatus").mockImplementation(async (folder) =>
      (folder === "B" ? { k: "refused" } : status(1, folder === "A" ? "8" : "7")));
    const r = await selfCheckMailbox(w.deps, w.accountId, w.mailboxId);
    expect(readSelfCheck(JSON.parse(JSON.stringify(r)))).toEqual({
      mailboxId: r.mailboxId, checkedAt: r.checkedAt, elapsedMs: r.elapsedMs, verdict: r.verdict, folders: r.folders,
    });
    expect(r.folders.map((f) => f.k)).toEqual(["in_step", "uidvalidity_changed", "unreadable"]);
  });
});

describe("GET /mailboxes/:id/self-check — the door", () => {
  const app = createApp(apiRoutes);

  it("is served by the desktop's and the phone's engine, the hosted table and a self-hosted server", () => {
    for (const [name, table] of [["local", localRoutes], ["hosted", apiRoutes], ["self-host", selfHostRoutes]] as const) {
      const m = matchRoute(table, "GET", "/mailboxes/3f1c2b9a/self-check");
      expect(m.matched, `${name} does not serve the self-check`).toBe(true);
      expect(m.matched && m.route.cost).toBe("connection");
    }
  });

  it("answers the reading for the caller's mailbox and 404 for anybody else's, before any dial", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const other = await seedSession(db, { now: FIXED_NOW });
    const [mb] = await db.insert(mailboxes).values({ accountId: s.accountId, provider: "imap", address: "rc@example.invalid" }).returning();
    await db.insert(mailboxCredentials).values({
      mailboxId: mb!.id, accountId: accountOfMailbox(mb!.id), transport: "imap", secretEnc: "enc", keyVersion: 1,
      meta: { host: "imap.example.invalid", port: 993, secure: true, user: "u" },
    });
    await db.insert(mailboxFolders).values({ mailboxId: mb!.id, accountId: accountOfMailbox(mb!.id), folder: "INBOX", uidvalidity: 7n });
    const d = { ...deps, keyProvider: { decrypt: async () => "not-printed" } } as unknown as ApiDeps;
    const peek = vi.spyOn(ImapAdapter.prototype, "folderStatus").mockResolvedValue(status(0, "7"));
    const H = (r: Request) => app.handle(r, { ...d, session: null, idempotency: null });

    const res = await H(req("GET", `/mailboxes/${mb!.id}/self-check`, { bearer: s.token }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mailboxId: mb!.id, verdict: "in_step", folders: [{ folder: "INBOX", k: "in_step" }] });
    expect(peek).toHaveBeenCalledTimes(1);

    const foreign = await H(req("GET", `/mailboxes/${mb!.id}/self-check`, { bearer: other.token }));
    expect(foreign.status).toBe(404);
    expect(peek).toHaveBeenCalledTimes(1);
  });
});
