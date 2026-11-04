import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { accounts, mailboxCredentials, UNMETERED_ACCESS, type AccessVerdict } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { StaticKeyProvider, type KeyProvider } from "@trafficflow/core";
import { makeMailboxService, ServiceError, type ServiceContext } from "@trafficflow/services";

/**
 * TWO CONCURRENT CREDENTIAL PATCHES MUST NOT COMMIT A MERGE NEITHER SERIAL ORDER WOULD PRODUCE.
 *
 * ## The state this file exists to make unreachable
 *
 * `MailboxService.update` probes a rotated credential BEFORE it opens its transaction, and it has
 * two good reasons to (`probedImapMeta`'s header: a foreign dial inside the transaction pins the
 * pooled connection at `max: 1`, and it would hold `SELECT … FOR UPDATE` on the mailbox row across
 * somebody else's mail server going quiet). The consequence nobody had written down is that the
 * MERGE computed from that unlocked read is what the transaction later WRITES:
 *
 *   stored     meta = { host: A, port: 993, secure: true, user: u }
 *   t1  PATCH { imap: { host: B, pass: p1 } }   reads A, merges → { host: B, … }
 *   t2  PATCH { imap: { pass: p2 } }            reads A, merges → { host: A, … }   ← stale
 *   t1  commits    meta.host = B
 *   t2  commits    meta.host = A                                                   ← lost update
 *
 * and the mailbox is left pointing at the host the user just moved off, with the new password on
 * it. Neither "t1 then t2" (which ends at B, because t2 never mentions a host and jsonb `||`
 * preserves the keys a patch does not restate) nor "t2 then t1" (which ends at B, because t1 sets
 * it) produces that. The `FOR UPDATE` added for the delete/dedup race does not cover it: the lost
 * value lives in `mailbox_credentials.meta`, not in the `mailboxes` row the lock protects.
 *
 * ## Why real Postgres, and why the timings
 *
 * PGlite is single-connection and cannot express one transaction blocking on another's row lock —
 * and the block is the mechanism here, because it is what puts t2's commit AFTER t1's. Two
 * independent `postgres()` pools make the concurrency genuine rather than one driver's queue, and
 * the interleaving is forced rather than hoped for: `SlowKeyProvider` stalls 400 ms inside t1's
 * transaction, after it has taken the row lock, so t2 is guaranteed to do its unlocked pre-read
 * while t1 holds the lock and to commit after t1 releases it. Same trick, and the same reason, as
 * `mailbox-credential-race.pg.test.ts`.
 *
 * ## What "both orders" buys, given only one of them can be red
 *
 * Only HOST-CHANGER-FIRST can lose the update: run the password-only patch first and its commit
 * changes nothing, so the host-changer's merge is not stale and the final host is B either way.
 * That order is the CONTROL — it is the case a fix must leave alone, and a refusal that fired
 * there would be a worse defect than the one being closed.
 */
const PG_UP = await realPgAvailable();

const sqlA = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });
const sqlB = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });
const dbA = brandDialect(drizzle(sqlA, { schema }), "pg");
const dbB = brandDialect(drizzle(sqlB, { schema }), "pg");

const NOW = new Date("2026-09-01T12:00:00.000Z");
const sleep = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms); });
const FAST_KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 11), 1);

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

const HOST_A = "imap.a.test";
const HOST_B = "imap.b.test";
const SMTP_A = "smtp.a.test";
const SMTP_B = "smtp.b.test";

/**
 * ALWAYS "ok", with NO `proven` — load-bearing twice over. Every case here is about what the
 * unlocked pre-read carries into the write, so a probe that could refuse would decide the race
 * before the merge ever got the chance; and a probe that PROVED a port would overwrite `port` on
 * every patch, which would make the stored meta differ for reasons unrelated to the lost update.
 * The verdicts themselves are driven in `packages/api/test/mailbox-patch-probe.at10.test.ts`.
 */
const PROBE_OK = {
  probe: async () => ({ verdict: "ok" as const }),
  smtpProbe: async () => ({ verdict: "ok" as const }),
};

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await sqlA.end({ timeout: 5 }); await sqlB.end({ timeout: 5 }); });

describe.skipIf(!PG_UP)("a concurrent credential PATCH never restores a superseded transport config", () => {
  async function seeded(): Promise<{ accountId: string; mailboxId: string }> {
    const [a] = await dbA.insert(accounts).values({ name: `lost-${randomUUID().slice(0, 8)}` }).returning();
    const dto = await fastSvc.create(ctxOn(dbA, a!.id), {
      provider: "imap",
      address: `lost-${randomUUID().slice(0, 8)}@x.test`,
      imap: { host: HOST_A, port: 993, secure: true, user: "u", pass: "earlier-entry-password" },
      smtp: { host: SMTP_A, port: 465, secure: true, user: "u", pass: "earlier-entry-password" },
    }, PROBE_OK);
    return { accountId: a!.id, mailboxId: dto.id };
  }

  const metaOf = async (id: string, transport: "imap" | "smtp"): Promise<Record<string, unknown>> => {
    const [row] = await dbA.select().from(mailboxCredentials)
      .where(and(eq(mailboxCredentials.mailboxId, id), eq(mailboxCredentials.transport, transport)));
    return (row!.meta ?? {}) as Record<string, unknown>;
  };
  const secretOf = async (id: string, transport: "imap" | "smtp"): Promise<string> => {
    const [row] = await dbA.select().from(mailboxCredentials)
      .where(and(eq(mailboxCredentials.mailboxId, id), eq(mailboxCredentials.transport, transport)));
    return FAST_KP.decrypt(row!.secretEnc, row!.keyVersion);
  };

  it("HOST-CHANGER FIRST: the password-only patch that read the OLD host does not put it back", async () => {
    const { accountId, mailboxId } = await seeded();

    // t1 takes the mailbox row lock and then stalls 400 ms encrypting, so t2's UNLOCKED pre-read
    // is guaranteed to see the meta from before t1 and its transaction is guaranteed to commit after t1's.
    const t1 = slowSvc.update(ctxOn(dbA, accountId), mailboxId, { imap: { host: HOST_B, pass: "p1" } }, PROBE_OK)
      .then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, e }));
    await sleep(60);
    const startedT2 = Date.now();
    const t2 = fastSvc.update(ctxOn(dbB, accountId), mailboxId, { imap: { pass: "p2" } }, PROBE_OK)
      .then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, e }));

    const [r1, r2] = await Promise.all([t1, t2]);
    // Evidence the interleaving actually happened: t2 blocked on t1's row lock rather than the
    // two merely running in sequence. Without the block the whole scenario is a different one.
    expect(Date.now() - startedT2).toBeGreaterThan(200);
    expect(r1.ok, "the host change is the one that must land").toBe(true);

    // THE PROPERTY, stated without reference to which side wins: no serial ordering of these two
    // requests ends with the mailbox pointing at the host the user moved off.
    expect((await metaOf(mailboxId, "imap")).host).toBe(HOST_B);

    // And the loser is REFUSED OUT LOUD rather than answering 200 while storing something it did
    // not dial. A silent skip would tell the client a password is stored that is not.
    expect(r2.ok, "the stale patch must not report success").toBe(false);
    const err = (r2 as { e: unknown }).e;
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe("mailbox_config_changed");
    expect((err as ServiceError).httpStatus).toBe(409);
    // NOT flagged retryable, and that is a decision rather than an omission: the flag is read by
    // transports that retry on their own, and an automatic retry here re-dials somebody's mail
    // server unasked. The sentence tells the human to try again; nothing does it for them.
    expect((err as ServiceError).retryable).toBeUndefined();
    // Refused means NOTHING was written: the secret the refused patch carried is not stored.
    expect(await secretOf(mailboxId, "imap")).toBe("p1");
  });

  it("PASSWORD-ONLY FIRST — the control: the benign order still commits, and commits the new host", async () => {
    const { accountId, mailboxId } = await seeded();

    // The password-only patch holds the lock this time. Its commit changes no meta key, so the
    // host-changer's merge is NOT stale and must go through untouched. A conflict check that
    // fired here would break the ordinary rotate-then-correct-the-host sequence.
    const t2 = slowSvc.update(ctxOn(dbA, accountId), mailboxId, { imap: { pass: "p2" } }, PROBE_OK)
      .then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, e }));
    await sleep(60);
    const t1 = fastSvc.update(ctxOn(dbB, accountId), mailboxId, { imap: { host: HOST_B, pass: "p1" } }, PROBE_OK)
      .then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, e }));

    const [r2, r1] = await Promise.all([t2, t1]);
    expect(r2.ok, `password-only patch was refused: ${String((r2 as { e?: unknown }).e)}`).toBe(true);
    expect(r1.ok, `host change was refused: ${String((r1 as { e?: unknown }).e)}`).toBe(true);
    expect((await metaOf(mailboxId, "imap")).host).toBe(HOST_B);
    expect(await secretOf(mailboxId, "imap")).toBe("p1");
  });

  it("AGREEING PATCHES ARE NOT A CONFLICT — both name the same new host, both land", async () => {
    const { accountId, mailboxId } = await seeded();

    // The case that separates a RECOMPUTED merge from a blunt "did the stored meta move" check.
    // The stored meta DOES move (A → B) under the second patch's feet, but recomputing its merge
    // against the new value yields exactly the config it dialled, so there is nothing stale to
    // write back and refusing would be a false conflict.
    const t1 = slowSvc.update(ctxOn(dbA, accountId), mailboxId, { imap: { host: HOST_B, pass: "p1" } }, PROBE_OK)
      .then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, e }));
    await sleep(60);
    const t2 = fastSvc.update(ctxOn(dbB, accountId), mailboxId, { imap: { host: HOST_B, pass: "p2" } }, PROBE_OK)
      .then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, e }));

    const [r1, r2] = await Promise.all([t1, t2]);
    expect(r1.ok, `first patch refused: ${String((r1 as { e?: unknown }).e)}`).toBe(true);
    expect(r2.ok, `agreeing patch was falsely refused: ${String((r2 as { e?: unknown }).e)}`).toBe(true);
    expect((await metaOf(mailboxId, "imap")).host).toBe(HOST_B);
    expect(await secretOf(mailboxId, "imap")).toBe("p2");
  });

  it("SMTP has the same seam and the same answer — a stale submission host is not restored", async () => {
    const { accountId, mailboxId } = await seeded();

    const t1 = slowSvc.update(ctxOn(dbA, accountId), mailboxId, { smtp: { host: SMTP_B, pass: "s1" } }, PROBE_OK)
      .then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, e }));
    await sleep(60);
    const t2 = fastSvc.update(ctxOn(dbB, accountId), mailboxId, { smtp: { pass: "s2" } }, PROBE_OK)
      .then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, e }));

    const [r1, r2] = await Promise.all([t1, t2]);
    expect(r1.ok, "the submission host change is the one that must land").toBe(true);
    expect((await metaOf(mailboxId, "smtp")).host).toBe(SMTP_B);
    expect(r2.ok, "the stale submission patch must not report success").toBe(false);
    expect((r2 as { e: unknown }).e).toBeInstanceOf(ServiceError);
    expect(((r2 as { e: unknown }).e as ServiceError).code).toBe("mailbox_config_changed");
    expect(await secretOf(mailboxId, "smtp")).toBe("s1");
  });

  it("UNCONTENDED PATCHES ARE UNAFFECTED — the ordinary rotate, and the ordinary re-point", async () => {
    // The refusal must be about CONCURRENCY and nothing else. A serial sequence of exactly the
    // two patches the first case races reaches the outcome the first case's property names.
    const { accountId, mailboxId } = await seeded();

    await fastSvc.update(ctxOn(dbA, accountId), mailboxId, { imap: { host: HOST_B, pass: "p1" } }, PROBE_OK);
    await fastSvc.update(ctxOn(dbA, accountId), mailboxId, { imap: { pass: "p2" } }, PROBE_OK);

    const meta = await metaOf(mailboxId, "imap");
    expect(meta.host).toBe(HOST_B);
    // The keys the patches never restated survive, which is what `||` is there for.
    expect(meta.port).toBe(993);
    expect(meta.secure).toBe(true);
    expect(meta.user).toBe("u");
    expect(await secretOf(mailboxId, "imap")).toBe("p2");
  });

  /**
   * ══ THE SUBMISSION HOST A CREDENTIAL WAS SAVED FOR — recorded here, compared elsewhere ═══════
   *
   * An install that holds the whole mailbox itself has one password for both transports and reads
   * its outgoing coordinates from its own configuration, so it owns no `smtp` credential row and
   * nothing recorded WHICH outgoing server a password had been saved for. Its sending path
   * therefore had nothing to compare its configuration against, and a change that moved only the
   * outgoing server left the stored password offerable to a server nobody had named.
   *
   * `TransportInput.smtpHost` is that missing record, and it is written by THIS service, which a
   * hosted deployment shares. Hence the two properties these cases hold, in this order of
   * importance:
   *
   *  1. A CALLER THAT NEVER SENDS IT CHANGES NOTHING. Every case above is exactly that caller, and
   *     the tolerance case below says it about the stored blob directly.
   *  2. IT IS INSIDE THE COMPARE-AND-SET, not bolted on after it, and the direction that costs is
   *     the OPPOSITE of the one it looks like. A STALE value is caught either way — the stored meta
   *     is spread into the merge, so `smtpHost` rides through the recomputation whether or not the
   *     patch's own statement does. What the placement decides is whether the patch's NEW statement
   *     is visible to that recomputation, and a witness applied after the merge is not: two patches
   *     that AGREE about the authorized outgoing server then read as a conflict, because the merge
   *     they are compared on still carries the value they both just replaced. Measured, not
   *     reasoned: the mutation that moves the key to the write leaves the stale case green and
   *     reddens the AGREEING one.
   */
  it("RECORDS the outgoing server a password is saved for, and leaves it alone when unmentioned", async () => {
    const { accountId, mailboxId } = await seeded();

    // Nothing writes it unless a caller says so — which is the whole of the backward tolerance.
    // `create` above never mentions it, so the row a hosted deployment produces is unchanged.
    expect(await metaOf(mailboxId, "imap")).not.toHaveProperty("smtpHost");

    await fastSvc.update(ctxOn(dbA, accountId), mailboxId,
      { imap: { host: HOST_A, pass: "p1", smtpHost: SMTP_A } }, PROBE_OK);
    expect((await metaOf(mailboxId, "imap")).smtpHost).toBe(SMTP_A);

    // A later rotation that says nothing about it keeps it, like every other unrestated key —
    // otherwise an ordinary password change would quietly retract the authorization.
    await fastSvc.update(ctxOn(dbA, accountId), mailboxId, { imap: { pass: "p2" } }, PROBE_OK);
    expect((await metaOf(mailboxId, "imap")).smtpHost).toBe(SMTP_A);

    // …and one that DOES say something moves it, because that is a new statement about the pair.
    await fastSvc.update(ctxOn(dbA, accountId), mailboxId,
      { imap: { pass: "p3", smtpHost: SMTP_B } }, PROBE_OK);
    expect((await metaOf(mailboxId, "imap")).smtpHost).toBe(SMTP_B);

    /* THE EMPTY STRING IS A STATEMENT, NOT A SILENCE. A caller with no outgoing server configured
       has to be able to retract a witness, or a stale one outlives the configuration that set it
       and the comparison it feeds is about a server this install no longer uses. */
    await fastSvc.update(ctxOn(dbA, accountId), mailboxId,
      { imap: { pass: "p4", smtpHost: "" } }, PROBE_OK);
    expect((await metaOf(mailboxId, "imap")).smtpHost).toBe("");

    // The INCOMING record is untouched by all of it: two servers, two keys, no crosstalk.
    expect((await metaOf(mailboxId, "imap")).host).toBe(HOST_A);

    /* AND IT IS AN INCOMING-BLOCK FIELD ONLY, asserted by sending it on the OUTGOING block and
       finding it dropped. A mailbox that owns an outgoing credential row already records that
       server in that row's own `host`, so a witness beside it would be one fact stored twice and
       two places for it to disagree. The type cannot express "this field, on that block only" —
       both blocks share one shape — so the narrowing is a runtime rule and this is what holds it. */
    await fastSvc.update(ctxOn(dbA, accountId), mailboxId,
      { smtp: { pass: "s9", smtpHost: SMTP_A } }, PROBE_OK);
    expect(await metaOf(mailboxId, "smtp")).not.toHaveProperty("smtpHost");
    expect((await metaOf(mailboxId, "smtp")).host).toBe(SMTP_A);
  });

  it("A STALE authorized outgoing server is not restored either — it is inside the compare-and-set", async () => {
    const { accountId, mailboxId } = await seeded();
    await fastSvc.update(ctxOn(dbA, accountId), mailboxId,
      { imap: { host: HOST_A, pass: "p0", smtpHost: SMTP_A } }, PROBE_OK);

    /* The same interleaving as the first case in this file, with the disagreement moved onto the
       new key: t1 moves the authorized outgoing server, t2's unlocked pre-read still sees the old
       one, and t2 commits second. Nothing but the recomputation stops t2 writing SMTP_A back over
       a mailbox whose password was just re-saved for SMTP_B — and the install would then refuse its
       own sends, or worse, permit one to a server nobody authorized. */
    const t1 = slowSvc.update(ctxOn(dbA, accountId), mailboxId,
      { imap: { pass: "p1", smtpHost: SMTP_B } }, PROBE_OK)
      .then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, e }));
    await sleep(60);
    const startedT2 = Date.now();
    const t2 = fastSvc.update(ctxOn(dbB, accountId), mailboxId, { imap: { pass: "p2" } }, PROBE_OK)
      .then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, e }));

    const [r1, r2] = await Promise.all([t1, t2]);
    // Evidence the interleaving happened rather than the two running in sequence.
    expect(Date.now() - startedT2).toBeGreaterThan(200);
    expect(r1.ok, "the change of authorized outgoing server is the one that must land").toBe(true);
    expect((await metaOf(mailboxId, "imap")).smtpHost).toBe(SMTP_B);
    expect(r2.ok, "the stale patch must not report success").toBe(false);
    expect((r2 as { e: unknown }).e).toBeInstanceOf(ServiceError);
    expect(((r2 as { e: unknown }).e as ServiceError).code).toBe("mailbox_config_changed");
    expect(await secretOf(mailboxId, "imap")).toBe("p1");
  });

  it("AGREEING about the outgoing server is not a conflict either — both land", async () => {
    const { accountId, mailboxId } = await seeded();
    await fastSvc.update(ctxOn(dbA, accountId), mailboxId,
      { imap: { host: HOST_A, pass: "p0", smtpHost: SMTP_A } }, PROBE_OK);

    /* THE CASE THAT SEPARATES A RECOMPUTED MERGE FROM A BLUNT "DID THE STORED META MOVE" CHECK, on
       the new key. The stored witness DOES move (A → B) under the second patch's feet, but
       recomputing its merge against the new value yields exactly what it meant to store, so
       refusing would be a false conflict — and a false conflict here is the ordinary case of two
       tabs, or a retry, saving the same change of outgoing server.

       This is also the case that decides WHERE the key is applied. A witness written after the
       merge is invisible to the recomputation: both patches' merges would still carry the OLD
       witness, the rebuild would carry the new one, and this would 409 for no reason. */
    const t1 = slowSvc.update(ctxOn(dbA, accountId), mailboxId,
      { imap: { pass: "p1", smtpHost: SMTP_B } }, PROBE_OK)
      .then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, e }));
    await sleep(60);
    const t2 = fastSvc.update(ctxOn(dbB, accountId), mailboxId,
      { imap: { pass: "p2", smtpHost: SMTP_B } }, PROBE_OK)
      .then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, e }));

    const [r1, r2] = await Promise.all([t1, t2]);
    expect(r1.ok, `first patch refused: ${String((r1 as { e?: unknown }).e)}`).toBe(true);
    expect(r2.ok, `agreeing patch was falsely refused: ${String((r2 as { e?: unknown }).e)}`).toBe(true);
    expect((await metaOf(mailboxId, "imap")).smtpHost).toBe(SMTP_B);
    expect(await secretOf(mailboxId, "imap")).toBe("p2");
  });
});
