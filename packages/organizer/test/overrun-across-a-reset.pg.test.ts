import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, isNull } from "drizzle-orm";
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
 * A UIDVALIDITY RESET CONVERGES (REVIEW-026 HIGH 2). INBOX holds three messages, the middle one a
 * liar (RFC822.SIZE 10, 2 MiB streamed); then the server renumbers INBOX 100 -> 200, right after
 * the breach or after a finished first pass. The old row is closed, the message under the new
 * epoch breaches once and is set aside, and the mailbox serves every pass after.
 */
const URL = pgTestUrl(import.meta.url);
const AVAILABLE = await realPgAvailable(URL);
const FOLDERS = ["INBOX", "ohmail/Screener", "ohmail/News", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine"];
const cfg = { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } };

const eml = (id: string): Buffer => Buffer.from([
  "From: Anna <anna@sender.test>", "To: owner@trafficflow.test", `Subject: ${id}`,
  "Date: Wed, 30 Sep 2026 12:00:00 +0000", `Message-ID: <${id}@lane.test>`, "", `Body of ${id}.`, "",
].join("\r\n"));

interface Msg { id: string; raw: Buffer; declared: number }

/** One scripted server; `state` is mutable so a test can reset UIDVALIDITY between passes. */
function server() {
  const state = {
    uidValidity: 100n,
    inbox: new Map<number, Msg>(),
    overrunBodies: 0,
  };
  const overrun = Buffer.alloc(2 * 1024 * 1024, 0x61);
  const put = (epoch: bigint, uids: [number, number, number]) => {
    state.uidValidity = epoch;
    state.inbox = new Map<number, Msg>([
      [uids[0], { id: "ordinary-a", raw: eml("ordinary-a"), declared: eml("ordinary-a").length }],
      [uids[1], { id: "the-liar", raw: overrun, declared: 10 }],
      [uids[2], { id: "ordinary-b", raw: eml("ordinary-b"), declared: eml("ordinary-b").length }],
    ]);
  };
  put(100n, [1, 2, 3]);
  const parseSet = (range: unknown): number[] => {
    const all = [...state.inbox.keys()].sort((a, b) => a - b);
    if (Array.isArray(range)) return range.map(Number).filter((u) => state.inbox.has(u));
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
  let path = "INBOX";
  const client = {
    usable: true,
    capabilities: new Map<string, boolean>([["MOVE", true], ["UIDPLUS", true]]),
    mailbox: undefined as unknown,
    async list() {
      return FOLDERS.map((p) => ({ path: p, name: p.split("/").pop()!, delimiter: "/", flags: new Set<string>() }));
    },
    async mailboxCreate(p: string) { return { path: p }; },
    async getMailboxLock(p: string) {
      path = p;
      const n = p === "INBOX" ? state.inbox.size : 0;
      const next = p === "INBOX" ? Math.max(0, ...state.inbox.keys()) + 1 : 1;
      client.mailbox = { path: p, uidValidity: p === "INBOX" ? state.uidValidity : 7n, uidNext: next, highestModseq: 0n, exists: n };
      return { path: p, release() { /* nothing */ } };
    },
    async search() { return []; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async *fetch(range: any, query: any) {
      if (path !== "INBOX") return;
      const uids = parseSet(range);
      for (const uid of uids) {
        const m = state.inbox.get(uid)!;
        if (query?.source) {
          if (m.id === "the-liar") state.overrunBodies++;
          yield {
            uid, flags: new Set<string>(), envelope: { messageId: `<${m.id}@lane.test>` },
            source: m.raw, internalDate: new Date(Date.UTC(2026, 8, 30) + uid * 1000),
          };
        } else if (query?.size) {
          yield { uid, size: m.declared };
        } else if (query?.headers) {
          yield { uid, headers: Buffer.from(`Message-ID: <${m.id}@lane.test>\r\n`) };
        } else if (query?.internalDate) {
          yield { uid, internalDate: new Date(Date.UTC(2026, 8, 30) + uid * 1000), envelope: {} };
        } else if (query?.flags) {
          yield { uid, flags: new Set<string>() };
        } else {
          yield { uid };
        }
      }
    },
    async messageMove() { return { uidValidity: state.uidValidity, uidMap: new Map<number, number>() }; },
    async messageCopy() { return { uidValidity: state.uidValidity, uidMap: new Map<number, number>() }; },
    async messageDelete() { return true; },
    async logout() { /* nothing */ },
    close() { /* nothing */ },
  };
  return { state, client, put };
}

describe.skipIf(!AVAILABLE)("an overrun message and a UIDVALIDITY change (real adapter, real Postgres)", () => {
  const sql = postgres(URL, { max: 3 });
  const db = brandDialect(drizzle(sql, { schema }), "pg");
  const repo = makeDrizzleRepo(db);
  beforeAll(async () => { await runMigrations(URL); }, 60_000);
  afterAll(async () => { await sql.end({ timeout: 5 }); });

  async function seed(): Promise<{ accountId: string; mailboxId: string }> {
    const [acct] = await db.insert(accounts).values({ name: "review026-reset" }).returning();
    const [mb] = await db.insert(mailboxes)
      .values({ accountId: acct!.id, provider: "imap", address: `rv-${randomUUID().slice(0, 8)}@tf.example` }).returning();
    return { accountId: acct!.id, mailboxId: mb!.id };
  }

  async function cycle(ids: { accountId: string; mailboxId: string }, s: ReturnType<typeof server>, deadLetters: DeadLetterLedger): Promise<string> {
    // A fresh attachment per cycle, as the worker re-attaches after a failed one.
    const adapter = new ImapAdapter(cfg, { client: s.client as never });
    await adapter.connect();
    return runSyncCycle({
      repo, adapter, ...ids, storageCap: UNMETERED_STORAGE_CAP,
      writeAuthority: FIXTURE_LEASE, deadLetters, buildVersion: "build-one",
      role: "organizer", trustedAuthservIds: new Set<string>(),
    }).then(() => "served", (e: unknown) => (e instanceof ImapBoundExceeded ? `breach:${e.site?.uidValidity ?? "-"}:${e.site?.uid ?? "-"}` : `threw:${String(e)}`));
  }

  async function facts(ids: { mailboxId: string }) {
    const failures = await db.select({ uidValidity: messageFailures.uidvalidity, uid: messageFailures.uid, code: messageFailures.code })
      .from(messageFailures).where(and(eq(messageFailures.mailboxId, ids.mailboxId), isNull(messageFailures.resolvedAt)));
    const stored = await db.select({ subject: messages.subject }).from(messages).where(eq(messages.mailboxId, ids.mailboxId));
    const rows = await db.select({ folder: mailboxFolders.folder, uidValidity: mailboxFolders.uidvalidity })
      .from(mailboxFolders).where(eq(mailboxFolders.mailboxId, ids.mailboxId));
    return {
      failures: failures.map((f) => `${String(f.uidValidity)}:${f.uid}:${f.code}`).sort(),
      subjects: stored.map((r) => r.subject).sort(),
      inboxEpoch: String(rows.find((r) => r.folder === "INBOX")?.uidValidity ?? null),
    };
  }

  it("CONTROL (no reset): the real adapter's breach is set aside once and the rest syncs", async () => {
    const ids = await seed();
    const s = server();
    const dl = new DeadLetterLedger();
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) outcomes.push(await cycle(ids, s, dl));
    const f = await facts(ids);
    expect(outcomes).toEqual(["breach:100:2", "served", "served"]);
    expect(s.state.overrunBodies).toBe(1);
    expect(f.failures).toEqual(["100:2:mime_too_large"]);
  });

  it("A: UIDVALIDITY changes between the breach and the next pass (first pass never finished)", async () => {
    const ids = await seed();
    const s = server();
    const dl = new DeadLetterLedger();
    const outcomes: string[] = [];
    outcomes.push(await cycle(ids, s, dl));
    s.put(200n, [11, 12, 13]);                       // the server renumbers the folder
    for (let i = 0; i < 5; i++) {
      if (i === 2) s.state.inbox.set(14, { id: "new-after-reset", raw: eml("new-after-reset"), declared: eml("new-after-reset").length });
      outcomes.push(await cycle(ids, s, dl));
    }
    const f = await facts(ids);
    expect(outcomes, "one breach per epoch, then every pass served").toEqual(
      ["breach:100:2", "breach:200:12", "served", "served", "served", "served"]);
    expect(s.state.overrunBodies).toBe(2);
    expect(f.failures, "the old epoch's row is closed; one message is set aside").toEqual(["200:12:mime_too_large"]);
    expect(f.inboxEpoch).toBe("200");
    expect(f.subjects, "new INBOX mail after the reset is stored").toContain("new-after-reset");
  });

  it("B: UIDVALIDITY changes after the first pass finished (the folder row names epoch 100)", async () => {
    const ids = await seed();
    const s = server();
    const dl = new DeadLetterLedger();
    const outcomes: string[] = [];
    outcomes.push(await cycle(ids, s, dl));
    outcomes.push(await cycle(ids, s, dl));
    s.put(200n, [11, 12, 13]);
    for (let i = 0; i < 5; i++) outcomes.push(await cycle(ids, s, dl));
    const f = await facts(ids);
    expect(outcomes, "one breach per epoch, then every pass served").toEqual(
      ["breach:100:2", "served", "breach:200:12", "served", "served", "served", "served"]);
    expect(s.state.overrunBodies).toBe(2);
    expect(f.failures, "the old epoch's row is closed; one message is set aside").toEqual(["200:12:mime_too_large"]);
  });
});
