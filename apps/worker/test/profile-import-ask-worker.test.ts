import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import {
  PROFILE_IMPORT_ASK_TTL_MS, PROFILE_IMPORT_RESOLVED_AUDIT_ACTION, SCREENER_FOLDER, accountSettings, accountSyncState, accounts, auditLog, changeLog,
  contacts, fencedAccountWrite, folderState, idempotencyKeys, latestProfileFoundMarker, lockAccountRuleKeys, mailboxes, messageStates, messages,
  profileImportResult, recordImportAsk, recordImportAskSignature, tags,
  type LedgerTx, type Tx,
} from "@trafficflow/db";
import { applyOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
import { makeDb } from "@trafficflow/db/cloud";
import {
  formatProfileMessage, makeProfileDoc, profileFingerprint, signatureReceipt, type OrganizerProfilePayload,
} from "@trafficflow/core/adapters/organizer-profile";
import { ScreenerService, TriageService, type ServiceContext } from "@trafficflow/services";
import { OrganizerProfileSync } from "../src/profile.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * THE ORGANIZER FINISHES A PRESS THE REQUEST COULD NOT. The ask is on the mailbox row (mail 0129);
 * the organizer reads it by primary key BEFORE its five-minute debounce, reads the document on its
 * own (pinned) connection, and applies it through the one merge — or refuses by name. These drive
 * `OrganizerProfileSync` tick by tick against the fake folder, with the SHIPPED debounce.
 */

type Db = ReturnType<typeof makeDb>;
let DB = "";
const INSTALL = "organizer-under-test";
const INTERVAL = 5 * 60 * 1000;
const PAYLOAD: OrganizerProfilePayload = {
  screener: [{ address: "friend@elsewhere.example" }],
  rules: [], notifyRules: [], awayResponder: null, tagNames: ["theirs"], signature: null,
};
const FOREIGN = makeProfileDoc(PAYLOAD, { updatedAt: new Date("2026-09-01T00:00:00Z"), producer: { kind: "local", version: "0.25.1" } });
const FP = profileFingerprint(FOREIGN);

async function seed(db: Db): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "ask" });
  const [row] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`, organizerRole: "organizer",
    organizeConsentedAt: new Date(Date.now() - 60 * 60 * 1000),
  }).returning();
  return { accountId, mailboxId: row!.id };
}

function sync(db: Db, fleet: FakeAdapterFleet, mb: { accountId: string; mailboxId: string }, now: () => Date, events: string[]) {
  const adapter = fleet.factory(
    { host: "fake.invalid", port: 1143, secure: false, auth: { user: "u", pass: "p" }, sentDomain: "t" } as never,
    { accountId: mb.accountId, mailboxId: mb.mailboxId, onConnectionError: () => undefined },
  );
  return new OrganizerProfileSync({
    db, accountId: mb.accountId, mailboxId: mb.mailboxId, adapter,
    self: { installId: INSTALL, kind: "cloud" }, producerVersion: "dev", flushIntervalMs: INTERVAL, now,
    log: (event, detail) => { events.push(`${event} ${JSON.stringify(detail)}`); },
  });
}

async function askOf(db: Db, mailboxId: string) {
  const [r] = await db.select({
    fp: mailboxes.profileImportAskFingerprint, outcome: mailboxes.profileImportAskOutcome,
    reason: mailboxes.profileImportAskReason,
  }).from(mailboxes).where(eq(mailboxes.id, mailboxId));
  return r!;
}

const named = (name: string): string => { const u = new URL(DB); u.searchParams.set("application_name", name); return u.toString(); };
const outcome = (p: Promise<unknown>): Promise<string> => p.then(() => "committed",
  (e: unknown) => `refused: ${String((e as { code?: unknown; cause?: { code?: unknown } }).code ?? (e as { cause?: { code?: unknown } }).cause?.code ?? e)}`);

/** Resolves once `waiter` waits on a lock `holder` holds, or once `until` settles; without `until`, the wait must come. */
async function blockedOn(probe: postgres.Sql, waiter: string, holder: string, until?: Promise<unknown>): Promise<void> {
  let settled = false;
  void until?.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; until !== undefined || i < 400; i++) {
    if (settled) return;
    const rows = await probe`select 1 from pg_stat_activity w where w.datname = current_database()
      and w.application_name = ${waiter} and w.wait_event_type = 'Lock' and exists (select 1 from pg_stat_activity h
        where h.application_name = ${holder} and h.pid = any(pg_blocking_pids(w.pid)))`;
    if (rows.length > 0) return;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`${waiter} never waited on ${holder}`);
}

/** A third session holding something inside an open transaction until released. */
async function hold(db: Db, body: (tx: Tx) => Promise<void>): Promise<{ release: () => void; done: Promise<unknown> }> {
  let reached!: () => void;
  let release!: () => void;
  const at = new Promise<void>((res) => { reached = res; });
  const gone = new Promise<void>((res) => { release = res; });
  const done = db.transaction(async (tx) => { await body(tx as unknown as Tx); reached(); await gone; tx.rollback(); })
    .catch(() => undefined);
  await at;
  return { release, done };
}

/** An uncommitted change row at the account's next seq: the next writer parks at its insert, holding the counter. */
const holdNextSeq = (db: Db, accountId: string) => hold(db, async (tx) => {
  const rows = await tx.execute(sql`select greatest(s.next_seq, coalesce((select max(c.seq) from change_log c
    where c.account_id = ${accountId}), 0)) + 1 as next from account_sync_state s where s.account_id = ${accountId}`);
  const next = BigInt(String((rows as unknown as Array<{ next: unknown }>)[0]!.next));
  await tx.insert(changeLog).values({ accountId, seq: next, entityType: "settings", entityId: accountId, op: "update" });
});

/** A second organizer mailbox with one letter, for a triage press beside the import. */
async function seedOther(db: Db, accountId: string): Promise<string> {
  const [n] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`, organizerRole: "organizer",
    organizeConsentedAt: new Date(Date.now() - 60 * 60 * 1000),
  }).returning();
  const tag = randomUUID().slice(0, 8);
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: n!.id, bodyHash: `ask-${tag}`, dedupKey: `ask:${tag}`, subject: "hello",
    fromAddress: `p-${tag}@example.test`, nativeLocator: { folder: "INBOX", ref: "1:7" },
  }).returning();
  await db.insert(accountSyncState).values({ accountId }).onConflictDoNothing();
  return m!.id;
}

/** A triage press as the route makes it, with an Idempotency-Key. */
const triage = (db: Db, accountId: string, messageId: string, key: string): Promise<unknown> => new TriageService().setState({
  db: db as unknown as ServiceContext["db"], accountId, userId: null,
  now: () => new Date("2026-09-26T20:00:00Z"), requestId: `ask-${key}`,
}, messageId, { state: "reply_later" }, { idempotency: { key, requestHash: "ask" } });

describe("the organizer's tick answers a handed-over press", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_profile_ask"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  it("inside the debounce, the ask runs the merge on this tick, rings the settings doorbell, and reads once", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seed(db);
    await fleet.metaFor(mb.mailboxId).appendProfile(formatProfileMessage(FOREIGN, { installId: "another-mac" }));
    let now = new Date("2026-09-26T20:00:00Z");
    const events: string[] = [];
    const s = sync(db, fleet, mb, () => now, events);
    await s.onOrganize(); // seed: the foreign document is held
    now = new Date(now.getTime() + 1000); // well inside the five-minute debounce
    await recordImportAsk(db as unknown as Tx, { accountId: mb.accountId, mailboxId: mb.mailboxId, fingerprint: FP, now });
    await db.insert(accountSettings).values({ accountId: mb.accountId, updatedAt: new Date("2026-09-01T00:00:00Z") });
    const reads = fleet.metaFor(mb.mailboxId).profileReads;
    await s.onOrganize();
    expect(await askOf(db, mb.mailboxId)).toMatchObject({ fp: FP, outcome: "imported", reason: null });
    expect((await db.select().from(contacts).where(eq(contacts.accountId, mb.accountId))).map((c) => c.address))
      .toEqual(["friend@elsewhere.example"]);
    expect((await db.select().from(tags).where(eq(tags.accountId, mb.accountId))).map((t) => t.name)).toEqual(["theirs"]);
    const bells = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, mb.accountId), eq(changeLog.entityType, "settings")));
    expect(bells.length, "the settings doorbell").toBeGreaterThanOrEqual(1);
    // No signature changed, so the stamp every window compares for `GET /consent` stays put.
    const [stamp] = await db.select({ at: accountSettings.updatedAt }).from(accountSettings)
      .where(eq(accountSettings.accountId, mb.accountId));
    expect(stamp!.at.toISOString(), "a merge that changed no signature moved the settings stamp").toBe("2026-09-01T00:00:00.000Z");
    // One read for the ask, and the resolved arm's re-derivation — on the one pinned connection.
    expect(fleet.metaFor(mb.mailboxId).profileReads - reads).toBeLessThanOrEqual(2);
    expect(events.some((e) => e.startsWith("organizer_profile_import_answered") && e.includes("imported"))).toBe(true);
  }, 60_000);

  /* AN IMPORT NEVER LOSES A SIGNATURE TYPED HERE (ruled 2026-11-01): the organizer's answer replaces
     a different one only when the press named it, and moves the stamp only when it writes one. */
  it("a handed-over press replaces the signature typed here only when it named it; the marker names the copy's", async () => {
    const SIGNED = makeProfileDoc({ ...PAYLOAD, signature: "-- \nfriend" }, {
      updatedAt: new Date("2026-09-01T00:00:00Z"), producer: { kind: "local", version: "0.25.1" },
    });
    const fp = profileFingerprint(SIGNED);
    const run = async (named: boolean) => {
      const db = makeDb(DB);
      const fleet = new FakeAdapterFleet();
      const mb = await seed(db);
      await db.update(mailboxes).set({ signature: "-- \ntyped here" }).where(eq(mailboxes.id, mb.mailboxId));
      await db.insert(accountSettings).values({ accountId: mb.accountId, updatedAt: new Date("2026-09-01T00:00:00Z") });
      await fleet.metaFor(mb.mailboxId).appendProfile(formatProfileMessage(SIGNED, { installId: "another-mac" }));
      let now = new Date("2026-09-26T20:00:00Z");
      const s = sync(db, fleet, mb, () => now, []);
      await s.onOrganize();
      const marker = await latestProfileFoundMarker(db as unknown as Tx, mb.accountId, mb.mailboxId);
      now = new Date(now.getTime() + 1000);
      await recordImportAsk(db as unknown as Tx, { accountId: mb.accountId, mailboxId: mb.mailboxId, fingerprint: fp, now });
      if (named) {
        await recordImportAskSignature(db as unknown as Tx, {
          accountId: mb.accountId, mailboxId: mb.mailboxId, fingerprint: fp, signatureReplaces: signatureReceipt("-- \ntyped here")!, at: now,
        });
      }
      await s.onOrganize();
      expect(await askOf(db, mb.mailboxId)).toMatchObject({ fp, outcome: "imported" });
      const [row] = await db.select({ signature: mailboxes.signature }).from(mailboxes).where(eq(mailboxes.id, mb.mailboxId));
      const [stamp] = await db.select({ at: accountSettings.updatedAt }).from(accountSettings).where(eq(accountSettings.accountId, mb.accountId));
      const result = await profileImportResult(db as unknown as Tx, { accountId: mb.accountId, mailboxId: mb.mailboxId, fingerprint: fp });
      return { marker, signature: row!.signature, stamp: stamp!.at.toISOString(), imported: result?.imported, now: now.toISOString() };
    };
    const kept = await run(false);
    expect(kept.signature, "the organizer replaced the signature typed here unasked").toBe("-- \ntyped here");
    expect(kept.imported).toMatchObject({ signature: false, signatureKept: true });
    expect(kept.stamp).toBe("2026-09-01T00:00:00.000Z");
    expect(kept.marker?.signatureReceipt, "the marker does not name the copy's signature").toBe(signatureReceipt("-- \nfriend"));
    const replaced = await run(true);
    expect(replaced.signature).toBe("-- \nfriend");
    expect(replaced.imported).toMatchObject({ signature: true });
    expect(replaced.stamp).toBe(replaced.now);
  }, 60_000);

  it("a document that changed since the press is refused `changed`, and nothing is applied", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seed(db);
    await fleet.metaFor(mb.mailboxId).appendProfile(formatProfileMessage(FOREIGN, { installId: "another-mac" }));
    let now = new Date("2026-09-26T20:00:00Z");
    const s = sync(db, fleet, mb, () => now, []);
    await s.onOrganize();
    now = new Date(now.getTime() + 1000);
    await recordImportAsk(db as unknown as Tx, { accountId: mb.accountId, mailboxId: mb.mailboxId, fingerprint: "not-this-document", now });
    await s.onOrganize();
    expect(await askOf(db, mb.mailboxId)).toMatchObject({ outcome: "refused", reason: "changed" });
    expect(await db.select().from(contacts).where(eq(contacts.accountId, mb.accountId))).toEqual([]);
  }, 60_000);

  it("a read that fails leaves the ask standing for the next tick; past the TTL it is `timed_out`", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seed(db);
    await fleet.metaFor(mb.mailboxId).appendProfile(formatProfileMessage(FOREIGN, { installId: "another-mac" }));
    let now = new Date("2026-09-26T20:00:00Z");
    const events: string[] = [];
    const s = sync(db, fleet, mb, () => now, events);
    await s.onOrganize();
    now = new Date(now.getTime() + 1000);
    await recordImportAsk(db as unknown as Tx, { accountId: mb.accountId, mailboxId: mb.mailboxId, fingerprint: FP, now });
    fleet.metaFor(mb.mailboxId).deadConnection = true;
    await s.onOrganize();
    expect(await askOf(db, mb.mailboxId)).toMatchObject({ fp: FP, outcome: null });
    expect(events.some((e) => e.startsWith("organizer_profile_import_retry"))).toBe(true);
    now = new Date(now.getTime() + PROFILE_IMPORT_ASK_TTL_MS);
    await s.onOrganize();
    expect(await askOf(db, mb.mailboxId)).toMatchObject({ fp: FP, outcome: "refused", reason: "timed_out" });
  }, 60_000);

  /* THE TWO MERGES RACING ON ONE ACCOUNT, on a real Postgres: the confirm route's inline merge (a
     press that read in time) against the organizer's job for the same ask. The advisory lock
     serializes the transactions and the compare-and-set answers the ask once; both orders. */
  for (const order of ["tick-first", "inline-first"] as const) {
    it(`the inline merge and the tick's merge race: one resolution, one row per key, imported once (${order})`, async () => {
      const db = makeDb(DB);
      const fleet = new FakeAdapterFleet();
      const mb = await seed(db);
      await fleet.metaFor(mb.mailboxId).appendProfile(formatProfileMessage(FOREIGN, { installId: "another-mac" }));
      let now = new Date("2026-09-26T20:00:00Z");
      const s = sync(db, fleet, mb, () => now, []);
      await s.onOrganize();
      now = new Date(now.getTime() + 1000);
      await recordImportAsk(db as unknown as Tx, { accountId: mb.accountId, mailboxId: mb.mailboxId, fingerprint: FP, now });
      // The confirm route's shape exactly: the account fence alone (`profile-import-service.ts#apply`).
      const inline = (): Promise<unknown> => fencedAccountWrite(db as unknown as Tx, { accountId: mb.accountId },
        async (tx) => applyOrganizerProfile(tx as LedgerTx, { accountId: mb.accountId, mailboxId: mb.mailboxId, doc: FOREIGN, fingerprint: FP, now }));
      const tick = (): Promise<unknown> => s.onOrganize();
      await Promise.all(order === "tick-first" ? [tick(), inline()] : [inline(), tick()]);
      expect(await db.select().from(contacts).where(eq(contacts.accountId, mb.accountId))).toHaveLength(1);
      expect(await db.select().from(tags).where(eq(tags.accountId, mb.accountId))).toHaveLength(1);
      const resolutions = await db.select().from(auditLog).where(and(
        eq(auditLog.accountId, mb.accountId), eq(auditLog.action, PROFILE_IMPORT_RESOLVED_AUDIT_ACTION),
      ));
      expect(resolutions, "one imported answer for the one document").toHaveLength(1);
      expect(await askOf(db, mb.mailboxId)).toMatchObject({ fp: FP, outcome: "imported" });
    }, 60_000);
  }

  /* THE OVERLAP ITSELF. The two orders above serialize before the transactions meet. Here the
     inline merge takes the merge's lock and parks on a contact row a third session holds; the tick
     then takes its fence and waits at the rule-key lock; released, the inline merge updates the
     mailbox row, which the tick's fence (the account row alone) does not hold. */
  it("the tick's fence meeting an inline merge that holds the lock: both commit, neither is a deadlock victim", async () => {
    const named = (name: string): string => { const u = new URL(DB); u.searchParams.set("application_name", name); return u.toString(); };
    const tag = randomUUID().slice(0, 8);
    const TICK = `fix025-tick-${tag}`;
    const INLINE = `fix025-inline-${tag}`;
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seed(db);
    await fleet.metaFor(mb.mailboxId).appendProfile(formatProfileMessage(FOREIGN, { installId: "another-mac" }));
    let now = new Date("2026-09-26T20:00:00Z");
    const events: string[] = [];
    const s = sync(makeDb(named(TICK)), fleet, mb, () => now, events);
    await s.onOrganize();
    now = new Date(now.getTime() + 1000);
    await recordImportAsk(db as unknown as Tx, { accountId: mb.accountId, mailboxId: mb.mailboxId, fingerprint: FP, now });
    await db.insert(contacts).values({ accountId: mb.accountId, address: "friend@elsewhere.example" });

    const probe = postgres(DB, { max: 1, onnotice: () => undefined });
    const gate = postgres(DB, { max: 1, onnotice: () => undefined });
    try {
      const waiting = async (name: string): Promise<void> => {
        for (let i = 0; i < 400; i++) {
          const [r] = await probe`select count(*)::int as n from pg_stat_activity
            where datname = current_database() and application_name = ${name} and wait_event_type = 'Lock'`;
          if ((r as { n: number }).n > 0) return;
          await new Promise((res) => setTimeout(res, 25));
        }
        throw new Error(`${name} never waited on a lock`);
      };
      let release!: () => void;
      const released = new Promise<void>((res) => { release = res; });
      let held!: () => void;
      const holding = new Promise<void>((res) => { held = res; });
      const holder = gate.begin(async (tx) => {
        await tx`select 1 from contacts where account_id = ${mb.accountId} and address = 'friend@elsewhere.example' for update`;
        held();
        await released;
      });
      await holding;
      const inline = fencedAccountWrite(makeDb(named(INLINE)) as unknown as Tx, { accountId: mb.accountId },
        async (tx) => applyOrganizerProfile(tx as LedgerTx, { accountId: mb.accountId, mailboxId: mb.mailboxId, doc: FOREIGN, fingerprint: FP, now }))
        .then(() => "committed", (err: unknown) => `refused: ${String((err as { code?: string }).code ?? err)}`);
      await waiting(INLINE); // the merge's lock taken, parked on the held contact
      const tick = s.onOrganize();
      await waiting(TICK); // the tick at its fence, or on the merge's lock
      release();
      await holder;
      expect(await inline, "the inline merge was aborted").toBe("committed");
      await tick;
      expect(events.filter((e) => e.startsWith("organizer_profile_write_failed")), "the tick's merge was aborted").toEqual([]);
      expect(await askOf(db, mb.mailboxId)).toMatchObject({ fp: FP, outcome: "imported" });
    } finally {
      await probe.end({ timeout: 5 });
      await gate.end({ timeout: 5 });
    }
  }, 60_000);

  /* A TRIAGE PRESS BESIDE THE TICK, each side first, on another mailbox. Triage takes the counter
     before it reads the account row; a tick holding that row exclusively deadlocked it (40P01). */
  describe("beside a press made at the same moment", () => {
    let probe: postgres.Sql;
    beforeAll(() => { probe = postgres(DB, { max: 1, onnotice: () => undefined }); });
    afterAll(async () => { await probe?.end({ timeout: 5 }); });

    const cases = [
      { name: "the answer first, parked at the rule-key lock", askFp: FP, first: "tick" },
      { name: "the triage first, parked holding the counter", askFp: FP, first: "triage" },
      { name: "the refusal first, parked at the mailbox row", askFp: "not-this-document", first: "tick" },
    ] as const;
    for (const c of cases) {
      it(`${c.name}: both commit, the press keeps its stored answer`, async () => {
        const tag = randomUUID().slice(0, 8);
        const TICK = `ask-tick-${tag}`, TRI = `ask-tri-${tag}`, HOLD = `ask-hold-${tag}`;
        const db = makeDb(DB);
        const fleet = new FakeAdapterFleet();
        const mb = await seed(db);
        const letter = await seedOther(db, mb.accountId);
        await fleet.metaFor(mb.mailboxId).appendProfile(formatProfileMessage(FOREIGN, { installId: "another-mac" }));
        let now = new Date("2026-09-26T20:00:00Z");
        const events: string[] = [];
        const s = sync(makeDb(named(TICK)), fleet, mb, () => now, events);
        await s.onOrganize();
        now = new Date(now.getTime() + 1000);
        await recordImportAsk(db as unknown as Tx, { accountId: mb.accountId, mailboxId: mb.mailboxId, fingerprint: c.askFp, now });
        const holder = makeDb(named(HOLD));
        const key = `ask-key-${tag}`;
        let pressed: Promise<string>;
        let held: { release: () => void; done: Promise<unknown> };
        let tick: Promise<unknown>;
        if (c.first === "triage") {
          held = await holdNextSeq(holder, mb.accountId);
          pressed = outcome(triage(makeDb(named(TRI)), mb.accountId, letter, key));
          await blockedOn(probe, TRI, HOLD);
          tick = s.onOrganize();
          await blockedOn(probe, TICK, TRI);
        } else {
          held = c.askFp === FP
            ? await hold(holder, (tx) => lockAccountRuleKeys(tx, mb.accountId))
            : await hold(holder, async (tx) => { await tx.execute(sql`select id from mailboxes where id = ${mb.mailboxId} for share`); });
          tick = s.onOrganize();
          await blockedOn(probe, TICK, HOLD);
          pressed = outcome(triage(makeDb(named(TRI)), mb.accountId, letter, key));
          await blockedOn(probe, TRI, TICK, pressed); // finished, or waiting on the tick
        }
        held.release();
        await held.done;
        expect(await pressed, "the triage press").toBe("committed");
        await tick;
        expect(events.filter((e) => e.startsWith("organizer_profile_write_failed")), "the tick's write").toEqual([]);
        const [stored] = await db.select({ status: idempotencyKeys.responseStatus }).from(idempotencyKeys)
          .where(and(eq(idempotencyKeys.accountId, mb.accountId), eq(idempotencyKeys.key, key)));
        expect(stored?.status, "the press's stored answer").toBe(200);
        const [state] = await db.select({ state: messageStates.state }).from(messageStates).where(eq(messageStates.messageId, letter));
        expect(state?.state).toBe("reply_later");
        expect(await askOf(db, mb.mailboxId)).toMatchObject(c.askFp === FP
          ? { fp: FP, outcome: "imported" } : { outcome: "refused", reason: "changed" });
        const bells = await db.select().from(changeLog)
          .where(and(eq(changeLog.accountId, mb.accountId), eq(changeLog.entityType, "settings")));
        expect(bells.length, "the settings doorbell").toBeGreaterThanOrEqual(1);
      }, 60_000);
    }

    /* A SCREENER YES ON THE SAME MAILBOX: it takes the rule-key lock and the counter before it reads
       the held letter's mailbox row, which the refusal locks; the press parks after its rule delta. */
    for (const late of [false, true]) {
      it(`the refusal beside a Screener yes holding the counter, released ${late ? "after the deadlock timeout" : "at once"}: both commit`, async () => {
        const tag = randomUUID().slice(0, 8);
        const TICK = `ask-tick-${tag}`, SCR = `ask-scr-${tag}`, HOLD = `ask-hold-${tag}`;
        const db = makeDb(DB);
        const fleet = new FakeAdapterFleet();
        const mb = await seed(db);
        await fleet.metaFor(mb.mailboxId).appendProfile(formatProfileMessage(FOREIGN, { installId: "another-mac" }));
        let now = new Date("2026-09-26T20:00:00Z");
        const events: string[] = [];
        const s = sync(makeDb(named(TICK)), fleet, mb, () => now, events);
        await s.onOrganize();
        now = new Date(now.getTime() + 1000);
        await recordImportAsk(db as unknown as Tx, { accountId: mb.accountId, mailboxId: mb.mailboxId, fingerprint: "not-this-document", now });
        const sender = `s-${tag}@example.test`;
        const [m] = await db.insert(messages).values({
          accountId: mb.accountId, mailboxId: mb.mailboxId, bodyHash: `scr-${tag}`, dedupKey: `scr:${tag}`, subject: "hello",
          fromAddress: sender, nativeLocator: { folder: SCREENER_FOLDER, ref: "1:9" },
        }).returning();
        await db.insert(folderState).values({ messageId: m!.id, desiredFolder: SCREENER_FOLDER, observedFolder: SCREENER_FOLDER, lastSetBy: "us" });
        await db.insert(accountSyncState).values({ accountId: mb.accountId }).onConflictDoNothing();
        const held = await hold(makeDb(named(HOLD)), async (tx) => {
          await tx.insert(contacts).values({ accountId: mb.accountId, address: sender, source: "person" });
        });
        const pressed = outcome(new ScreenerService({}).decide({
          db: makeDb(named(SCR)) as unknown as ServiceContext["db"], accountId: mb.accountId, userId: null,
          now: () => now, requestId: `scr-${tag}`,
        }, m!.id, { decision: "yes", dest: "INBOX" }));
        await blockedOn(probe, SCR, HOLD);
        const tick = s.onOrganize();
        await blockedOn(probe, TICK, SCR);
        if (late) await new Promise((res) => setTimeout(res, 1500));
        held.release();
        await held.done;
        await tick;
        expect(await pressed, "the Screener press").toBe("committed");
        expect(events.filter((e) => e.startsWith("organizer_profile_write_failed")), "the refusal").toEqual([]);
        expect(await askOf(db, mb.mailboxId)).toMatchObject({ outcome: "refused", reason: "changed" });
        const [fs] = await db.select({ desired: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, m!.id));
        expect(fs?.desired, "the held letter").toBe("INBOX");
      }, 60_000);
    }
  });

  it("CONTROL: with no ask, the debounce still holds — no read inside the interval", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seed(db);
    await fleet.metaFor(mb.mailboxId).appendProfile(formatProfileMessage(FOREIGN, { installId: "another-mac" }));
    let now = new Date("2026-09-26T20:00:00Z");
    const s = sync(db, fleet, mb, () => now, []);
    await s.onOrganize();
    const reads = fleet.metaFor(mb.mailboxId).profileReads;
    now = new Date(now.getTime() + 1000);
    await s.onOrganize();
    expect(fleet.metaFor(mb.mailboxId).profileReads).toBe(reads);
  }, 60_000);
});
