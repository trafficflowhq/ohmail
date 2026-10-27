import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { brandDialect, dialect } from "@trafficflow/db/dialect";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, mailboxes, drafts, rules, organizerRequests, users, graduations,
  AccountErasedError, MailboxErasedError, type LedgerTx, type OrganizedBy, type Tx,
} from "@trafficflow/db";
// `auth_events` is a HOSTED table — the local install has no sign-in trail to keep.
import { authEvents, connectAttempts, recordConnectAttempt } from "@trafficflow/db/cloud";
import { sweepMailboxData } from "../src/mailbox-erasure.js";
import { writeReaderRequest } from "../src/reader-request.js";
import { DraftsService } from "../src/drafts-service.js";
import { learningService } from "../src/learning-service.js";
import type { ServiceContext } from "../src/context.js";
import { makeAuthService, makeTestAuthDeps } from "../src/index.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE SWEEP'S OWN STAMP, AND THE SERVICE WRITERS THAT ARE REFUSED ON IT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `packages/db/test/erasure-seam.pg.test.ts` proves the fence READS the stamps and refuses. This
 * file proves the other half, which is the half a fence cannot survive without: that a mailbox
 * erasure WRITES `mailboxes.erased_at`, in the sweep's own transaction, and that the service
 * writers above it are then refused and recreate nothing.
 *
 * THE ORDER IS THE CONTROL. Erasing before a writer's own read measures nothing — compose would
 * fail its mailbox check and never reach the insert it is here to be refused at. Each case below
 * places the erasure at the LAST AWAIT before the write by wrapping the handle's `transaction`,
 * so the reads run against a live subject, the erasure commits on ANOTHER connection, and the
 * write then attempts exactly as it does in production. The code under test is untouched.
 *
 * WHY `.pg.test.ts`: the fence reads `FOR SHARE`, and PGlite is one connection — the sweep and
 * the writer are serialised by the driver before either reaches a lock.
 *
 * MUTATIONS WATCHED RED, THEN RESTORED (pristine copy back, `cmp`):
 *  · the stamp deleted from `sweepMailboxData` → every case here red, and the db control's
 *    mailbox cases stay green: they stamp the column directly, which is exactly why this file
 *    exists — a fence is only as real as the stamp it reads;
 *  · `coalesce` dropped from the stamp → the retried-erasure case red on a moved instant;
 *  · the `mailboxId` dropped from `withAccountTx` in `drafts-service.ts` → COMPOSE red on the
 *    recreated draft, with every other case green;
 *  · the promotion is fenced TWICE — at its door and inside `ensurePromotedRule` — and the case
 *    goes red only when BOTH are removed. Measured, after two mutations that did not redden it:
 *    removing the inner fence alone leaves this green and reddens the CENSUS by name; removing
 *    the door alone leaves both green. Each guards a different caller, so neither is redundant
 *    and neither alone is what this case proves.
 */
const PG_UP = await realPgAvailable();

const NOW = new Date("2026-09-14T12:00:00.000Z");

let client: ReturnType<typeof postgres>;
let sweepClient: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let sweepDb: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  if (!PG_UP) return;
  await runMigrations(PG_TEST_URL);
  client = postgres(PG_TEST_URL, { max: 6, onnotice: () => {} });
  // Its own connection, as in production: an erasure is a request on another host.
  sweepClient = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
  db = brandDialect(drizzle(client, { schema }), "pg");
  sweepDb = brandDialect(drizzle(sweepClient, { schema }), "pg");
});

afterAll(async () => {
  await client?.end({ timeout: 5 });
  await sweepClient?.end({ timeout: 5 });
});

async function seed(): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "fence" });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId}@fence.test`,
  }).returning({ id: mailboxes.id });
  return { accountId, mailboxId: mb!.id };
}

/** The mailbox erasure, through the sweep itself — the stamp under test is the sweep's own. */
async function eraseMailbox(accountId: string, mailboxId: string, now = NOW): Promise<void> {
  await (sweepDb as unknown as Tx).transaction(async (tx) => {
    await sweepMailboxData(tx as unknown as LedgerTx, dialect(tx), { accountId, mailboxId, now });
  });
}

/**
 * The handle, with an erasure wedged into the last moment before the write: every read the writer
 * makes before it opens its transaction runs against a LIVE subject, and the erasure commits
 * between that and the fence. A timer would make the window approximate; this makes it exact.
 */
function raceDb(erase: () => Promise<void>): ServiceContext["db"] {
  let fired = false;
  const inner = db as unknown as {
    transaction: <R>(f: (t: unknown) => Promise<R>) => Promise<R>;
  };
  const wrapper = Object.create(db as object) as Record<string, unknown>;
  wrapper["transaction"] = async <R,>(f: (t: unknown) => Promise<R>): Promise<R> => {
    if (!fired) { fired = true; await erase(); }
    return inner.transaction(f);
  };
  return wrapper as unknown as ServiceContext["db"];
}

function ctxOn(handle: ServiceContext["db"], accountId: string): ServiceContext {
  return { db: handle, accountId, userId: null, now: () => NOW, requestId: randomUUID() };
}

/** The account `register` created, read from the row rather than from a union with two arms. */
async function accountOf(email: string): Promise<string> {
  const [row] = await db.select({ accountId: users.accountId })
    .from(users).where(eq(users.email, email)).limit(1);
  if (!row) throw new Error(`register wrote no user for ${email}`);
  return row.accountId;
}

/** A sign-in request names no account: the credential decides which one, not the session. */
function authCtx(): ServiceContext {
  return {
    db: db as unknown as ServiceContext["db"], accountId: "", userId: null,
    now: () => new Date(), requestId: randomUUID(),
    ip: `10.0.0.${Math.floor(Math.random() * 250) + 1}`,
  };
}

describe.skipIf(!PG_UP)("the sweep's own mailbox stamp", () => {
  it("is written inside the sweep's transaction", async () => {
    const { accountId, mailboxId } = await seed();
    const before = await db.select({ erasedAt: mailboxes.erasedAt })
      .from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(before[0]!.erasedAt, "a live mailbox is already stamped").toBeNull();
    await eraseMailbox(accountId, mailboxId);
    const after = await db.select({ erasedAt: mailboxes.erasedAt })
      .from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(after[0]!.erasedAt, "the sweep left no stamp — every fence below reads nothing")
      .toEqual(NOW);
  });

  it("goes with the sweep when the sweep rolls back", async () => {
    // The stamp and the deletes are ONE decision. A stamp surviving a rolled-back erasure would
    // refuse every later write against a mailbox whose mail is still there.
    const { accountId, mailboxId } = await seed();
    await expect((sweepDb as unknown as Tx).transaction(async (tx) => {
      await sweepMailboxData(tx as unknown as LedgerTx, dialect(tx), { accountId, mailboxId, now: NOW });
      throw new Error("rolled back on purpose");
    })).rejects.toThrow("rolled back on purpose");
    const after = await db.select({ erasedAt: mailboxes.erasedAt })
      .from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(after[0]!.erasedAt, "the stamp outlived its own rollback").toBeNull();
  });

  it("keeps the FIRST instant when an erasure is retried", async () => {
    // `coalesce`: erasure is resumable, and a retry that moved the stamp would move the boundary
    // a writer is refused against.
    const { accountId, mailboxId } = await seed();
    await eraseMailbox(accountId, mailboxId);
    await eraseMailbox(accountId, mailboxId, new Date("2026-09-15T12:00:00.000Z"));
    const after = await db.select({ erasedAt: mailboxes.erasedAt })
      .from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(after[0]!.erasedAt, "the retry moved the stamp").toEqual(NOW);
  });

  it("leaves the ACCOUNT untouched — the two scopes are separate", async () => {
    // Without this, every mailbox case below could be passing on the account's stamp instead.
    const { accountId, mailboxId } = await seed();
    await eraseMailbox(accountId, mailboxId);
    const acct = await db.select({ erasedAt: accounts.erasedAt })
      .from(accounts).where(eq(accounts.id, accountId));
    expect(acct[0]!.erasedAt).toBeNull();
  });
});

describe.skipIf(!PG_UP)("the reader's request — the granularity arm", () => {
  it("is refused when the MAILBOX was erased under it, with the account live", async () => {
    /* THE SEQUENCE THE REVIEW NAMED. The decision passes mailbox eligibility, the mailbox erasure
       commits, and the account-only fence this writer already had still admitted the erased
       mailbox's correspondent and decision into `organizer_requests`. */
    const { accountId, mailboxId } = await seed();
    await eraseMailbox(accountId, mailboxId);
    const ctx = ctxOn(db as unknown as ServiceContext["db"], accountId);
    await expect((db as unknown as Tx).transaction(async (tx) => writeReaderRequest(tx, ctx, {
      mailboxId, kind: "screener.decide",
      payload: { address: "a correspondent of theirs" }, holder: { kind: "cloud", name: null, since: null } as OrganizedBy,
    }))).rejects.toBeInstanceOf(MailboxErasedError);
    expect(await db.select({ id: organizerRequests.id }).from(organizerRequests)
      .where(eq(organizerRequests.mailboxId, mailboxId)),
    "the erased mailbox's decision was written back").toHaveLength(0);
  });

  it("is written for a live mailbox — the positive", async () => {
    const { accountId, mailboxId } = await seed();
    const ctx = ctxOn(db as unknown as ServiceContext["db"], accountId);
    const out = await (db as unknown as Tx).transaction(async (tx) =>
      writeReaderRequest(tx, ctx, {
        mailboxId, kind: "screener.decide", payload: {}, holder: { kind: "cloud", name: null, since: null } as OrganizedBy,
      }));
    expect(out.pending).toBe(true);
  });
});

describe.skipIf(!PG_UP)("compose, against a mailbox erased while it validated one", () => {
  it("recreates no draft when the mailbox goes between the check and the insert", async () => {
    const { accountId, mailboxId } = await seed();
    const handle = raceDb(() => eraseMailbox(accountId, mailboxId));
    const ctx = ctxOn(handle, accountId);
    await expect(new DraftsService().create(ctx, {
      mailboxId, subject: "their subject", body: "their words", to: [{ address: "someone@example.test" }],
    } as never)).rejects.toThrow();
    expect(await db.select({ id: drafts.id }).from(drafts)
      .where(eq(drafts.mailboxId, mailboxId)),
    "the draft's body and recipients came back under an erased mailbox").toHaveLength(0);
  });

  it("writes an ordinary draft on a live mailbox — the positive", async () => {
    const { accountId, mailboxId } = await seed();
    const ctx = ctxOn(db as unknown as ServiceContext["db"], accountId);
    const out = await new DraftsService().create(ctx, {
      mailboxId, subject: "ordinary", body: "ordinary", to: [{ address: "someone@example.test" }],
    } as never);
    expect(out.draft.subject).toBe("ordinary");
  });
});

describe.skipIf(!PG_UP)("the promoted rule, against an erasure that lands on the approval", () => {
  it("writes no rule when the account goes between the graduation read and the promotion",
    async () => {
      const { accountId } = await seed();
      await db.insert(graduations).values({
        accountId, patternKey: "sender:promoted@example.test\u2192INBOX",
        positives: 9, negatives: 0, graduated: true,
      });
      const handle = raceDb(async () => {
        await sweepDb.update(accounts).set({ erasedAt: NOW }).where(eq(accounts.id, accountId));
      });
      const ctx = ctxOn(handle, accountId);
      await expect(learningService.promoteOrDemote(ctx, "sender:promoted@example.test\u2192INBOX"))
        .rejects.toThrow();
      expect(await db.select({ id: rules.id }).from(rules).where(eq(rules.accountId, accountId)),
        "the promoted rule was written into an erased account").toHaveLength(0);
    });
});

describe.skipIf(!PG_UP)("the authentication trail", () => {
  it("records nothing under an account that was erased before the login finished", async () => {
    /* `auth_events` carries an IP and a device per attempt and the sweep deletes every row bearing
       the account id, so a login already past its user read wrote both back. Driven through the
       real `login`, which is where the audit row comes from: a probe on the method would have
       measured the call and not the path. */
    const svc = makeAuthService(makeTestAuthDeps({ inviteCodes: new Set(["INVITE-OK"]) }));
    const email = `erased-${randomUUID()}@lichtgrat.example`;
    await svc.register(
      authCtx(),
      { email, password: "pw-correct-horse-password-password", displayName: "G", inviteCode: "INVITE-OK" },
    );
    const accountId = await accountOf(email);
    await db.delete(authEvents).where(eq(authEvents.accountId, accountId));
    await sweepDb.update(accounts).set({ erasedAt: NOW }).where(eq(accounts.id, accountId));

    await expect(svc.login(
      { ...authCtx(), ip: "203.0.113.9", userAgent: "a device of theirs" },
      { email, password: "wrong" },
    )).rejects.toMatchObject({ httpStatus: 401 });

    expect(await db.select({ id: authEvents.id }).from(authEvents)
      .where(eq(authEvents.accountId, accountId)),
    "an IP and a device were written back under an erased account").toHaveLength(0);
  });

  it("still records an ordinary failure on a LIVE account — the positive", async () => {
    /* Without this the refusal above is satisfied by a fence that turned the trail off. The
       account-less half — `audit` called with no user at all, which is the throttle's shape — is
       left unfenced by construction: the branch reads `user != null`, so an attempt that resolved
       nobody keeps being recorded, and there is no account to ask about. */
    const svc = makeAuthService(makeTestAuthDeps({ inviteCodes: new Set(["INVITE-OK"]) }));
    const email = `live-${randomUUID()}@lichtgrat.example`;
    await svc.register(
      authCtx(),
      { email, password: "pw-correct-horse-password-password", displayName: "G", inviteCode: "INVITE-OK" },
    );
    const accountId = await accountOf(email);
    await db.delete(authEvents).where(eq(authEvents.accountId, accountId));
    await expect(svc.login(
      { ...authCtx(), ip: "203.0.113.9", userAgent: "a device of theirs" },
      { email, password: "wrong" },
    )).rejects.toMatchObject({ httpStatus: 401 });
    expect(await db.select({ id: authEvents.id }).from(authEvents)
      .where(eq(authEvents.accountId, accountId)),
    "the fence turned the trail off for an ordinary failure").toHaveLength(1);
  });
});

describe.skipIf(!PG_UP)("the connect record (cloud 0054)", () => {
  const row = (accountId: string) =>
    ({ accountId, door: "connect", preset: "gmail", outcome: "refused", reason: "auth", transport: "imap" } as const);

  it("records nothing for an account erased between the request's start and the write", async () => {
    /* `accounts` survives the erasure, so the key refuses nothing: the erasure commits on its own
       connection at the last moment before the record's transaction opens, and the fence refuses. */
    const { accountId } = await seed();
    const raced = raceDb(async () => {
      await sweepDb.update(accounts).set({ erasedAt: NOW }).where(eq(accounts.id, accountId));
    });
    await expect(recordConnectAttempt(raced as unknown as Tx, row(accountId), NOW)).rejects.toBeInstanceOf(AccountErasedError);
    expect(await db.select().from(connectAttempts).where(eq(connectAttempts.accountId, accountId)),
      "a connect record was written under an erased account").toHaveLength(0);
  });

  it("still records on a LIVE account — the positive", async () => {
    const { accountId } = await seed();
    expect(await recordConnectAttempt(db as unknown as Tx, row(accountId), NOW)).toBe("recorded");
    expect(await db.select().from(connectAttempts).where(eq(connectAttempts.accountId, accountId))).toHaveLength(1);
  });
});
