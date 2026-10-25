import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq, sql } from "drizzle-orm";
import {
  accountSyncState, accounts, auditLog, changeLog, fencedAccountWrite, idempotencyKeys, mailboxes, messageStates, messages,
  rules, tags, PROFILE_IMPORT_RESOLVED_AUDIT_ACTION, type LedgerTx, type Tx,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  ProfileUnavailableError, makeProfileDoc, profileFingerprint,
  type OrganizerProfileDoc, type ProfileReadResult,
} from "@trafficflow/core/adapters/organizer-profile";
import { applyOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
import { TriageService, profileImportService, type ServiceContext } from "@trafficflow/services";

/**
 * THE APPLY UNDER A REAL POOL — the one claim PGlite structurally cannot check.
 *
 * PGlite is a single-connection Postgres: it serializes everything, so the apply's per-account
 * advisory lock behaves identically whether it is held or missing, and the race it exists to
 * remove never reproduces. The race is the merge's read-then-act: two tabs answering the same
 * card each read "no rule under this key yet" and each insert — a duplicate rule under one
 * natural key, which is the destination coin toss the merge rule exists to prevent. So the
 * property is asserted here, against a pool wide enough to actually race, or it is asserted
 * nowhere: EIGHT concurrent applies of one document leave the store exactly as ONE apply would.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId,
  userId: null,
  now: () => new Date(),
  requestId: `pfi-pg-${randomUUID().slice(0, 8)}`,
} as unknown as ServiceContext);

/**
 * DELIBERATELY NO SCREENER SECTION. A document with one would hide the race this file exists to
 * see: all eight applies upsert the same (account, address) contact row FIRST, and the loser
 * transactions block on that row's unique-conflict lock until the winner commits — an accidental
 * per-account mutex that serializes everything after it. Measured: with a screener entry present,
 * removing the advisory lock left this test green. Rules-and-tags-only is the shape whose first
 * write is the read-then-insert the lock guards.
 */
const DOC: OrganizerProfileDoc = makeProfileDoc({
  screener: [],
  rules: [
    {
      kind: "sender", match: "anna@example.com", destination: "ohmail/News",
      priority: 0, enabled: true, provenance: "promoted",
    },
    {
      kind: "domain", match: "shop.example", destination: "ohmail/Receipts",
      priority: 0, enabled: true, provenance: "manual",
    },
  ],
  notifyRules: [{ kind: "sender", target: "boss@example.com" }],
  awayResponder: null,
  tagNames: ["Invoices"],
  signature: null,
}, { updatedAt: new Date("2026-08-10T09:00:00.000Z"), producer: { kind: "local", version: "0.9.3" } });

const read = async (): Promise<ProfileReadResult> =>
  ({ state: "found", doc: DOC, installId: "elsewhere", ref: 1, residue: 0, generation: 1_000 });

type PgDb = typeof db;
const named: Array<ReturnType<typeof postgres>> = [];
/** A one-connection handle under `name`, so `pg_stat_activity` can say who waits on whom. */
const handle = (name: string): PgDb => {
  const c = postgres(PG_TEST_URL, { max: 1, onnotice: () => {}, connection: { application_name: name } });
  named.push(c);
  return brandDialect(drizzle(c, { schema }), "pg");
};
const outcome = (p: Promise<unknown>): Promise<string> => p.then((v) => (v as { state?: string } | undefined)?.state ?? "committed",
  (e: unknown) => `refused: ${String((e as { code?: unknown; cause?: { code?: unknown } }).code ?? (e as { cause?: { code?: unknown } }).cause?.code ?? e)}`);

/** Resolves once `waiter` waits on a lock `holder` holds, or once `until` settles; without `until`, the wait must come. */
async function blockedOn(waiter: string, holder: string, until?: Promise<unknown>): Promise<void> {
  let settled = false;
  void until?.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; until !== undefined || i < 400; i++) {
    if (settled) return;
    const rows = await client`select 1 from pg_stat_activity w where w.datname = current_database()
      and w.application_name = ${waiter} and w.wait_event_type = 'Lock' and exists (select 1 from pg_stat_activity h
        where h.application_name = ${holder} and h.pid = any(pg_blocking_pids(w.pid)))`;
    if (rows.length > 0) return;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`${waiter} never waited on ${holder}`);
}

/** A third session holding something inside an open transaction until released. */
async function hold(h: PgDb, body: (tx: Tx) => Promise<void>): Promise<{ release: () => void; done: Promise<unknown> }> {
  let reached!: () => void;
  let release!: () => void;
  const at = new Promise<void>((res) => { reached = res; });
  const gone = new Promise<void>((res) => { release = res; });
  const done = h.transaction(async (tx) => { await body(tx as unknown as Tx); reached(); await gone; tx.rollback(); })
    .catch(() => undefined);
  await at;
  return { release, done };
}

/** An uncommitted change row at the account's next seq: the next writer parks at its insert, holding the counter. */
const holdNextSeq = (h: PgDb, accountId: string) => hold(h, async (tx) => {
  const rows = await tx.execute(sql`select greatest(s.next_seq, coalesce((select max(c.seq) from change_log c
    where c.account_id = ${accountId}), 0)) + 1 as next from account_sync_state s where s.account_id = ${accountId}`);
  const next = BigInt(String((rows as unknown as Array<{ next: unknown }>)[0]!.next));
  await tx.insert(changeLog).values({ accountId, seq: next, entityType: "settings", entityId: accountId, op: "update" });
});

/** An account with two organizer mailboxes, a letter in each. */
async function twoMailboxes(): Promise<{ accountId: string; m: string; n: string; inM: string; inN: string }> {
  const accountId = randomUUID();
  const tag = accountId.slice(0, 8);
  await db.insert(accounts).values({ id: accountId, name: `pfl-${tag}` });
  const box = async (k: string): Promise<{ id: string; letter: string }> => {
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `pfl-${k}-${tag}@example.test`, organizerRole: "organizer",
      organizeConsentedAt: new Date(Date.now() - 60 * 60 * 1000),
    }).returning();
    const [msg] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `pfl-${k}-${tag}`, dedupKey: `pfl:${k}:${tag}`, subject: "hello",
      fromAddress: `p-${k}-${tag}@example.test`, nativeLocator: { folder: "INBOX", ref: "1:7" },
    }).returning();
    return { id: mb!.id, letter: msg!.id };
  };
  const m = await box("m");
  const n = await box("n");
  await db.insert(accountSyncState).values({ accountId }).onConflictDoNothing();
  return { accountId, m: m.id, n: n.id, inM: m.letter, inN: n.letter };
}

describe.skipIf(!PG_UP)("profile import — the concurrency PGlite cannot see", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 8, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await Promise.all(named.map((c) => c.end({ timeout: 5 })));
  });

  it("EIGHT concurrent applies of one document leave the store exactly as one would", async () => {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `pfi-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `pfi-${accountId.slice(0, 8)}@example.test`,
    }).returning();
    const fingerprint = profileFingerprint(DOC);

    // All eight from separate pool connections. Without the per-account advisory lock, several
    // read "no rule under this key" before any insert lands, and the account ends up with
    // duplicate rules under one natural key.
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      profileImportService.apply(ctx(accountId), mb!.id, { fingerprint }, { read }),
    ));
    expect(results).toHaveLength(8);

    const storedRules = await db.select().from(rules).where(eq(rules.accountId, accountId));
    expect(storedRules, "one rule per natural key, however many confirmations raced").toHaveLength(2);
    expect(new Set(storedRules.map((r) => `${r.kind} ${r.match}`)).size).toBe(2);

    const storedTags = await db.select().from(tags).where(eq(tags.accountId, accountId));
    expect(storedTags.map((t) => t.name)).toEqual(["Invoices"]);

    // One durable answer, not eight: the serialized transactions each see the winner's row.
    const resolutions = await db.select().from(auditLog).where(and(
      eq(auditLog.accountId, accountId), eq(auditLog.action, PROFILE_IMPORT_RESOLVED_AUDIT_ACTION),
    ));
    expect(resolutions).toHaveLength(1);
  }, 60_000);

  it("declined, then EIGHT concurrent replaces: two rows, one per decision", async () => {
    // The replace's write-once check and its insert are one step only under the same advisory
    // lock; racing them from separate connections is the case a single-connection store hides.
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `pfr-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `pfr-${accountId.slice(0, 8)}@example.test`,
    }).returning();
    const fingerprint = profileFingerprint(DOC);

    await profileImportService.decline(ctx(accountId), mb!.id, { fingerprint });
    await Promise.all(Array.from({ length: 8 }, () =>
      profileImportService.replace(ctx(accountId), mb!.id, { fingerprint }),
    ));

    const resolutions = await db.select().from(auditLog).where(and(
      eq(auditLog.accountId, accountId), eq(auditLog.action, PROFILE_IMPORT_RESOLVED_AUDIT_ACTION),
    ));
    expect(resolutions.map((r) => (r.payload as { decision: string }).decision).sort())
      .toEqual(["declined", "replaced"]);
    // Nothing was applied by either answer.
    expect(await db.select().from(rules).where(eq(rules.accountId, accountId))).toHaveLength(0);
  }, 60_000);

  /* A TRIAGE PRESS WITH AN IDEMPOTENCY-KEY BESIDE THE IMPORT, each side first. Triage reads the
     mailbox row FOR SHARE, takes the counter, then reads the account row: a door holding that row
     exclusively deadlocked it (40P01) through the mailbox row. The inline merge is the control. */
  const cases = [
    { name: "the triage first, then the handed-over press, same mailbox", door: "press", first: "triage", same: true },
    { name: "the handed-over press first, then the triage, same mailbox", door: "press", first: "door", same: true },
    { name: "CONTROL the triage first, then the inline merge, another mailbox", door: "inline", first: "triage", same: false },
    { name: "CONTROL the triage first, then the inline merge, same mailbox", door: "inline", first: "triage", same: true },
  ] as const;
  for (const c of cases) {
    it(`${c.name}: both commit`, async () => {
      const a = await twoMailboxes();
      const tag = randomUUID().slice(0, 8);
      const DOOR = `pfl-door-${tag}`, TRI = `pfl-tri-${tag}`, HOLD = `pfl-hold-${tag}`;
      const key = `pfl-key-${tag}`;
      const fingerprint = profileFingerprint(DOC);
      const press = (): Promise<string> => outcome(c.door === "press"
        ? profileImportService.apply({ ...ctx(a.accountId), db: handle(DOOR) as unknown as ServiceContext["db"] }, a.m, { fingerprint }, {
          read: async () => { throw new ProfileUnavailableError("the mailbox could not be dialled", { op: "list_profiles" }); },
        })
        : fencedAccountWrite(handle(DOOR) as unknown as Tx, { accountId: a.accountId }, async (tx) =>
          applyOrganizerProfile(tx as LedgerTx, { accountId: a.accountId, mailboxId: a.m, doc: DOC, fingerprint, now: new Date() }))
          .then(() => undefined));
      const triage = (): Promise<string> => outcome(new TriageService().setState(
        { ...ctx(a.accountId), db: handle(TRI) as unknown as ServiceContext["db"] },
        c.same ? a.inM : a.inN, { state: "reply_later" }, { idempotency: { key, requestHash: "pfl" } },
      ).then(() => undefined));
      let held: { release: () => void; done: Promise<unknown> };
      let pressed: Promise<string>;
      let triaged: Promise<string>;
      if (c.first === "triage") {
        held = await holdNextSeq(handle(HOLD), a.accountId);
        triaged = triage();
        await blockedOn(TRI, HOLD);
        pressed = press();
        await blockedOn(DOOR, TRI);
      } else {
        held = await hold(handle(HOLD), async (tx) => { await tx.execute(sql`select id from mailboxes where id = ${a.m} for share`); });
        pressed = press();
        await blockedOn(DOOR, HOLD);
        triaged = triage();
        await blockedOn(TRI, DOOR, triaged); // finished, or waiting on the press
      }
      held.release();
      await held.done;
      expect(await triaged, "the triage press").toBe("committed");
      expect(await pressed, "the import").toBe(c.door === "press" ? "importing" : "committed");
      const [stored] = await db.select({ status: idempotencyKeys.responseStatus }).from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.accountId, a.accountId), eq(idempotencyKeys.key, key)));
      expect(stored?.status, "the press's stored answer").toBe(200);
      const [state] = await db.select({ state: messageStates.state }).from(messageStates)
        .where(eq(messageStates.messageId, c.same ? a.inM : a.inN));
      expect(state?.state).toBe("reply_later");
      if (c.door === "press") {
        const [mb] = await db.select({ fp: mailboxes.profileImportAskFingerprint }).from(mailboxes).where(eq(mailboxes.id, a.m));
        expect(mb?.fp, "the ask is recorded").toBe(fingerprint);
      }
    }, 60_000);
  }
});
