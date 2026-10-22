import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials, mailboxFolders, messageFailures, messageInstances, messages } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { pgTestUrl, realPgAvailable } from "@trafficflow/db/testing";
import { StaticKeyProvider, createLogger } from "@trafficflow/core/mail";
import { ImapAdapter, type MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { startWorker } from "../src/index.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";

/**
 * A BATCH-TOTAL OVERRUN KEEPS WHAT ARRIVED, ON THE HOSTED WORKER. Twelve messages each declare
 * 10 bytes and stream 300 KB: every one is inside its own 1 MiB floor, four together cross the
 * batch total. That breach named no message, so nothing was kept or set aside and every
 * attachment breached on the same four bodies until the mailbox was quarantined. Now each pass
 * keeps what arrived, and a breach after stored mail is progress. The real ImapAdapter over a
 * scripted server streaming ascending, through the worker's own loop and its `buildCursor`.
 */
const URL = pgTestUrl(import.meta.url);
const AVAILABLE = await realPgAvailable(URL);
const WATCHED = ["INBOX", "ohmail/Screener", "ohmail/News", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine"];
const cfg = { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } };
const eml = (id: string): Buffer => Buffer.from([
  "From: Anna <anna@sender.test>", "To: owner@trafficflow.test", `Subject: ${id}`,
  "Date: Wed, 30 Sep 2026 12:00:00 +0000", `Message-ID: <${id}@lane.test>`, "", `Body of ${id}.`, "",
].join("\r\n"));
type Msg = { id: string; raw: Buffer; declared: number };
const ordinary = (id: string): Msg => ({ id, raw: eml(id), declared: eml(id).length });
const rider = (id: string): Msg => ({ id, raw: Buffer.concat([eml(id), Buffer.alloc(300_000, 0x61)]), declared: 10 });
type Folder = { uidValidity: bigint; msgs: Map<number, Msg> };

/** The scripted server: each folder its own epoch; `bodies` counts every body fetch by message id. */
function server(folders: Map<string, Folder>) {
  const state = { bodies: {} as Record<string, number>, folders };
  const client = () => {
    let path = "INBOX";
    const here = () => folders.get(path)?.msgs ?? new Map<number, Msg>();
    const parseSet = (range: unknown): number[] => {
      const all = [...here().keys()].sort((a, b) => a - b);
      if (Array.isArray(range)) return range.map(Number).filter((u) => here().has(u)).sort((a, b) => a - b);
      if (typeof range !== "string") return all;
      const out = new Set<number>();
      for (const part of range.split(",")) {
        const [lo, hi] = part.split(":");
        const a = lo === "*" ? Number.MAX_SAFE_INTEGER : Number(lo);
        const b = hi === undefined ? a : hi === "*" ? Number.MAX_SAFE_INTEGER : Number(hi);
        for (const u of all) if (u >= Math.min(a, b) && u <= Math.max(a, b)) out.add(u);
      }
      return [...out].sort((x, y) => x - y);
    };
    const c = {
      usable: true,
      capabilities: new Map<string, boolean>([["MOVE", true], ["UIDPLUS", true]]),
      mailbox: undefined as unknown,
      async list() {
        return [...new Set([...WATCHED, ...folders.keys()])].map((p) => ({ path: p, name: p.split("/").pop()!, delimiter: "/", flags: new Set<string>() }));
      },
      async mailboxCreate(p: string) { return { path: p }; },
      async getMailboxLock(p: string) {
        path = p;
        const keys = [...here().keys()];
        c.mailbox = { path: p, uidValidity: folders.get(p)?.uidValidity ?? 7n, uidNext: Math.max(0, ...keys) + 1, highestModseq: 0n, exists: keys.length };
        return { path: p, release() { /* nothing */ } };
      },
      async search() { return []; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async *fetch(range: any, query: any) {
        for (const uid of parseSet(range)) {
          const m = here().get(uid)!;
          if (query?.source) {
            state.bodies[m.id] = (state.bodies[m.id] ?? 0) + 1;
            yield { uid, flags: new Set<string>(), envelope: { messageId: `<${m.id}@lane.test>` }, source: m.raw, internalDate: new Date(Date.UTC(2026, 8, 30) + uid * 1000) };
          } else if (query?.size) yield { uid, size: m.declared };
          else if (query?.headers) yield { uid, headers: Buffer.from(`Message-ID: <${m.id}@lane.test>\r\n`) };
          else if (query?.internalDate) yield { uid, internalDate: new Date(Date.UTC(2026, 8, 30) + uid * 1000), envelope: {} };
          else if (query?.flags) yield { uid, flags: new Set<string>() };
          else yield { uid };
        }
      },
      async messageMove() { return { uidValidity: 100n, uidMap: new Map<number, number>() }; },
      async messageCopy() { return { uidValidity: 100n, uidMap: new Map<number, number>() }; },
      async messageDelete() { return true; },
      async logout() { /* nothing */ },
      close() { /* nothing */ },
      on() { /* no events */ },
    };
    return c;
  };
  return { state, client };
}

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 47));

describe.skipIf(!AVAILABLE)("the hosted worker over a batch-total overrun", () => {
  let DB = "";
  const closers: Array<() => Promise<void>> = [];
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_overrunbatch"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  /** One mailbox on the worker's own loop over `s`, until `want` messages are stored or it is quarantined. */
  async function run(s: ReturnType<typeof server>, want: number) {
    const w = await start(s);
    await w.until(async () => (await w.subjects()).length >= want);
    return w.result();
  }

  /** The worker's own loop over `s`, left running: `until` polls a condition, `result` reads the outcome. */
  async function start(s: ReturnType<typeof server>) {
    const wdb = makeDb(DB);
    const [row] = await wdb.insert(mailboxes).values({
      accountId: randomUUID(), provider: "imap", address: `${randomUUID()}@trafficflow.test`,
    }).returning();
    const enc = await KP.encrypt("pw");
    await wdb.insert(mailboxCredentials).values({
      mailboxId: row!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
    });
    const fleet = new FakeAdapterFleet();
    const factory = (c: Parameters<FakeAdapterFleet["factory"]>[0], ctx: Parameters<FakeAdapterFleet["factory"]>[1]): MailboxAdapter => {
      const fake = fleet.factory(c, ctx);
      const real = new ImapAdapter(cfg, { client: s.client() as never, onConnectionError: ctx.onConnectionError });
      return {
        ...fake,
        async connect() { await fake.connect(); await real.connect(); },
        async close() { await fake.close(); await real.close(); },
        forceClose: () => real.forceClose(),
        capabilities: () => real.capabilities(),
        changesSince: (cur) => real.changesSince(cur),
        fetchByUid: (f, u, o) => real.fetchByUid(f, u, o),
      } as MailboxAdapter;
    };
    const lines: Array<Record<string, unknown>> = [];
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 50, sentDomain: "trafficflow.test",
      // One failure quarantines, so a pass that kept nothing would show at once.
      rosterIntervalMs: 100, mailboxRetryMs: 250, maxSyncFailures: 1,
      lockHeartbeatMs: 150, instanceId: `wkr-overrun-batch-${randomUUID().slice(0, 8)}`,
      adapterFactory: factory,
      logger: createLogger({ service: "worker", level: "info", sink: (l) => lines.push(JSON.parse(l)) }),
    });
    closers.push(() => worker.stop());
    const subjects = async (): Promise<string[]> =>
      (await wdb.select({ subject: messages.subject }).from(messages).where(eq(messages.mailboxId, row!.id)))
        .map((m) => m.subject ?? "").sort();
    /** Until `done` holds, the mailbox is quarantined, or 40 s pass. */
    const until = async (done: () => Promise<boolean>): Promise<void> => {
      const started = Date.now();
      while (Date.now() - started < 40_000) {
        if (await done() || lines.some((l) => l.event === "mailbox_quarantined")) return;
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const result = async () => ({
      subjects: await subjects(), lines,
      failures: await wdb.select().from(messageFailures).where(eq(messageFailures.mailboxId, row!.id)),
      quarantined: lines.filter((l) => l.event === "mailbox_quarantined").length,
      failed: lines.filter((l) => l.event === "sync_cycle_failed").length,
    });
    return { wdb, mailboxId: row!.id, lines, subjects, until, result };
  }

  it("twelve floor-riders then new mail: everything stored, each body once, no failed cycle, no quarantine", async () => {
    const inbox: Array<[number, Msg]> = [[1, ordinary("old-1")]];
    for (let u = 2; u <= 13; u++) inbox.push([u, rider(`rider-${u}`)]);
    inbox.push([14, ordinary("new-mail")]);
    const s = server(new Map([["INBOX", { uidValidity: 100n, msgs: new Map(inbox) }]]));
    const r = await run(s, 14);
    console.log("BATCH TOTAL worker", JSON.stringify({ stored: r.subjects.length, quarantined: r.quarantined, failed: r.failed, bodies: s.state.bodies }));
    expect(r.quarantined, "the mailbox was quarantined over mail every bound admits").toBe(0);
    expect(r.failed, "a pass that kept mail was counted as a failed cycle").toBe(0);
    expect(r.subjects).toEqual([...inbox.map(([, m]) => m.id)].sort());
    expect(r.failures, "a message inside its own ceiling was set aside").toEqual([]);
    expect(r.lines.filter((l) => String(l.event).startsWith("sync_message_skip")).map((l) => l.event),
      "a write-off was attempted for a breach naming no message").toEqual([]);
    expect(Object.values(s.state.bodies), "a body was fetched more than once").toEqual(Array(14).fill(1));
    expect(r.lines.some((l) => l.event === "sync_cycle_set_aside"), "no breach was met, so this case proves nothing").toBe(true);
  }, 60_000);

  /* A FOLDER WITH NO CURSOR YET: Sent is not a watched folder, and a customer folder has no row
     until a pass writes one, so `buildCursor` names neither. A breach on its first read must leave
     a cursor naming its epoch, or the next pass holds none of the kept mail as known and crosses
     at the same row again: the mailbox was quarantined after the first such cycle. */
  for (const folder of ["Sent", "Archive"]) {
    it(`twelve floor-riders in a first-seen ${folder}: everything stored, each body once, no failed cycle, no quarantine`, async () => {
      const first = new Map<number, Msg>();
      for (let u = 1; u <= 12; u++) first.set(u, rider(`${folder}-${u}`));
      const s = server(new Map([
        ["INBOX", { uidValidity: 100n, msgs: new Map([[1, ordinary("old-1")], [2, ordinary("new-mail")]]) }],
        [folder, { uidValidity: 300n, msgs: first }],
      ]));
      const r = await run(s, 14);
      console.log(`FIRST-SEEN ${folder} worker`, JSON.stringify({ stored: r.subjects.length, quarantined: r.quarantined, failed: r.failed, bodies: s.state.bodies }));
      expect(r.quarantined, "the mailbox was quarantined over mail every bound admits").toBe(0);
      expect(r.failed, "a pass that kept mail was counted as a failed cycle").toBe(0);
      expect(r.subjects).toEqual(["new-mail", "old-1", ...[...first.values()].map((m) => m.id)].sort());
      expect(r.failures, "a message inside its own ceiling was set aside").toEqual([]);
      expect(Object.values(s.state.bodies), "a body was fetched more than once").toEqual(Array(14).fill(1));
      expect(r.lines.some((l) => l.event === "sync_cycle_set_aside"), "no breach was met, so this case proves nothing").toBe(true);
    }, 60_000);
  }

  /* A RENUMBERED FOLDER whose re-read crosses the batch total. The cursor kept naming the old epoch,
     so every pass saw the reset again and re-read the same newest letters, already held: the cycle
     failed and the mailbox was quarantined. Now the reset settles in the pass that crosses, the next
     one resumes, and a letter re-learned under the new epoch is progress. */
  for (const folder of ["Archive", "Sent"]) {
    it(`twelve floor-riders in a renumbered ${folder}: each re-learned once, the deleted one gone, no failed cycle`, async () => {
      const ids = Array.from({ length: 12 }, (_, i) => `${folder}-${i + 1}`);
      const first = new Map<number, Msg>(ids.map((id, i) => [1 + i, rider(id)]));
      const s = server(new Map([
        ["INBOX", { uidValidity: 100n, msgs: new Map([[1, ordinary("old-1")]]) }],
        [folder, { uidValidity: 300n, msgs: first }],
      ]));
      const w = await start(s);
      await w.until(async () => (await w.subjects()).length >= 13);
      expect((await w.subjects()).length, "the first read did not drain, so this case proves nothing").toBe(13);
      const failedBefore = w.lines.filter((l) => l.event === "sync_cycle_failed").length;
      const setAsideBefore = w.lines.filter((l) => l.event === "sync_cycle_set_aside").length;
      // The server renumbers the folder, the last letter deleted meanwhile, and new mail arrives.
      const renumbered = new Map<number, Msg>();
      for (const [uid, m] of first) if (m.id !== ids[11]) renumbered.set(100 + uid, m);
      const bodiesBefore = { ...s.state.bodies };
      s.state.folders.set(folder, { uidValidity: 301n, msgs: renumbered });
      s.state.folders.get("INBOX")!.msgs.set(2, ordinary("new-mail"));
      const atNew = async (): Promise<string[]> => (await w.wdb.select({ uv: messageInstances.uidvalidity, folder: messageInstances.folder })
        .from(messageInstances).where(eq(messageInstances.mailboxId, w.mailboxId)))
        .filter((r) => r.folder === folder).map((r) => String(r.uv));
      await w.until(async () => {
        const at = await atNew();
        return (await w.subjects()).includes("new-mail") && at.length === renumbered.size && at.every((uv) => uv === "301");
      });
      const r = await w.result();
      const again = Object.fromEntries(Object.entries(s.state.bodies).map(([id, n]) => [id, n - (bodiesBefore[id] ?? 0)]));
      const at = await atNew();
      console.log(`RENUMBERED ${folder} worker`, JSON.stringify({ at: at.length, again, quarantined: r.quarantined, failed: r.failed - failedBefore }));
      expect(r.quarantined, "the mailbox was quarantined over a renumbered folder").toBe(0);
      expect(r.failed - failedBefore, "a pass that re-learned mail was counted as a failed cycle").toBe(0);
      expect(at.length === renumbered.size && at.every((uv) => uv === "301"), "the folder was not re-learned under its new epoch").toBe(true);
      for (const m of renumbered.values()) expect(again[m.id], `${m.id} fetched again`).toBe(1);
      expect(again[ids[11]!] ?? 0, "the deleted letter was fetched").toBe(0);
      expect(again["new-mail"]).toBe(1);
      expect(r.failures, "a message inside its own ceiling was set aside").toEqual([]);
      expect(r.lines.filter((l) => l.event === "sync_cycle_set_aside").length, "no breach was met after the renumbering, so this case proves nothing")
        .toBeGreaterThan(setAsideBefore);
      const [gone] = await w.wdb.select({ deletedAt: messages.deletedAt }).from(messages).where(eq(messages.subject, ids[11]!));
      expect(gone?.deletedAt, "the letter deleted during the renumbering is still shown").not.toBeNull();
      const [row] = await w.wdb.select({ uv: mailboxFolders.uidvalidity }).from(mailboxFolders).where(eq(mailboxFolders.folder, folder));
      expect(String(row?.uv)).toBe("301");
    }, 90_000);
  }
});
