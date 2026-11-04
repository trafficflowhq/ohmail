import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import {
  accounts, mailboxes, mailboxCredentials, mailboxFolders, folderOps,
  UNMETERED_ACCESS, type AccessVerdict,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { StaticKeyProvider } from "@trafficflow/core";
import { makeMailboxService, ServiceError, type ServiceContext } from "../src/index.js";
import { FolderOpsService, setFoldersEnabled } from "../src/index.js";

/**
 * AN ERASED MAILBOX CAN BE NEITHER RE-CREDENTIALED NOR RE-FILLED — the services half.
 *
 * The erasure LEAVES the `mailboxes` row as the tombstone, so a key to it refuses the account's
 * sweep and nothing else. These two doors write rows hanging off that key — the sealed credential
 * and the folder verb's inventory row — and ask `mailboxes.erased_at` in the writing transaction.
 * `.pg` because the fence is a `share` read ordered against the erasure's `FOR UPDATE`, which one
 * connection cannot express. Mutations watched red, restored by `cmp`: the fence cut from
 * `upsertCredOn` (the PATCH is admitted and re-seals) and from `FolderOpsService.create`.
 */
const PG_UP = await realPgAvailable();

const NOW = new Date("2026-09-16T09:00:00.000Z");
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 9), 1);
const UNMETERED_READER = { accessOf: async (): Promise<AccessVerdict> => UNMETERED_ACCESS };
const PROBE_OK = { probe: async () => ({ verdict: "ok" as const }) };
const IMAP = { host: "imap.erased.test", port: 993, secure: true, user: "u", pass: "earlier-attempt-password" };

let sqlA: ReturnType<typeof postgres>;
let sqlB: ReturnType<typeof postgres>;
let dbA: ReturnType<typeof drizzle<typeof schema>>;
let dbB: ReturnType<typeof drizzle<typeof schema>>;

const svc = makeMailboxService({ keyProvider: KP, ...UNMETERED_READER });
const folders = new FolderOpsService();

beforeAll(async () => {
  if (!PG_UP) return;
  await runMigrations(PG_TEST_URL);
  sqlA = postgres(PG_TEST_URL, { max: 6, onnotice: () => {} });
  sqlB = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
  dbA = brandDialect(drizzle(sqlA, { schema }), "pg");
  dbB = brandDialect(drizzle(sqlB, { schema }), "pg");
}, 120_000);

afterAll(async () => {
  await Promise.all([sqlA?.end({ timeout: 5 }), sqlB?.end({ timeout: 5 })]);
}, 60_000);

const ctxOn = (db: typeof dbA, accountId: string): ServiceContext =>
  ({ db: db as unknown as ServiceContext["db"], accountId, userId: null, now: () => NOW, requestId: "r" });

async function seeded(): Promise<{ accountId: string; mailboxId: string; address: string }> {
  const [a] = await dbA.insert(accounts).values({ name: `erased-${randomUUID().slice(0, 8)}` }).returning();
  const address = `erase-${randomUUID().slice(0, 8)}@x.test`;
  const dto = await svc.create(ctxOn(dbA, a!.id), {
    provider: "imap", address, imap: IMAP,
  }, PROBE_OK);
  /* A CONNECT WRITES A CONSENT-LESS READER (mail 0083), and the folder verb refuses a reader
     before it reaches anything this file is about — measured, as `OrganizedElsewhereError`, on
     the first run. The promotion is the ordinary state a person is in when they create a folder,
     so it belongs in the fixture rather than in the cases. */
  await dbA.update(mailboxes)
    .set({ organizerRole: "organizer", organizeConsentedAt: NOW })
    .where(eq(mailboxes.id, dto.id));
  return { accountId: a!.id, mailboxId: dto.id, address };
}

/**
 * THE MAILBOX STAMP ALONE, from the OTHER connection — and never the real sweep, which would make
 * every case here green with no fence at all. `delete` writes `status = 'disabled'` and sweeps in
 * ONE transaction, and both doors refuse a disabled mailbox already, so the older refusal would
 * answer first. `status` stays `connected`: that is not a state the product reaches, and it is the
 * only one in which "does this door ask the erasure's own column?" has an answer. The ordinary
 * path is the last case, which runs the real erasure against a live PATCH on two connections.
 */
async function stampErased(mailboxId: string): Promise<void> {
  await dbB.update(mailboxes).set({ erasedAt: NOW }).where(eq(mailboxes.id, mailboxId));
}

/** What could have answered instead of the fence. Read after every refusal, never assumed. */
async function nothingElseAnswered(accountId: string, mailboxId: string): Promise<void> {
  const [mb] = await dbA.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
  expect(mb!.status, "the disabled refusal could have answered this").toBe("connected");
  const [acct] = await dbA.select().from(accounts).where(eq(accounts.id, accountId));
  expect(acct!.erasedAt, "the account arm could have answered this").toBeNull();
}

describe.skipIf(!PG_UP)("an erased mailbox stays erased", () => {
  it("CREDENTIAL — a password PATCH for an erased mailbox is refused and seals nothing", async () => {
    const s = await seeded();
    const before = await dbA.select().from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, s.mailboxId));
    expect(before, "the create should have sealed one credential").toHaveLength(1);
    const firstSecret = before[0]!.secretEnc;

    await stampErased(s.mailboxId);

    const refused = await svc.update(ctxOn(dbA, s.accountId), s.mailboxId, {
      imap: { ...IMAP, pass: "later-attempt-password" },
    }, PROBE_OK).then(() => null, (e: unknown) => e);

    expect(refused, "the PATCH was admitted").toBeInstanceOf(ServiceError);
    expect((refused as ServiceError).code).toBe("mailbox_erased");
    expect((refused as ServiceError).httpStatus).toBe(410);

    // …and the row is EXACTLY as it was: not a second row, and not the same row re-sealed with
    // the new password, which is what "re-minted" means and what a live way back in looks like.
    const after = await dbA.select().from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, s.mailboxId));
    expect(after).toHaveLength(1);
    expect(after[0]!.secretEnc).toBe(firstSecret);
    await nothingElseAnswered(s.accountId, s.mailboxId);
  });

  it("CREDENTIAL — the same PATCH on a live mailbox still seals, so the refusal is not everything", async () => {
    const s = await seeded();
    const before = await dbA.select().from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, s.mailboxId));
    await svc.update(ctxOn(dbA, s.accountId), s.mailboxId, {
      imap: { ...IMAP, pass: "later-attempt-password" },
    }, PROBE_OK);
    const after = await dbA.select().from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, s.mailboxId));
    expect(after).toHaveLength(1);
    expect(after[0]!.secretEnc, "the live PATCH did not re-seal").not.toBe(before[0]!.secretEnc);
  });

  it("FOLDER — a folder create for an erased mailbox writes neither the row nor the command", async () => {
    const s = await seeded();
    const ctx = ctxOn(dbA, s.accountId);
    await setFoldersEnabled(ctx, true);
    await stampErased(s.mailboxId);

    const name = `Receipts-${randomUUID().slice(0, 6)}`;
    const refused = await folders.create(ctx, { mailboxId: s.mailboxId, name })
      .then(() => null, (e: unknown) => e);

    expect(refused, "the folder verb was admitted").toBeInstanceOf(ServiceError);
    expect((refused as ServiceError).code).toBe("mailbox_erased");

    expect(await dbA.select().from(mailboxFolders)
      .where(eq(mailboxFolders.mailboxId, s.mailboxId))).toHaveLength(0);
    expect(await dbA.select().from(folderOps)
      .where(eq(folderOps.mailboxId, s.mailboxId))).toHaveLength(0);
    await nothingElseAnswered(s.accountId, s.mailboxId);
  });

  it("FOLDER — the same create on a live mailbox still records its command", async () => {
    const s = await seeded();
    const ctx = ctxOn(dbA, s.accountId);
    await setFoldersEnabled(ctx, true);
    const name = `Receipts-${randomUUID().slice(0, 6)}`;
    await folders.create(ctx, { mailboxId: s.mailboxId, name });
    expect(await dbA.select().from(mailboxFolders)
      .where(eq(mailboxFolders.mailboxId, s.mailboxId))).toHaveLength(1);
    expect(await dbA.select().from(folderOps)
      .where(eq(folderOps.mailboxId, s.mailboxId))).toHaveLength(1);
  });

  it("THE REAL ERASURE, concurrently — both interleavings end with no credential", async () => {
    /**
     * The production shape, on two connections: a credential PATCH and a real `delete --erase`,
     * started together. Whichever takes the `mailboxes` row first, the other waits — and the end
     * state is the same, which is the property the lock order exists for. Asserted rather than
     * timed: the two orders differ only in which call refuses, and the database must not be able
     * to tell you afterwards which one ran.
     */
    const s = await seeded();
    const [patch, erase] = await Promise.allSettled([
      svc.update(ctxOn(dbA, s.accountId), s.mailboxId, {
        imap: { ...IMAP, pass: "later-attempt-password" },
      }, PROBE_OK),
      svc.delete(ctxOn(dbB, s.accountId), s.mailboxId, { erase: { confirmAddress: s.address } }),
    ]);
    expect(erase.status, "the erasure itself must not fail").toBe("fulfilled");
    // The PATCH may be admitted (it won the row and its credential is swept behind it) or refused
    // (it waited and read the tombstone). Both are correct; neither may leave a credential.
    expect(["fulfilled", "rejected"]).toContain(patch.status);
    expect(await dbA.select().from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, s.mailboxId))).toHaveLength(0);
    const [mb] = await dbA.select().from(mailboxes).where(eq(mailboxes.id, s.mailboxId));
    expect(mb!.status).toBe("disabled");
    expect(mb!.erasedAt, "the sweep's own stamp").not.toBeNull();
  });
});
