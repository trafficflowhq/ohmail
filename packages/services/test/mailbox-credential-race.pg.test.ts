import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fixturePassword } from "../../../test/support/fixture-credentials.js";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq, sql } from "drizzle-orm";
import { accounts, mailboxes, mailboxCredentials, UNMETERED_ACCESS, type AccessVerdict } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import {
  runMigrations, readJournalOf, MAIL_JOURNAL,
  resolveActiveAddressDuplicates, ACTIVE_ADDRESS_UQ,
} from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { StaticKeyProvider, type KeyProvider } from "@trafficflow/core";
import { makeMailboxService, ServiceError, type ServiceContext } from "@trafficflow/services";

/**
 * A DISABLED MAILBOX MUST NEVER HOLD A CREDENTIAL — under real concurrency (0021 review #4).
 *
 * ## The state this file exists to make unreachable
 *
 * `MailboxService.delete` disables the row AND deletes its credentials, mail 0021's prelude does
 * the same to the duplicates it resolves, and 0021's own header states the resulting invariant
 * as a fact. Nothing enforced it. A credentials-only `PATCH /mailboxes/:id` writes
 * `mailbox_credentials` and never touches the `mailboxes` row, so before this change it took NO
 * lock at all:
 *
 *   A   PATCH reads the mailbox: 'connected'
 *   B   delete / dedup-resolver / 0021's prelude disables it and deletes its credentials
 *   A   commits its credential upsert
 *
 * and the database is left with a disabled tombstone owning a live, decryptable IMAP secret for
 * somebody's real mailbox. Nothing rosters it, so nothing notices.
 *
 * ## Why real Postgres, and why the timings
 *
 * PGlite is single-connection and cannot express one transaction blocking on another's row lock,
 * which IS the mechanism (CLAUDE.md's rule). Two independent `postgres()` pools make the
 * concurrency genuine rather than one driver's queue, and the interleaving is forced rather than
 * hoped for: `SlowKeyProvider` stalls 400 ms inside the PATCH's transaction, AFTER it has taken
 * the row lock, so the other actor is guaranteed to arrive while the lock is held. The
 * `mailbox-limit.concurrency.pg.test.ts` trick, for the same reason — a test that only fires
 * under a lucky interleave is not a gate.
 */
const PG_UP = await realPgAvailable();

const sqlA = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });
const sqlB = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });
const dbA = brandDialect(drizzle(sqlA, { schema }), "pg");
const dbB = brandDialect(drizzle(sqlB, { schema }), "pg");

const NOW = new Date("2026-08-01T12:00:00.000Z");
const sleep = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms); });
const FAST_KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7), 1);

/** Stalls INSIDE the update transaction, after `ownedRowOn(..., { forUpdate: true })`. */
class SlowKeyProvider implements KeyProvider {
  constructor(private readonly inner: KeyProvider, private readonly ms: number) {}
  async encrypt(plaintext: string): Promise<{ ciphertext: string; keyVersion: number }> {
    await sleep(this.ms);
    return this.inner.encrypt(plaintext);
  }
  decrypt(ciphertext: string, keyVersion: number): Promise<string> {
    return this.inner.decrypt(ciphertext, keyVersion);
  }
  currentKeyVersion(): number { return this.inner.currentKeyVersion(); }
  deriveSubkey(info: string): Buffer { return this.inner.deriveSubkey(info); }
}

/* THE HOST'S OWN ANSWER ABOUT AN ACCOUNT'S STANDING — UNMETERED, and stated rather than
   omitted. `assertMayAddMailbox` refuses a `null` verdict, deliberately: "nobody wired a
   reader" and "this host meters nothing" must not be the same state. This file's subject is
   not the limit, so it declares the unmetered one and moves on. */
const UNMETERED_READER = { accessOf: async (): Promise<AccessVerdict> => UNMETERED_ACCESS };
const fastSvc = makeMailboxService({ keyProvider: FAST_KP, ...UNMETERED_READER });
const slowSvc = makeMailboxService({
  keyProvider: new SlowKeyProvider(FAST_KP, 400), ...UNMETERED_READER,
});

const ctxOn = (db: typeof dbA, accountId: string): ServiceContext =>
  ({ db: db as unknown as ServiceContext["db"], accountId, userId: null, now: () => NOW, requestId: "r" });

const IMAP = { host: "imap.example", port: 993, secure: true, user: "u", pass: fixturePassword("mailbox-credential-race") };

/**
 * The probe seam, satisfied rather than exercised — a later change extended it from `create` to `update`.
 *
 * ALWAYS "ok", and that is load-bearing for this file: every case here is about the ROW LOCK, so
 * a probe that could refuse would decide the race before the lock ever got the chance and these
 * tests would go green for the wrong reason. The verdicts themselves are driven in
 * `packages/api/test/mailbox-add-probe.wprobe.test.ts` and
 * `packages/api/test/mailbox-patch-probe.at10.test.ts`.
 */
const PROBE_OK = { probe: async () => ({ verdict: "ok" as const }) };

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
/* TWO ENDS IN PARALLEL, UNDER A BOUND OF THIS HOOK'S OWN. Sequentially, two 5 s ends sit inside
   vitest's 10 s default and the hook times out on the sum while every test has passed — a red at
   the boundary that reads as a suite failure and is a teardown. */
afterAll(async () => {
  await Promise.all([sqlA.end({ timeout: 5 }), sqlB.end({ timeout: 5 })]);
}, 60_000);

describe.skipIf(!PG_UP)("a disabled mailbox never keeps a credential", () => {
  async function seeded(): Promise<{ accountId: string; mailboxId: string }> {
    const [a] = await dbA.insert(accounts).values({ name: `race-${randomUUID().slice(0, 8)}` }).returning();
    const dto = await fastSvc.create(ctxOn(dbA, a!.id), {
      provider: "imap", address: `race-${randomUUID().slice(0, 8)}@x.test`, imap: IMAP,
    // The seam, satisfied rather than exercised: `create` requires a probe now, this
    // file is about the credential race, and the verdicts are driven in
    // `packages/api/test/mailbox-add-probe.wprobe.test.ts`.
    }, { probe: async () => ({ verdict: "ok" as const }) });
    return { accountId: a!.id, mailboxId: dto.id };
  }

  const state = async (id: string): Promise<{ status: string; creds: number }> => {
    const [mb] = await dbA.select().from(mailboxes).where(eq(mailboxes.id, id));
    const creds = await dbA.select().from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, id));
    return { status: mb!.status, creds: creds.length };
  };

  it("PATCH holds the lock, DELETE waits behind it — and the credential does not survive", async () => {
    const { accountId, mailboxId } = await seeded();

    // The PATCH takes the row lock and then stalls 400 ms encrypting. The delete arrives 60 ms
    // in and must BLOCK; without the lock it would slip between the patch's read and its write.
    const patch = slowSvc.update(ctxOn(dbA, accountId), mailboxId, { imap: { pass: "rotated" } }, PROBE_OK)
      .then(() => Date.now());
    await sleep(60);
    const started = Date.now();
    const del = fastSvc.delete(ctxOn(dbB, accountId), mailboxId).then(() => Date.now());

    const [patchAt, delAt] = await Promise.all([patch, del]);
    // Evidence that the lock actually blocked rather than the two merely finishing in order:
    // the delete could not complete until the patch's transaction committed.
    expect(delAt).toBeGreaterThanOrEqual(patchAt);
    expect(delAt - started).toBeGreaterThan(200);

    expect(await state(mailboxId)).toEqual({ status: "disabled", creds: 0 });
  });

  it("DELETE first: a credential PATCH that arrives afterwards is REFUSED, not written", async () => {
    const { accountId, mailboxId } = await seeded();
    await fastSvc.delete(ctxOn(dbA, accountId), mailboxId);

    const err = await fastSvc.update(ctxOn(dbB, accountId), mailboxId, { imap: { pass: "rotated" } }, PROBE_OK)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe("mailbox_disabled");
    expect((err as ServiceError).httpStatus).toBe(409);
    expect(await state(mailboxId)).toEqual({ status: "disabled", creds: 0 });
  });

  it("EITHER ORDER, twelve times: never a disabled row holding a credential", async () => {
    // The property, without depending on which side wins. Both outcomes are legal —
    // (disabled, 0 creds) whichever way the lock falls — and the forbidden state is the
    // conjunction the invariant names.
    const cases = await Promise.all(Array.from({ length: 12 }, () => seeded()));
    await Promise.all(cases.map(async ({ accountId, mailboxId }, i) => {
      // HALF EACH WAY, and the alternation is load-bearing rather than tidy: starting the patch
      // first every time only ever exercises the interleaving the row lock already resolves, and
      // a run of that shape stays green with the effective-status refusal deleted.
      const patchFirst = i % 2 === 0;
      const svc = patchFirst ? slowSvc : fastSvc;
      const runPatch = (): Promise<unknown> =>
        // the probe seam. Always "ok" on purpose: this test is about the ROW LOCK, and a
        // probe that could refuse would decide the race before the lock ever got the chance.
        svc.update(ctxOn(dbA, accountId), mailboxId, { imap: { pass: `p-${i}` } }, PROBE_OK).catch((e: unknown) => e);
      const runDelete = (): Promise<unknown> =>
        fastSvc.delete(ctxOn(dbB, accountId), mailboxId).catch((e: unknown) => e);
      const first = patchFirst ? runPatch() : runDelete();
      await sleep(30);
      const second = patchFirst ? runDelete() : runPatch();
      await Promise.all([first, second]);
    }));

    for (const { mailboxId } of cases) {
      const s = await state(mailboxId);
      expect(s.status, "delete must always land").toBe("disabled");
      expect(s.creds, `mailbox ${mailboxId} is disabled and still holds a credential`).toBe(0);
    }
  });

  it("the refusal is NOT blanket — re-enabling and rotating in one PATCH still works", async () => {
    // The gate is on the EFFECTIVE status, so the one-call reconnect the UI performs is
    // untouched. A gate that broke this would be a worse defect than the one it closes.
    const { accountId, mailboxId } = await seeded();
    await fastSvc.delete(ctxOn(dbA, accountId), mailboxId);
    expect(await state(mailboxId)).toEqual({ status: "disabled", creds: 0 });

    const dto = await fastSvc.update(ctxOn(dbA, accountId), mailboxId, {
      status: "connected", imap: { ...IMAP, pass: "fresh-pass-password-password" },
    }, PROBE_OK);
    expect(dto.status).toBe("connected");
    const [cred] = await dbA.select().from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, mailboxId));
    expect(await FAST_KP.decrypt(cred!.secretEnc, cred!.keyVersion)).toBe("fresh-pass-password-password");
  });

  it("a PATCH that only renames a disabled mailbox is still fine — only SECRETS are gated", async () => {
    const { accountId, mailboxId } = await seeded();
    await fastSvc.delete(ctxOn(dbA, accountId), mailboxId);
    const dto = await fastSvc.update(ctxOn(dbA, accountId), mailboxId, { displayName: "Old work address" });
    expect(dto.displayName).toBe("Old work address");
    expect(dto.status).toBe("disabled");
  });
});

/**
 * THE SCENARIO THE REVIEW ACTUALLY NAMED: the dedup resolver, not `delete`.
 *
 * "A concurrent credential PATCH that read a duplicate loser before the migration ran can commit
 * its credential upsert afterwards." Reproducing it needs a database with duplicates in it, which
 * the shared one cannot have — `mailboxes_active_address_uq` makes them unrepresentable. So this
 * builds a throwaway database in the state a developer's would have been in the day before 0021
 * shipped: fully migrated, then the index dropped and 0021's bookkeeping row removed.
 */
const ENTRY_0021 = readJournalOf(MAIL_JOURNAL).find((e) => e.tag === "0021_mailbox_address_unique");

describe.skipIf(!PG_UP)("the dedup resolver and a credential PATCH cannot interleave into a tombstone", () => {
  const dbName = `ohmail_credrace_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  let admin: ReturnType<typeof postgres>;
  let c1: ReturnType<typeof postgres>;
  let c2: ReturnType<typeof postgres>;
  let d1: ReturnType<typeof drizzle<typeof schema>>;
  let d2: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    expect(ENTRY_0021).toBeDefined();
    admin = postgres(PG_TEST_URL, { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => {} });
    await admin.unsafe(`create database "${dbName}"`);
    const u = new URL(PG_TEST_URL);
    u.pathname = `/${dbName}`;
    await runMigrations(u.toString());
    c1 = postgres(u.toString(), { max: 5, onnotice: () => {} });
    c2 = postgres(u.toString(), { max: 5, onnotice: () => {} });
    d1 = brandDialect(drizzle(c1, { schema }), "pg");
    d2 = brandDialect(drizzle(c2, { schema }), "pg");
    await d1.execute(sql.raw(`drop index if exists "${ACTIVE_ADDRESS_UQ}"`));
    await d1.execute(sql`delete from drizzle_mail.__drizzle_migrations where created_at = ${ENTRY_0021!.when}`);
  }, 180_000);

  /* The two pool ends in parallel, then the drop — the order matters (a forced drop would kill
     them anyway, but ending first keeps the drop from racing a live backend) — and the whole hook
     under its own bound rather than vitest's 10 s default, which the sum of four awaits exceeds. */
  afterAll(async () => {
    await Promise.all([
      c1?.end({ timeout: 5 }).catch(() => {}),
      c2?.end({ timeout: 5 }).catch(() => {}),
    ]);
    await admin?.unsafe(`drop database if exists "${dbName}" with (force)`).catch(() => {});
    await admin?.end({ timeout: 5 }).catch(() => {});
  }, 60_000);

  /** Two active rows on one address: `keep` (the working one) and `loser` (the one to disable). */
  async function duplicates(): Promise<{ accountId: string; keep: string; loser: string }> {
    const [a] = await d1.insert(accounts).values({ name: `dup-${randomUUID().slice(0, 8)}` }).returning();
    const address = `dup-${randomUUID().slice(0, 8)}@x.test`;
    const mk = async (status: string): Promise<string> => {
      const [mb] = await d1.insert(mailboxes)
        .values({ accountId: a!.id, provider: "imap", address, status }).returning();
      await d1.insert(mailboxCredentials).values({
        // `meta` is what `MailboxService.create` writes on every real row, and a later change made the
        // update path READ it: a credential rotation is dialled against the merge of the patch
        // over the stored connection params. Seeding it here is not a concession to the new
        // code — a row without it never existed in production, and leaving it out made this
        // fixture describe a mailbox the worker could not have logged into either.
        mailboxId: mb!.id, transport: "imap", secretEnc: "enc", keyVersion: 1,
        meta: { host: IMAP.host, port: IMAP.port, secure: IMAP.secure, user: IMAP.user },
      });
      return mb!.id;
    };
    return { accountId: a!.id, keep: await mk("connected"), loser: await mk("error") };
  }

  const credsOf = async (id: string): Promise<number> =>
    (await d1.select().from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, id))).length;

  it("PATCH first: the resolver waits, and the loser ends disabled with no credential", async () => {
    const { accountId, keep, loser } = await duplicates();

    const patch = slowSvc.update(ctxOn(d1 as never, accountId), loser, { imap: { pass: "rotated" } }, PROBE_OK);
    await sleep(60);
    const resolve = resolveActiveAddressDuplicates(d2 as never, [keep], NOW);

    const [, outcomes] = await Promise.all([patch, resolve]);
    expect(outcomes.map((o) => [o.kept, o.disabled])).toEqual([[keep, [loser]]]);

    const [row] = await d1.select().from(mailboxes).where(eq(mailboxes.id, loser));
    expect(row!.status).toBe("disabled");
    // The whole point: the credential the PATCH committed a moment earlier is gone with it.
    expect(await credsOf(loser)).toBe(0);
    expect(await credsOf(keep)).toBe(1);
  });

  it("resolver first: the PATCH blocks, re-reads 'disabled', and refuses", async () => {
    const { accountId, keep, loser } = await duplicates();

    await resolveActiveAddressDuplicates(d1 as never, [keep], NOW);
    const err = await fastSvc.update(ctxOn(d2 as never, accountId), loser, { imap: { pass: "rotated" } }, PROBE_OK)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe("mailbox_disabled");
    expect(await credsOf(loser)).toBe(0);
  });
});
