import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { realPgAvailable, serviceUp } from "@trafficflow/db/testing";
import { accounts, contacts, mailboxes, messages, type Tx } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { SyncService, TriageService, type ServiceContext } from "@trafficflow/services";
import { MemoryMirrorStore, triagePiles, type MessageStateDTO } from "@ohmail/client-engine";
import { runSyncCycle } from "../src/sync.js";
import { FIXTURE_DOOR, FIXTURE_LEASE } from "./_door.js";
import { greenmailPorts } from "./_greenmail-ports.js";
import { DB_URL, refuseDriftedSharedDb } from "./_workerdb.js";

/**
 * A LETTER DELETED ON THE MAIL SERVER LEAVES ANSWER LATER, the Cloud door's shape:
 * the worker's own sync cycle on Postgres, the API's `/sync` read, and a client mirror fed from it.
 * Three letters are parked; another mail program expunges one and files another in a folder; ONE
 * sync cycle later the server pile and the client's pile list the two that exist, the filed letter
 * keeping its place in the pile (it moved, it did not leave), and the mirror holds no claim for
 * the gone one. Real Postgres because the reaper's tombstone is a change-log write in a cycle.
 */

const PG_UP = await realPgAvailable();
const sql = postgres(DB_URL, { max: 4, onnotice: () => {} });
const db = brandDialect(drizzle(sql, { schema }), "pg") as unknown as Tx;
beforeAll(async () => { if (PG_UP) { await refuseDriftedSharedDb(); await runMigrations(DB_URL); } }, 120_000);
afterAll(async () => { await sql.end({ timeout: 5 }); });

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const c of closers.splice(0)) await c().catch(() => undefined); });

const eml = (messageId: string, to: string, subject: string): string => [
  `Message-ID: <${messageId}>`, "From: anna@x.example", `To: ${to}`, `Subject: ${subject}`,
  "Date: Mon, 12 Oct 2026 01:19:58 +0000", "Content-Type: text/plain; charset=utf-8", "", "answer me later",
].join("\r\n");

async function uidOf(c: ImapFlow, path: string, messageId: string): Promise<number> {
  const l = await c.getMailboxLock(path);
  try {
    const r = await c.search({ header: { "message-id": messageId } }, { uid: true });
    return Array.isArray(r) && r.length ? r[0]! : 0;
  } finally { l.release(); }
}

const GM = greenmailPorts();
/* The run's one probe (test/setup/services.global.ts), at the address this file dials. */
const GM_UP = serviceUp("greenmail", `${GM.imapHost}:${GM.imapPort}`).up;

describe.skipIf(!PG_UP || !GM_UP)("Answer Later forgets a letter the server deleted (worker cycle, Postgres, /sync)", () => {
  it("one sync cycle after an expunge and a filing, the pile lists the two letters that exist", async () => {
    const p = greenmailPorts();
    const me = `t-${randomUUID()}@trafficflow.test`;
    const cfg = { host: p.imapHost, port: p.imapPort, secure: false, auth: { user: me, pass: "test" } };
    const c = new ImapFlow({ ...cfg, logger: false });
    await c.connect();
    closers.push(() => c.logout());
    await c.mailboxCreate("Projects").catch(() => undefined);
    const tag = randomUUID().slice(0, 8);
    const h = { gone: `gone-${tag}@x`, moved: `moved-${tag}@x`, stays: `stays-${tag}@x` };
    for (const [k, mid] of Object.entries(h)) await c.append("INBOX", eml(mid, me, `later ${k}`));

    const [a] = await db.insert(accounts).values({ name: `answer-later-expunge-${tag}` }).returning();
    const accountId = a!.id;
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: me }).returning();
    const mailboxId = mb!.id;
    await db.insert(contacts).values({ accountId, address: "anna@x.example" });
    const repo = makeDrizzleRepo(db);
    // One connection per drain, closed after it, as a worker reconnects between cycles.
    let adapter: ImapAdapter;
    const drain = async (max = 10): Promise<number> => {
      adapter = new ImapAdapter(cfg);
      await adapter.connect();
      closers.push(() => adapter.close());
      await adapter.ensureFolders(FIXTURE_DOOR);
      try { return await cycleUntilSettled(max); } finally { await adapter.close().catch(() => undefined); }
    };
    const cycleUntilSettled = async (max: number): Promise<number> => {
      for (let i = 1; i <= max; i++) {
        const out = await runSyncCycle({
          repo, adapter, accountId, mailboxId, role: "organizer", writeAuthority: FIXTURE_LEASE,
          storageCap: UNMETERED_STORAGE_CAP, trustedAuthservIds: new Set<string>(),
        });
        if (!out.hasBacklog && !out.owesFiling) return i;
      }
      if (max === 1) return 1;
      throw new Error(`the drain did not settle in ${max} cycles`);
    };
    const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => new Date(), requestId: "r33-05" };
    const idOf = async (mid: string) => (await db.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.mailboxId, mailboxId), eq(messages.messageIdHeader, mid))))[0]!.id;
    const mirror = new MemoryMirrorStore();
    await mirror.load();
    let since: string | undefined;
    const pull = async (): Promise<void> => {
      for (;;) {
        const resp = await new SyncService().getChanges(ctx, since === undefined ? {} : { since });
        await mirror.applyResponse(resp);
        since = resp.cursor;
        if (!resp.hasMore) return;
      }
    };
    const triage = new TriageService();
    const serverPile = async () => (await triage.listByState(ctx, "reply_later")).items.map((m) => m.id).sort();
    const clientPile = () => triagePiles(mirror).replyLater.map((e) => e.messageId!).sort();

    await drain();
    const ids = { gone: await idOf(h.gone), moved: await idOf(h.moved), stays: await idOf(h.stays) };
    for (const id of Object.values(ids)) await triage.setState(ctx, id, { state: "reply_later" });
    await pull();
    expect(clientPile(), "the precondition: three letters in Answer Later").toEqual(Object.values(ids).sort());

    const [goneUid, movedUid] = [await uidOf(c, "INBOX", h.gone), await uidOf(c, "INBOX", h.moved)];
    expect(goneUid * movedUid, "both letters are in INBOX on the server").toBeGreaterThan(0);
    const gl = await c.getMailboxLock("INBOX");
    try {
      await c.messageDelete([goneUid], { uid: true });
      await c.messageMove([movedUid], "Projects", { uid: true });
    } finally { gl.release(); }

    await drain(1);
    await pull();
    const two = [ids.moved, ids.stays].sort();
    expect(await serverPile(), "the server pile after ONE sync cycle").toEqual(two);
    expect(clientPile(), "the client's pile and its count").toEqual(two);
    expect(triagePiles(mirror).replyLater.some((e) => e.title === ids.gone), "no row reads an id").toBe(false);
    const claims = mirror.list<MessageStateDTO>("message_state").map((s) => s.messageId);
    expect(claims, "the mirror's claim left with its letter").not.toContain(ids.gone);
    expect(claims, "the filed letter keeps its claim").toContain(ids.moved);
  }, 120_000);
});
