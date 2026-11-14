import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import {
  accounts, accountSettings, drafts, folderState, mailboxes, mailboxCredentials, messages,
  OrganizedElsewhereError, UNMETERED_ACCESS, type AccessVerdict,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { StaticKeyProvider } from "@trafficflow/core";
import {
  ScreenerService, makeMailboxService, messageService, scheduleService, triageService,
  type ServiceContext,
} from "@trafficflow/services";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A READER IS REFUSED AT EVERY WRITE DOOR — and the refusal carries who holds the mailbox
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Mail 0083. The census beside this file proves every door CALLS the refusal; this file proves the
 * refusal REFUSES, and that what it hands back is a sentence a client can render: `409
 * organized_elsewhere` with `by: { kind, name, since }`.
 *
 * ── WHY REAL POSTGRES ───────────────────────────────────────────────────────────────────────
 *
 * Two of the four cases are concurrency and cannot be expressed anywhere else. The refusals
 * themselves would run on PGlite; they are here because they share a fixture with the races and
 * because splitting them would mean two spellings of "make a reader".
 *
 * The race that matters is CONSENT RACING THE FIRST SCREENER DECIDE. Both write
 * `screening_baseline_at`, both guard on it being NULL, and they guard DIFFERENTLY: the decide
 * uses `ON CONFLICT … DO UPDATE … WHERE screening_baseline_at IS NULL`, the consent uses
 * `COALESCE`. Two correct-looking implementations of one invariant is exactly the shape that
 * produces two baselines under load — and the value MATTERS (readers do arithmetic on it, not an
 * `IS NOT NULL` check), so "which write wins" has a wrong answer rather than a tie. PGlite is
 * single-connection, so two awaited calls there are sequential by construction and a sequential
 * test of a concurrent property cannot fail.
 */
const PG_UP = await realPgAvailable();

const sqlA = postgres(PG_TEST_URL, { max: 6, onnotice: () => {} });
const sqlB = postgres(PG_TEST_URL, { max: 6, onnotice: () => {} });
const dbA = brandDialect(drizzle(sqlA, { schema }), "pg");
const dbB = brandDialect(drizzle(sqlB, { schema }), "pg");

const NOW = new Date("2026-09-02T09:00:00.000Z");
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7), 1);
/* THE HOST'S OWN ANSWER ABOUT AN ACCOUNT'S STANDING — UNMETERED, and stated rather than
   omitted. `assertMayAddMailbox` refuses a `null` verdict, deliberately: "nobody wired a
   reader" and "this host meters nothing" must not be the same state. This file's subject is
   not the limit, so it declares the unmetered one and moves on. */
const UNMETERED_READER = { accessOf: async (): Promise<AccessVerdict> => UNMETERED_ACCESS };
const mailboxSvc = makeMailboxService({ keyProvider: KP, ...UNMETERED_READER });

const ctxOn = (db: typeof dbA, accountId: string, now: Date = NOW): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId, userId: null, now: () => now, requestId: `rr-${randomUUID().slice(0, 8)}`,
});

interface World {
  accountId: string; mailboxId: string; messageId: string; heldId: string; draftId: string;
}

/**
 * An account whose ONE mailbox is a READER — demoted exactly as the worker's gate demotes it:
 * the role and the four holder columns, `status` untouched. A message and a draft sit on it, so
 * every door below has something real to refuse about.
 */
async function readerWorld(): Promise<World> {
  const accountId = randomUUID();
  await dbA.insert(accounts).values({ id: accountId, name: `rr-${accountId.slice(0, 8)}` });
  // A LIVE SUBSCRIPTION, because `organizeHere` takes the allowance gate — becoming the organizer
  // of a mailbox IS a connection whichever door it comes through, and an account with no plan is
  // refused before the role is ever consulted. That refusal has its own case in the takeover
  // suite; here it would just hide the property under test.
  const [mb] = await dbA.insert(mailboxes).values({
    accountId, provider: "imap", address: `rr-${accountId.slice(0, 8)}@reader.test`,
    organizerRole: "reader",
    organizedByKind: "local",
    organizedByName: "mila-thinkpad",
    organizedSince: new Date("2026-08-20T08:30:00.000Z"),
    organizerState: "held",
    // CONSENTED, deliberately. The refusal must be about the ROLE and not about consent, or a
    // green here would only prove that an unconsented mailbox refuses — which is a different
    // (and weaker) statement.
    organizeConsentedAt: new Date("2026-08-01T00:00:00.000Z"),
  }).returning();
  // TWO messages, and the pair is the realistic shape of a demoted organizer's store.
  //
  //  · `m` is in INBOX with `last_set_by: 'external'` — a row THIS install ingested as a reader,
  //    which is what `planChange`'s reader arm writes.
  //  · `held` is in `ohmail/Screener` with `last_set_by: 'us'` — a row from before the demotion,
  //    which survives it (the mirror is kept). It is also the only shape the SCREENER can decide
  //    about: `decide` refuses a message that is not held at the gate, so a fixture with only the
  //    INBOX row would be refused for the wrong reason and prove nothing about the role.
  // A STORED IMAP CREDENTIAL. `organizeHere` with no password in the body requires one — a claim
  // on a mailbox with nothing to log in with authorizes a becoming the worker cannot perform, and
  // the ceremony refuses it rather than committing a stamp that quarantines the mailbox. The
  // fixture inserts the row directly (the encryption is not what these cases are about); the
  // takeover suite beside this one builds its mailboxes through `create`, which writes it.
  await dbA.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap", secretEnc: "sealed", keyVersion: 1,
    meta: { host: "imap.reader.test", port: 993, secure: true, user: "u" },
    updatedAt: NOW,
  });
  const [m] = await dbA.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `rr:${randomUUID()}`,
    subject: "held", fromAddress: "stranger@waiting.test",
    nativeLocator: { folder: "INBOX", ref: "1:7" },
  }).returning();
  await dbA.insert(folderState).values({
    messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX",
    lastSetBy: "external", reconcileStatus: "reconciled", conflict: false,
  });
  const [h] = await dbA.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: "h2", dedupKey: `rr:${randomUUID()}`,
    subject: "at the gate", fromAddress: "waiting@waiting.test",
    nativeLocator: { folder: "ohmail/Screener", ref: "1:8" },
  }).returning();
  await dbA.insert(folderState).values({
    messageId: h!.id, accountId: h!.accountId, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  const [d] = await dbA.insert(drafts).values({
    accountId, mailboxId: mb!.id, subject: "later", body: "words",
    to: [{ name: null, address: "you@example.com" }], status: "draft",
    createdAt: NOW, updatedAt: NOW,
  }).returning();
  return { accountId, mailboxId: mb!.id, messageId: m!.id, heldId: h!.id, draftId: d!.id };
}

/** The same account with an ORGANIZER mailbox — the control every refusal below needs. */
async function organizerWorld(): Promise<World> {
  const w = await readerWorld();
  await dbA.update(mailboxes)
    .set({
      organizerRole: "organizer", organizedByKind: null, organizedByName: null,
      organizedSince: null, organizerState: null,
    })
    .where(eq(mailboxes.id, w.mailboxId));
  return w;
}

type Decided = { createdRuleId?: string | null; mailboxes?: unknown };

/** The consent and the first decide in one ORDER; asserts what holds in every order, returns the decide. */
async function decideBesideConsent(order: "race" | "decide-first" | "consent-first") {
  const w = await readerWorld();
  const svc = new ScreenerService({});
  const consentAt = new Date("2026-09-02T09:00:00.000Z");
  const decideAt = new Date("2026-09-02T09:00:00.500Z");
  const consentCall = () => mailboxSvc.organizeHere(ctxOn(dbA, w.accountId, consentAt), w.mailboxId, {
    intent: "takeover", screening: { dormancyDays: 365 },
  }).catch((e: unknown) => e);
  const decideCall = () => svc.decide(ctxOn(dbB, w.accountId, decideAt), w.heldId, { decision: "yes", dest: "INBOX" })
    .catch((e: unknown) => e);
  let consent: unknown;
  let decided: unknown;
  if (order === "race") [consent, decided] = await Promise.all([consentCall(), decideCall()]);
  else if (order === "decide-first") { decided = await decideCall(); consent = await consentCall(); }
  else { consent = await consentCall(); decided = await decideCall(); }

  if (consent instanceof Error) throw consent;
  expect((consent as { outcome?: string }).outcome).toBe("authorized");
  // The consent does not flip the role (the gate promotes), so no order files the held mail.
  const [mb] = await dbA.select().from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
  expect(mb!.organizerRole).toBe("reader");
  const [held] = await dbA.select().from(folderState).where(eq(folderState.messageId, w.heldId));
  expect(held).toMatchObject({ desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener" });

  const [st] = await dbA.select().from(accountSettings)
    .where(eq(accountSettings.accountId, w.accountId));
  expect(st!.screeningBaselineAt?.toISOString()).toBe(consentAt.toISOString());
  expect(st!.dormancyDays).toBe(365);

  // NOW PROMOTE, as the gate would, and decide. The baseline must not move.
  await dbA.update(mailboxes).set({ organizerRole: "organizer" })
    .where(eq(mailboxes.id, w.mailboxId));
  const later = new Date("2026-09-09T12:00:00.000Z");
  await svc.decide(ctxOn(dbA, w.accountId, later), w.heldId, { decision: "yes", dest: "INBOX" });
  const [after] = await dbA.select().from(accountSettings)
    .where(eq(accountSettings.accountId, w.accountId));
  expect(
    after!.screeningBaselineAt?.toISOString(),
    "the first decide re-stamped a baseline the consent had already established",
  ).toBe(consentAt.toISOString());
  return { w, decided };
}

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await sqlA.end({ timeout: 5 }); await sqlB.end({ timeout: 5 }); });

describe.skipIf(!PG_UP)("a reader is refused at every write door", () => {
  it("SCHEDULING A SEND is 409 organized_elsewhere, and it names who holds the mailbox", async () => {
    const w = await readerWorld();
    const due = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
    const err = await scheduleService.schedule(ctxOn(dbA, w.accountId), w.draftId, due)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OrganizedElsewhereError);
    const e = err as OrganizedElsewhereError;
    expect(e.httpStatus).toBe(409);
    expect(e.code).toBe("organized_elsewhere");
    // THE THREE FIELDS A SENTENCE NEEDS. Without them every door would have to compose its own
    // guess ("another install has this"), which is the copy this ruling replaced.
    expect(e.details.by).toEqual({
      kind: "local",
      name: "mila-thinkpad",
      since: "2026-08-20T08:30:00.000Z",
    });

    // AND NOTHING WAS WRITTEN. An appointment refused after being recorded would be the orphan
    // `closeStoodDownAppointments` exists to clean up — created by the very check meant to
    // prevent it.
    const [d] = await dbA.select().from(drafts).where(eq(drafts.id, w.draftId));
    expect(d!.status).toBe("draft");
    expect(d!.sendAt).toBeNull();
    expect(d!.sendKey).toBeNull();
  });

  it("NEGATIVE CONTROL — the same draft on an ORGANIZER mailbox schedules", async () => {
    // Without this the case above proves only that scheduling is broken.
    const w = await organizerWorld();
    const due = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
    await scheduleService.schedule(ctxOn(dbA, w.accountId), w.draftId, due);
    const [d] = await dbA.select().from(drafts).where(eq(drafts.id, w.draftId));
    expect(d!.status).toBe("scheduled");
    expect(d!.sendKey).not.toBeNull();
  });

  it("MOVE, DELETE and TRIAGE are all 409 — and the mirror row is untouched by each", async () => {
    const w = await readerWorld();

    const move = await messageService.move(ctxOn(dbA, w.accountId), w.messageId, { folder: "ohmail/News" })
      .catch((e: unknown) => e);
    expect(move).toBeInstanceOf(OrganizedElsewhereError);

    const del = await messageService.delete(ctxOn(dbA, w.accountId), w.messageId)
      .catch((e: unknown) => e);
    expect(del).toBeInstanceOf(OrganizedElsewhereError);

    const triage = await triageService.setState(ctxOn(dbA, w.accountId), w.messageId, { state: "parked" })
      .catch((e: unknown) => e);
    expect(triage).toBeInstanceOf(OrganizedElsewhereError);

    // THE ROW IS EXACTLY AS THE READER'S OWN CYCLE LEFT IT. `desired === observed === INBOX` with
    // `last_set_by: 'external'` is what `planChange`'s reader arm writes, and it is what keeps
    // the row out of every retro pass by DATA. A refusal that had already written `desired` would
    // leave a move queued to fire on the next promotion.
    const [fs] = await dbA.select().from(folderState).where(eq(folderState.messageId, w.messageId));
    expect(fs).toMatchObject({
      desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "external",
    });
  });

  it("SCREENER DECIDE is refused for an account that organizes nothing", async () => {
    // ACCOUNT-scoped: a decision writes a RULE, and rules belong to the account. On a one-mailbox
    // standalone this collapses to "all refused", which is the honest answer — a rule this install
    // will never apply is a settings screen that accepts an edit and silently does nothing.
    const w = await readerWorld();
    const svc = new ScreenerService({});
    const err = await svc.decide(ctxOn(dbA, w.accountId), w.heldId, { decision: "yes", dest: "INBOX" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrganizedElsewhereError);
    // No rule, and — the sharper half — NO BASELINE. The decide's baseline stamp is inside the
    // same transaction as the rule, so a refusal that landed after it would establish a cutline
    // for an account that has decided nothing, quietly emptying its Screener queue.
    const [st] = await dbA.select().from(accountSettings)
      .where(eq(accountSettings.accountId, w.accountId));
    expect(st?.screeningBaselineAt ?? null).toBeNull();
  });

  /**
   * CONSENT RACING THE FIRST DECIDE. Both write `screening_baseline_at`, guarded on NULL two ways
   * (`COALESCE` on the consent, `ON CONFLICT … WHERE … IS NULL` on the decide): ONE baseline, and
   * no later decide moves it. The decide's own answer follows the commit order. Read before the
   * consent it is refused on the ROLE; read after, the takeover the consent asked for admits it
   * as a rule whose held mail waits for the claim (setup keeps its first decision). Either way
   * the consent leaves the role alone and nothing is filed. The race must be one of the two.
   */
  it("CONSENT RACING THE FIRST DECIDE: exactly ONE baseline, and it never moves afterwards", async () => {
    const { w, decided } = await decideBesideConsent("race");
    if (!(decided instanceof OrganizedElsewhereError)) {
      expect((decided as Decided).mailboxes, "the racing decide was neither refused nor held for the claim")
        .toEqual({ filed: [], requested: [], awaiting: [w.mailboxId] });
    }
  });

  it("a decide read before the consent is refused on the ROLE", async () => {
    const { decided } = await decideBesideConsent("decide-first");
    expect(decided).toBeInstanceOf(OrganizedElsewhereError);
  });

  it("a decide after the takeover consent is a rule at once, and its held mail waits for the claim", async () => {
    const { w, decided } = await decideBesideConsent("consent-first");
    expect((decided as Decided).createdRuleId).toBeTruthy();
    expect((decided as Decided).mailboxes).toEqual({ filed: [], requested: [], awaiting: [w.mailboxId] });
  });
});
