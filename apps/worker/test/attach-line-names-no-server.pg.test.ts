import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider, createLogger } from "@trafficflow/core";
import type { HostResolver } from "@trafficflow/core/net";
import { startWorkerWithLock } from "../src/index.js";
import { acquireLeaderLock } from "../src/leader-lock.js";
import { makeDialHostGuard } from "../src/dial-host-guard.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";

/**
 * NO LOG LINE NAMES A PERSON'S MAIL SERVER. The attach says it started before it dials, and that
 * line carried the stored IMAP host into the operator's log drain on every attach. The REAL logger
 * writes into a sink here, so the reading is what the drain receives, not what a call site hands a
 * fake. The stored host is a synthetic sentinel that a scripted resolver answers. Its own database,
 * for the leader-lock reason `worker-dial-refusal.pg.test.ts` states.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 17));
const PUBLIC = "93.184.216.34";
type Db = ReturnType<typeof makeDb>;
type Line = Record<string, unknown> & { event?: string };

const resolverOf = (answers: Record<string, string[]>): HostResolver => ({
  resolve: async (host: string) => {
    const a = answers[host];
    if (!a) throw new Error("no answer scripted for this name");
    return [...a];
  },
});

async function seed(db: Db, accountId: string, host: string): Promise<string> {
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "u@attach.example" }).returning();
  const enc = await KP.encrypt("fixture");
  await db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host, port: 993, secure: true, user: "u@attach.example" },
  });
  return mb!.id;
}

async function waitFor(p: () => boolean, ms: number, what: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (p()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("the attach's log lines name no mail server", () => {
  let DB_URL = "";
  let db!: Db;
  let accountId = "";
  const closers: Array<() => Promise<void>> = [];

  beforeAll(async () => { DB_URL = await prepareIsolatedDb("trafficflow_worker_attachline"); db = makeDb(DB_URL); }, 60000);
  beforeEach(async () => { accountId = randomUUID(); await truncateAll(DB_URL); }, ISOLATED_DB_RESET_BUDGET_MS);
  afterEach(async () => { for (const c of closers.splice(0)) await c(); }, ISOLATED_DB_RESET_BUDGET_MS);

  it("mailbox_attach_started says which mailbox and not which server", async () => {
    const sentinel = `attach-line-${randomUUID()}.mail.example`;
    const mailboxId = await seed(db, accountId, sentinel);
    const raw: string[] = [];
    const logger = createLogger({ service: "worker", level: "debug", sink: (l) => { raw.push(l); } });
    const lines = (): Line[] => raw.map((l) => JSON.parse(l) as Line);
    const fleet = new FakeAdapterFleet();
    const lock = await acquireLeaderLock(DB_URL);
    expect(lock, "this file's own database has no other leader").not.toBeNull();
    const worker = await startWorkerWithLock({
      databaseUrl: DB_URL, accountId, keyProvider: KP, pollIntervalMs: 600_000, rosterIntervalMs: 600_000,
      sentDomain: "trafficflow.test", logger, adapterFactory: fleet.factory,
      dialHostGuard: makeDialHostGuard(resolverOf({ [sentinel]: [PUBLIC] })),
    }, lock!);
    closers.push(() => worker.stop());
    await waitFor(() => lines().some((l) => l.event === "mailbox_attached"), 20000, "the attach to finish");

    const started = lines().filter((l) => l.event === "mailbox_attach_started");
    expect(started.map((l) => l.mailboxId), "the line still says which mailbox began attaching").toEqual([mailboxId]);
    expect.soft(started.filter((l) => JSON.stringify(l).includes(sentinel)).length,
      "mailbox_attach_started carries the stored mail server's name").toBe(0);
    // Every line the attach wrote, by event name only: the offending value is never printed.
    expect.soft(raw.filter((l) => l.includes(sentinel)).map((l) => (JSON.parse(l) as Line).event),
      "these lines carry the stored mail server's name").toEqual([]);
  }, 40000);
});
