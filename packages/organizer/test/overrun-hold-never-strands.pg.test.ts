import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { accounts, mailboxes, messageFailures, messages, mailboxFolders } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { pgTestUrl, realPgAvailable } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { ImapAdapter, ImapBoundExceeded } from "@trafficflow/core/adapters/imap";
import { runSyncCycle } from "../src/sync.js";
import { DeadLetterLedger } from "../src/dead-letter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * THE HOLD MAY DELAY A WRITE-OFF, NEVER STRAND A MAILBOX (VERIFY-026). The real ImapAdapter over a
 * scripted server. Six messages that each stream far past their declared size, in one INBOX page:
 * every one is set aside once, the readable mail around them is stored, and new mail arrives, on
 * the worker's ledger and on the desktop's hold-enabled one. A server stating no RFC822.SIZE is
 * capped at the MIME ceiling, so its ordinary 5 MiB message is stored, not set aside.
 */
const URL = pgTestUrl(import.meta.url);
const AVAILABLE = await realPgAvailable(URL);
const WATCHED = ["INBOX", "ohmail/Screener", "ohmail/News", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine"];
const cfg = { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } };
const eml = (id: string): Buffer => Buffer.from([
  "From: Anna <anna@sender.test>", "To: owner@trafficflow.test", `Subject: ${id}`,
  "Date: Wed, 30 Sep 2026 12:00:00 +0000", `Message-ID: <${id}@lane.test>`, "", `Body of ${id}.`, "",
].join("\r\n"));
type Msg = { id: string; raw: Buffer; declared: number | undefined; liar?: boolean };
const ordinary = (id: string): Msg => ({ id, raw: eml(id), declared: eml(id).length });
const liar = (id: string): Msg => ({ id, raw: Buffer.alloc(2 * 1024 * 1024, 0x61), declared: 10, liar: true });

function server(init: Record<string, { uidValidity: bigint; msgs: Array<[number, Msg]> }>) {
  const folders = new Map<string, { uidValidity: bigint; msgs: Map<number, Msg> }>();
  for (const [k, v] of Object.entries(init)) folders.set(k, { uidValidity: v.uidValidity, msgs: new Map(v.msgs) });
  const state = { overrunBodies: 0, liarBodies: {} as Record<string, number>, folders };
  let path = "INBOX";
  const msgsOf = (p: string) => folders.get(p)?.msgs ?? new Map<number, Msg>();
  const parseSet = (range: unknown): number[] => {
    const all = [...msgsOf(path).keys()].sort((a, b) => a - b);
    if (Array.isArray(range)) return range.map(Number).filter((u) => msgsOf(path).has(u));
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
  const extra = [...folders.keys()].filter((f) => !WATCHED.includes(f));
  const client = {
    usable: true,
    capabilities: new Map<string, boolean>([["MOVE", true], ["UIDPLUS", true]]),
    mailbox: undefined as unknown,
    async list() {
      return [...WATCHED, ...extra].map((p) => ({
        path: p, name: p.split("/").pop()!, delimiter: "/",
        flags: new Set<string>(p === "Sent" ? ["\\Sent"] : []), ...(p === "Sent" ? { specialUse: "\\Sent" } : {}),
      }));
    },
    async mailboxCreate(p: string) { return { path: p }; },
    async getMailboxLock(p: string) {
      path = p;
      const f = folders.get(p);
      const keys = f ? [...f.msgs.keys()] : [];
      client.mailbox = { path: p, uidValidity: f?.uidValidity ?? 7n, uidNext: Math.max(0, ...keys) + 1, highestModseq: 0n, exists: keys.length };
      return { path: p, release() { /* nothing */ } };
    },
    async search() { return []; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async *fetch(range: any, query: any) {
      for (const uid of parseSet(range)) {
        const m = msgsOf(path).get(uid)!;
        if (query?.source) {
          if (m.liar) { state.overrunBodies++; const k = `${path}:${uid}`; state.liarBodies[k] = (state.liarBodies[k] ?? 0) + 1; }
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
  };
  return { state, client };
}

describe.skipIf(!AVAILABLE)("the backstop hold and read-bound overruns (real adapter, real Postgres)", () => {
  const sql = postgres(URL, { max: 3 });
  const db = brandDialect(drizzle(sql, { schema }), "pg");
  const repo = makeDrizzleRepo(db);
  beforeAll(async () => { await runMigrations(URL); }, 60_000);
  afterAll(async () => { await sql.end({ timeout: 5 }); });

  async function seed(name: string) {
    const [acct] = await db.insert(accounts).values({ name }).returning();
    const [mb] = await db.insert(mailboxes)
      .values({ accountId: acct!.id, provider: "imap", address: `v26-${randomUUID().slice(0, 8)}@tf.example` }).returning();
    return { accountId: acct!.id, mailboxId: mb!.id };
  }
  async function seedRow(ids: { accountId: string; mailboxId: string }, folder: string, epoch: bigint, uid: number, code: string, version: string) {
    await db.insert(messageFailures).values({
      accountId: ids.accountId, mailboxId: ids.mailboxId, folder, uidvalidity: epoch, uid, code,
      attempts: 1, attemptedVersion: version, nextAttemptAt: null,
    });
  }
  async function cycle(ids: { accountId: string; mailboxId: string }, s: ReturnType<typeof server>, dl: DeadLetterLedger, version = "build-one") {
    const adapter = new ImapAdapter(cfg, { client: s.client as never });
    await adapter.connect();
    return runSyncCycle({
      repo, adapter, ...ids, storageCap: UNMETERED_STORAGE_CAP,
      writeAuthority: FIXTURE_LEASE, deadLetters: dl, buildVersion: version,
      role: "organizer", trustedAuthservIds: new Set<string>(),
    }).then(() => "served", (e: unknown) => (e instanceof ImapBoundExceeded ? `breach:${e.folder}:${e.site?.uidValidity ?? "-"}:${e.site?.uid ?? "-"}` : `threw:${String(e).slice(0, 120)}`));
  }
  async function facts(ids: { mailboxId: string }) {
    const failures = await db.select().from(messageFailures).where(eq(messageFailures.mailboxId, ids.mailboxId));
    const stored = await db.select({ subject: messages.subject }).from(messages).where(eq(messages.mailboxId, ids.mailboxId));
    const rows = await db.select({ folder: mailboxFolders.folder, uidValidity: mailboxFolders.uidvalidity, uidNext: mailboxFolders.uidnext })
      .from(mailboxFolders).where(eq(mailboxFolders.mailboxId, ids.mailboxId));
    return {
      failures: failures.map((f) => `${f.folder}:${String(f.uidvalidity)}:${f.uid}:${f.code}:${f.attemptedVersion}:${f.resolvedAt ? "RESOLVED" : "open"}`).sort(),
      unresolved: failures.filter((f) => f.resolvedAt === null).length,
      subjects: stored.map((x) => x.subject).sort(),
      folders: rows.filter((r) => !r.folder.startsWith("ohmail/")).map((r) => `${r.folder}@${String(r.uidValidity)}/next=${String(r.uidNext)}`).sort(),
    };
  }

  for (const hold of [false, true]) {
    it(`six overruns in one INBOX page are each set aside once and the mailbox keeps syncing (hold=${hold})`, async () => {
      const ids = await seed(`overrun-hold-${hold}`);
      const msgs: Array<[number, Msg]> = [[1, ordinary("inbox-1")]];
      for (let u = 2; u <= 7; u++) msgs.push([u, liar(`liar-${u}`)]);
      msgs.push([8, ordinary("inbox-8")]);
      const s = server({ INBOX: { uidValidity: 100n, msgs }, Archive: { uidValidity: 300n, msgs: [[1, ordinary("archive-1")]] } });
      const dl = new DeadLetterLedger(hold ? { holdAtCap: true } : {});
      const outcomes: string[] = [];
      let afterFirst: string[] = [];
      for (let i = 0; i < 11; i++) {
        if (i === 8) s.state.folders.get("INBOX")!.msgs.set(9, ordinary("inbox-new-mail"));
        outcomes.push(await cycle(ids, s, dl));
        if (i === 0) afterFirst = (await facts(ids)).subjects as string[];
      }
      // The newest-first fetch streams uid 8 before the first liar: the breaching pass stores it.
      expect(afterFirst, "the breaching pass threw away the folder's mail read before the breach").toEqual(["inbox-8"]);
      const f = await facts(ids);
      expect(Object.values(s.state.liarBodies), "a set-aside message was fetched again").toEqual([1, 1, 1, 1, 1, 1]);
      expect(f.unresolved, "six messages set aside").toBe(6);
      expect(dl.skipped).toBe(6);
      expect(f.subjects).toEqual(["archive-1", "inbox-1", "inbox-8", "inbox-new-mail"]);
      expect(outcomes.slice(-3)).toEqual(["served", "served", "served"]);
    });
  }

  it("a server stating no RFC822.SIZE has its ordinary 5 MiB message stored, not set aside", async () => {
    const ids = await seed("overrun-no-size");
    const big = Buffer.concat([eml("big-mail").subarray(0, -2), Buffer.from(`${"x".repeat(76)}\r\n`.repeat(70_000))]);
    expect(big.length).toBeGreaterThan(5 * 1024 * 1024);
    const s = server({ INBOX: { uidValidity: 100n, msgs: [[1, ordinary("inbox-1")], [2, { id: "big-mail", raw: big, declared: undefined }], [3, { id: "small", raw: eml("small"), declared: undefined }]] } });
    const dl = new DeadLetterLedger({ holdAtCap: true });
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) outcomes.push(await cycle(ids, s, dl));
    const f = await facts(ids);
    expect(f.unresolved, "ordinary mail from a no-size server was set aside").toBe(0);
    expect(f.subjects).toEqual(["big-mail", "inbox-1", "small"]);
    expect(outcomes.every((o) => o === "served")).toBe(true);
  });

  it("CONTROL: a message declaring a small size and streaming 2 MiB is still set aside", async () => {
    const ids = await seed("overrun-declared-small");
    const s = server({ INBOX: { uidValidity: 100n, msgs: [[1, ordinary("inbox-1")], [2, liar("liar")]] } });
    const dl = new DeadLetterLedger({ holdAtCap: true });
    const outcomes = [await cycle(ids, s, dl), await cycle(ids, s, dl)];
    const f = await facts(ids);
    expect(outcomes).toEqual(["breach:INBOX:100:2", "served"]);
    expect(f.unresolved).toBe(1);
    expect(f.subjects).toEqual(["inbox-1"]);
  });
});
