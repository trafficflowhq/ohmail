import { accountOfMailbox } from "@trafficflow/db";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, mailboxes, mailboxCredentials } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { bootstrapEnvCreds, BootstrapRefusedError } from "../src/mailboxes.js";

/**
 * A TOMBSTONE IS NOT A TEMPLATE.
 *
 * An environment-bootstrap deployment names one mailbox in `TF_MAILBOX_ID` and seeds its
 * credentials from env on first start. A person removes that mailbox — the removal deletes the
 * credentials and leaves the row as a tombstone — and the next restart read the row it was
 * configured for and put their IMAP and SMTP passwords back on the deployment they had just taken
 * them off. Real Postgres because the refusal is the first statement of the transaction the
 * insert runs in, and a fence that is not in the writer's own transaction is not a fence.
 *
 * NOTHING IN THIS FILE PRINTS A SECRET: the fixture password is a constant of this file, the
 * assertions are on the ROW's presence and on the sealed column's absence, never on its value.
 */
const AVAILABLE = await realPgAvailable();
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7), 1);
/** A SENTINEL, not a credential: long and distinctive so "the ciphertext does not contain it" is
 *  a real assertion rather than one a base64 blob satisfies by accident. */
const SEALED_SENTINEL = "sentinel-never-a-real-secret-0191";
const ENV_IMAP = {
  host: "imap.lichtgrat.example", port: 993, secure: true, user: "u", pass: SEALED_SENTINEL,
};
const ENV_SMTP = { host: "smtp.lichtgrat.example", port: 465, secure: true };

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

/** One account and one mailbox, with the status the case is about and no credentials. */
async function seed(status: string, erasedAt: Date | null = null): Promise<{
  accountId: string; mailboxId: string;
}> {
  const [a] = await db.insert(accounts).values({ name: "bootstrap tombstone" }).returning();
  const accountId = a!.id;
  if (erasedAt) {
    await db.update(accounts).set({ erasedAt }).where(eq(accounts.id, accountId));
  }
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `b-${randomUUID().slice(0, 8)}@lichtgrat.example`, status,
  }).returning();
  return { accountId, mailboxId: mb!.id };
}

const credsOf = (mailboxId: string) => db.select({
  transport: mailboxCredentials.transport, secretEnc: mailboxCredentials.secretEnc,
}).from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, mailboxId));

describe.skipIf(!AVAILABLE)("env credential bootstrap refuses a tombstone", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 180_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("writes NO credential row for a removed mailbox, and says so by name", async () => {
    const { mailboxId } = await seed("disabled");

    await expect(bootstrapEnvCreds(db as never, KP, {
      mailboxId, imap: ENV_IMAP, smtp: ENV_SMTP,
    })).rejects.toBeInstanceOf(BootstrapRefusedError);

    // THE SEALED MATERIAL IS ASSERTED ABSENT, not merely the row: a bootstrap that wrote the
    // imap row and threw on the smtp one would leave the password on the deployment.
    expect(await credsOf(mailboxId)).toHaveLength(0);
  });

  it("writes NO credential row when the ACCOUNT was erased", async () => {
    const { mailboxId } = await seed("connected", new Date("2026-09-14T08:00:00.000Z"));

    await expect(bootstrapEnvCreds(db as never, KP, {
      mailboxId, imap: ENV_IMAP, smtp: ENV_SMTP,
    })).rejects.toThrow(/deleted/);

    expect(await credsOf(mailboxId)).toHaveLength(0);
  });

  it("writes NO credential row when the MAILBOX was erased and the account stands", async () => {
    // The status stays `connected`, so the tombstone refusal above cannot be what answers here:
    // only `mailboxes.erased_at` can, which is the scope this fence gained.
    const { accountId, mailboxId } = await seed("connected");
    await db.update(mailboxes).set({ erasedAt: new Date("2026-09-15T08:00:00.000Z") })
      .where(eq(mailboxes.id, mailboxId));

    await expect(bootstrapEnvCreds(db as never, KP, {
      mailboxId, imap: ENV_IMAP, smtp: ENV_SMTP,
    })).rejects.toBeInstanceOf(BootstrapRefusedError);

    expect(await credsOf(mailboxId)).toHaveLength(0);
    // The account is untouched, or the account arm could be what refused.
    const [a] = await db.select({ erasedAt: accounts.erasedAt })
      .from(accounts).where(eq(accounts.id, accountId));
    expect(a!.erasedAt, "the account was erased too — this case proves nothing").toBeNull();
  });

  it("POSITIVE CONTROL: an ordinary bootstrap still seals the mailbox it is configured for",
    async () => {
      const { mailboxId } = await seed("connected");

      await bootstrapEnvCreds(db as never, KP, {
        mailboxId, imap: ENV_IMAP, smtp: ENV_SMTP,
      });

      const rows = await credsOf(mailboxId);
      expect(rows.map((r) => r.transport).sort()).toEqual(["imap", "smtp"]);
      // Sealed, not stored: the column is ciphertext, and the plaintext is nowhere in it.
      for (const r of rows) expect(r.secretEnc).not.toContain(SEALED_SENTINEL);
    });

  it("still never overwrites a DB credential row that already exists", async () => {
    const { mailboxId } = await seed("connected");
    await db.insert(mailboxCredentials).values({
      mailboxId, accountId: accountOfMailbox(mailboxId), transport: "imap", secretEnc: "enc:already-here", keyVersion: 1,
    });

    await bootstrapEnvCreds(db as never, KP, { mailboxId, imap: ENV_IMAP, smtp: ENV_SMTP });

    const rows = await db.select({ secretEnc: mailboxCredentials.secretEnc })
      .from(mailboxCredentials)
      .where(and(eq(mailboxCredentials.mailboxId, mailboxId),
        eq(mailboxCredentials.transport, "imap")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.secretEnc).toBe("enc:already-here");
  });
});
