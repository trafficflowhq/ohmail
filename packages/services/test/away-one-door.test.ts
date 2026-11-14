import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  awayReplies, awayResponders, awaySenderState, folderState, mailboxes, messageBodies, messages,
} from "@trafficflow/db";
import type { OutboundMessage, SendAdapter } from "@trafficflow/core";
import { DrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { runAwayResponderPass } from "../src/away-responder-pass.js";

/**
 * AN AWAY REPLY'S CLAIM IS ITS LEDGER ROW, AND A REFUSAL THAT DIALLED NOTHING GIVES IT BACK.
 *
 * Two defects measured at this lane's base. A message expunged while its reply was on the wire
 * left the reply DELIVERED and the row `pending`: the finalize keyed on `message_id`, which mail
 * 0118's key sets NULL. And a lease refusal at the send boundary, asked inside the transport,
 * landed in the SMTP arm: `unverified`, the throttle spent, the reply never offered again. PGlite;
 * the two-runner interleave is `away-release-interleave.pg.test.ts`.
 */

const NOW = new Date("2026-09-02T12:00:00.000Z");
const ENABLED_AT = new Date("2026-09-02T11:00:00.000Z");
const THEM = "colleague@them.test";

type Db = Awaited<ReturnType<typeof makeTestDb>>;
interface World { db: Db; accountId: string; mailboxId: string }

async function world(): Promise<World> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: "me@away.test",
    organizerRole: "organizer", status: "connected",
  }).returning();
  // `always`, so a second message from the same person is admitted by the throttle and the
  // state a release puts back is the FIRST reply's, which a snapshot-free release must find.
  await db.insert(awayResponders).values({
    accountId, enabled: true, body: "Back Monday.", audience: "everyone",
    throttle: "always", piles: ["INBOX"], enabledAt: ENABLED_AT, updatedAt: ENABLED_AT,
  });
  return { db, accountId, mailboxId: mb!.id };
}

async function arrive(w: World, subject: string, minutesAgo = 1): Promise<string> {
  const at = new Date(NOW.getTime() - minutesAgo * 60_000);
  const [m] = await w.db.insert(messages).values({
    accountId: w.accountId, mailboxId: w.mailboxId,
    messageIdHeader: `<o-${randomUUID()}@them.test>`,
    bodyHash: randomUUID(), dedupKey: randomUUID(), subject,
    fromAddress: THEM, date: at, createdAt: at,
  }).returning();
  await w.db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "hello", headers: {} });
  await w.db.insert(folderState).values({
    messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
  });
  return m!.id;
}

/** A transport that records every delivery; `during` runs while the reply is on the wire. */
function transport(opts: { during?: () => Promise<void>; fail?: boolean } = {}) {
  const delivered: OutboundMessage[] = [];
  const factory = async (): Promise<SendAdapter> => ({
    send: async (m: OutboundMessage) => {
      if (opts.fail) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
      delivered.push(m);
      if (opts.during) await opts.during();
      return { providerMessageId: `<p-${delivered.length}>` };
    },
    messageInSent: async () => false,
    close: async () => {},
  }) as unknown as SendAdapter;
  return { factory, delivered };
}

/** The lease answers in order: before the reservation, then at the dial. */
const answering = (...answers: boolean[]) => async (): Promise<boolean> => answers.shift() ?? true;

const rows = (w: World) =>
  w.db.select().from(awayReplies).where(eq(awayReplies.accountId, w.accountId));
const state = (w: World) =>
  w.db.select().from(awaySenderState).where(eq(awaySenderState.accountId, w.accountId));

describe("the reservation's own row is what every ending keys on", () => {
  // Postgres only: the device store has no key that nulls the pointer (`schema-mail-sqlite.ts`
  // says so on the column), so there is nothing for this case to measure there.
  it.skipIf(process.env.OHMAIL_TEST_DIALECT === "sqlite")("a message expunged while its reply is on the wire still finalizes `sent`", async () => {
    const w = await world();
    const id = await arrive(w, "the roof");
    // The expunge the product performs, dependents first, so the 0118 key's SET NULL fires.
    const t = transport({
      during: async () => {
        await w.db.delete(folderState).where(eq(folderState.messageId, id));
        await w.db.delete(messageBodies).where(eq(messageBodies.messageId, id));
        await w.db.delete(messages).where(eq(messages.id, id));
      },
    });

    const out = await runAwayResponderPass(w.db, {
      openSendAdapter: t.factory as never, now: () => NOW, mailboxIds: [w.mailboxId],
    });

    expect(t.delivered).toHaveLength(1);
    expect(out.sent).toBe(1);
    const [row] = await rows(w);
    expect(row!.messageId, "the fixture did not null the pointer").toBeNull();
    expect(row!.outcome, "a delivered reply was left pending").toBe("sent");
    expect(row!.sentAt?.toISOString()).toBe(NOW.toISOString());
  });
});

describe("a lease refusal at the dial releases the reservation", () => {
  it("a first reply to this person: nothing sent, no ledger row, no throttle state", async () => {
    const w = await world();
    await arrive(w, "the roof");
    const t = transport();

    const out = await runAwayResponderPass(w.db, {
      openSendAdapter: t.factory as never, stillOrganizing: answering(true, false),
      now: () => NOW, mailboxIds: [w.mailboxId],
    });

    expect(t.delivered, "a reply left an install the lease had just refused").toHaveLength(0);
    expect(out).toMatchObject({ sent: 0, unverified: 0, examined: 0, refusedNotOrganizer: 1, capped: true });
    expect(await rows(w), "the refusal kept a reservation").toHaveLength(0);
    expect(await state(w), "the refusal kept the person's throttle").toHaveLength(0);
  });

  it("a person answered before keeps exactly the state that earlier reply wrote", async () => {
    const w = await world();
    await arrive(w, "the roof", 30);
    const EARLIER = new Date(NOW.getTime() - 10 * 60_000);
    await runAwayResponderPass(w.db, {
      openSendAdapter: transport().factory as never, now: () => EARLIER, mailboxIds: [w.mailboxId],
    });
    const before = await state(w);
    expect(before).toHaveLength(1);
    await arrive(w, "the drains");
    const t = transport();

    const out = await runAwayResponderPass(w.db, {
      openSendAdapter: t.factory as never, stillOrganizing: answering(true, false),
      now: () => NOW, mailboxIds: [w.mailboxId],
    });

    expect(out).toMatchObject({ sent: 0, refusedNotOrganizer: 1 });
    expect(t.delivered).toHaveLength(0);
    expect(await state(w), "the release did not put back the earlier reply's state").toEqual(before);
    expect((await rows(w)).map((r) => r.outcome)).toEqual(["sent"]);
  });

  it("a bounce stamped while the reservation was held is never deleted with it", async () => {
    const w = await world();
    await arrive(w, "the roof");
    const t = transport();
    const asks = [true, false];

    await runAwayResponderPass(w.db, {
      openSendAdapter: t.factory as never,
      stillOrganizing: async () => {
        const answer = asks.shift() ?? true;
        if (!answer) {
          await w.db.update(awaySenderState).set({ undeliverableAt: NOW })
            .where(and(eq(awaySenderState.accountId, w.accountId), eq(awaySenderState.sender, THEM)));
        }
        return answer;
      },
      now: () => NOW, mailboxIds: [w.mailboxId],
    });

    const [row] = await state(w);
    expect(row?.undeliverableAt?.toISOString(), "the release deleted what a bounce taught").toBe(NOW.toISOString());
    expect(await rows(w)).toHaveLength(0);
  });

  it("and the reply is still owed: the next pass that holds the mailbox sends it, once", async () => {
    const w = await world();
    await arrive(w, "the roof");
    await runAwayResponderPass(w.db, {
      openSendAdapter: transport().factory as never, stillOrganizing: answering(true, false),
      now: () => NOW, mailboxIds: [w.mailboxId],
    });
    const t = transport();

    const out = await runAwayResponderPass(w.db, {
      openSendAdapter: t.factory as never, stillOrganizing: async () => true,
      now: () => new Date(NOW.getTime() + 60_000), mailboxIds: [w.mailboxId],
    });
    const again = await runAwayResponderPass(w.db, {
      openSendAdapter: t.factory as never, stillOrganizing: async () => true,
      now: () => new Date(NOW.getTime() + 120_000), mailboxIds: [w.mailboxId],
    });

    expect(out.sent).toBe(1);
    expect(again.sent).toBe(0);
    expect(t.delivered.map((m) => m.subject)).toEqual(["Re: the roof"]);
    expect((await rows(w)).map((r) => r.outcome)).toEqual(["sent"]);
  });

  it("CONTROL — an SMTP throw is ambiguous: the claim is KEPT, `unverified`, never offered again", async () => {
    const w = await world();
    await arrive(w, "the roof");

    const out = await runAwayResponderPass(w.db, {
      openSendAdapter: transport({ fail: true }).factory as never, stillOrganizing: async () => true,
      now: () => NOW, mailboxIds: [w.mailboxId],
    });
    const later = transport();
    await runAwayResponderPass(w.db, {
      openSendAdapter: later.factory as never, stillOrganizing: async () => true,
      now: () => new Date(NOW.getTime() + 60_000), mailboxIds: [w.mailboxId],
    });

    expect(out).toMatchObject({ unverified: 1, refusedNotOrganizer: 0 });
    expect((await rows(w)).map((r) => r.outcome)).toEqual(["unverified"]);
    expect(await state(w), "an ambiguous send released the person's throttle").toHaveLength(1);
    expect(later.delivered, "a possibly-delivered reply was offered a second time").toHaveLength(0);
  });
});

/** A letter in `folder` the server no longer holds: located, with no instance, for the reaper. */
let goneUid = 0;
async function goneLetter(w: World, from: string, folder: string, subject: string, headers: Record<string, string[]>) {
  const at = new Date(NOW.getTime() - 2 * 60_000);
  const [m] = await w.db.insert(messages).values({
    accountId: w.accountId, mailboxId: w.mailboxId, messageIdHeader: `<g-${randomUUID()}@them.test>`,
    bodyHash: randomUUID(), dedupKey: randomUUID(), subject, fromAddress: from, date: at, createdAt: at,
    nativeLocator: { folder, ref: `1:${++goneUid}` },
  }).returning();
  await w.db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "gone", headers: { to: ["me@away.test"], ...headers } });
  await w.db.insert(folderState).values({ messageId: m!.id, accountId: m!.accountId, desiredFolder: folder, observedFolder: folder, lastSetBy: "us" });
  return m!.id;
}

describe("a letter gone from the server before the pass decided it is never answered", () => {
  // The reaper cuts a gone letter's header block (`gone-letter-headers.ts`), list and bounce lines included.
  it("a newsletter and a bounce the reaper took get no reply and no ledger row; a letter still there does", async () => {
    const w = await world();
    await w.db.update(awayResponders).set({ piles: ["INBOX", "ohmail/Screener"] })
      .where(eq(awayResponders.accountId, w.accountId));
    const gone = [
      await goneLetter(w, "hello@brand.test", "INBOX", "Our autumn picks", {
        "list-id": ["<news.brand.test>"], "list-unsubscribe": ["<https://brand.test/u?t=abc>"], "feedback-id": ["c1:brand"],
      }),
      await goneLetter(w, "MicrosoftExchange@contoso.test", "ohmail/Screener", "Undeliverable: the roof", {
        "return-path": ["<>"], "content-type": ['multipart/report; report-type=delivery-status; boundary="b"'],
      }),
    ];
    const live = await arrive(w, "the roof");
    expect(await new DrizzleRepo(w.db as never).transaction((r) => r.tombstoneInstanceless!(w.accountId, w.mailboxId, 50))).toBe(2);
    for (const id of gone) {
      const [b] = await w.db.select({ h: messageBodies.headers }).from(messageBodies).where(eq(messageBodies.messageId, id));
      expect(Object.keys(b!.h as object), "the precondition: the reaper cut the block").toEqual(["to"]);
    }
    const t = transport();

    const out = await runAwayResponderPass(w.db, { openSendAdapter: t.factory as never, now: () => NOW, mailboxIds: [w.mailboxId] });

    expect(t.delivered.map((m) => m.subject), "a letter gone from the server was answered").toEqual(["Re: the roof"]);
    expect(out).toMatchObject({ sent: 1, examined: 1, suppressed: 0 });
    expect((await rows(w)).map((r) => r.messageId), "a gone letter was decided").toEqual([live]);
  });
});
