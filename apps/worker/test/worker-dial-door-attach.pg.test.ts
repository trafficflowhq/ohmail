import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import type { HostResolver } from "@trafficflow/core/net";
import type { ImapConfig } from "@trafficflow/core/adapters/imap";
import { startWorker } from "../src/index.js";
import { makeDialHostGuard } from "../src/dial-host-guard.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";

/**
 * THE ORGANIZER'S ATTACH UNDER THE MANAGED POLICY, END TO END: roster, decrypt, the door, the
 * failure write. The stored hosts are fixture names the injected resolver answers, and the adapter
 * factory records the config it is handed and dials nothing. Its own database, for the leader-lock
 * reason `worker-dial-refusal.pg.test.ts` states.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 13));
const PUBLIC = "93.184.216.34";
type Db = ReturnType<typeof makeDb>;

const resolverOf = (answers: Record<string, string[]>): HostResolver => ({
  resolve: async (host: string) => {
    const a = answers[host];
    if (!a) throw new Error(`no answer scripted for ${host}`);
    return [...a];
  },
});

async function seed(db: Db, accountId: string, imap: { host: string; port: number }, smtp?: { host: string; port: number }): Promise<string> {
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "u@door.example" }).returning();
  const enc = await KP.encrypt("fixture");
  await db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: imap.host, port: imap.port, secure: imap.port === 993, user: "u@door.example" },
  });
  if (smtp) {
    const s = await KP.encrypt("fixture");
    await db.insert(mailboxCredentials).values({
      mailboxId: mb!.id, accountId: mb!.accountId, transport: "smtp", secretEnc: s.ciphertext, keyVersion: s.keyVersion,
      meta: { host: smtp.host, port: smtp.port, secure: smtp.port === 465, user: "u@door.example" },
    });
  }
  return mb!.id;
}

async function rowOf(db: Db, id: string): Promise<{ errorCode: string | null; errorDetail: string | null }> {
  const [r] = await db.select().from(mailboxes).where(eq(mailboxes.id, id));
  return { errorCode: r!.errorCode, errorDetail: r!.errorDetail };
}

async function waitFor(p: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await p()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A factory that records the config and hands back an adapter that dials nothing. */
function recorder(dialled: ImapConfig[]) {
  return (cfg: ImapConfig, ctx: { onConnectionError: (e: unknown) => void }) => {
    dialled.push(cfg);
    return {
      connect: async () => {},
      close: async () => {},
      changesSince: async () => ({ creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} }, hasBacklog: false }),
      ensureFolders: async () => {},
      leaseIo: () => ({ read: async () => [], append: async () => {}, expunge: async () => {} }),
      onConnectionError: ctx.onConnectionError,
    } as never;
  };
}

describe("the organizer's attach under the managed policy", () => {
  let DB_URL = "";
  let db!: Db;
  let accountId = "";
  const closers: Array<() => Promise<void>> = [];

  beforeAll(async () => { DB_URL = await prepareIsolatedDb("trafficflow_worker_dialdoor"); db = makeDb(DB_URL); }, 60000);
  beforeEach(async () => { accountId = randomUUID(); await truncateAll(DB_URL); }, ISOLATED_DB_RESET_BUDGET_MS);
  afterEach(async () => { for (const c of closers.splice(0)) await c(); }, ISOLATED_DB_RESET_BUDGET_MS);

  it("a stored incoming port that carries no mail is refused, said, and never dialled", async () => {
    const id = await seed(db, accountId, { host: "imap.door.example", port: 8080 });
    const dialled: ImapConfig[] = [];
    const worker = await startWorker({
      databaseUrl: DB_URL, accountId, keyProvider: KP, pollIntervalMs: 500, sentDomain: "trafficflow.test",
      dialHostGuard: makeDialHostGuard(resolverOf({ "imap.door.example": [PUBLIC] })),
      adapterFactory: recorder(dialled),
    });
    closers.push(() => worker.stop());
    await waitFor(async () => dialled.length > 0 || (await rowOf(db, id)).errorCode !== null, 15000, "the attach to decide");
    expect(dialled.map((c) => c.port), "the organizer dialled a port the API's door refuses").toEqual([]);
    expect(await rowOf(db, id)).toEqual({ errorCode: "connect", errorDetail: "MAILBOX_PORT_REFUSED" });
  }, 40000);

  it("a refused outgoing leg does not stop a healthy mailbox syncing", async () => {
    const id = await seed(db, accountId, { host: "imap2.door.example", port: 993 }, { host: "smtp2.door.example", port: 587 });
    const dialled: ImapConfig[] = [];
    const worker = await startWorker({
      databaseUrl: DB_URL, accountId, keyProvider: KP, pollIntervalMs: 500, sentDomain: "trafficflow.test",
      dialHostGuard: makeDialHostGuard(resolverOf({ "imap2.door.example": [PUBLIC], "smtp2.door.example": ["10.0.0.5"] })),
      adapterFactory: recorder(dialled),
    });
    closers.push(() => worker.stop());
    await waitFor(async () => dialled.length > 0 || (await rowOf(db, id)).errorCode !== null, 15000, "the attach to decide");
    // The recording adapter is thin, so what the attach does after the dial is not the subject here.
    expect(dialled.map((c) => [c.host, c.port, c.pin]), "the organizer never sends, yet its submission leg failed the attach")
      .toEqual([["imap2.door.example", 993, [PUBLIC]]]);
    expect((await rowOf(db, id)).errorDetail).not.toBe("MAILBOX_HOST_REFUSED");
  }, 40000);

  it("CONTROL: a healthy mailbox on mail ports attaches, pinned to what was cleared", async () => {
    const id = await seed(db, accountId, { host: "imap3.door.example", port: 993 });
    const dialled: ImapConfig[] = [];
    const worker = await startWorker({
      databaseUrl: DB_URL, accountId, keyProvider: KP, pollIntervalMs: 500, sentDomain: "trafficflow.test",
      dialHostGuard: makeDialHostGuard(resolverOf({ "imap3.door.example": [PUBLIC] })),
      adapterFactory: recorder(dialled),
    });
    closers.push(() => worker.stop());
    await waitFor(async () => dialled.length > 0, 15000, "the attach to assemble a dial");
    expect(dialled.map((c) => [c.host, c.port, c.pin])).toEqual([["imap3.door.example", 993, [PUBLIC]]]);
    expect(["MAILBOX_HOST_REFUSED", "MAILBOX_PORT_REFUSED"]).not.toContain((await rowOf(db, id)).errorDetail);
  }, 40000);
});
