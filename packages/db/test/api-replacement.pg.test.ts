import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { BINDER_SQL } from "../src/bound.js";
import { freshConnectProbe } from "../src/client.js";
import { readLock } from "../src/row-security/check.js";
import { API_REPLACEMENT_ROLE, API_ROLE } from "../src/row-security/logins.js";
import { MIGRATED_DB_SETUP_BUDGET_MS, MIGRATOR_ROLE, ownServersAvailable, startLockGround } from "../src/testing.js";
import { plantAccount } from "./_store-at-old-heads.js";

const database = "api_replacement";
const available = ownServersAvailable("packages/db/test/api-replacement.pg.test.ts");

it.skipIf(!available)("keeps the replacement API's direct grants and account isolation after hardening", async () => {
  const ground = await startLockGround(16, database, database);
  const owner = ground.connectAs(database);
  try {
    await ground.setup(database);
    await ground.makeRoles(database);
    await ground.setup(database, MIGRATOR_ROLE, { lock: "apply" });
    await ground.runRolesScript(database);

    await ground.runRolesScript(database, ground.server.superuser, { prepareApiReplacement: true });
    await ground.password(API_REPLACEMENT_ROLE);
    await ground.setup(database, MIGRATOR_ROLE, { lock: "apply" });
    await ground.runRolesScript(database);

    const { accountId, mailboxId } = await plantAccount(owner, randomUUID());
    await owner`insert into public.accounts (name) values ('Other synthetic account')`;
    const [message] = await owner<{ id: string }[]>`insert into public.messages (account_id, mailbox_id, body_hash, dedup_key)
      values (${accountId}, ${mailboxId}, 'fixture', 'rotation') returning id`;
    const probe = () => freshConnectProbe(ground.urlAs(database, API_REPLACEMENT_ROLE), {
      apiAccess: { account: accountId, message: message!.id }, memoMs: 0,
    })();
    expect((await probe()).ok).toBe(true);
    for (const role of [API_ROLE, API_REPLACEMENT_ROLE]) {
      const login = ground.connectAs(database, role);
      try {
        expect(await readLock(login, { role })).toMatchObject({ verdict: "locked", role: { member: 0, policies: "equal" } });
        await login.begin("read only", async (tx) => {
          await tx.unsafe(BINDER_SQL, [accountId, ""]);
          const rows = await tx<Array<{ id: string }>>`select id::text as id from public.accounts`;
          expect(rows.map((row) => row.id)).toEqual([accountId]);
          await tx`select id from ohmail.messages limit 1`;
        });
      } finally {
        await login.end({ timeout: 5 });
      }
    }

    await owner.unsafe(`revoke select on ohmail.messages from ${API_REPLACEMENT_ROLE}`);
    expect((await freshConnectProbe(ground.urlAs(database, API_REPLACEMENT_ROLE))()).ok).toBe(true);
    expect(await probe()).toMatchObject({ ok: false, code: "42501" });
    await ground.runRolesScript(database);
    expect((await probe()).ok).toBe(true);
  } finally {
    await owner.end({ timeout: 5 });
    ground.stop();
  }
}, MIGRATED_DB_SETUP_BUDGET_MS);
