import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import {
  accounts, awayReplies, awayResponders, awaySenderState, folderState, mailboxes, messageBodies,
  messages,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { OutboundMessage, SendAdapter } from "@trafficflow/core";
import { runAwayResponderPass } from "../src/away-responder-pass.js";
import { deleteAccount } from "../src/account-deletion-service.js";
import type { ServiceContext } from "../src/context.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE AWAY PASS, AGAINST AN ERASURE THAT LANDS WHILE IT IS IN FLIGHT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The reported defect, verbatim: a person erased their account, was told it was done, and the away
 * pass then recreated their correspondent's address in two tables the sweep had just emptied and
 * SENT MAIL from the erased account. It is the worst shape the erasure window has, because the
 * write is not the end of it — a row can be swept again, and mail cannot be recalled.
 *
 * TWO WINDOWS, and they are different defects with different fixes:
 *
 *  RESERVE — erasure commits between the candidate read and the reservation. The fence inside
 *  `reserve`'s own transaction refuses, the transaction rolls back, and neither `away_replies` nor
 *  `away_sender_state` gains a row. Injected at `openSendAdapter`, which the pass awaits between
 *  the eligibility verdict and the reservation: a real dial is what makes that window wide, so
 *  this is the production seam and not a test-only affordance.
 *
 *  PRE-DIAL — erasure commits AFTER the reservation has committed, before the SMTP dial. The
 *  reservation was legitimate when it was taken, so no fence inside it can help; the pass re-reads
 *  the fence immediately before the dial and sends nothing. Injected by wrapping the handle's
 *  `transaction` so the sweep runs the instant the reservation commits — the code under test is
 *  untouched and the window is exact rather than timed.
 *
 * WHY `.pg.test.ts`: `readAccountErasedAt` reads `accounts FOR SHARE`, and PGlite is one
 * connection — the sweep and the pass are serialised by the driver before either reaches a lock,
 * so a fence that takes no lock passes there. The lock's own interlock is `erasure-fence-race`'s
 * CONCURRENT arm; what this file adds is the pass that SENDS.
 *
 * MUTATIONS WATCHED RED, THEN RESTORED (each restored by copying back a pristine copy, `cmp`):
 *  · the fence deleted from `reserve` → RESERVE red on the delivered count AND on both row
 *    counts: mail leaves and the correspondent's address is back in two tables;
 *  · the pre-dial re-read deleted → PRE-DIAL red on the delivered count alone, with both row
 *    counts still zero. That split is why both cases are here: the reservation's fence cannot see
 *    the second window at all, and a single case would have passed a fix for half the defect;
 *  · the fence deleted from `recordDecision` → SUPPRESSED red on the ledger row count, which is
 *    the one this lane FOUND: the suppressed candidate's ledger row carries the same address and
 *    was written one function away from the reservation the review named.
 */
const PG_UP = await realPgAvailable();

const NOW = new Date("2026-09-14T12:00:00.000Z");
const ENABLED_AT = new Date("2026-09-14T11:00:00.000Z");

let client: ReturnType<typeof postgres>;
let sweepClient: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let sweepDb: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  if (!PG_UP) return;
  await runMigrations(PG_TEST_URL);
  client = postgres(PG_TEST_URL, { max: 6, onnotice: () => {} });
  // The sweep runs on its OWN connection, as it does in production: erasure is a request on
  // another host, not a statement this pass makes.
  sweepClient = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
  db = brandDialect(drizzle(client, { schema }), "pg");
  sweepDb = brandDialect(drizzle(sweepClient, { schema }), "pg");
});

afterAll(async () => {
  await client?.end({ timeout: 5 });
  await sweepClient?.end({ timeout: 5 });
});

interface Seeded { accountId: string; mailboxId: string }

async function seed(audience: "screened_in" | "everyone" = "everyone"): Promise<Seeded> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "away fence" });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId}@away.test`,
    organizerRole: "organizer", status: "connected",
  }).returning();
  await db.insert(awayResponders).values({
    accountId, enabled: true, body: "Back Monday.", audience,
    throttle: "always", enabledAt: ENABLED_AT, updatedAt: ENABLED_AT,
  });
  return { accountId, mailboxId: mb!.id };
}

async function arrive(
  s: Seeded, from: string, desiredFolder = "INBOX", agoMs = 60_000,
): Promise<string> {
  // `agoMs` orders the candidates: the pass reads them `createdAt` ascending, and a case that
  // needs one candidate decided BEFORE another says so here rather than hoping.
  const at = new Date(NOW.getTime() - agoMs);
  const [m] = await db.insert(messages).values({
    accountId: s.accountId, mailboxId: s.mailboxId,
    messageIdHeader: `<${randomUUID()}@them.test>`,
    bodyHash: randomUUID(), dedupKey: randomUUID(),
    subject: "the roof", fromAddress: from, date: at, createdAt: at,
  }).returning();
  await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "hello", headers: {} });
  await db.insert(folderState).values({
    messageId: m!.id, accountId: m!.accountId, desiredFolder, observedFolder: desiredFolder, lastSetBy: "us",
  });
  return m!.id;
}

const ctxFor = (accountId: string): ServiceContext => ({
  db: sweepDb as unknown as ServiceContext["db"],
  accountId,
  userId: null,
  now: () => NOW,
  requestId: `away-fence-${randomUUID()}`,
} as ServiceContext);

/**
 * Counts what the pass actually handed to a transport. Zero is the verdict every case wants.
 *
 * The mailbox id is taken and ignored: this is an `OpenSendAdapter`, and the cases that wrap this
 * factory to open their window pass the id through, so the parameter has to exist here.
 */
function recorder() {
  const delivered: OutboundMessage[] = [];
  const factory = async (_mailboxId?: string): Promise<SendAdapter> => ({
    send: async (m: OutboundMessage) => {
      delivered.push(m);
      return { providerMessageId: `<p-${delivered.length}>` };
    },
    messageInSent: async () => false,
    close: async () => {},
  }) as unknown as SendAdapter;
  return { factory, delivered };
}

const replyRows = async (accountId: string) =>
  db.select().from(awayReplies).where(eq(awayReplies.accountId, accountId));
const senderRows = async (accountId: string) =>
  db.select().from(awaySenderState).where(eq(awaySenderState.accountId, accountId));

describe.skipIf(!PG_UP)("the away pass and the erasure fence", () => {
  it("RESERVE — erasure lands before the reservation: nothing sent, no correspondent row", async () => {
    const s = await seed();
    await arrive(s, "colleague@them.test");
    const r = recorder();

    // The erasure completes HERE — between the candidate read and the reservation, which is the
    // window the review reported. `openSendAdapter` is awaited at exactly that point.
    let erased = false;
    const factory = async (mailboxId: string) => {
      if (!erased) { erased = true; await deleteAccount(ctxFor(s.accountId)); }
      return r.factory(mailboxId);
    };

    const out = await runAwayResponderPass(db as never, {
      openSendAdapter: factory as never, now: () => NOW, mailboxIds: [s.mailboxId],
    });

    expect(erased, "the sweep never ran — the window was not opened").toBe(true);
    expect(r.delivered, "MAIL WAS SENT FROM AN ERASED ACCOUNT").toHaveLength(0);
    expect(out.sent).toBe(0);
    expect(out.refusedErased, "the refusal was not recorded").toBe(1);
    // The two rows the defect recreated. Both carry the correspondent's address, and the sweep
    // had already deleted both.
    expect(await replyRows(s.accountId), "a ledger row was recreated after erasure").toHaveLength(0);
    expect(await senderRows(s.accountId), "a sender-state row was recreated after erasure")
      .toHaveLength(0);
  }, 60_000);

  it("PRE-DIAL — erasure lands after the reservation commits: still nothing sent", async () => {
    const s = await seed();
    await arrive(s, "colleague@them.test");
    const r = recorder();

    /* The reservation is legitimate when it is taken — no fence inside it can refuse. The sweep
       runs the moment it COMMITS, which is the window the pre-dial re-read exists for. Wrapping
       `transaction` puts the sweep exactly there rather than at a sleep's mercy; the handle is
       the real one and every statement still goes to Postgres. */
    let reserved = false;
    const handle = db as unknown as { transaction: (f: unknown) => Promise<unknown> };
    const original = handle.transaction.bind(handle);
    const wrapped = new Proxy(db as object, {
      get(target, prop, recv) {
        if (prop !== "transaction") return Reflect.get(target, prop, recv);
        return async (f: unknown) => {
          const out = await original(f);
          if (!reserved) { reserved = true; await deleteAccount(ctxFor(s.accountId)); }
          return out;
        };
      },
    });

    const out = await runAwayResponderPass(wrapped as never, {
      openSendAdapter: r.factory as never, now: () => NOW, mailboxIds: [s.mailboxId],
    });

    expect(reserved, "no reservation committed — the window was never opened").toBe(true);
    expect(r.delivered, "MAIL WAS SENT AFTER THE ACCOUNT WAS ERASED").toHaveLength(0);
    expect(out.sent).toBe(0);
    expect(out.refusedErased).toBe(1);
    // The reservation DID commit, and the sweep then took it — so the absence here is the sweep's
    // work, not the fence's, and that is the honest reading of this window.
    expect(await replyRows(s.accountId)).toHaveLength(0);
    expect(await senderRows(s.accountId)).toHaveLength(0);
  }, 60_000);

  it("PRE-DIAL, MAILBOX — the mailbox is erased after the reservation: still nothing sent", async () => {
    /* THE HALF THE PRE-DIAL RE-READ DID NOT HAVE. The window above is the same one; what differs
       is WHICH row is stamped. The re-read asked `readAccountErasedAt` and nothing else, so a
       mailbox removed in exactly this window was answered — its row survives its own sweep as a
       tombstone, so the account's stamp says nothing about it, and the reservation's own fence
       (which does ask both arms) committed before the removal landed. Measured at the base of
       this lane: delivered 1, sent 1, refusedErased 0 — mail left for a mailbox the person had
       taken away. The re-read now asks `fenceErased`'s two arms in one transaction. */
    const s = await seed();
    await arrive(s, "colleague@them.test");
    const r = recorder();

    let reserved = false;
    const handle = db as unknown as { transaction: (f: unknown) => Promise<unknown> };
    const original = handle.transaction.bind(handle);
    const wrapped = new Proxy(db as object, {
      get(target, prop, recv) {
        if (prop !== "transaction") return Reflect.get(target, prop, recv);
        return async (f: unknown) => {
          const out = await original(f);
          if (!reserved) {
            reserved = true;
            await sweepDb.update(mailboxes).set({ erasedAt: NOW })
              .where(eq(mailboxes.id, s.mailboxId));
          }
          return out;
        };
      },
    });

    const out = await runAwayResponderPass(wrapped as never, {
      openSendAdapter: r.factory as never, now: () => NOW, mailboxIds: [s.mailboxId],
    });

    expect(reserved, "no reservation committed — the window was never opened").toBe(true);
    expect(r.delivered, "MAIL WAS SENT FOR A MAILBOX ERASED AFTER THE RESERVATION").toHaveLength(0);
    expect(out.sent).toBe(0);
    expect(out.refusedErased).toBe(1);
    const [acct] = await db.select({ erasedAt: accounts.erasedAt })
      .from(accounts).where(eq(accounts.id, s.accountId));
    expect(acct!.erasedAt, "the account was erased too — this case proves nothing").toBeNull();
  }, 60_000);

  it("SUPPRESSED — a held candidate's ledger row is not written after erasure either", async () => {
    /* `recordDecision` writes `away_replies` for a candidate a guard refused, carrying the same
       `sender` column — one function away from the reservation the review named, and unfenced
       until this lane. `screened_in` with the message in the Screener pile is a suppression the
       pass reaches BEFORE it asks for a transport, so the adapter seam cannot open this window.

       TWO DRAFTS OF THIS CASE WERE GREEN AGAINST THE DEFECT, and both are worth the lines:
       erasing BEFORE the pass measures nothing (the sweep deletes `mailboxes` and `messages`, so
       a pass that starts afterwards reads no candidate and writes nothing); and firing the sweep
       on the first transaction the pass opens measures the FIX, not the defect — at base
       `recordDecision` opens no transaction at all, so that seam exists only once the fence does,
       and the case went red on its own instrumentation.

       The seam has to be one BOTH versions have. `openSendAdapter` is it: the first candidate is
       eligible and reaches the transport, the sweep runs there, and the SECOND candidate — the
       suppressed one — then reaches `recordDecision` with the account already erased, which is
       the window. */
    const s = await seed("screened_in");
    await arrive(s, "colleague@them.test", "INBOX", 120_000);
    await arrive(s, "stranger@them.test", "ohmail/Screener", 60_000);
    const r = recorder();

    let erased = false;
    const factory = async (mailboxId: string) => {
      if (!erased) { erased = true; await deleteAccount(ctxFor(s.accountId)); }
      return r.factory(mailboxId);
    };

    const out = await runAwayResponderPass(db as never, {
      openSendAdapter: factory as never, now: () => NOW, mailboxIds: [s.mailboxId],
    });

    expect(erased, "the transport was never opened — the window did not exist").toBe(true);
    // THE ROW FIRST, because it is what this case is about: both candidates are refused, the
    // eligible one at the reservation and the suppressed one at its ledger write, so neither
    // correspondent's address is back in `away_replies`. Asserted ahead of the delivered count so
    // an unfenced `recordDecision` reds by NAME here rather than being masked by the send.
    expect(await replyRows(s.accountId), "a ledger row was recreated after erasure").toHaveLength(0);
    expect(await senderRows(s.accountId)).toHaveLength(0);
    expect(r.delivered, "mail was sent from an erased account").toHaveLength(0);
    expect(out.suppressed).toBe(0);
    expect(out.refusedErased).toBe(2);
  }, 60_000);

  it("MAILBOX — the mailbox is erased and the account stands: nothing sent, no row", async () => {
    /* The granularity half. A removal leaves the `mailboxes` row standing, so the ACCOUNT's stamp
       says nothing about it and a fence asked on the account alone let this pass reserve, write
       the correspondent's address and SEND for a mailbox the person had taken away. Both writes
       are in one case, as the erasure twin above does it: the eligible candidate reaches
       `reserve` and the Screener one reaches `recordDecision`, so a fence missing from either
       site reds by its own count. Only `mailboxes.erased_at` is stamped — asserted below. */
    const s = await seed("screened_in");
    await arrive(s, "colleague@them.test", "INBOX", 120_000);
    await arrive(s, "stranger@them.test", "ohmail/Screener", 60_000);
    const r = recorder();

    let erased = false;
    const factory = async (mailboxId: string) => {
      if (!erased) {
        erased = true;
        await sweepDb.update(mailboxes).set({ erasedAt: NOW })
          .where(eq(mailboxes.id, s.mailboxId));
      }
      return r.factory(mailboxId);
    };

    const out = await runAwayResponderPass(db as never, {
      openSendAdapter: factory as never, now: () => NOW, mailboxIds: [s.mailboxId],
    });

    expect(erased, "the transport was never opened — the window did not exist").toBe(true);
    expect(await replyRows(s.accountId), "a ledger row was written for an erased mailbox")
      .toHaveLength(0);
    expect(await senderRows(s.accountId)).toHaveLength(0);
    expect(r.delivered, "MAIL WAS SENT FOR AN ERASED MAILBOX").toHaveLength(0);
    expect(out.sent).toBe(0);
    expect(out.suppressed).toBe(0);
    expect(out.refusedErased).toBe(2);
    const [a] = await db.select({ erasedAt: accounts.erasedAt })
      .from(accounts).where(eq(accounts.id, s.accountId));
    expect(a!.erasedAt, "the account was erased too — this case proves nothing").toBeNull();
  }, 60_000);

  it("THE POSITIVE CONTROL — an ordinary pass on a live account still sends and still records", async () => {
    // Every refusal above must be about erasure and nothing else. Without this, a fence that
    // refused unconditionally would pass all three.
    const s = await seed();
    await arrive(s, "colleague@them.test");
    const r = recorder();

    const out = await runAwayResponderPass(db as never, {
      openSendAdapter: r.factory as never, now: () => NOW, mailboxIds: [s.mailboxId],
    });

    expect(r.delivered, "the fence refused a live account").toHaveLength(1);
    expect(out.sent).toBe(1);
    expect(out.refusedErased).toBe(0);
    const rows = await replyRows(s.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("sent");
    expect(await senderRows(s.accountId)).toHaveLength(1);
  }, 60_000);
});
