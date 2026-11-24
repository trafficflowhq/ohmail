/* @postpush: alone — each case uses a database at the released journal heads. */
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { makeOwnedDb, readLock } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { MIGRATED_DB_TEARDOWN_BUDGET_MS, MIGRATOR_ROLE, ownServersAvailable, realPgAvailable, startLockGround, throwawayDb } from "../../../packages/db/src/testing.js";
import { fingerprintOf } from "../../../packages/db/test/_plant-1-0-11.js";
import { keyRingVar } from "../../../test/support/key-ring-env.js";
import { makeStoreAtOldHeads, plantAccount } from "../../../packages/db/test/_store-at-old-heads.js";

const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const pgUp = await realPgAvailable();
const own = ownServersAvailable("apps/server/test/cloud-migration.pg.test.ts");
const databases: ReturnType<typeof throwawayDb>[] = [];
const key = randomBytes(32);
const ring = new StaticKeyProvider({ 1: key });

afterAll(async () => {
  for (const db of databases) await db.drop();
}, MIGRATED_DB_TEARDOWN_BUDGET_MS);

async function legacy(label: string) {
  const db = throwawayDb(label);
  databases.push(db);
  await db.create(makeStoreAtOldHeads);
  return db;
}

function migrate(url: string, keyValue: Buffer, args: string[]) {
  const result = spawnSync("npm", ["run", "db:setup:server", "--", ...args], {
    cwd: workspace,
    env: {
      PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS,
      npm_config_userconfig: "/dev/null", npm_config_globalconfig: `${workspace}/node_modules/.fixture-npm-global`,
      DATABASE_URL_SESSION: url, DATABASE_URL_POOLED: url,
      TF_ENV: "development", TF_PROD_DB_HOST: new URL(url).hostname,
      [keyRingVar(1)]: keyValue.toString("hex"),
    },
    encoding: "utf8", timeout: 15_000,
  });
  return { status: result.status, out: result.stdout + result.stderr };
}

async function withFixture<T>(label: string, run: (sql: Parameters<typeof plantAccount>[0], url: string) => Promise<T>) {
  const db = await legacy(label);
  const fixture = makeOwnedDb(db.url);
  const sql = fixture.db.$client;
  try {
    const { mailboxId } = await plantAccount(sql, randomUUID());
    for (const transport of ["imap", "smtp"]) {
      const sealed = await ring.encrypt(randomBytes(24).toString("hex"));
      await sql`insert into mailbox_credentials (mailbox_id, transport, secret_enc, key_version)
        values (${mailboxId}, ${transport}, ${sealed.ciphertext}, ${sealed.keyVersion})`;
    }
    return await run(sql, db.url);
  } finally {
    await fixture.close();
  }
}

describe.skipIf(!pgUp)("the server migration command", () => {
  it("opens every sealed value and records both journals", async () => {
    await withFixture("server_migration_opens", async (sql, url) => {
      const result = migrate(url, key, ["--store", "cloud"]);
      expect(result.out).toContain("mailbox_credentials.secret_enc: 2 rows, 2 opened, 0 failed");
      expect(result.status).toBe(0);
      expect(result.out.match(/^\[db:setup:prod\] OK — mail \d+\/\d+, cloud \d+\/\d+/gm)).toHaveLength(1);
      expect((await sql`select to_regclass('public.cal_connections') is not null as moved`)[0]?.moved).toBe(true);
    });
  }, 25_000);

  it("rolls back with the wrong ring and names the sealed column", async () => {
    await withFixture("server_migration_wrong_ring", async (sql, url) => {
      const before = await fingerprintOf(sql);
      const result = migrate(url, randomBytes(32), ["--store", "cloud"]);
      expect(result.out).toMatch(/rolled back whole at sealed:.*mailbox_credentials.secret_enc: expected 0, found 2/);
      expect(result.status).toBe(1);
      expect(await fingerprintOf(sql)).toEqual(before);
    });
  }, 25_000);

  it.skipIf(!own)("a locked Cloud retry requires a ring that opens the stored values", async () => {
    const database = "ground";
    const g = await startLockGround(17, "migration_retry", database);
    const fixture = g.connectAs(database);
    try {
      const url = g.urlAs(database);
      await makeStoreAtOldHeads(url);
      const { accountId, mailboxId } = await plantAccount(fixture, randomUUID());
      const [user] = await fixture<{ id: string }[]>`insert into users (account_id, email)
        values (${accountId}, ${[randomUUID(), "example.invalid"].join("@")}) returning id`;
      const plaintext = randomBytes(24).toString("hex");
      const sealed = await ring.encrypt(plaintext);
      await fixture`insert into mailbox_credentials (mailbox_id, transport, secret_enc, key_version)
        values (${mailboxId}, 'imap', ${sealed.ciphertext}, ${sealed.keyVersion})`;
      await fixture`insert into totp_secrets (user_id, secret_enc, key_version)
        values (${user!.id}, ${sealed.ciphertext}, ${sealed.keyVersion})`;
      const first = migrate(url, key, ["--store", "cloud"]);
      const failure = first.out.split("\n").find((line) => line.startsWith("[db:setup:prod] FAILED:"))
        ?.replace(/\S+@\S+|[A-Za-z0-9_-]{32,}/g, "[fixture]");
      expect(first.status, failure).toBe(0);
      expect(first.out).toContain("mailbox_credentials.secret_enc: 1 rows, 1 opened, 0 failed");
      expect(first.out).toContain("totp_secrets.secret_enc: 1 rows, 1 opened, 0 failed");
      expect(first.out.match(/^\[db:setup:prod\] SEALED_VALUES_OK$/gm)).toHaveLength(1);

      await g.makeRoles(database);
      await g.setup(database, MIGRATOR_ROLE, { lock: "apply" });
      for (const role of ["ohmail_api", "ohmail_worker"] as const) {
        const login = g.connectAs(database, role);
        try {
          const lock = await readLock(login, { role });
          expect(lock.verdict).toBe("locked");
          expect(lock.forced).toBe(lock.listed);
          expect(lock.role.bypass).toBe(false);
        } finally {
          await login.end();
        }
      }

      const lockedUrl = g.urlAs(database, MIGRATOR_ROLE);
      const wrong = randomBytes(32);
      const retry = migrate(lockedUrl, wrong, ["--store", "cloud", "--lock"]);
      expect(retry.status).toBe(1);
      expect(retry.out).toContain("[db:setup:prod] FAILED: the configured ring could not open the store's sealed values");
      expect(retry.out).not.toContain("[db:setup:prod] OK");
      for (const sensitive of [wrong.toString("hex"), key.toString("hex"), plaintext, sealed.ciphertext]) {
        expect(retry.out.includes(sensitive)).toBe(false);
      }

      const correct = migrate(lockedUrl, key, ["--store", "cloud", "--lock"]);
      expect(correct.status).toBe(0);
      expect(correct.out).toContain("mailbox_credentials.secret_enc: 1 sampled, 1 opened, 0 failed");
      expect(correct.out).toContain("totp_secrets.secret_enc: 1 sampled, 1 opened, 0 failed");
      expect(correct.out.match(/^\[db:setup:prod\] SEALED_VALUES_OK$/gm)).toHaveLength(1);
    } finally {
      await fixture.end();
      g.stop();
    }
  }, 120_000);

  it("requires the store kind before any database or server setup", () => {
    const result = migrate("postgresql://127.0.0.1:1/postgres", key, []);
    expect(result.out).toContain("--store cloud or --store server is required");
    expect(result.status).toBe(1);
  });
});
