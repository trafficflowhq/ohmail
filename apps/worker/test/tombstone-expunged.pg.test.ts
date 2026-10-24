import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, accountStorage, changeLog, folderState, mailboxes, messageBodies, messageInstances,
  messages, routingDecisions, rules,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { NativeLocator } from "@trafficflow/core";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { junkGonePass } from "../src/junk-gone.js";

/**
 * ═══ EXPUNGE PROPAGATION — WHAT THE MIRROR DOES WHEN THE SERVER NO LONGER HOLDS THE MESSAGE ══
 *
 * THE TRUTH THIS FILE PINS, stated plainly because it was measured before it was built: until
 * mail 0065, a server-side expunge in a watched folder propagated exactly one step —
 * `forgetInstanceAt` removed the `message_instances` row (and promoted a survivor) — and then
 * STOPPED. The `messages` row stayed live in every view, every search hit and every client
 * mirror, for ever; no `change_log` row was ever written; `forgetInstanceAt`'s own comment left
 * "the last known locator on the row for the reaper to find" and no reaper existed. Mirror-row
 * propagation was genuinely ABSENT, and `tombstoneInstanceless` is the minimal honest version:
 * the row is tombstoned (`deleted_at` + a `delete` change every client applies), the husk goes
 * with it (`withheld_reason='expunged'`, bytes released), and a re-appearance clears the stamp
 * through the adopt path.
 *
 * Real Postgres (:5433), because every claim here is transactional bookkeeping — seq
 * allocation, the storage counter's row lock, the husk/change ordering — which is exactly the
 * class PGlite has been shown not to witness (CLAUDE.md).
 *
 * Mutations watched (each restored, 2026-08-22):
 *  · drop the junk-parked exclusion (the reconciled-while-divergent NOT EXISTS) from
 *    `tombstoneInstanceless` ⇒ the junk-parked test red: a spam-verdict husk in native Junk is
 *    tombstoned as if it had been expunged.
 *  · make `huskBody` skip `releaseBodyBytes` ⇒ the accounting test red: the account keeps
 *    paying for bytes of a message the server no longer holds.
 */

const AVAILABLE = await realPgAvailable();
const LOC = (folder: string, ref: string): NativeLocator => ({ folder, ref });

describe.skipIf(!AVAILABLE)("mail 0065 — expunge propagation: the mirror row goes, the husk goes", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 60_000);

  afterAll(async () => { await sql?.end({ timeout: 5 }); });

  async function seed(opts: { instances?: Array<{ folder: string; uid: number; primary: boolean }> } = {}) {
    const accountId = randomUUID();
    const tag = accountId.slice(0, 8);
    await db.insert(accounts).values({ id: accountId, name: `tg-${tag}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `tg-${tag}@example.test`, status: "connected",
    }).returning();
    const instances = opts.instances ?? [{ folder: "INBOX", uid: 300, primary: true }];
    const primary = instances.find((i) => i.primary) ?? instances[0]!;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id,
      dedupKey: `mid:<tg-${tag}@example.test>`,
      messageIdHeader: `tg-${tag}@example.test`,
      fromAddress: "stranger@example.test", subject: "s",
      bodyHash: `tg-hash-${tag}`,
      nativeLocator: LOC(primary.folder, `1:${primary.uid}`),
    }).returning();
    for (const i of instances) {
      await db.insert(messageInstances).values({
        accountId, messageId: m!.id, mailboxId: mb!.id, folder: i.folder, uid: i.uid,
        uidvalidity: 1n, isPrimary: i.primary,
      });
    }
    // A stored body with real content, and the counter that says the account is paying for it.
    const text = "the whole body of a message the server is about to expunge";
    await db.insert(messageBodies).values({ messageId: m!.id, text, html: null });
    await db.insert(accountStorage).values({ accountId, bytes: Buffer.byteLength(text) });
    return { accountId, mailboxId: mb!.id, messageId: m!.id, bytes: Buffer.byteLength(text) };
  }

  const repoOf = (): WorkerRepo & { transaction: <T>(fn: (r: WorkerRepo) => Promise<T>) => Promise<T> } =>
    makeDrizzleRepo(db as never) as never;

  it("an expunge of the ONLY instance tombstones the row: deleted_at, one delete change, the expunged husk, bytes released", async () => {
    const { accountId, mailboxId, messageId, bytes } = await seed();
    const repo = repoOf();

    // The observation sync.ts makes for each of the adapter's deletes…
    await repo.forgetInstanceAt(mailboxId, LOC("INBOX", "1:300"));
    // …and the reaper pass that follows it, transactional as fencedGroup runs it.
    const reaped = await repo.transaction((r) => r.tombstoneInstanceless!(accountId, mailboxId, 200));
    expect(reaped).toBe(1);

    const [row] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(row!.deletedAt).not.toBeNull();

    const changes = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityType, "message")))
      .orderBy(asc(changeLog.seq));
    expect(changes.map((c) => c.op)).toEqual(["delete"]);
    expect(changes[0]!.entityId).toBe(messageId);

    const [body] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, messageId));
    expect(body!.text).toBe("");
    expect(body!.html).toBeNull();
    expect(body!.withheldReason).toBe("expunged");

    const [storage] = await db.select().from(accountStorage).where(eq(accountStorage.accountId, accountId));
    expect(Number(storage!.bytes)).toBe(0);
    expect(bytes).toBeGreaterThan(0);

    // Idempotent: a second pass finds nothing — the tombstone is not re-emitted.
    const again = await repo.transaction((r) => r.tombstoneInstanceless!(accountId, mailboxId, 200));
    expect(again).toBe(0);
  });

  it("a SURVIVING copy is promoted, not tombstoned — the message is still on the server", async () => {
    const { accountId, mailboxId, messageId } = await seed({
      instances: [
        { folder: "INBOX", uid: 300, primary: true },
        { folder: "ohmail/News", uid: 41, primary: false },
      ],
    });
    const repo = repoOf();
    await repo.forgetInstanceAt(mailboxId, LOC("INBOX", "1:300"));
    const reaped = await repo.transaction((r) => r.tombstoneInstanceless!(accountId, mailboxId, 200));
    expect(reaped).toBe(0);
    const [row] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(row!.deletedAt).toBeNull();
    expect((row!.nativeLocator as NativeLocator).folder).toBe("ohmail/News");
  });

  it("a JUNK-PARKED row is not reaped: reconciled-while-divergent means designed, not expunged", async () => {
    const { accountId, mailboxId, messageId } = await seed();
    const repo = repoOf();
    // The spam verdict's completion: parked instance, satisfied folder_state, junk husk.
    await repo.updateLocator(messageId, LOC("[Gmail]/Spam", "7:70"));
    await repo.forgetInstanceAt(mailboxId, LOC("[Gmail]/Spam", "7:70"));
    await repo.upsertFolderState(messageId, {
      desiredFolder: "ohmail/Quarantine", observedFolder: "[Gmail]/Spam",
      lastSetBy: "us", satisfiedBy: "[Gmail]/Spam",
    });
    await repo.transaction(async (r) => { await r.huskBody!(accountId, messageId, "junk_filed"); });

    const reaped = await repo.transaction((r) => r.tombstoneInstanceless!(accountId, mailboxId, 200));
    expect(reaped).toBe(0);
    const [row] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(row!.deletedAt).toBeNull();

    // And the folder_state the completion wrote is STORED as reconciled: fulfilment, not a
    // divergence the reconciler would re-move — while a later plain re-file goes pending again.
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
    expect(fs!.reconcileStatus).toBe("reconciled");
    await repo.upsertFolderState(messageId, {
      desiredFolder: "INBOX", observedFolder: "[Gmail]/Spam", lastSetBy: "us",
    });
    const [fs2] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
    expect(fs2!.reconcileStatus).toBe("pending");
  });

  /** One more letter in `mailboxId`, filed by a spam verdict into `folder` at `ref` (the exempt shape). */
  async function parked(accountId: string, mailboxId: string, folder: string, ref: string): Promise<string> {
    const tag = randomUUID().slice(0, 8);
    const [m] = await db.insert(messages).values({
      accountId, mailboxId, dedupKey: `mid:<jp-${tag}@example.test>`, messageIdHeader: `jp-${tag}@example.test`,
      fromAddress: "stranger@example.test", subject: "s", bodyHash: `jp-${tag}`, nativeLocator: LOC(folder, ref),
    }).returning();
    await repoOf().upsertFolderState(m!.id, {
      desiredFolder: "ohmail/Quarantine", observedFolder: folder, lastSetBy: "us", satisfiedBy: folder,
    });
    return m!.id;
  }

  it("listJunkParked answers exactly the rows the reaper exempts as Junk-filed", async () => {
    const { accountId, mailboxId, messageId: watched } = await seed();
    const repo = repoOf();
    const junk = "[Gmail]/Spam";
    const a = await parked(accountId, mailboxId, junk, "7:70");
    const b = await parked(accountId, mailboxId, junk, "7:71");
    await db.update(messages).set({ serverMissingAt: new Date() }).where(eq(messages.id, b));
    const c = await parked(accountId, mailboxId, junk, "7:72");
    await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, c));
    const elsewhere = await parked(accountId, mailboxId, "Other", "7:73");
    // An instanceless row that is not parked: the reaper's victim, never listed.
    await repo.forgetInstanceAt(mailboxId, LOC("INBOX", "1:300"));

    const listed = await repo.listJunkParked!(accountId, mailboxId, { folder: junk, limit: 10 });
    expect(listed).toEqual([{ messageId: a, locator: LOC(junk, "7:70") }]);
    expect(await repo.listJunkParked!(accountId, mailboxId, { folder: junk, limit: 10, afterId: a })).toEqual([]);
    expect((await repo.listJunkParked!(accountId, mailboxId, { folder: "Other", limit: 10 })).map((r) => r.messageId))
      .toEqual([elsewhere]);
    expect(await repo.listJunkParked!(randomUUID(), mailboxId, { folder: junk, limit: 10 })).toEqual([]);
    // The reaper takes the watched letter and spares the listed one.
    await repo.transaction((r) => r.tombstoneInstanceless!(accountId, mailboxId, 200));
    const live = await db.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.mailboxId, mailboxId), isNull(messages.deletedAt), isNull(messages.serverMissingAt)));
    expect(live.map((r) => r.id).sort()).toEqual([a, elsewhere].sort());
    void watched;
  });

  it("tombstoneJunkParkedGone tombstones a gone row and spares a re-decided, missing, moved or foreign one", async () => {
    const { accountId, mailboxId } = await seed();
    const other = await seed();
    const repo = repoOf();
    const junk = "Junk";
    const gone = await parked(accountId, mailboxId, junk, "9:1");
    const redecided = await parked(accountId, mailboxId, junk, "9:2");
    const missing = await parked(accountId, mailboxId, junk, "9:3");
    const moved = await parked(accountId, mailboxId, junk, "9:4");
    const foreign = await parked(other.accountId, other.mailboxId, junk, "9:5");
    const read = [
      ...await repo.listJunkParked!(accountId, mailboxId, { folder: junk, limit: 10 }),
      ...await repo.listJunkParked!(other.accountId, other.mailboxId, { folder: junk, limit: 10 }),
    ];
    expect(read).toHaveLength(5);
    // Since the read: a Not-junk press, a mail-0164 mark, a new stored location.
    await repo.upsertFolderState(redecided, { desiredFolder: "INBOX", observedFolder: junk, lastSetBy: "us" });
    await db.update(messages).set({ serverMissingAt: new Date() }).where(eq(messages.id, missing));
    await db.update(messages).set({ nativeLocator: LOC(junk, "9:40") }).where(eq(messages.id, moved));

    const n = await repo.transaction((r) => r.tombstoneJunkParkedGone!(accountId, mailboxId, read));
    expect(n).toBe(1);
    const rows = await db.select({ id: messages.id, deletedAt: messages.deletedAt }).from(messages)
      .where(inArray(messages.id, [gone, redecided, missing, moved, foreign]));
    expect(rows.filter((r) => r.deletedAt !== null).map((r) => r.id)).toEqual([gone]);
    const changes = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityId, gone)));
    expect(changes.map((c) => c.op)).toEqual(["delete"]);
  });

  it("junkGonePass proves an unchanged Junk over several pages, then skips it until its keys move", async () => {
    const { accountId, mailboxId } = await seed();
    await db.update(mailboxes).set({ junkFolder: "Junk" }).where(eq(mailboxes.id, mailboxId));
    for (let i = 1; i <= 5; i++) await parked(accountId, mailboxId, "Junk", `8:${i}`);
    let keys = { uidValidity: "8", uidNext: 100, messages: 5 };
    let asked = 0;
    const adapter = {
      folderKeys: async () => ({ k: "keys" as const, keys }),
      uidsHeld: async (_f: string, v: string, uids: readonly number[]) => { asked++; return { k: "held" as const, uidValidity: v, present: new Set(uids) }; },
    } as unknown as MailboxAdapter;
    const repo = repoOf();
    const visit = async () => (await junkGonePass({ repo, adapter, accountId, mailboxId, page: 2, write: (fn) => repo.transaction(fn) })).skipped;
    for (let i = 0; i < 3; i++) await visit();
    expect(asked, "a walk of three pages").toBe(3);
    expect(await visit(), "an unchanged Junk was walked again").toBe("unchanged");
    expect(await visit()).toBe("unchanged");
    expect(asked).toBe(3);
    // Junk moves mid-walk: that walk proves nothing, the next one does.
    keys = { ...keys, uidNext: 101, messages: 6 };
    await visit();
    keys = { ...keys, uidNext: 102, messages: 7 };
    await visit();
    await visit();
    expect(await visit(), "a walk Junk moved under was taken as proof").toBeUndefined();
    await visit();
    await visit();
    expect(asked).toBe(9);
    expect(await visit()).toBe("unchanged");
  });

  it("the husk never touches the SENDER RULE — the verdict's durable artifact survives", async () => {
    const { accountId, messageId } = await seed();
    const [rule] = await db.insert(rules).values({
      accountId, kind: "sender", match: "stranger@example.test",
      destination: "ohmail/Quarantine", provenance: "promoted", enabled: true,
    }).returning();
    const repo = repoOf();
    await repo.transaction(async (r) => { await r.huskBody!(accountId, messageId, "junk_filed"); });

    const [body] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, messageId));
    expect(body!.withheldReason).toBe("junk_filed");
    const [after] = await db.select().from(rules).where(eq(rules.id, rule!.id));
    expect(after).toBeDefined();
    expect(after!.enabled).toBe(true);
    expect(after!.destination).toBe("ohmail/Quarantine");

    // And a husk keeps its FIRST reason: a later expunge of the junked copy re-labels nothing.
    await repo.transaction(async (r) => { await r.huskBody!(accountId, messageId, "expunged"); });
    const [again] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, messageId));
    expect(again!.withheldReason).toBe("junk_filed");
  });

  it("a junk_filed/expunged husk is REFILLED from an arrival's bytes; a storage_cap husk stands", async () => {
    const { accountId, mailboxId, messageId } = await seed();
    const repo = repoOf();
    await repo.transaction(async (r) => { await r.huskBody!(accountId, messageId, "junk_filed"); });
    const body = { text: "the restored body", html: null, headers: {} };
    const restored = await repo.transaction((r) =>
      r.restoreWithheldBody!(messageId, body, { accountId, capBytes: null }));
    expect(restored).toBe(true);
    const [row] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, messageId));
    expect(row!.text).toBe("the restored body");
    expect(row!.withheldReason).toBeNull();
    const [storage] = await db.select().from(accountStorage).where(eq(accountStorage.accountId, accountId));
    expect(Number(storage!.bytes)).toBe(Buffer.byteLength("the restored body"));

    // The cap's own husk is standing POLICY — a duplicate delivery must not undo it.
    await db.update(messageBodies)
      .set({ text: "", html: null, withheldReason: "storage_cap" })
      .where(eq(messageBodies.messageId, messageId));
    const refused = await repo.transaction((r) =>
      r.restoreWithheldBody!(messageId, body, { accountId, capBytes: null }));
    expect(refused).toBe(false);
    const [still] = await db.select().from(messageBodies).where(eq(messageBodies.messageId, messageId));
    expect(still!.withheldReason).toBe("storage_cap");
    expect(still!.text).toBe("");

    void mailboxId;
  });

  it("AI provenance is account-scoped and SUPERSEDED by a later user move to the pile", async () => {
    const { accountId, mailboxId, messageId } = await seed();
    const repo = repoOf();
    // The AI auto-applied this message into the pile at…
    await db.insert(routingDecisions).values({
      accountId, messageId, inputProvenance: "ai", destination: "ohmail/Quarantine",
      confidence: "0.99", rationale: "r", spam: true, status: "auto_applied",
      createdAt: new Date("2026-08-20T10:00:00.000Z"),
    });
    expect(await repo.listAiAutoAppliedQuarantine!(accountId, [messageId])).toEqual([messageId]);
    // …and another account's history says nothing about this one.
    expect(await repo.listAiAutoAppliedQuarantine!(randomUUID(), [messageId])).toEqual([]);

    // The user later files it to the pile THEMSELVES (a decide re-route or an API move records
    // exactly this change): the decision row is history now, not the placement's author.
    await repo.transaction(async (r) => {
      await r.recordChange({
        accountId, entityType: "message", entityId: messageId, op: "move",
        meta: { from: "INBOX", to: "ohmail/Quarantine" },
      });
    });
    expect(await repo.listAiAutoAppliedQuarantine!(accountId, [messageId])).toEqual([]);

    void mailboxId;
  });

  it("a re-appearance clears the tombstone (the adopt path's half of 'a LATER create resurrects')", async () => {
    const { accountId, mailboxId, messageId } = await seed();
    const repo = repoOf();
    await repo.forgetInstanceAt(mailboxId, LOC("INBOX", "1:300"));
    await repo.transaction((r) => r.tombstoneInstanceless!(accountId, mailboxId, 200));
    const [gone] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(gone!.deletedAt).not.toBeNull();

    const cleared = await repo.clearDeletedOnAdopt!(messageId);
    expect(cleared).toBe(true);
    const [back] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(back!.deletedAt).toBeNull();
    // Idempotent, and honest about it: nothing to clear answers false.
    expect(await repo.clearDeletedOnAdopt!(messageId)).toBe(false);
  });
});
