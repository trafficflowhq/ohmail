import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accountSettings,
  accounts,
  drafts,
  flagState,
  folderState,
  mailboxCredentials,
  mailboxFolders,
  mailboxes,
  messageBodies,
  messageFailures,
  messageInstances,
  messages,
  outboundSendFingerprints,
  outboundSends,
  refreshTokens,
  users,
} from "@trafficflow/db";
import {
  accountStorageHolds,
  attachmentStaging,
  authThrottle,
  connectAttempts,
  credentials,
  erasedBearers,
  invites,
  loginTokens,
  mailboxOauthCeremonies,
  mailboxOauthDeviceCeremonies,
  oauthAuthCodes,
  recoveryCodes,
  totpSecrets,
  waitlist,
  webauthnChallenges,
  webauthnCredentials,
} from "@trafficflow/db/cloud";
import { deleteAccount, type ServiceContext } from "../src/index.js";
import {
  EXPIRED_NOT_DELETED, NOW, RETAINED, accountScopedTables, rowsOf, seedFullAccount,
  unseededScopedTables,
  type Db,
} from "./helpers/erasure-fixture.js";

/**
 * ART. 17 ERASURE, ON PGlite — the rulings, the catalog sweep, and the arithmetic.
 *
 * The seed and the catalog helpers live in `helpers/erasure-fixture.ts` because
 * `account-deletion.pg.test.ts` runs the same shape against real Postgres and the two must not be
 * able to disagree about what "a fully populated account" is. What is asserted HERE is behaviour
 * that PGlite can see perfectly well: which rows go, which survive, and what the result reports.
 *
 * The STRUCTURAL guard — "every FK-reachable table is either erased or on a written exemption
 * list, so the next table added fails until somebody rules on it" — is in the pg file, against
 * the catalog a real Postgres exposes.
 */

const ctxFor = (db: Db, accountId: string, userId: string): ServiceContext =>
  ({ db, accountId, userId, now: () => NOW, requestId: "del" });

describe("account deletion — Art. 17 erasure by anonymisation", () => {
  it("empties EVERY account-scoped table except the billing subject", async () => {
    // The load-bearing case. It reads the table list out of the catalog rather
    // than a hand-written array, so a table added later is erased or fails here.
    const db = await makeTestDb();
    const { accountId, userId } = await seedFullAccount(db);

    const tables = await accountScopedTables(db);
    expect(tables.length).toBeGreaterThan(25); // the list is real, not empty

    // Seed coverage first: this sweep can only clear a table it found rows in, so a table
    // the fixture leaves empty is admitted vacuously — `screener_suggest_owed` was, 0 -> 0 with
    // no deleter anywhere. An unseedable table is a red, not a skip.
    expect(
      await unseededScopedTables(db, accountId, tables),
      "an account-scoped table seedFullAccount leaves empty — this sweep passes over it vacuously",
    ).toEqual([]);

    await deleteAccount(ctxFor(db, accountId, userId));

    const survivors: string[] = [];
    for (const t of tables) {
      if (RETAINED.has(t) || EXPIRED_NOT_DELETED.has(t)) continue;
      const rows = await db.execute(
        sql`select count(*)::int as c from ${sql.identifier(t)} where account_id = ${accountId}`,
      );
      const c = rowsOf<{ c: number }>(rows)[0]!.c;
      if (c > 0) survivors.push(`${t} (${c})`);
    }
    expect(survivors, "personal data survived erasure").toEqual([]);
  });

  it("keeps the live tokens' HASHES for the session door, and nothing that could name a person", async () => {
    // The one table the erasure WRITES (cloud 0043, RETAINED in the fixture): an app still
    // holding a token is told the account was deleted. The column set is the ruling's evidence.
    const db = await makeTestDb();
    const { accountId, userId } = await seedFullAccount(db);
    const live = await db.select({ h: refreshTokens.tokenHash }).from(refreshTokens)
      .where(eq(refreshTokens.accountId, accountId));
    expect(live.length, "the fixture seeds no live token to keep").toBeGreaterThan(0);
    await deleteAccount(ctxFor(db, accountId, userId));
    const kept = await db.select().from(erasedBearers).where(eq(erasedBearers.accountId, accountId));
    expect(kept.map((r) => r.tokenHash).sort()).toEqual(live.map((r) => r.h).sort());
    const cols = rowsOf<{ column_name: string }>(await db.execute(sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'erased_bearers' order by column_name`));
    expect(cols.map((c) => c.column_name)).toEqual(["account_id", "expires_at", "token_hash"]);
  });

  it("erases the rows that key off the user or the mailbox, not the account", async () => {
    // These tables have no `account_id` at all, so the catalog sweep above cannot
    // see them — they are the ones a naive "delete where account_id" would miss.
    const db = await makeTestDb();
    const { accountId, userId, email } = await seedFullAccount(db);
    await deleteAccount(ctxFor(db, accountId, userId));

    expect(await db.select().from(users).where(eq(users.accountId, accountId))).toHaveLength(0);
    expect(await db.select().from(credentials).where(eq(credentials.userId, userId))).toHaveLength(0);
    expect(await db.select().from(totpSecrets).where(eq(totpSecrets.userId, userId))).toHaveLength(0);
    expect(await db.select().from(recoveryCodes).where(eq(recoveryCodes.userId, userId))).toHaveLength(0);
    expect(await db.select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, userId))).toHaveLength(0);
    expect(await db.select().from(webauthnChallenges).where(eq(webauthnChallenges.userId, userId))).toHaveLength(0);
    expect(await db.select().from(loginTokens).where(eq(loginTokens.userId, userId))).toHaveLength(0);
    expect(await db.select().from(oauthAuthCodes).where(eq(oauthAuthCodes.userId, userId))).toHaveLength(0);
    // mailbox_credentials is the one that would be a breach if it survived.
    expect(await db.select().from(mailboxCredentials)).toHaveLength(0);
    expect(await db.select().from(mailboxFolders)).toHaveLength(0);
    // Bodies, folder state and flag state key off the message.
    expect(await db.select().from(messageBodies)).toHaveLength(0);
    expect(await db.select().from(folderState)).toHaveLength(0);
    // `flag_state` has no `account_id`, so the catalog sweep above is structurally blind to it —
    // and it is written for every message the sync loop ingests.
    expect(await db.select().from(flagState), "read state survived erasure").toHaveLength(0);
    // Throttle keys carry the email and the user id verbatim.
    expect(await db.select().from(authThrottle)).toHaveLength(0);
    expect(email).toContain("@"); // the address itself is gone; only this local copy remains
  });

  it("keeps the account as a pseudonymous subject", async () => {
    // THE ACCOUNT ROW SURVIVES and its name goes. A uuid is not personal data, and records
    // elsewhere — including whatever an entitlements program holds — point at it.
    //
    // What this case USED to also assert is gone with the tables: the ledger, the subscription
    // and the customer's address are not in this database any more. Erasure reaches them
    // through the port's `releaseAccount`, and the program that holds them is where their own
    // erasure is proven.
    const db = await makeTestDb();
    const { accountId, userId } = await seedFullAccount(db);
    await deleteAccount(ctxFor(db, accountId, userId));

    const [acct] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(acct, "the subject must survive — records elsewhere point at it").toBeDefined();
    expect(acct!.name).toBe("");                       // a uuid is not personal data; a name is
  });

  it("erases what an ORDINARY SYNC writes — the three tables that made erasure fail outright", async () => {
    // `message_instances`, `message_failures` and `flag_state` FK `messages`/`mailboxes` with
    // `ON DELETE no action` and are written by any account that has fetched mail, so before this
    // was fixed `DELETE /account` raised 23503 and rolled the whole erasure back. The bug was
    // never "data was retained" — it was that erasure did not work at all.
    const db = await makeTestDb();
    const { accountId, userId } = await seedFullAccount(db);

    // The seed is real: two instances (a message in two folders) and one failure.
    expect(await db.select().from(messageInstances)).toHaveLength(2);
    expect(await db.select().from(messageFailures)).toHaveLength(1);
    expect(await db.select().from(flagState)).toHaveLength(1);

    const result = await deleteAccount(ctxFor(db, accountId, userId));
    expect(result.deleted.message_instances).toBe(2);
    expect(result.deleted.message_failures).toBe(1);
    expect(result.deleted.flag_state).toBe(1);

    expect(await db.select().from(messageInstances)).toHaveLength(0);
    expect(await db.select().from(messageFailures)).toHaveLength(0);
    expect(await db.select().from(flagState)).toHaveLength(0);
  });

  it("erases the HOSTED-ONLY account rows, which no foreign key would ever have complained about", async () => {
    // Every one of these FKs `accounts`, and `accounts` survives erasure — so unlike the three
    // above they broke nothing and simply outlived the Art. 17 request.
    const db = await makeTestDb();
    const { accountId, userId } = await seedFullAccount(db);
    const result = await deleteAccount(ctxFor(db, accountId, userId));

    expect(result.deleted.account_settings).toBe(1);
    expect(result.deleted.mailbox_oauth_ceremonies).toBe(1);

    expect(await db.select().from(accountSettings)).toHaveLength(0);
    expect(await db.select().from(mailboxOauthCeremonies)).toHaveLength(0);
    /*
     * THE DEVICE CEREMONY (cloud 0027) — asserted by COUNT and by ROW, because the structural test
     * next door accepts the presence of the `deleted` key alone and would stay green on a DELETE
     * whose predicate matched nothing. What survives such a bug is a sealed `device_code`, which is
     * a bearer credential for a live sign-in, belonging to an account that asked to be erased.
     */
    expect(result.deleted.mailbox_oauth_device_ceremonies).toBe(1);
    expect(await db.select().from(mailboxOauthDeviceCeremonies)).toHaveLength(0);
    // How connecting a mailbox ended (cloud 0054): by count and by row, for the reason above.
    expect(result.deleted.connect_attempts).toBe(1);
    expect(await db.select().from(connectAttempts)).toHaveLength(0);
    // A lower storage limit's hold (cloud 0055): by count and by row, for the reason above.
    expect(result.deleted.account_storage_holds).toBe(1);
    expect(await db.select().from(accountStorageHolds)).toHaveLength(0);
  });

  it("brings staged attachment tickets forward to expire NOW, rather than orphaning the bytes", async () => {
    // The one exemption from the catalog sweep, and the assertion that keeps it honest. A staging
    // row is the only key to an object in the bucket and the worker's sweep deletes row and
    // object together on `expires_at <= now()`; deleting the row here would strand the attachment
    // in storage for the life of the deployment, which is a WORSE Art. 17 outcome than a
    // filename surviving one maintenance interval.
    const db = await makeTestDb();
    const { accountId, userId } = await seedFullAccount(db);

    const [before] = await db.select().from(attachmentStaging)
      .where(eq(attachmentStaging.accountId, accountId));
    expect(before!.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());

    const result = await deleteAccount(ctxFor(db, accountId, userId));
    expect(result.stagingTicketsExpired).toBe(1);

    const [after] = await db.select().from(attachmentStaging)
      .where(eq(attachmentStaging.accountId, accountId));
    expect(after, "the row must SURVIVE — it is the sweep's delete key").toBeDefined();
    expect(after!.expiresAt.getTime(), "due now, so the next sweep takes row and object")
      .toBe(NOW.getTime());
    // …and the object path is intact, which is the whole point of not deleting the row.
    expect(after!.objectPath).toBe(before!.objectPath);
  });

  it("is idempotent — a retried deletion is a no-op, not an error", async () => {
    const db = await makeTestDb();
    const { accountId, userId } = await seedFullAccount(db);

    const first = await deleteAccount(ctxFor(db, accountId, userId));
    expect(first.usersErased).toBe(1);
    expect(first.deleted.messages).toBe(1);
    expect(first.deleted.mailbox_credentials).toBe(1);
    expect(first.stagingTicketsExpired).toBe(1);

    const second = await deleteAccount(ctxFor(db, accountId, userId));
    expect(second.usersErased).toBe(0);
    expect(Object.values(second.deleted).reduce((a, b) => a + b, 0)).toBe(0);
    // The staging UPDATE is bounded by `expires_at > now`, so the already-expired ticket is not
    // touched a second time. Without that predicate this would report 1 for ever.
    expect(second.stagingTicketsExpired).toBe(0);
  });

  it("touches nothing belonging to another account", async () => {
    const db = await makeTestDb();
    const mine = await seedFullAccount(db, "Erased");
    const theirs = await seedFullAccount(db, "Mila Brunner");

    await deleteAccount(ctxFor(db, mine.accountId, mine.userId));

    expect(await db.select().from(users).where(eq(users.accountId, theirs.accountId))).toHaveLength(1);
    expect(await db.select().from(messages).where(eq(messages.accountId, theirs.accountId))).toHaveLength(1);
    expect(await db.select().from(mailboxes).where(eq(mailboxes.accountId, theirs.accountId))).toHaveLength(1);
    expect(await db.select().from(authThrottle)).toHaveLength(2); // theirs only
    const [other] = await db.select().from(accounts).where(eq(accounts.id, theirs.accountId));
    expect(other!.name).toBe("Mila Brunner");
  });
});


/**
 * A CHILD ROW THAT BLOCKS ERASURE IS WORSE THAN A DUPLICATE ROW.
 *
 * `outbound_send_fingerprints.send_id` references `outbound_sends`, and three paths delete
 * reservations directly: the desktop's mirror wipe, the local mirror's per-draft cleanup, and this
 * erasure. With a plain reference all three failed with SQLSTATE 23503 — and the desktop's wipe
 * handler CATCHES its own failure and answers 200, so removing a mailbox looked successful, left
 * the rows behind, and re-adding it showed the old mail beside its newly synced copy.
 *
 * Erasure failing is the sharper half: an account that cannot be erased is a promise this product
 * makes and would not have kept. The reference cascades, and this is the case that says so.
 */
describe("account deletion — a send's content claim does not block erasure", () => {
  it("erases an account that has a reservation with a content claim on it", async () => {
    const db = await makeTestDb();
    const { accountId, userId } = await seedFullAccount(db);

    const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.accountId, accountId));
    const [draft] = await db.insert(drafts).values({
      accountId, mailboxId: mb!.id, subject: "s", body: "b",
      to: [{ name: null, address: "you@example.com" }], status: "sent",
    }).returning();
    const [res] = await db.insert(outboundSends).values({
      accountId, idempotencyKey: "erase-me", draftId: draft!.id,
      mintedMessageId: "<erase@example.com>", status: "sent", createdAt: NOW,
    }).returning();
    await db.insert(outboundSendFingerprints).values({
      accountId, mailboxId: mb!.id, fingerprint: "a".repeat(64), sendId: res!.id, createdAt: NOW,
    });

    // The whole assertion: this used to raise 23503 and now completes.
    await deleteAccount(ctxFor(db, accountId, userId));

    expect(await db.select().from(outboundSends).where(eq(outboundSends.accountId, accountId)))
      .toHaveLength(0);
    expect(await db.select().from(outboundSendFingerprints)
      .where(eq(outboundSendFingerprints.accountId, accountId)),
      "the claim goes with the reservation it pointed at").toHaveLength(0);
  });
});

/**
 * THE SIGNUP FUNNEL, which an Art. 17 erasure used to leave standing.
 *
 * `invites.email` and `waitlist.email` are how somebody got in, keyed by their address. Neither
 * table carries an `account_id` and neither is reachable from the account's foreign-key graph, so
 * the structural guard in the pg file cannot see either of them — and the sweep, written against
 * that graph, never touched them. An erased person's address stayed on file in two places.
 *
 * They are PSEUDONYMISED rather than deleted: the operator's funnel counts (waiting, invited,
 * registered) are a fact about the service; the address is a fact about a person.
 */
describe("account deletion — the signup funnel", () => {
  it("pseudonymises the invite and the waitlist entry, and leaves the neighbour's alone", async () => {
    const db = await makeTestDb();
    const mine = await seedFullAccount(db, "Erased");
    const theirs = await seedFullAccount(db, "Neighbour");

    const result = await deleteAccount(ctxFor(db, mine.accountId, mine.userId));
    expect(result.redacted.invites).toBe(1);
    expect(result.redacted.waitlist).toBe(1);

    const [invite] = await db.select().from(invites).where(eq(invites.id, mine.inviteId));
    const [listed] = await db.select().from(waitlist).where(eq(waitlist.id, mine.waitlistId));
    // The ROWS survive — the funnel count is the operator's record — and the address does not.
    expect(invite, "the invite record is the operator's, and stays").toBeDefined();
    expect(listed, "the waitlist entry is the operator's, and stays").toBeDefined();
    expect(invite!.email).not.toBe(mine.email);
    expect(listed!.email).not.toBe(mine.email);
    // Pseudonymous, not blank, and unique per row: `waitlist_email_unique` still has to hold when
    // two of an account's users were both on the list.
    expect(invite!.email).toMatch(/^erased-[0-9a-f-]{36}@invalid$/);
    expect(listed!.email).toMatch(/^erased-[0-9a-f-]{36}@invalid$/);

    // The reach is the erased account's addresses and nothing else.
    const [neighbourInvite] = await db.select().from(invites).where(eq(invites.id, theirs.inviteId));
    const [neighbourListed] = await db.select().from(waitlist).where(eq(waitlist.id, theirs.waitlistId));
    expect(neighbourInvite!.email, "another account's invite was redacted").toBe(theirs.email);
    expect(neighbourListed!.email, "another account's waitlist entry was redacted").toBe(theirs.email);

    // And nothing anywhere still carries the address, which is the promise Art. 17 makes.
    const hits = rowsOf<{ c: number }>(await db.execute(sql`
      select ((select count(*) from invites where email = ${mine.email})
           + (select count(*) from waitlist where email = ${mine.email}))::int as c
    `));
    expect(hits[0]!.c, "the erased address survives in the signup funnel").toBe(0);
  });

  it("is idempotent — a second erasure redacts nothing and does not fail", async () => {
    const db = await makeTestDb();
    const mine = await seedFullAccount(db, "Twice");
    await deleteAccount(ctxFor(db, mine.accountId, mine.userId));
    const again = await deleteAccount(ctxFor(db, mine.accountId, mine.userId));
    expect(again.redacted.invites).toBe(0);
    expect(again.redacted.waitlist).toBe(0);
  });
});
