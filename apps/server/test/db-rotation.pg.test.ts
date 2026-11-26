import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { setupProdDatabase } from "@trafficflow/db/admin";
import { LOCK_READERS, makeOwnedDb, readerStatement } from "@trafficflow/db/cloud";
import { MIGRATED_DB_SETUP_BUDGET_MS, realPgAvailable, throwawayDb } from "@trafficflow/db/testing";
import { plantAccount } from "../../../packages/db/test/_store-at-old-heads.js";
import { dbRotationProof, DB_ROTATION_PATH } from "../src/db-rotation.js";

const available = await realPgAvailable();
const database = throwawayDb("rotation_visibility");

it.skipIf(!available)("signs the proof only when the replacement can read the seeded account and message", async () => {
  const original = `${database.name}_original`;
  const replacement = `${database.name}_replacement`;
  const password = randomBytes(24).toString("hex");
  const account = randomUUID();
  const message = randomUUID();
  const unbound = randomUUID();
  const otherMessage = randomUUID();
  await database.create((url) => setupProdDatabase(url, { log() {} }));
  const ownerHandle = makeOwnedDb(database.url);
  const owner = ownerHandle.db.$client;
  try {
    await owner.unsafe(`create role ${original}; create role ${replacement} login password '${password}'`).simple();
    const planted = await plantAccount(owner, account);
    const other = await plantAccount(owner, unbound);
    await owner`insert into public.messages (id, account_id, mailbox_id, body_hash, dedup_key)
      values (${message}, ${account}, ${planted.mailboxId}, 'fixture', 'visible'),
             (${otherMessage}, ${unbound}, ${other.mailboxId}, 'fixture', 'unrelated')`;
    await owner`create schema ohmail`;
    for (const reader of LOCK_READERS) await owner.unsafe(readerStatement(reader));
    const messageView = (...roles: string[]) => `create or replace view ohmail.messages as
      select id, account_id from public.messages
      where account_id = ohmail.current_account() and current_user in (${roles.map((role) => `'${role}'`).join(", ")})`;
    await owner.unsafe(`
      alter table public.accounts enable row level security;
      alter table public.accounts force row level security;
      alter table public.messages enable row level security;
      alter table public.messages force row level security;
      create policy lock_account on public.accounts to ${original} using (id = ohmail.current_account());
      create policy lock_account on public.messages to ${original} using (account_id = ohmail.current_account());
      ${messageView(original)};
      grant usage on schema ohmail to ${replacement};
      grant select on public.accounts, public.messages, ohmail.messages to ${replacement};
    `).simple();

    const url = new URL(database.url);
    url.username = replacement;
    url.password = password;
    const config = { secret: randomBytes(32).toString("hex"), revision: "a".repeat(40),
      deployment: "fixture-deployment", pooled: url.href, session: url.href };
    const proof = dbRotationProof(config);
    const check = (messageId = message) => {
      const challenge = `${Date.now()}.${randomBytes(32).toString("hex")}`;
      const authorization = createHmac("sha256", config.secret)
        .update(JSON.stringify(["request", challenge, config.revision, config.deployment, account, messageId])).digest("hex");
      return proof(new Request(`http://localhost${DB_ROTATION_PATH}`, { method: "HEAD", headers: {
        authorization: `Ohmail-Rotation ${authorization}`,
        "x-ohmail-rotation-challenge": challenge,
        "x-ohmail-rotation-deployment": config.deployment,
        "x-ohmail-rotation-account": account,
        "x-ohmail-rotation-message": messageId,
      } }));
    };
    expect((await check()).status).toBe(503);
    await owner.unsafe(`alter policy lock_account on public.accounts to ${original}, ${replacement}`);
    await owner.unsafe(`alter policy lock_account on public.messages to ${original}, ${replacement}`);
    expect((await check()).status).toBe(503);
    await owner.unsafe(messageView(original, replacement));
    expect((await check()).status).toBe(200);
    expect((await check(otherMessage)).status).toBe(503);
    expect((await check(randomUUID())).status).toBe(503);
    await owner.unsafe(`alter policy lock_account on public.accounts to ${original}`);
    expect((await check()).status).toBe(503);
    await owner.unsafe(`alter policy lock_account on public.accounts to ${original}, ${replacement}`);
    await owner.unsafe(`revoke select on ohmail.messages from ${replacement}`);
    expect((await check()).status).toBe(503);
  } finally {
    await ownerHandle.close();
    try { await database.drop(); } finally {
      const adminUrl = new URL(database.url);
      adminUrl.pathname = "/postgres";
      const admin = makeOwnedDb(adminUrl.href);
      try { await admin.db.$client.unsafe(`drop role if exists ${replacement}, ${original}`); }
      finally { await admin.close(); }
    }
  }
}, MIGRATED_DB_SETUP_BUDGET_MS);
