import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { startWorker } from "../src/index.js";
import { dialHostGuardFromEnv } from "../src/dial-host-guard.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import {
  HOME_NAME, osAnswers, plainImap, resolverAnswering, type PlainServer,
} from "../../../test/support/plaintext-wire.js";

/**
 * THE ORGANIZER'S PLAINTEXT DIAL, through `startWorker` and the real adapter. A consent stored
 * for a server on the person's own network used to be honoured by name on every later dial, so a
 * name that now answers a public address got the LOGIN in clear. The wire is read by verb only.
 * Its own database, for the leader-lock reason `worker-dial-refusal.pg.test.ts` gives.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 12));
const USER = "home@home.example";
type Db = ReturnType<typeof makeDb>;

async function seedConsented(db: Db, accountId: string, port: number): Promise<string> {
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: USER }).returning();
  const enc = await KP.encrypt("imap-fixture");
  await db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: HOME_NAME, port, secure: false, user: USER, insecureConsent: true },
  });
  return mb!.id;
}

async function waitFor(p: () => Promise<boolean> | boolean, ms: number, what: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await p()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("the organizer's plaintext dial", () => {
  let DB_URL = "";
  let db!: Db;
  let accountId = "";
  const closers: Array<() => Promise<void>> = [];

  beforeAll(async () => { DB_URL = await prepareIsolatedDb("trafficflow_worker_plaintext"); db = makeDb(DB_URL); }, 60000);
  beforeEach(async () => { accountId = randomUUID(); await truncateAll(DB_URL); }, ISOLATED_DB_RESET_BUDGET_MS);
  afterEach(async () => { for (const c of closers.splice(0).reverse()) await c(); }, ISOLATED_DB_RESET_BUDGET_MS);

  async function run(scope: readonly string[], os: string | null): Promise<{ imap: PlainServer; mailboxId: string }> {
    const imap = await plainImap();
    closers.push(() => imap.close());
    const restore = osAnswers(os);
    closers.push(async () => restore());
    const mailboxId = await seedConsented(db, accountId, imap.port);
    const worker = await startWorker({
      databaseUrl: DB_URL, accountId, keyProvider: KP, pollIntervalMs: 500, sentDomain: "home.example",
      // The self-host policy, read the way config.ts reads it, with the resolver the dial asks.
      dialHostGuard: dialHostGuardFromEnv({ TF_PROBE_ALLOW_PRIVATE: "1" } as NodeJS.ProcessEnv, resolverAnswering(scope)),
    });
    closers.push(() => worker.stop());
    return { imap, mailboxId };
  }

  it("a consented name that now answers a public address is refused, with its sentence, and no LOGIN is sent", async () => {
    const { imap, mailboxId } = await run(["0.0.0.0"], "0.0.0.0");
    await waitFor(async () => {
      const [r] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
      return (r?.errorCode ?? null) !== null || imap.saw("LOGIN");
    }, 20000, "the dial to be refused or made");
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(imap.saw("LOGIN"), "the password went out in clear to a server off the person's network").toBe(false);
    expect(imap.connections()).toBe(0);
    expect(row!.errorCode).toBe("connect");
    expect(row!.errorDetail).toBe("MAILBOX_PLAINTEXT_REFUSED");
  }, 40000);

  it("a name still on the person's network keeps dialling, pinned to the address that was checked", async () => {
    // The OS no longer resolves the name, so only a dial carried to the checked address arrives.
    const { imap } = await run(["127.0.0.1"], null);
    await waitFor(() => imap.saw("LOGIN"), 20000, "the consented dial to reach its server");
    expect(imap.saw("LOGIN")).toBe(true);
  }, 40000);
});
