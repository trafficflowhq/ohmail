import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  accounts, contacts, mailboxes, mailboxProfileMirror, messageFailures, messageInstances,
} from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { carryDialect } from "@trafficflow/db/dialect";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { planChange, commitChange, UNMETERED_STORAGE_CAP, type Change } from "@trafficflow/core/mail";
import { applyProfileRead } from "../src/profile.js";

/**
 * A UID the server may issue is a UID every worker writer stores — real Postgres. RFC 3501 makes
 * a UID an unsigned 32-bit integer and nothing bounds a server below 2^31, but the locator columns
 * were `integer`: the ingest, the failure ledger and the settings cache each answered 22003 for
 * such a message, so it was never stored and was offered again every cycle. Each case writes
 * through the production writer the worker calls and reads the row back as a JS number.
 */
const PG_UP = await realPgAvailable();
const BIG_UID = 2_147_483_648;
const U32_MAX = 4_294_967_295;
const NOW = new Date("2026-09-27T08:00:00.000Z");

describe.skipIf(!PG_UP)("a uid above 2^31 on every worker writer", () => {
  let owned: OwnedDb;
  const made: string[] = [];
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
  }, 180_000);
  // The rows at uids int4 cannot hold go; nothing else this file wrote reads differently.
  afterAll(async () => {
    if (owned && made.length > 0) {
      await owned.db.delete(messageFailures).where(inArray(messageFailures.accountId, made));
      await owned.db.delete(mailboxProfileMirror).where(inArray(mailboxProfileMirror.accountId, made));
    }
    await owned?.close().catch(() => {});
  });

  async function world(): Promise<{ accountId: string; mailboxId: string }> {
    const accountId = randomUUID();
    made.push(accountId);
    await owned.db.insert(accounts).values({ id: accountId, name: `u32-${accountId.slice(0, 8)}` });
    const [mb] = await owned.db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: `${accountId}@u32.test` }).returning();
    await owned.db.insert(contacts).values({ accountId, address: "anna@example.com" });
    return { accountId, mailboxId: mb!.id };
  }

  const eml = Buffer.from([
    "Message-ID: <u32-1@example.com>", "From: Anna <anna@example.com>", "To: me@u32.test",
    "Subject: Roof detail", "Date: Tue, 14 Jul 2026 09:41:07 +0000",
    "Content-Type: text/plain; charset=utf-8", "", "the ridge beam is 240mm",
  ].join("\r\n"));

  class Rollback extends Error {}

  /* ROLLED BACK, never committed: a migration's backfill (replayed by `message-instances.pg.test.ts`, as
     production runs it) casts every `messages.native_locator` uid to `integer`, so a committed
     row above the int4 range on the shared lane database would redden that replay for a reason it does not own. */
  it("the ingest stores the primary locator and a second copy at the top of the u32 range", async () => {
    const w = await world();
    let seen: Array<[string, number, boolean]> = [];
    let uidType = "";
    await owned.db.transaction(async (tx) => {
      const repo = makeDrizzleRepo(carryDialect(owned.db, tx) as never);
      const ids = { accountId: w.accountId, mailboxId: w.mailboxId };
      // An ORGANIZER's ingest, stated: an omitted `readerMode` would route as one by accident.
      const ingest = async (change: Change) => commitChange(
        await planChange(change, { repo, routing: repo, ...ids, readerMode: false }),
        { repo, routing: repo, ...ids, storageCap: UNMETERED_STORAGE_CAP },
      );
      const first = await ingest({ type: "create", locator: { folder: "INBOX", ref: `7:${BIG_UID}` }, raw: eml });
      expect(first.outcome).toBe("new");
      // The same bytes in a second folder: `recordInstance`, the ON CONFLICT upsert, not a new row.
      const second = await ingest({ type: "create", locator: { folder: "Archive", ref: `7:${U32_MAX}` }, raw: eml });
      expect([second.outcome, second.messageId]).toEqual(["external_copy", first.messageId]);
      const rows = await tx.select().from(messageInstances)
        .where(eq(messageInstances.accountId, w.accountId)).orderBy(messageInstances.folder);
      seen = rows.map((r) => [r.folder, r.uid, r.isPrimary]);
      uidType = typeof rows[0]?.uid;
      throw new Rollback();
    }).catch((e: unknown) => { if (!(e instanceof Rollback)) throw e; });
    expect(seen).toEqual([
      ["Archive", U32_MAX, false],
      ["INBOX", BIG_UID, true],
    ]);
    expect(uidType, "mode number: every reader keeps its TypeScript type").toBe("number");
  });

  it("the failure writer records a failed message at that uid", async () => {
    const w = await world();
    const repo = makeDrizzleRepo(owned.db);
    const attempts = await repo.recordMessageFailure(w.mailboxId, {
      accountId: w.accountId, folder: "INBOX", uidValidity: "7", uid: BIG_UID,
      code: "mime_unparseable", version: "u32-build", nextAttemptAt: null,
    });
    expect(attempts).toBe(1);
    const listed = await repo.listMessageFailures(w.mailboxId);
    expect(listed.map((f) => f.uid)).toEqual([BIG_UID]);
    const [raw] = await owned.db.select({ uid: messageFailures.uid }).from(messageFailures)
      .where(eq(messageFailures.mailboxId, w.mailboxId));
    expect(raw!.uid).toBe(BIG_UID);
  });

  it("the profile mirror caches a settings document read at that uid", async () => {
    const w = await world();
    const doc = {
      v: 1, updatedAt: "2026-09-27T07:00:00.000Z", producer: { kind: "cloud", version: "u32" },
      screener: [], rules: [], notifyRules: [], tagNames: [], awayResponder: null, signature: "",
    };
    const out = await applyProfileRead(
      { db: owned.db as never, accountId: w.accountId, mailboxId: w.mailboxId, now: NOW, log: () => {} },
      { state: "found", doc: doc as never, installId: "cloud-u32", ref: BIG_UID, generation: 1757000000, residue: 0 },
    );
    expect(out).toMatchObject({ state: "written", uid: BIG_UID });
    const [row] = await owned.db.select({ uid: mailboxProfileMirror.uid }).from(mailboxProfileMirror)
      .where(eq(mailboxProfileMirror.mailboxId, w.mailboxId));
    expect(row!.uid).toBe(BIG_UID);
  });
});
