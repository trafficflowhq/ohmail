import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapCursor, MailboxAdapter, NativeLocator, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, LeasePeekIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { openPhoneStore, pagedExecutor, type PhoneSqlExecutor, type PhoneSqlRows } from "../src/mobile.js";

/**
 * THE DRAIN COMMITS A PAGE, NOT A LETTER — PERF-026. One durable commit per message parsed was most of
 * what was left of a phone's first sync once its timers were gone (host rig, thousands of letters: many
 * times longer with a commit per letter than with one per cycle). The mail is re-derivable from the server, so a kill
 * may cost a page and nothing more; a person's write never joins a page and nobody outside the drain
 * reads one. MUTATION WATCHED RED: the cycle back on the main repo commits per letter.
 */
vi.setConfig({ testTimeout: 60_000 });

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const ON_DEVICE_STORE = process.env.OHMAIL_EXPECT_DIALECT === "sqlite";

/** node:sqlite behind the phone's statement-runner contract, counting the COMMITs that reach the file. */
function countingExecutor(path = ":memory:"): PhoneSqlExecutor & {
  commits: () => number; raw: InstanceType<typeof sqlite.DatabaseSync>; refuseCommits: (n: number) => void;
} {
  const raw = new sqlite.DatabaseSync(path);
  let commits = 0;
  /* A refused COMMIT the way a full disk refuses one: SQLite rolls the transaction back. */
  let refusals = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => T): Promise<T> => { const n = tail.then(job, job); tail = n.catch(() => undefined); return n; };
  return {
    raw,
    commits: () => commits,
    refuseCommits: (n: number) => { refusals = n; },
    all: (sql, params): Promise<PhoneSqlRows> => serial(() => {
      const st = raw.prepare(sql);
      const columns = st.columns().map((c) => c.name);
      const objects = st.all(...(params as never[])) as Record<string, unknown>[];
      return { columns, rows: columns.length > 0 ? objects.map((o) => columns.map((c) => o[c])) : objects.map((o) => Object.values(o)) };
    }),
    run: (sql, params) => serial(() => {
      if (/^\s*(commit|end)\b/i.test(sql)) {
        if (refusals > 0) { refusals -= 1; raw.exec("ROLLBACK"); throw new Error("SQLITE_FULL: database or disk is full"); }
        commits += 1;
      }
      raw.prepare(sql).run(...(params as never[]));
    }),
    batch: (statements) => serial(() => {
      raw.exec("BEGIN IMMEDIATE");
      try { for (const { sql, params = [] } of statements) raw.prepare(sql).run(...(params as never[])); raw.exec("COMMIT"); commits += 1; }
      catch (err) { try { raw.exec("ROLLBACK"); } catch { /* keep the first error */ } throw err; }
    }),
    close: () => serial(() => { try { raw.close(); } catch { /* closed */ } }),
  };
}

class MemoryMeta implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
  }
  uidValidity(): number { return 4_260; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims.filter((c) => c.raw.includes(installId)).map((c) => ({ ...c }));
  }
}

const eml = (n: number): Buffer => Buffer.from([
  `From: Sender ${n % 7} <s${n % 7}@sender.test>`, "To: owner@trafficflow.test", `Subject: Letter ${n}`,
  "Date: Wed, 30 Sep 2026 12:00:00 +0000", `Message-ID: <letter-${n}@lane.test>`, "", `Body of letter ${n}.`, "",
].join("\r\n"));

/** An INBOX of `count` letters, handed over in ONE batch — one cycle, one page. */
function inbox(count: number, onCycle: () => void = () => undefined): () => MailboxAdapter & { leaseIo(): LeaseIo; leasePeekIo(): LeasePeekIo } {
  const meta = new MemoryMeta();
  const uids = Array.from({ length: count }, (_, i) => i + 1);
  const create = (uid: number) => ({ type: "create" as const, locator: { folder: "INBOX", ref: `4260:${uid}` }, seen: false, raw: eml(uid) });
  return () => ({
    leaseIo: () => meta,
    leasePeekIo: () => ({ listClaims: async () => meta.listClaims() }),
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(c: ImapCursor): Promise<ChangeBatch> {
      onCycle();
      const known = new Set((c.folders.INBOX?.known ?? []).map((k) => k.uid));
      return {
        creates: uids.filter((u) => !known.has(u)).map(create), moves: [], flagChanges: [], deletes: [],
        newCursor: { folders: { INBOX: { uidValidity: "4260", uidNext: count + 1, highestModseq: "0" } } },
      } as unknown as ChangeBatch;
    },
    async fetchByUid(_folder: string, wanted: readonly number[]) {
      return { uidValidity: "4260", creates: uids.filter((u) => wanted.includes(u)).map(create), absent: [], oversize: [] } as never;
    },
    async move(_l: NativeLocator, toFolder: string): Promise<NativeLocator> { return { folder: toFolder, ref: "4260:9999" }; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async fetchPart(): Promise<FetchedPart> { throw new Error("no fetchPart in this rig"); },
    async send(): Promise<SendResult> { throw new Error("no send in this rig"); },
  });
}

const open: Sidecar[] = [];
afterEach(async () => { for (const s of open.splice(0)) await s.stop().catch(() => undefined); });

describe.runIf(ON_DEVICE_STORE)("the phone's first sync commits once per cycle page", () => {
  it("takes 60 letters in one cycle with a handful of commits, not one per letter", async () => {
    const exec = countingExecutor();
    const events: string[] = [];
    let commitsAtDrainStart = -1;
    let commitsAtFinish = -1;
    const s = await createSidecar({
      dataDir: "",
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "pw" } },
      address: "owner@trafficflow.test", machineName: "ohmail on a phone", installId: "install-ingest-page",
      organizerKind: "mobile", pollIntervalMs: 60_000, keks: { 1: Buffer.alloc(32, 5) },
      adapterFactory: inbox(60, () => { if (commitsAtDrainStart < 0) commitsAtDrainStart = exec.commits(); }),
      store: async () => openPhoneStore(exec),
      log: (event) => {
        events.push(event);
        if (event === "first_sync_finished") commitsAtFinish = exec.commits();
      },
    });
    open.push(s);
    await s.start().catch(() => undefined);
    for (let i = 0; i < 400 && commitsAtFinish < 0; i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(commitsAtFinish, "the first sync never finished, so nothing was measured").toBeGreaterThan(0);
    const rows = exec.raw.prepare("select count(*) as n from messages").get() as { n: number };
    expect(rows.n, "the positive control: every letter is in the store").toBe(60);
    expect(commitsAtDrainStart, "no cycle asked the mailbox for its changes").toBeGreaterThanOrEqual(0);
    const drainCommits = commitsAtFinish - commitsAtDrainStart;
    expect(drainCommits, `the cycle committed ${drainCommits} times for 60 letters`).toBeLessThan(10);
  });
});

describe.runIf(ON_DEVICE_STORE)("the app's door reads through the committed-rows handle", () => {
  it("serves an app request through `routeDb`, never the engine's own handle", async () => {
    const exec = countingExecutor();
    let touched = 0;
    const s = await createSidecar({
      dataDir: "",
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "pw" } },
      address: "owner@trafficflow.test", machineName: "ohmail on a phone", installId: "install-route-db",
      organizerKind: "mobile", pollIntervalMs: 60_000, keks: { 1: Buffer.alloc(32, 5) },
      adapterFactory: inbox(1),
      store: async () => {
        const opened = await openPhoneStore(exec);
        const routeDb = new Proxy(opened.routeDb!, {
          get(target, key, receiver) { touched += 1; return Reflect.get(target, key, receiver) as unknown; },
        });
        return { ...opened, routeDb };
      },
    });
    open.push(s);
    const before = touched;
    const res = await s.handle(new Request("http://engine.invalid/mailboxes", {
      headers: { authorization: `Bearer ${s.sessionToken}` },
    }));
    expect(res.status).toBe(200);
    expect(touched - before, "the app's request was served on the engine's own handle").toBeGreaterThan(0);
  });
});

describe("the page and everybody else's writes (the statement runner)", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const fileStore = () => {
    const dir = mkdtempSync(join(tmpdir(), "perf026-page-"));
    dirs.push(dir);
    const path = join(dir, "engine.db");
    const exec = countingExecutor(path);
    exec.raw.exec("create table t (k text)");
    /* A SECOND CONNECTION reads what a relaunch after a kill would read: only what was committed. */
    const relaunch = () => {
      const other = new sqlite.DatabaseSync(path);
      const ks = (other.prepare("select k from t order by rowid").all() as { k: string }[]).map((r) => r.k);
      other.close();
      return ks;
    };
    return { exec, relaunch, paged: pagedExecutor(exec) };
  };
  const letter = async (x: PhoneSqlExecutor, k: string, fail = false): Promise<void> => {
    await x.run("begin", []);
    await x.run("insert into t (k) values (?)", [k]);
    await x.run(fail ? "rollback" : "commit", []);
  };

  it("keeps the drain's letters out of reach until the page commits, and commits it once", async () => {
    const { exec, relaunch, paged } = fileStore();
    await letter(paged.ingest, "a");
    await letter(paged.ingest, "b");
    expect(relaunch(), "a kill now loses the page and nothing else").toEqual([]);
    await paged.endPage();
    expect(relaunch()).toEqual(["a", "b"]);
    expect(exec.commits()).toBe(1);
  });

  it("commits the page BEFORE a person's write, which then commits on its own", async () => {
    const { relaunch, paged } = fileStore();
    await letter(paged.ingest, "mail");
    await paged.main.run("insert into t (k) values (?)", ["draft"]);
    expect(relaunch(), "the person's write waited on the page, or joined it").toEqual(["mail", "draft"]);
  });

  /** Settled yet? Read after the queue has had its turns, never from a timer. */
  const settled = async (p: Promise<unknown>): Promise<boolean> => {
    let done = false;
    void p.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    return done;
  };

  it("holds an app's write that arrives inside a letter until the letter ends, then commits it alone", async () => {
    const { relaunch, paged } = fileStore();
    await letter(paged.ingest, "earlier");
    await paged.ingest.run("begin", []);
    await paged.ingest.run("insert into t (k) values (?)", ["mail"]);
    const write = paged.main.run("insert into t (k) values (?)", ["draft"]);
    expect(await settled(write), "the app's write joined a letter in flight").toBe(false);
    await paged.ingest.run("rollback", []);
    await write;
    expect(relaunch(), "the letter's rollback took nothing of the app's; the page committed first")
      .toEqual(["earlier", "draft"]);
  });

  it("serves an app's read inside a letter only after the letter, and only what a kill keeps", async () => {
    const { relaunch, paged } = fileStore();
    for (const k of ["a", "b"]) await letter(paged.ingest, k);
    await paged.ingest.run("begin", []);
    await paged.ingest.run("insert into t (k) values (?)", ["c"]);
    const read = paged.main.all("select k from t order by rowid", []);
    expect(await settled(read), "the read was served inside the letter").toBe(false);
    await paged.ingest.run("commit", []);
    const seen = (await read).rows.map((r) => r[0]);
    expect(seen).toEqual(["a", "b", "c"]);
    expect(relaunch(), "everything the app was served survives a kill now").toEqual(["a", "b", "c"]);
  });

  it("replays a page whose commit another caller set off and the disk refused once (L1)", async () => {
    const { exec, relaunch, paged } = fileStore();
    await letter(paged.ingest, "a");
    exec.refuseCommits(1);
    await paged.main.run("insert into t (k) values (?)", ["draft"]);
    await letter(paged.ingest, "cursor");
    await paged.endPage();
    expect(relaunch()).toEqual(["a", "draft", "cursor"]);
  });

  it("replays the engine's own writes inside a letter with the page they belong to (L1)", async () => {
    const { exec, relaunch, paged } = fileStore();
    await paged.ingest.run("begin", []);
    await paged.ingest.run("insert into t (k) values (?)", ["mail"]);
    await paged.engine.run("insert into t (k) values (?)", ["its index row"]);
    await paged.ingest.run("commit", []);
    exec.refuseCommits(1);
    await paged.endPage();
    expect(relaunch()).toEqual(["mail", "its index row"]);
  });

  it("makes a page the disk keeps refusing the DRAIN's failure, never another caller's (L1)", async () => {
    const { exec, relaunch, paged } = fileStore();
    await letter(paged.ingest, "a");
    exec.refuseCommits(2);
    await paged.main.run("insert into t (k) values (?)", ["draft"]);
    await expect(paged.ingest.run("begin", []), "the drain's next step hears its page is gone").rejects.toThrow(/SQLITE_FULL/);
    await letter(paged.ingest, "a again");
    await paged.endPage();
    expect(relaunch(), "the cursor's page never committed past the lost letter").toEqual(["draft", "a again"]);
  });

  it("drops a letter that rolled back and keeps the page's others", async () => {
    const { relaunch, paged } = fileStore();
    await letter(paged.ingest, "a");
    await letter(paged.ingest, "refused", true);
    await letter(paged.ingest, "c");
    await paged.endPage();
    expect(relaunch()).toEqual(["a", "c"]);
  });

  /* A REFUSED CONNECT CLOSES THE STORE while an app statement waits out a letter: it is answered
     in JS and never reaches the closed native handle. */
  it("refuses every statement after the close without reaching the store, the waiting app's too", async () => {
    const { exec } = fileStore();
    const reached: string[] = [];
    let shut = false;
    const watched: PhoneSqlExecutor = {
      all: (sql, params) => { if (shut) reached.push(sql); return exec.all(sql, params); },
      run: (sql, params) => { if (shut) reached.push(sql); return exec.run(sql, params); },
      batch: (statements) => { if (shut) reached.push("batch"); return exec.batch(statements); },
      close: () => { shut = true; return exec.close(); },
    };
    const paged = pagedExecutor(watched);
    await paged.ingest.run("begin", []);
    await paged.ingest.run("insert into t (k) values (?)", ["mail"]);
    const read = paged.main.all("select k from t", []);
    expect(await settled(read), "the read was served inside the letter").toBe(false);
    await Promise.all([paged.main.close(), paged.engine.close()]);
    expect(await settled(read), "the waiting read outlived the close").toBe(true);
    await expect(read).rejects.toMatchObject({ code: "engine_store_closed" });
    await expect(paged.ingest.run("commit", [])).rejects.toMatchObject({ code: "engine_store_closed" });
    await expect(paged.engine.all("select k from t", [])).rejects.toMatchObject({ code: "engine_store_closed" });
    await expect(paged.main.run("insert into t (k) values (?)", ["draft"])).rejects.toMatchObject({ code: "engine_store_closed" });
    await expect(paged.ingest.batch([{ sql: "select 1" }])).rejects.toMatchObject({ code: "engine_store_closed" });
    await paged.main.close();
    expect(reached, "a statement reached the closed store").toEqual([]);
  });
});
