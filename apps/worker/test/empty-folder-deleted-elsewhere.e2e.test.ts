import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import {
  accountSettings, accounts, changeLog, folderOps, mailboxFolders, mailboxes, messages, type Tx,
} from "@trafficflow/db";
import { makeTestDb, serviceUp } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import type { ImapConfig } from "@trafficflow/core/adapters/imap-types";
import { SyncService, type ServiceContext } from "@trafficflow/services";
import { OhmailEngine, type EngineAdapter, type SyncSnapshotPage } from "@ohmail/client-engine";
import { runSyncCycle } from "../src/sync.js";
import { FIXTURE_DOOR, FIXTURE_LEASE } from "./_door.js";
import { greenmailPorts } from "./_greenmail-ports.js";

/**
 * A FOLDER DELETED ON THE SERVER LEAVES EVERY FOLDER LIST WITHIN ONE SYNC, EMPTY OR NOT.
 *
 * Folders deleted elsewhere stayed listed for days: only a folder with remembered letters was
 * asked about, and no answer retired the row the list is read from. The real adapter over
 * GreenMail and Dovecot, the worker's cycle, the client engine over the snapshot and delta.
 * Controls: an omitted folder STATUS finds, a failed LIST, an unanswered STATUS, a user's
 * command — each keeps the folder; a folder made elsewhere joins.
 */

type Role = "organizer" | "reader";
type Server = "greenmail" | "dovecot";

function configFor(server: Server): ImapConfig {
  const user = `t-${randomUUID()}@trafficflow.test`;
  if (server === "dovecot") {
    return {
      host: process.env.IMAP_CONDSTORE_HOST ?? process.env.IMAP_HOST ?? "127.0.0.1",
      port: Number(process.env.IMAP_CONDSTORE_PORT ?? 3144), secure: false,
      auth: { user, pass: process.env.IMAP_CONDSTORE_PASS ?? "testpass-password" },
    };
  }
  const p = greenmailPorts();
  return { host: p.imapHost, port: p.imapPort, secure: false, auth: { user, pass: "test" } };
}

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const c of closers.splice(0)) await c().catch(() => undefined); });

/** How the next launch's client is bent, for the controls. Absent: the adapter dials itself. */
interface Bend { omitFromList?: string; statusHangs?: true; listFails?: true }

/** The fixture's own folder names: one left empty, one holding a letter, one that stays. */
const EMPTY = "Clients";
const FILED = "Projects";
const KEPT = "Archive2026";

async function world(server: Server, role: Role) {
  const cfg = configFor(server);
  const me = cfg.auth.user;
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: false, auth: cfg.auth, logger: false });
  await c.connect();
  for (const p of ["Sent", "Trash", EMPTY, FILED, KEPT]) await c.mailboxCreate(p).catch(() => undefined);
  await c.append(FILED, [
    "Message-ID: <filed-r34@x>", "From: anna@x.example", `To: ${me}`, "Subject: filed away",
    "Date: Sun, 11 Oct 2026 04:30:00 +0000", "Content-Type: text/plain; charset=utf-8", "", "the letter",
  ].join("\r\n"));
  // Logged out before anything is deleted: GreenMail ends a session whose folder another one deletes.
  await c.logout();

  const db = (await makeTestDb()) as unknown as Tx;
  const [a] = await db.insert(accounts).values({ name: `empty-folder-deleted-elsewhere-${role}` }).returning();
  const accountId = a!.id;
  await db.insert(accountSettings).values({ accountId, foldersEnabledAt: new Date() });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: me }).returning();
  const mailboxId = mb!.id;
  const repo = makeDrizzleRepo(db);

  let now = Date.now();
  const statusAsked: string[] = [];
  let listsFailed = 0;
  async function launch(bend: Bend = {}): Promise<ImapAdapter> {
    let adapter: ImapAdapter;
    if (Object.keys(bend).length === 0) {
      adapter = new ImapAdapter(cfg);
    } else {
      const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: false, auth: cfg.auth, logger: false });
      await client.connect();
      const list = client.list.bind(client);
      client.list = (async (o?: Parameters<ImapFlow["list"]>[0]) => {
        // The pass's inventory refresh is the LIST that carries a STATUS query.
        if (bend.listFails && o?.statusQuery) { listsFailed++; throw new Error("LIST failed: the command was dropped"); }
        return (await list(o)).filter((f) => f.path !== bend.omitFromList);
      }) as ImapFlow["list"];
      const status = client.status.bind(client);
      client.status = (async (path: string, q: Parameters<ImapFlow["status"]>[1]) => {
        statusAsked.push(path);
        if (bend.statusHangs) { now += 10 * 60_000; return new Promise(() => undefined); }
        return status(path, q);
      }) as ImapFlow["status"];
      adapter = new ImapAdapter(cfg, { client, nowMs: () => now });
    }
    await adapter.connect();
    closers.push(() => adapter.close());
    if (role === "organizer") await adapter.ensureFolders(FIXTURE_DOOR);
    return adapter;
  }
  async function drain(adapter: ImapAdapter): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const out = await runSyncCycle({
        repo, adapter, accountId, mailboxId, role,
        writeAuthority: role === "reader" ? { noLease: "reader" as const } : FIXTURE_LEASE,
        storageCap: UNMETERED_STORAGE_CAP, trustedAuthservIds: new Set<string>(),
      });
      if (!out.hasBacklog && !out.owesFiling) return;
    }
    throw new Error("the drain did not settle in ten cycles");
  }
  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => new Date(), requestId: "r34" };
  /* The client engine over the hosted snapshot and delta, as the web and the paired phone are
     served: bootstrapped once by snapshot, then fed deltas — a folder that leaves must leave
     through the delta, because nothing re-snapshots a settled client. */
  const sync = new SyncService();
  const engine = new OhmailEngine({
    adapter: {
      sync: async (p: { since: string; limit?: number }) => sync.getChanges(ctx, {
        ...(p.since !== "0" ? { since: p.since } : {}), ...(p.limit !== undefined ? { limit: p.limit } : {}),
      }),
      snapshot: async (p: { cursor?: string; limit?: number; phase?: "tail" }) =>
        (await sync.getSnapshot(ctx, p)) as unknown as SyncSnapshotPage,
      mutate: async () => { throw new Error("no mutations in this rig"); },
      fetchBody: async () => null,
    } as unknown as EngineAdapter,
  });
  let started = false;
  const pull = async (): Promise<void> => {
    if (!started) { started = true; await engine.start(); return; }
    await engine.syncOnce();
  };
  /** The folder list a client draws: the engine's folder entities, by path. */
  const listedInMirror = () => engine.read().list<{ name: string }>("folder").map((f) => f.name).sort();
  /** The rows the folder list is read from. */
  const rows = async () => (await db.select({ folder: mailboxFolders.folder }).from(mailboxFolders)
    .where(eq(mailboxFolders.mailboxId, mailboxId))).map((r) => r.folder).sort();
  const rowId = async (folder: string) => (await db.select({ id: mailboxFolders.id }).from(mailboxFolders)
    .where(and(eq(mailboxFolders.mailboxId, mailboxId), eq(mailboxFolders.folder, folder))))[0]?.id ?? null;
  const folderDeletes = async () => (await db.select({ id: changeLog.entityId, op: changeLog.op, type: changeLog.entityType })
    .from(changeLog).where(eq(changeLog.accountId, accountId)))
    .filter((r) => r.type === "folder" && r.op === "delete").map((r) => r.id).sort();
  const liveLetter = async () => (await db.select({ deletedAt: messages.deletedAt }).from(messages)
    .where(and(eq(messages.mailboxId, mailboxId), eq(messages.messageIdHeader, "filed-r34@x"))))[0]?.deletedAt === null;
  /** First launch, drained twice, pulled into the mirror, closed: the state before the other app acts. */
  async function settled(): Promise<void> {
    const first = await launch();
    await drain(first);
    await drain(first);
    await pull();
    await first.close();
    expect(listedInMirror(), "the precondition: the client lists all three folders").toEqual(
      expect.arrayContaining([EMPTY, FILED, KEPT]),
    );
  }
  async function elsewhere(act: (other: ImapFlow) => Promise<unknown>): Promise<void> {
    const other = new ImapFlow({ host: cfg.host, port: cfg.port, secure: false, auth: cfg.auth, logger: false });
    await other.connect();
    try { await act(other); } finally { await other.logout().catch(() => undefined); }
  }
  /** The server's own LIST, on a connection of its own: GreenMail ends a session whose folder went. */
  async function serverHas(path: string): Promise<boolean> {
    let has = false;
    await elsewhere(async (o) => { has = (await o.list()).some((f) => f.path === path); });
    return has;
  }
  return {
    db, accountId, mailboxId, launch, drain, pull, listedInMirror, rows, rowId, folderDeletes, liveLetter,
    settled, elsewhere, serverHas, statusAsked, engine, listsFailed: () => listsFailed,
  };
}

const absent: Record<Server, string> = { greenmail: "", dovecot: "" };
const at = (server: Server): string => `${configFor(server).host}:${configFor(server).port}`;
for (const [server, s] of [["greenmail", serviceUp("greenmail", at("greenmail"))], ["dovecot", serviceUp("dovecot", at("dovecot"))]] as const) {
  if (!s.up) absent[server] = ` (SKIPPED: ${s.why})`;
}

describe("a folder deleted on the mail server leaves every folder list within one sync", () => {
  for (const server of ["greenmail", "dovecot"] as const) for (const role of ["reader", "organizer"] as const) {
    const skip = absent[server] !== "";
    const at = `${server}, ${role}`;

    it.skipIf(skip)(`${at}: an empty folder and a filed one leave the rows, the delta and the client${absent[server]}`, async () => {
      const w = await world(server, role);
      await w.settled();
      // Measured 2026-10-13, as on 2026-09-27: GreenMail ends the session that deletes a folder
      // the app read letters from, and keeps it. An EMPTY folder it deletes, which is the
      // finding's shape; the filed folder's delete is modelled on Dovecot.
      const doomed = server === "greenmail" ? [EMPTY] : [EMPTY, FILED];
      const ids = await Promise.all(doomed.map(async (f) => (await w.rowId(f))!));
      await w.elsewhere(async (o) => { for (const f of doomed) await o.mailboxDelete(f); });
      // The case is about what the APP does with a folder the server no longer has, so the
      // server's own LIST is the precondition.
      for (const f of doomed) expect(await w.serverHas(f), `the precondition: the server deleted ${f}`).toBe(false);

      const second = await w.launch();
      await w.drain(second);
      await w.pull();
      for (const f of doomed) {
        expect(await w.rows(), `${f} kept its row though the server does not have it`).not.toContain(f);
        expect(w.listedInMirror(), `the client still lists ${f}`).not.toContain(f);
      }
      expect(await w.folderDeletes(), "no folder delete reached the delta").toEqual([...ids].sort());
      expect(await w.rows(), "a folder still on the server lost its row").toContain(KEPT);
      expect(w.listedInMirror(), "a folder still on the server left the client").toContain(KEPT);
      expect(await w.liveLetter(), "the letter's liveness does not follow its folder").toBe(server === "greenmail");
    }, 120_000);

    it.skipIf(skip)(`${at}: a LIST that omits a folder STATUS still finds keeps it listed${absent[server]}`, async () => {
      const w = await world(server, role);
      await w.settled();
      const second = await w.launch({ omitFromList: EMPTY });
      await w.drain(second);
      await w.pull();
      expect(w.statusAsked).toContain(EMPTY);
      expect(await w.rows(), "a folder the server still holds lost its row").toContain(EMPTY);
      expect(await w.folderDeletes()).toEqual([]);
      expect(w.listedInMirror()).toContain(EMPTY);
    }, 120_000);

    // GreenMail advertises no LIST-STATUS (measured 2026-10-13), so its pass issues no LIST to fail.
    const noRefresh = server === "greenmail" ? " (SKIPPED: GreenMail's pass issues no LIST to fail)" : "";
    it.skipIf(skip || noRefresh !== "")(`${at}: a LIST that errors retires nothing${absent[server] || noRefresh}`, async () => {
      const w = await world(server, role);
      await w.settled();
      await w.elsewhere((o) => o.mailboxDelete(EMPTY));
      expect(await w.serverHas(EMPTY), "the precondition: the server deleted the folder").toBe(false);
      const second = await w.launch({ listFails: true });
      await w.drain(second);
      await w.pull();
      expect(w.listsFailed(), "the precondition: the pass's LIST failed").toBeGreaterThan(0);
      expect(w.statusAsked, "a pass whose LIST failed asked about an absence").toEqual([]);
      expect(await w.rows(), "a failed LIST retired a folder").toContain(EMPTY);
      expect(await w.folderDeletes()).toEqual([]);
      expect(w.listedInMirror()).toContain(EMPTY);
    }, 120_000);

    it.skipIf(skip)(`${at}: a folder made elsewhere reaches the client, and comes back when made again${absent[server]}`, async () => {
      const w = await world(server, role);
      await w.settled();
      await w.elsewhere((o) => o.mailboxCreate("Fresh"));
      const second = await w.launch();
      await w.drain(second);
      await w.pull();
      expect(w.listedInMirror(), "a folder made on the server after the client settled never reached it").toContain("Fresh");
      await second.close();

      await w.elsewhere((o) => o.mailboxDelete(EMPTY));
      const third = await w.launch();
      await w.drain(third);
      await w.pull();
      expect(w.listedInMirror()).not.toContain(EMPTY);
      await third.close();

      await w.elsewhere((o) => o.mailboxCreate(EMPTY));
      const fourth = await w.launch();
      await w.drain(fourth);
      await w.pull();
      expect(w.listedInMirror(), "a folder made again after it left stayed out of the client").toContain(EMPTY);
      expect(await w.rows()).toContain(EMPTY);
    }, 120_000);

    it.skipIf(skip)(`${at}: a STATUS that never answers retires nothing${absent[server]}`, async () => {
      const w = await world(server, role);
      await w.settled();
      await w.elsewhere((o) => o.mailboxDelete(EMPTY));
      expect(await w.serverHas(EMPTY), "the precondition: the server deleted the folder").toBe(false);
      const second = await w.launch({ statusHangs: true });
      await expect(w.drain(second)).rejects.toThrow(/cycle_deadline/);
      await w.pull();
      expect(await w.rows(), "an unanswered STATUS retired the folder").toContain(EMPTY);
      expect(await w.folderDeletes()).toEqual([]);
      expect(w.listedInMirror()).toContain(EMPTY);
    }, 120_000);

    it.skipIf(skip)(`${at}: a folder carrying a user's command keeps its row${absent[server]}`, async () => {
      const w = await world(server, role);
      await w.settled();
      const emptyId = (await w.rowId(EMPTY))!;
      // A rename the user pressed, not yet executed: the command owns the row, and retiring it
      // would cascade the command away with it.
      await w.db.insert(folderOps).values({
        accountId: w.accountId, mailboxId: w.mailboxId, folderId: emptyId, op: "rename", toFolder: "Clients2",
        status: "failed", error: "gone",
      });
      await w.elsewhere((o) => o.mailboxDelete(EMPTY));
      expect(await w.serverHas(EMPTY), "the precondition: the server deleted the folder").toBe(false);
      const second = await w.launch();
      await w.drain(second);
      expect(await w.rows(), "a folder with a command in flight was retired under it").toContain(EMPTY);
      expect(await w.folderDeletes()).toEqual([]);
    }, 120_000);
  }
});
