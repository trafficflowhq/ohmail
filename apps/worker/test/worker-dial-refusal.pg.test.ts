import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import type { ImapConfig } from "@trafficflow/core/adapters/imap";
import { startWorker } from "../src/index.js";
import { makeDialHostGuard } from "../src/dial-host-guard.js";
import { imapCfg } from "./_workerenv.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";

/**
 * THE ALWAYS-ON ORGANIZER'S OWN ATTACH, END TO END. The arms beside this one drive the helper; this
 * one drives `startWorker`'s real path — roster, credential decrypt, config assembly, the failure
 * write — against a mail server on a LOOPBACK address, which is exactly the range the managed
 * policy refuses and the self-host policy admits. The rig's GreenMail IS that server, so the
 * subject is a real stored credential pointing at a real listener, not a description of one.
 *
 * ITS OWN DATABASE, for the reason `worker-multimailbox.e2e.test.ts` states: the worker takes a
 * per-shard advisory leader lock that is global to the database it is pointed at, so on a shared
 * one a sibling file's worker holds it and this one sits in standby and never attaches — measured
 * here as both arms timing out with nothing wrong with either.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 11));

type Db = ReturnType<typeof makeDb>;

async function seedMailbox(db: Db, accountId: string, port?: number): Promise<{ id: string; host: string }> {
  const cfg = imapCfg();
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: cfg.auth.user }).returning();
  const enc = await KP.encrypt(cfg.auth.pass);
  await db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    // The stored host is the rig's own listener — a loopback address, which is what makes this
    // mailbox the subject: the managed policy will not dial it, the self-host policy will.
    meta: { host: cfg.host, port: port ?? cfg.port, secure: false, user: cfg.auth.user },
  });
  return { id: mb!.id, host: cfg.host };
}

async function rowOf(db: Db, id: string): Promise<{ errorCode: string | null; errorDetail: string | null; status: string }> {
  const [r] = await db.select().from(mailboxes).where(eq(mailboxes.id, id));
  return { errorCode: r!.errorCode, errorDetail: r!.errorDetail, status: r!.status };
}

async function waitFor(p: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await p()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("the organizer's attach, under each deployment policy", () => {
  let DB_URL = "";
  let db!: Db;
  let accountId = "";
  const closers: Array<() => Promise<void>> = [];

  beforeAll(async () => { DB_URL = await prepareIsolatedDb("trafficflow_worker_dial"); db = makeDb(DB_URL); }, 60000);
  beforeEach(async () => { accountId = randomUUID(); await truncateAll(DB_URL); }, ISOLATED_DB_RESET_BUDGET_MS);
  afterEach(async () => { for (const c of closers.splice(0)) await c(); }, ISOLATED_DB_RESET_BUDGET_MS);

  it("MANAGED: a mailbox whose server is at a private address is refused, and never dialled", async () => {
    // At 993, a port the dial door's port rule admits: that rule decides first, and the rig's own
    // port is not a mail port, so this arm would read MAILBOX_PORT_REFUSED and never reach the host.
    const { id: mailboxId } = await seedMailbox(db, accountId, 993);
    const dialled: ImapConfig[] = [];

    const worker = await startWorker({
      databaseUrl: DB_URL, accountId, keyProvider: KP,
      pollIntervalMs: 500, sentDomain: "trafficflow.test",
      // The MANAGED policy, injected rather than read from the environment, because the suite
      // declares the self-host one (see `test/setup/no-external-network.ts`). The resolver is never
      // reached: a stored loopback LITERAL is decided without a lookup.
      dialHostGuard: makeDialHostGuard({ resolve: async () => { throw new Error("must not resolve"); } }),
      adapterFactory: (cfg) => { dialled.push(cfg); throw new Error("the factory must not be reached"); },
    });
    closers.push(() => worker.stop());

    await waitFor(async () => (await rowOf(db, mailboxId)).errorCode !== null, 15000, "the refusal to be recorded");
    const row = await rowOf(db, mailboxId);

    // THE CLASS IS THE DECISION. `connect` — no connection was made — with the closed token beside
    // it saying WHICH connect failure it was. Never `auth` (nothing was presented) and never
    // `unknown`, which is where this fell before the classifier arm existed.
    expect(row.errorCode).toBe("connect");
    expect(row.errorDetail).toBe("MAILBOX_HOST_REFUSED");
    // And the dial never happened: the check runs before the adapter is built, so a server this
    // deployment will not reach costs the mailbox no socket and no connection slot.
    expect(dialled, "the refusal must come before the adapter is constructed").toEqual([]);
  }, 40000);

  it("SELF-HOST: the same mailbox is dialled, by name, with nothing pinned", async () => {
    // The positive control for the arm above. Without it "refused" is satisfied by a worker that
    // cannot attach this mailbox for any reason at all.
    const { id: mailboxId, host: storedHost } = await seedMailbox(db, accountId);
    const dialled: ImapConfig[] = [];

    const worker = await startWorker({
      databaseUrl: DB_URL, accountId, keyProvider: KP,
      pollIntervalMs: 500, sentDomain: "trafficflow.test",
      // NO `dialHostGuard` ON PURPOSE — this arm drives the composition's own read of the
      // environment, which the suite sets to the self-host answer (`test/setup/no-external-
      // network.ts`). Without an arm that omits it, the fallback ships unexecuted.
      adapterFactory: (cfg, ctx) => {
        dialled.push(cfg);
        return {
          connect: async () => {},
          close: async () => {},
          changesSince: async () => ({ creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} }, hasBacklog: false }),
          ensureFolders: async () => {},
          leaseIo: () => ({ read: async () => [], append: async () => {}, expunge: async () => {} }),
          onConnectionError: ctx.onConnectionError,
        } as never;
      },
    });
    closers.push(() => worker.stop());

    await waitFor(async () => dialled.length > 0, 15000, "the attach to assemble a dial");
    const cfg = dialled[0]!;
    // A LAN mail server behind a name only the operator's resolver knows has nothing to pin, so
    // the dial is by name exactly as it was before this guard existed.
    expect(cfg.pin, "the admitting policy clears nothing and therefore pins nothing").toBeUndefined();
    expect(cfg.host, "the dial is by the stored NAME").toBe(storedHost);
    expect((await rowOf(db, mailboxId)).errorDetail).not.toBe("MAILBOX_HOST_REFUSED");
  }, 40000);

  it("the dial carries the Sent, Junk and Trash the last attach recorded — a role never moves by a name guess", async () => {
    // Mutation watched red (2026-10-02): dropping `storedFolders` from the attach's config.
    const { id: mailboxId } = await seedMailbox(db, accountId);
    await db.update(mailboxes).set({ sentFolder: "Gesendete Elemente", junkFolder: "Spam", trashFolder: "Papierkorb" })
      .where(eq(mailboxes.id, mailboxId));
    const dialled: ImapConfig[] = [];
    const worker = await startWorker({
      databaseUrl: DB_URL, accountId, keyProvider: KP, pollIntervalMs: 500, sentDomain: "trafficflow.test",
      adapterFactory: (cfg, ctx) => {
        dialled.push(cfg);
        return {
          connect: async () => {},
          close: async () => {},
          changesSince: async () => ({ creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} }, hasBacklog: false }),
          ensureFolders: async () => {},
          leaseIo: () => ({ read: async () => [], append: async () => {}, expunge: async () => {} }),
          onConnectionError: ctx.onConnectionError,
        } as never;
      },
    });
    closers.push(() => worker.stop());
    await waitFor(async () => dialled.length > 0, 15000, "the attach to assemble a dial");
    expect(dialled[0]!.storedFolders).toEqual({ sent: "Gesendete Elemente", junk: "Spam", trash: "Papierkorb" });
  }, 40000);
});
