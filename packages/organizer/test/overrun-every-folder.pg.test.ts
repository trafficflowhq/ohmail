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
 * A SET-ASIDE MESSAGE IS NEVER FETCHED AGAIN, IN ANY FOLDER (REVIEW-026 HIGH 1). The real
 * ImapAdapter over a scripted server: the liar declares RFC822.SIZE 10 and streams 2 MiB, on the
 * FIRST pass of INBOX, of a customer folder (Archive) or of Sent. The pass stops at it and keeps
 * what came before; the next pass skips it against the folder's live epoch, with no cursor row.
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

function server(liarIn: string) {
  const overrun = Buffer.alloc(2 * 1024 * 1024, 0x61);
  const folders = new Map<string, { uidValidity: bigint; msgs: Map<number, Msg> }>([
    ["INBOX", { uidValidity: 100n, msgs: new Map([[1, ordinary("inbox-1")]]) }],
    ["Archive", { uidValidity: 300n, msgs: new Map([[1, ordinary("archive-1")], [2, ordinary("archive-2")]]) }],
    ["Sent", { uidValidity: 400n, msgs: new Map([[1, ordinary("sent-1")]]) }],
  ]);
  folders.get(liarIn)!.msgs.set(9, { id: "the-liar", raw: overrun, declared: 10 });
  const state = { overrunBodies: 0, folders };
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
  const client = {
    usable: true,
    capabilities: new Map<string, boolean>([["MOVE", true], ["UIDPLUS", true]]),
    mailbox: undefined as unknown,
    async list() {
      return [...WATCHED, "Archive", "Sent"].map((p) => ({
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
          if (m.id === "the-liar") state.overrunBodies++;
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

describe.skipIf(!AVAILABLE)("an overrun on the first pass of any folder (real adapter, real Postgres)", () => {
  const sql = postgres(URL, { max: 3 });
  const db = brandDialect(drizzle(sql, { schema }), "pg");
  const repo = makeDrizzleRepo(db);
  beforeAll(async () => { await runMigrations(URL); }, 60_000);
  afterAll(async () => { await sql.end({ timeout: 5 }); });

  async function run(liarIn: string) {
    const [acct] = await db.insert(accounts).values({ name: "review026-firstpass" }).returning();
    const [mb] = await db.insert(mailboxes)
      .values({ accountId: acct!.id, provider: "imap", address: `fp-${randomUUID().slice(0, 8)}@tf.example` }).returning();
    const ids = { accountId: acct!.id, mailboxId: mb!.id };
    const s = server(liarIn);
    const dl = new DeadLetterLedger();
    const outcomes: string[] = [];
    let afterFirst: string[] = [];
    for (let i = 0; i < 5; i++) {
      if (i === 1) {
        afterFirst = (await db.select({ subject: messages.subject }).from(messages)
          .where(eq(messages.mailboxId, ids.mailboxId))).map((x) => x.subject ?? "").sort();
      }
      if (i === 2) s.state.folders.get("INBOX")!.msgs.set(2, ordinary("inbox-new-mail"));   // new mail arrives
      const adapter = new ImapAdapter(cfg, { client: s.client as never });
      await adapter.connect();
      outcomes.push(await runSyncCycle({
        repo, adapter, ...ids, storageCap: UNMETERED_STORAGE_CAP,
        writeAuthority: FIXTURE_LEASE, deadLetters: dl, buildVersion: "build-one",
        role: "organizer", trustedAuthservIds: new Set<string>(),
      }).then(() => "served", (e: unknown) => (e instanceof ImapBoundExceeded ? `breach:${e.folder}:${e.site?.uidValidity ?? "-"}:${e.site?.uid ?? "-"}` : `threw:${String(e)}`)));
    }
    const failures = await db.select({ folder: messageFailures.folder, uidValidity: messageFailures.uidvalidity, uid: messageFailures.uid })
      .from(messageFailures).where(and(eq(messageFailures.mailboxId, ids.mailboxId), isNull(messageFailures.resolvedAt)));
    const stored = await db.select({ subject: messages.subject }).from(messages).where(eq(messages.mailboxId, ids.mailboxId));
    const rows = await db.select({ folder: mailboxFolders.folder }).from(mailboxFolders).where(eq(mailboxFolders.mailboxId, ids.mailboxId));
    const r = {
      outcomes, afterFirst, overrunBodies: s.state.overrunBodies,
      failures: failures.map((f) => `${f.folder}:${String(f.uidValidity)}:${f.uid}`),
      subjects: stored.map((x) => x.subject).sort(), folderRows: rows.map((x) => x.folder).sort(),
    };
    return r;
  }

  for (const liarIn of ["INBOX", "Archive", "Sent"]) {
    it(`the liar in ${liarIn}: set aside once, the rest of the mailbox keeps syncing`, async () => {
      const r = await run(liarIn);
      expect(r.overrunBodies, "the set-aside message was fetched again").toBe(1);
      expect(r.outcomes).toEqual([`breach:${liarIn}:${liarIn === "INBOX" ? 100 : liarIn === "Archive" ? 300 : 400}:9`, "served", "served", "served", "served"]);
      expect(r.failures, "one set-aside row, at the live epoch").toEqual([`${liarIn}:${liarIn === "INBOX" ? 100 : liarIn === "Archive" ? 300 : 400}:9`]);
      expect(r.subjects).toEqual(["archive-1", "archive-2", "inbox-1", "inbox-new-mail", "sent-1"]);
      // The breaching pass keeps the folders before it: INBOX is scanned first.
      if (liarIn !== "INBOX") expect(r.afterFirst, "the breach discarded another folder's work").toContain("inbox-1");
    });
  }
});
