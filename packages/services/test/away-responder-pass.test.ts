import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  awayReplies, awayResponders, awaySenderState, folderState, mailboxes, messageBodies, messages,
} from "@trafficflow/db";
import type { OutboundMessage, SendAdapter } from "@trafficflow/core";
import type { AwayPile } from "@trafficflow/core/away-scope";
import { runAwayResponderPass } from "../src/away-responder-pass.js";

/**
 * THE AWAY RESPONDER'S PASS — the behaviour, over a real (PGlite) store.
 *
 * The eligibility SET is covered as a table in `packages/core/test/away-eligibility.test.ts`,
 * where each guard is a pure-function branch. What is covered HERE is everything that needs rows:
 * the candidate floor, the ledger that makes the pass converge, the reservation, the compare-and-
 * swap, the organizer JOIN, the reply's own shape, and the two ways a run declines to spend a
 * reservation at all.
 *
 * ── WHAT PGlite CANNOT SEE, SAID OUT LOUD ────────────────────────────────────────────────────
 *
 * One connection, so the two-runner race and the upsert's `WHERE` under contention are NOT tested
 * here and cannot be. `away-responder-pass.pg.test.ts` runs those against real Postgres on :5433
 * with two clients. This file's `owned_elsewhere` case exercises the CODE PATH (a pre-existing
 * ledger row) and deliberately does not claim to have proven the race.
 *
 * ── MUTATIONS PERFORMED, WATCHED RED, AND RESTORED ───────────────────────────────────────────
 *
 * Each was applied to `away-responder-pass.ts`, run, and reverted; the count is what that run
 * actually reported.
 *
 *   · throttle upsert's `setWhere` removed    3 red — every rate answers every message.
 *   · organizer JOIN removed                  2 red — the reader's mailbox is answered.
 *   · `isNull(awayReplies.id)` removed        1 red — a decided candidate is re-examined for ever.
 *   · the floor moved past the arrivals       2 red — the backlog cases inverted.
 *   · `replySubject` → the raw subject        2 red — the reply carries no `Re:`.
 *   · `Auto-Submitted` header dropped         1 red — the loop stop is gone.
 *   · a factory throw writing a ledger row    1 red — `deferred` becomes a spent reservation.
 *   · an SMTP throw deleting the claim        1 red — the ambiguous send is retried.
 *
 * ── ONE CLAIM THIS BLOCK GOT WRONG, KEPT BECAUSE IT IS THE USEFUL PART ───────────────────────
 *
 * It first said that removing the ledger anti-join would make "does not answer the same message
 * twice" go red. It did not — that run stayed GREEN. What stops the second DELIVERY there is the
 * UNIQUE on (account_id, message_id): the reservation returns zero rows and the runner stops. The
 * anti-join is a different guard doing a different job (convergence — a decided row leaving the
 * candidate set), and it had no test at all until the mutation exposed the gap. "A decided
 * candidate leaves the set for good" below is that test, and it is red under the mutation.
 *
 * Two guards, one of them unwatched, and the assertion that looked like it covered both is exactly
 * the shape a mutation check exists to find.
 */

const NOW = new Date("2026-09-02T12:00:00.000Z");
/** The responder was switched on an hour before "now". Everything before that is backlog. */
const ENABLED_AT = new Date("2026-09-02T11:00:00.000Z");

interface Fake {
  factory: (mailboxId: string) => Promise<SendAdapter>;
  delivered: OutboundMessage[];
  opened: string[];
  closed: number;
}

/** No network. Records what was handed to a transport, and which mailboxes were dialled. */
function fakeAdapter(opts: { throwOnOpen?: boolean; throwOnSend?: boolean } = {}): Fake {
  const delivered: OutboundMessage[] = [];
  const opened: string[] = [];
  let closed = 0;
  const fake: Fake = {
    delivered, opened,
    get closed() { return closed; },
    factory: async (mailboxId: string): Promise<SendAdapter> => {
      opened.push(mailboxId);
      if (opts.throwOnOpen) throw new Error("no credentials for this mailbox");
      return {
        send: async (m: OutboundMessage) => {
          if (opts.throwOnSend) throw new Error("smtp said no");
          delivered.push(m);
          return { providerMessageId: `<p-${delivered.length}>` };
        },
        messageInSent: async () => false,
        close: async () => { closed += 1; },
      } as unknown as SendAdapter;
    },
  } as Fake;
  return fake;
}

type Db = Awaited<ReturnType<typeof makeTestDb>>;

interface World {
  db: Db;
  accountId: string;
  mailboxId: string;
  readerMailboxId: string;
}

/** One account, one ORGANIZING mailbox and one READER mailbox, with a live responder. */
async function world(opts: {
  throttle?: "always" | "per_message" | "per_day" | "per_week";
  audience?: "screened_in" | "everyone";
  /** Which piles the responder answers. Default `["INBOX"]` — the Ohbox alone (mail 0096). */
  piles?: AwayPile[];
  body?: string;
  enabledAt?: Date | null;
  enabled?: boolean;
  /** The chosen end date, or none. `expireEndedResponders` reads it; the probe's window uses it. */
  endsAt?: Date | null;
} = {}): Promise<World> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [organizer] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: "me@away.test",
    organizerRole: "organizer", status: "connected",
  }).returning();
  const [reader] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: "other@away.test",
    organizerRole: "reader", status: "connected",
  }).returning();
  await db.insert(awayResponders).values({
    accountId,
    enabled: opts.enabled ?? true,
    body: opts.body ?? "Back Monday.",
    audience: opts.audience ?? "screened_in",
    throttle: opts.throttle ?? "per_day",
    // The default scope: the Ohbox alone, which is the column's own DEFAULT.
    piles: opts.piles ?? ["INBOX"],
    enabledAt: opts.enabledAt === undefined ? ENABLED_AT : opts.enabledAt,
    endsAt: opts.endsAt ?? null,
    updatedAt: ENABLED_AT,
  });
  return { db, accountId, mailboxId: organizer!.id, readerMailboxId: reader!.id };
}

/**
 * One arrived message. `createdAt` AND `date` both matter — the pass requires both to be past the
 * floor, because the ingest clock lies about history (a backfill stamps old mail with the ingest
 * instant) and the message's own stated send time is the only per-row clock a backfill cannot
 * re-stamp.
 */
async function arrive(w: World, opts: {
  from?: string;
  subject?: string;
  at?: Date;
  mailboxId?: string;
  folder?: string | null;
  headers?: Record<string, unknown>;
  messageIdHeader?: string | null;
  threadId?: string | null;
  /** A message whose body has not been fetched yet — what the Cloud mirror inserts. */
  noBody?: boolean;
} = {}): Promise<string> {
  const at = opts.at ?? new Date(NOW.getTime() - 60_000);
  const [m] = await w.db.insert(messages).values({
    accountId: w.accountId,
    mailboxId: opts.mailboxId ?? w.mailboxId,
    messageIdHeader: opts.messageIdHeader === undefined ? `<orig-${randomUUID()}@them.test>` : opts.messageIdHeader,
    bodyHash: randomUUID(), dedupKey: randomUUID(),
    subject: opts.subject ?? "the roof",
    fromAddress: opts.from ?? "colleague@them.test",
    date: at, createdAt: at,
    ...(opts.threadId ? { threadId: opts.threadId } : {}),
  }).returning();
  if (!opts.noBody) {
    await w.db.insert(messageBodies).values({
      messageId: m!.id, accountId: m!.accountId, text: "hello", headers: opts.headers ?? {},
    });
  }
  if (opts.folder !== null) {
    /* INBOX, not "ohmail/Ohbox". The Ohbox pile's FOLDER is `INBOX` (`DESTINATIONS`,
       `VIEW_OF_FOLDER`); no product source writes "ohmail/Ohbox", so this fixture was seeding a
       placement the router cannot produce. Nothing read the value closely enough to notice until
       the pile rule (mail 0096) did, and then every case here went red at once. */
    const folder = opts.folder ?? "INBOX";
    // `folder_state` is keyed by message alone (no account/mailbox columns), and BOTH folders are
    // NOT NULL. `observed_folder` = `desired_folder` is the settled shape — a row mid-reconcile
    // would be a different fixture, and the pass does not read it either way.
    await w.db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: folder, observedFolder: folder, lastSetBy: "us",
    });
  }
  return m!.id;
}

const ledger = async (w: World, messageId: string) => {
  const [row] = await w.db.select().from(awayReplies)
    .where(and(eq(awayReplies.accountId, w.accountId), eq(awayReplies.messageId, messageId)));
  return row;
};

const run = (w: World, fake: Fake, now: Date = NOW) =>
  runAwayResponderPass(w.db, { openSendAdapter: fake.factory, now: () => now });

describe("the away responder answers a candidate, once", () => {
  it("sends one reply and records it as `sent` with the minted id", async () => {
    const w = await world();
    const id = await arrive(w);
    const fake = fakeAdapter();

    const r = await run(w, fake);

    expect(r).toMatchObject({ examined: 1, sent: 1, throttled: 0, suppressed: 0, deferredAccounts: 0, deferredCandidates: 0 });
    expect(fake.delivered).toHaveLength(1);
    const row = await ledger(w, id);
    expect(row!.outcome).toBe("sent");
    expect(row!.sentAt).not.toBeNull();
    expect(row!.mintedMessageId).toBe(fake.delivered[0]!.messageId);
  });

  /**
   * THE LEDGER IS WHAT MAKES THE PASS CONVERGE. Without the anti-join every run re-reads the same
   * candidate window, and a correspondent is answered once per cycle for as long as the responder
   * is on. This is also the away arm: a decided row leaves the set for good, so
   * a backlog of held candidates cannot pin the oldest page for ever.
   */
  it("does not answer the same message twice on a second run", async () => {
    const w = await world({ throttle: "always" });
    await arrive(w);
    const fake = fakeAdapter();

    await run(w, fake);
    await run(w, fake);

    expect(fake.delivered).toHaveLength(1);
  });

  it("closes the adapter it opened, once per mailbox", async () => {
    const w = await world();
    await arrive(w);
    await arrive(w, { from: "second@them.test" });
    const fake = fakeAdapter();

    await run(w, fake);

    expect(fake.opened).toEqual([w.mailboxId]);   // ONE adapter for two candidates
    expect(fake.closed).toBe(1);
  });
});

describe("the reply is a REPLY — no subject of its own", () => {
  it("answers with `Re:` exactly once, In-Reply-To and References, and never a Reply-To", async () => {
    const w = await world();
    await arrive(w, {
      subject: "the roof",
      messageIdHeader: "<orig-1@them.test>",
      headers: { references: ["<older-1@them.test> <older-2@them.test>"], "reply-to": ["elsewhere@them.test"] },
    });
    const fake = fakeAdapter();

    await run(w, fake);

    const sent = fake.delivered[0]!;
    expect(sent.subject).toBe("Re: the roof");
    expect(sent.inReplyTo).toBe("<orig-1@them.test>");
    // The parent's own chain PLUS the parent — RFC 5322 §3.6.4, which is what keeps a long thread
    // from splitting in the recipient's client.
    expect(sent.references).toBe("<older-1@them.test> <older-2@them.test> <orig-1@them.test>");
    // THE REPLY GOES TO `From`, NEVER `Reply-To`. A `Reply-To` can point anywhere, and an
    // unattended responder honouring it is a way to aim somebody's away note at a third party.
    expect(sent.to).toBe("colleague@them.test");
    expect(sent.from).toBe("me@away.test");
  });

  it("does not accumulate `Re:` on a subject that already has one", async () => {
    const w = await world();
    await arrive(w, { subject: "RE: re: the roof" });
    const fake = fakeAdapter();
    await run(w, fake);
    expect(fake.delivered[0]!.subject).toBe("Re: the roof");
  });

  it("carries `Auto-Submitted: auto-replied` on every reply — the loop stop it demands of others", async () => {
    const w = await world();
    await arrive(w);
    const fake = fakeAdapter();
    await run(w, fake);
    expect(fake.delivered[0]!.headers).toMatchObject({ "Auto-Submitted": "auto-replied" });
  });

  it("omits threading rather than inventing it when the original carried no Message-ID", async () => {
    const w = await world();
    await arrive(w, { messageIdHeader: null });
    const fake = fakeAdapter();
    await run(w, fake);
    expect(fake.delivered[0]!.inReplyTo).toBeUndefined();
    expect(fake.delivered[0]!.references).toBeUndefined();
  });
});

describe("the candidate floor is `enabled_at`, and an edit does not move it", () => {
  /**
   * from the other end. The floor used to be `updated_at`, so any
   * save pushed it past mail that had already arrived and those correspondents were never answered
   * at all — not by the old text and not by the new one. `enabled_at` moves only on OFF → ON.
   */
  it("answers mail that arrived AFTER the responder was switched on", async () => {
    const w = await world();
    await arrive(w, { at: new Date(ENABLED_AT.getTime() + 60_000) });
    const fake = fakeAdapter();
    await run(w, fake);
    expect(fake.delivered).toHaveLength(1);
  });

  it("does NOT answer the backlog that arrived before it was switched on", async () => {
    const w = await world();
    await arrive(w, { at: new Date(ENABLED_AT.getTime() - 60_000) });
    const fake = fakeAdapter();
    const r = await run(w, fake);
    expect(fake.delivered).toHaveLength(0);
    expect(r.examined).toBe(0);
  });

  it("an edit LONG after enabling still answers mail from before the edit", async () => {
    const w = await world();
    // Arrived after enabling; the responder is then edited (updatedAt moves, enabledAt does not).
    await arrive(w, { at: new Date(ENABLED_AT.getTime() + 60_000) });
    await w.db.update(awayResponders)
      .set({ body: "Back Tuesday.", updatedAt: new Date(NOW.getTime() - 1000) })
      .where(eq(awayResponders.accountId, w.accountId));
    const fake = fakeAdapter();
    await run(w, fake);
    // Answered, with the NEW text — the correspondent is not stranded by the edit.
    expect(fake.delivered).toHaveLength(1);
    expect(fake.delivered[0]!.text).toBe("Back Tuesday.");
  });

  it("a responder with no enablement instant answers no backlog — it is healed forward, not backward", async () => {
    const w = await world({ enabledAt: null });
    await arrive(w);
    const fake = fakeAdapter();
    const r = await run(w, fake);
    // The row IS healed and live this run (see the heal block below) — what it must never do is
    // read a NULL instant as "the beginning of time" and answer the stored backlog. Its floor is
    // the instant of the heal, so everything that arrived before it is out.
    expect(r.accounts).toBe(1);
    expect(fake.delivered).toHaveLength(0);
    expect(r.examined).toBe(0);
  });

  it("a switched-off responder answers nobody", async () => {
    const w = await world({ enabled: false });
    await arrive(w);
    const fake = fakeAdapter();
    expect((await run(w, fake)).accounts).toBe(0);
  });

  it("a responder with an empty message answers nobody — nothing is composed here", async () => {
    const w = await world({ body: "   " });
    await arrive(w);
    const fake = fakeAdapter();
    expect((await run(w, fake)).accounts).toBe(0);
    expect(fake.delivered).toHaveLength(0);
  });
});

describe("a READER never replies — the organizer JOIN", () => {
  it("leaves a reader mailbox's mail entirely alone, and writes no ledger row for it", async () => {
    const w = await world();
    const readerMsg = await arrive(w, { mailboxId: w.readerMailboxId });
    const fake = fakeAdapter();

    const r = await run(w, fake);

    expect(fake.delivered).toHaveLength(0);
    expect(r.examined).toBe(0);
    // Not "suppressed" — NOT DECIDED. The organizer's own install answers it, and a ledger row
    // here would take the candidate out of that install's set too.
    expect(await ledger(w, readerMsg)).toBeUndefined();
  });

  it("answers the organizer's mail in the same store, in the same run", async () => {
    const w = await world();
    await arrive(w, { mailboxId: w.readerMailboxId });
    await arrive(w, { mailboxId: w.mailboxId, from: "friend@them.test" });
    const fake = fakeAdapter();

    await run(w, fake);

    expect(fake.delivered).toHaveLength(1);
    expect(fake.opened).toEqual([w.mailboxId]);
  });

  it("a DISCONNECTED organizer mailbox is not dialled", async () => {
    const w = await world();
    await w.db.update(mailboxes).set({ status: "error" }).where(eq(mailboxes.id, w.mailboxId));
    await arrive(w);
    const fake = fakeAdapter();
    const r = await run(w, fake);
    expect(fake.opened).toHaveLength(0);
    expect(r.examined).toBe(0);
  });
});

describe("the mailbox filter — `undefined`, a list, and the empty list", () => {
  it("an EMPTY list answers nothing, and is not the same as no filter", async () => {
    const w = await world();
    await arrive(w);
    const fake = fakeAdapter();
    const r = await runAwayResponderPass(w.db, {
      openSendAdapter: fake.factory, now: () => NOW, mailboxIds: [],
    });
    expect(r).toMatchObject({ accounts: 0, examined: 0 });
    expect(fake.delivered).toHaveLength(0);
  });

  it("a list answers only the named mailbox", async () => {
    const w = await world();
    await arrive(w);
    const fake = fakeAdapter();
    const r = await runAwayResponderPass(w.db, {
      openSendAdapter: fake.factory, now: () => NOW, mailboxIds: [w.readerMailboxId],
    });
    expect(r.examined).toBe(0);
    expect(fake.delivered).toHaveLength(0);
  });
});

describe("nothing is spent when the pass cannot send", () => {
  /**
   * RISK 5 in the ruling — "injected default = untested branch". A standalone install with no SMTP
   * configured takes exactly this path, and the requirement is that it costs NOTHING: no ledger
   * row, no reservation, nobody recorded as answered. The next run tries again.
   */
  it("a factory that throws leaves NO ledger row and NO sender state — it is `deferred`", async () => {
    const w = await world();
    const id = await arrive(w);
    const fake = fakeAdapter({ throwOnOpen: true });

    const r = await run(w, fake);

    expect(r).toMatchObject({ sent: 0, examined: 0, deferredCandidates: 1 });
    expect(await ledger(w, id)).toBeUndefined();
    const state = await w.db.select().from(awaySenderState)
      .where(eq(awaySenderState.accountId, w.accountId));
    expect(state).toHaveLength(0);
  });

  it("a run after the credentials arrive answers the same candidate normally", async () => {
    const w = await world();
    await arrive(w);
    await run(w, fakeAdapter({ throwOnOpen: true }));
    const good = fakeAdapter();
    await run(w, good);
    expect(good.delivered).toHaveLength(1);
  });

  /**
   * SMTP is not transactional, so a throw is AMBIGUOUS — the message may have reached the server
   * before the failure. The reservation is KEPT and the outcome is `unverified`: this correspondent
   * is never offered a second copy. The interactive send path answers the same ambiguity the same
   * way, and this is the conservative half of that answer.
   */
  it("an SMTP throw keeps the claim as `unverified` and never resends", async () => {
    const w = await world({ throttle: "always" });
    const id = await arrive(w);

    const r = await run(w, fakeAdapter({ throwOnSend: true }));
    expect(r).toMatchObject({ sent: 0, unverified: 1 });
    const row = await ledger(w, id);
    expect(row!.outcome).toBe("unverified");
    expect(row!.sentAt).toBeNull();

    // A later, healthy run must NOT try again.
    const good = fakeAdapter();
    await run(w, good);
    expect(good.delivered).toHaveLength(0);
  });
});

describe("the ledger records every DECIDED candidate, with its reason", () => {
  it("a suppressed candidate gets a row naming the guard, and is never re-examined", async () => {
    const w = await world();
    const id = await arrive(w, { headers: { "list-id": ["<dev.them.test>"] } });
    const fake = fakeAdapter();

    const r = await run(w, fake);

    expect(r).toMatchObject({ examined: 1, sent: 0, suppressed: 1 });
    const row = await ledger(w, id);
    expect(row!.outcome).toBe("suppressed");
    expect(row!.reason).toBe("list_mail");
    expect(fake.delivered).toHaveLength(0);
  });

  /**
   * THE ANTI-JOIN IS WHAT MAKES THE PASS CONVERGE, and this is the case that pins it.
   *
   * Written after the mutation check exposed a false claim: deleting `isNull(awayReplies.id)` and
   * re-running "does not answer the same message twice" stayed GREEN, because what stops the second
   * DELIVERY there is the UNIQUE on (account, message) — the reservation returns zero rows and the
   * runner stops. Two different guards, and the test only covered one of them.
   *
   * A SUPPRESSED candidate is where the difference shows, because nothing about it is idempotent
   * at the reservation: without the anti-join the row is read again every run, re-decided, and
   * counted again. That is the away arm exactly — a held candidate that never
   * leaves the set pins the oldest page of every subsequent run, and a genuine arrival behind it is
   * never examined.
   *
   * Mutation watched red: delete `isNull(awayReplies.id)` from the WHERE and the second run reports
   * `examined: 1, suppressed: 1` instead of zero.
   */
  it("a DECIDED candidate leaves the set for good — the second run does not re-examine it", async () => {
    const w = await world();
    await arrive(w, { headers: { "list-id": ["<dev.them.test>"] } });
    const fake = fakeAdapter();

    const first = await run(w, fake);
    expect(first).toMatchObject({ examined: 1, suppressed: 1 });

    const second = await run(w, fake, new Date(NOW.getTime() + 60_000));
    expect(second).toMatchObject({ examined: 0, suppressed: 0 });
  });

  it("a candidate already reserved by another runner is left to it, silently", async () => {
    const w = await world();
    const id = await arrive(w);
    // Another runner got there first and holds the reservation.
    await w.db.insert(awayReplies).values({
      accountId: w.accountId, mailboxId: w.mailboxId, messageId: id,
      sender: "colleague@them.test", outcome: "pending", decidedAt: NOW,
    } as never);
    const fake = fakeAdapter();

    const r = await run(w, fake);

    // The anti-join takes it out of the candidate set entirely — nothing examined, nothing sent.
    expect(r).toMatchObject({ examined: 0, sent: 0 });
    expect(fake.delivered).toHaveLength(0);
  });
});


describe("a message whose body has not arrived is not a candidate yet", () => {
  /**
   * THE SUPPRESSION-SET HOLE THIS CLOSES, found by review.
   *
   * The body join was a LEFT join and the headers defaulted to `{}` downstream. `{}` reads as "no
   * markers", which is the PERMISSIVE answer, so a message with no stored body cleared `List-Id`,
   * `Auto-Submitted`, `Precedence`, `X-Auto-Response-Suppress` and the empty `Return-Path` in one
   * go and fell through to "send".
   *
   * Body-less rows are not hypothetical: the desktop's Cloud mirror inserts `messages` first and
   * fetches bodies afterwards (it has a backfill keyed on exactly that state) and writes
   * `organizerRole ?? "organizer"`, so such a row satisfies the organizer JOIN. The concrete
   * failure is an auto-reply to a mailing list — delivered to every subscriber, and public.
   *
   * Mutation watched red: change the `innerJoin(messageBodies, ...)` back to a `leftJoin` and the
   * first case here sends a reply to the list.
   */
  it("is not answered, and is not decided either — it waits for its body", async () => {
    const w = await world();
    const id = await arrive(w, { noBody: true });
    const fake = fakeAdapter();

    const r = await run(w, fake);

    expect(fake.delivered).toHaveLength(0);
    expect(r.examined).toBe(0);
    // NOT suppressed: nothing is known about it yet, so nothing may be recorded about it. A ledger
    // row here would take the message out of the set permanently, and it would never be answered
    // once its body did arrive.
    expect(await ledger(w, id)).toBeUndefined();
  });

  it("is answered normally once the body lands", async () => {
    const w = await world();
    const id = await arrive(w, { noBody: true });
    await run(w, fakeAdapter());

    await w.db.insert(messageBodies).values({ messageId: id, accountId: w.accountId, text: "hello", headers: {} });
    const good = fakeAdapter();
    await run(w, good, new Date(NOW.getTime() + 60_000));

    expect(good.delivered).toHaveLength(1);
  });

  it("the same message WITH its body is refused by the list guard — the positive control", () => {
    // Proves the case above is about the missing body and not about the message being uninteresting.
    return (async () => {
      const w = await world();
      await arrive(w, { headers: { "list-id": ["<dev.them.test>"] } });
      const fake = fakeAdapter();
      await run(w, fake);
      expect(fake.delivered).toHaveLength(0);
    })();
  });
});

describe("a responder enabled by an older build heals rather than staying dead", () => {
  /**
   * THE ROLLING-DEPLOY HOLE, found by review. 0087 promises an API one version older keeps working,
   * and that older `put` never writes `enabled_at` (the column has no DEFAULT). So: somebody whose
   * responder is off (enabled_at NULL) saves `enabled: true` against an old instance, and the probe
   * — which requires a non-null instant — would exclude the row FOR EVER. Silently dead for the
   * whole trip, with no error and no self-heal.
   *
   * The pass stamps `now()` on exactly that shape. `now()` and not `updated_at`, so the healing run
   * answers no backlog: the floor is the instant of the heal.
   */
  it("stamps an enablement instant, answers no backlog, and is live from the next message", async () => {
    const w = await world({ enabledAt: null });
    // Mail that arrived BEFORE the heal — it must not be answered by the heal itself.
    await arrive(w, { at: new Date(NOW.getTime() - 60_000) });
    const fake = fakeAdapter();

    const first = await run(w, fake);
    expect(fake.delivered, "the healing run answers no backlog").toHaveLength(0);
    // Live in the SAME run — the heal precedes the probe — but with a floor of `now()`, so the
    // account is served and has nothing to serve. Both halves matter: an unhealed row would be
    // invisible for ever, and a row healed to `updated_at` would answer the whole backlog.
    expect(first.accounts).toBe(1);
    expect(first.examined).toBe(0);

    // The row is live now, and mail arriving after the heal is answered.
    await arrive(w, { from: "later@them.test", at: new Date(NOW.getTime() + 60_000) });
    const second = fakeAdapter();
    await run(w, second, new Date(NOW.getTime() + 120_000));
    expect(second.delivered).toHaveLength(1);
  });

  it("does not touch a responder that is switched off", async () => {
    const w = await world({ enabled: false, enabledAt: null });
    await arrive(w);
    const fake = fakeAdapter();
    await run(w, fake);
    await run(w, fake, new Date(NOW.getTime() + 60_000));
    expect(fake.delivered).toHaveLength(0);
  });
});

describe("a mailbox that cannot dial does not pin the page", () => {
  /**
   * THE STARVATION SHAPE THE ORDERING REINTRODUCED, found by review. Eligibility used to run only
   * after `openSendAdapter` succeeded, so a mailbox whose factory throws left ALL its candidates
   * undecided — and since the read is oldest-first with a fixed limit and the ledger anti-join is
   * the only thing that removes a row, those candidates occupied the oldest page of every later
   * run for ever, starving a healthy mailbox on the same account.
   *
   * Eligibility now runs first, so an ineligible candidate is DECIDED even on a mailbox that cannot
   * send, and only the ones that actually need a transport defer.
   */
  it("still decides the candidates an eligibility guard refuses", async () => {
    const w = await world();
    const listMsg = await arrive(w, { headers: { "list-id": ["<dev.them.test>"] } });
    const humanMsg = await arrive(w, { from: "human@them.test" });
    const fake = fakeAdapter({ throwOnOpen: true });

    const r = await run(w, fake);

    // The list message is decided and gone from the set; the human is deferred, undecided.
    const listRow = await ledger(w, listMsg);
    expect(listRow!.outcome).toBe("suppressed");
    expect(listRow!.reason).toBe("list_mail");
    expect(await ledger(w, humanMsg)).toBeUndefined();
    expect(r.suppressed).toBe(1);
    expect(r.deferredCandidates).toBe(1);
  });

  it("opens the transport at most once per mailbox, and not at all when nothing needs one", async () => {
    const w = await world();
    await arrive(w, { headers: { "list-id": ["<a.them.test>"] } });
    await arrive(w, { headers: { "list-id": ["<b.them.test>"] }, from: "two@them.test" });
    const fake = fakeAdapter();

    await run(w, fake);

    // Every candidate was refused by a guard, so no dial was ever needed.
    expect(fake.opened).toHaveLength(0);
    expect(fake.closed).toBe(0);
  });
});

describe("the per-person throttle", () => {
  const second = async (w: World, from = "colleague@them.test") =>
    arrive(w, { from, subject: "and another thing" });

  it("`per_day` answers once and throttles the next message inside the window", async () => {
    const w = await world({ throttle: "per_day" });
    await arrive(w);
    const fake = fakeAdapter();
    await run(w, fake);

    const id2 = await second(w);
    const r = await run(w, fake, new Date(NOW.getTime() + 60 * 60 * 1000));

    expect(fake.delivered).toHaveLength(1);
    expect(r.throttled).toBe(1);
    const row = await ledger(w, id2);
    expect(row!.outcome).toBe("throttled");
    expect(row!.reason).toBe("per_day");
    // No minted id on a row that sent nothing: the column exists to correlate a ledger row with a
    // Sent-folder copy, and an id that correlates with nothing is a thread an operator can pull
    // for ever. It is minted before the reservation (so a crash leaves an attributable one) and
    // cleared in the same transaction that records the refusal.
    expect(row!.mintedMessageId).toBeNull();
    expect(row!.sentAt).toBeNull();
  });

  it("`per_day` answers again once the day has passed", async () => {
    const w = await world({ throttle: "per_day" });
    await arrive(w);
    const fake = fakeAdapter();
    await run(w, fake);

    await second(w);
    await run(w, fake, new Date(NOW.getTime() + 25 * 60 * 60 * 1000));

    expect(fake.delivered).toHaveLength(2);
  });

  it("`per_week` still throttles after a day, and answers after eight", async () => {
    const w = await world({ throttle: "per_week" });
    await arrive(w);
    const fake = fakeAdapter();
    await run(w, fake);

    await second(w);
    await run(w, fake, new Date(NOW.getTime() + 25 * 60 * 60 * 1000));
    expect(fake.delivered).toHaveLength(1);

    await arrive(w, { subject: "a third" });
    await run(w, fake, new Date(NOW.getTime() + 8 * 24 * 60 * 60 * 1000));
    expect(fake.delivered).toHaveLength(2);
  });

  it("`always` answers every message from the same person", async () => {
    const w = await world({ throttle: "always" });
    await arrive(w);
    const fake = fakeAdapter();
    await run(w, fake);
    await second(w);
    await run(w, fake, new Date(NOW.getTime() + 1000));
    expect(fake.delivered).toHaveLength(2);
  });

  it("the throttle is PER PERSON — a different correspondent is answered regardless", async () => {
    const w = await world({ throttle: "per_week" });
    await arrive(w);
    const fake = fakeAdapter();
    await run(w, fake);

    await second(w, "someone-else@them.test");
    await run(w, fake, new Date(NOW.getTime() + 1000));

    expect(fake.delivered).toHaveLength(2);
  });

  /**
   * `per_message` — "once, until you change the text" — keyed by a HASH OF THE TEXT and never by
   * the row's `updated_at`. The third leg is the one that matters: changing the text BACK answers
   * again, because the question the setting asks is "have they been told THIS", not "how many
   * times has this row been written". A version-keyed implementation passes the first two legs
   * and fails this one.
   */
  it("`per_message`: once for the same text, again when it changes, again when it changes back", async () => {
    const w = await world({ throttle: "per_message", body: "Text A" });
    const fake = fakeAdapter();

    await arrive(w);
    await run(w, fake);
    expect(fake.delivered).toHaveLength(1);

    // Same text, saved again (updatedAt moves; the words do not). Nothing new is sent.
    await w.db.update(awayResponders).set({ updatedAt: new Date(NOW.getTime() + 1000) })
      .where(eq(awayResponders.accountId, w.accountId));
    await arrive(w, { subject: "two" });
    await run(w, fake, new Date(NOW.getTime() + 2000));
    expect(fake.delivered).toHaveLength(1);

    // The text CHANGES → answered again.
    await w.db.update(awayResponders).set({ body: "Text B" })
      .where(eq(awayResponders.accountId, w.accountId));
    await arrive(w, { subject: "three" });
    await run(w, fake, new Date(NOW.getTime() + 3000));
    expect(fake.delivered).toHaveLength(2);

    // And BACK to the first text → answered again. A stored version id would refuse here.
    await w.db.update(awayResponders).set({ body: "Text A" })
      .where(eq(awayResponders.accountId, w.accountId));
    await arrive(w, { subject: "four" });
    await run(w, fake, new Date(NOW.getTime() + 4000));
    expect(fake.delivered).toHaveLength(3);
  });
});

describe("the suspension gate", () => {
  it("an ineligible account is not examined and nothing is decided for it", async () => {
    const w = await world();
    const id = await arrive(w);
    const fake = fakeAdapter();

    const r = await runAwayResponderPass(w.db, {
      openSendAdapter: fake.factory, now: () => NOW,
      accountEligible: async () => false,
    });

    expect(r).toMatchObject({ examined: 0, sent: 0, deferredAccounts: 1 });
    expect(fake.opened).toHaveLength(0);
    // NOT recorded as suppressed: the replies go out promptly once the suspension lifts.
    expect(await ledger(w, id)).toBeUndefined();
  });

  it("an absent gate means ELIGIBLE — the standalone door injects none", async () => {
    const w = await world();
    await arrive(w);
    const fake = fakeAdapter();
    await run(w, fake);
    expect(fake.delivered).toHaveLength(1);
  });
});

describe("the send budget", () => {
  it("stops at the cap and reports it, leaving the rest for the next run", async () => {
    const w = await world({ throttle: "always" });
    for (let i = 0; i < 4; i += 1) await arrive(w, { from: `p${i}@them.test`, subject: `s${i}` });
    const fake = fakeAdapter();

    const r = await runAwayResponderPass(w.db, {
      openSendAdapter: fake.factory, now: () => NOW, sendsPerRun: 2,
    });

    expect(r.sent).toBe(2);
    expect(r.capped).toBe(true);
    expect(fake.delivered).toHaveLength(2);
  });
});

/**
 * ═══ THE CALLER CAN STOP THE PASS BETWEEN DELIVERIES ═══════════════════════════════════════
 *
 * A pass that has begun is not entitled to finish. On the desktop the mailbox can change hands
 * mid-pass: the socket dies, a re-dial re-reads the organizer lease, and a stranger's claim is
 * found — while this loop is still holding candidates it selected under the old answer. Sending
 * them duplicates the real organizer's reply, in the user's name, from an install the mailbox no
 * longer belongs to.
 *
 * ── WHY THE CHECK HAD TO GO INSIDE, AND WHAT THE FIRST VERSION MISSED ─────────────────────
 *
 * The first version of this hook was consulted once, at the top of the pass, and the public
 * message said it was consulted "between rows". On the hosted side that was nearly true — the
 * pass loops many responders. On the DESKTOP, which is the door that needs it, exactly ONE
 * account is handed in, so the outer check fires before any work and never again: every
 * correspondent in the group still received a reply after a hand-over, up to the run's budget.
 *
 * The checks that matter are the inner ones — per mailbox, and per CANDIDATE, because each
 * candidate is a delivery.
 */
describe("a pass stops delivering when its caller says the mailbox is no longer ours", () => {
  /** Two correspondents on one mailbox, so the group has a second candidate to reach. */
  const twoCandidates = async (tag: string) => {
    const w = await world();
    await arrive(w, { from: `one-${tag}@elsewhere.test`, messageIdHeader: `<away-${tag}-1@x>` });
    await arrive(w, { from: `two-${tag}@elsewhere.test`, messageIdHeader: `<away-${tag}-2@x>` });
    return w;
  };

  it("THE CONTROL — with no cancellation both candidates are answered", async () => {
    /* Without this the case below proves nothing: if the fixture only ever produced one reply,
       "exactly one" would be true whether the inner check exists or not. This lane has had to
       repair three vacuous assertions already, so the control is written first. */
    const w = await twoCandidates("control");
    const fake = fakeAdapter();
    await runAwayResponderPass(w.db, { openSendAdapter: fake.factory, now: () => NOW });
    expect(
      fake.delivered.length,
      "the fixture does not produce two replies, so the cancellation case asserts nothing",
    ).toBe(2);
  });

  it("sends exactly ONE reply when the mailbox changes hands after the first delivery", async () => {
    const w = await twoCandidates("cancel");
    const fake = fakeAdapter();
    await runAwayResponderPass(w.db, {
      openSendAdapter: fake.factory,
      now: () => NOW,
      /* OURS until the first reply has gone out, somebody else's immediately after — the shape a
         mid-pass hand-over actually has. Keyed on the deliveries themselves, so the moment is the
         send rather than a counter the test has to keep in step with. */
      cancelled: () => fake.delivered.length >= 1,
    });
    expect(
      fake.delivered.length,
      "the pass went on replying in the user's name after the mailbox changed hands — the outer "
      + "check cannot see this, because the desktop hands the pass a single account",
    ).toBe(1);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE PILE SCOPE, THROUGH THE WHOLE PASS (mail 0096 · 0.16 owner feedback item 4)
   ══════════════════════════════════════════════════════════════════════════════════════════

   The rule itself is a table in `packages/core/test/away-eligibility.test.ts`. What these cases
   add is the WIRING: that the stored column reaches the rule, that a refused candidate leaves a
   ledger row carrying its reason (which is what makes the pass converge instead of re-reading the
   same message for ever), and that no send happens. A pure-function table cannot see any of that
   — the column could be read into the wrong field, or dropped between the probe and the decision,
   and every case there would stay green.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("the away responder answers only the piles it was asked to", () => {
  it("POSITIVE CONTROL: an Ohbox message from a let-in sender gets exactly one reply", async () => {
    const w = await world();
    const id = await arrive(w, { folder: "INBOX" });
    const fake = fakeAdapter();

    const r = await run(w, fake);

    expect(r).toMatchObject({ examined: 1, sent: 1, suppressed: 0 });
    expect(fake.delivered).toHaveLength(1);
    expect((await ledger(w, id))!.outcome).toBe("sent");
  });

  it("a READS-filed message is not answered, and says why in the ledger", async () => {
    const w = await world();
    const id = await arrive(w, { folder: "ohmail/News" });
    const fake = fakeAdapter();

    const r = await run(w, fake);

    expect(r).toMatchObject({ examined: 1, sent: 0, suppressed: 1 });
    expect(fake.delivered).toHaveLength(0);
    const row = await ledger(w, id);
    expect(row!.outcome).toBe("suppressed");
    // The REASON, not merely a refusal: an operator reading this row has to be able to tell "in a
    // pile you did not ask me to answer" from "this sender is a mailing list".
    expect(row!.reason).toBe("wrong_pile");
  });

  it("…and IS answered once Reads is opted in — the setting does what it says", async () => {
    const w = await world({ piles: ["INBOX", "ohmail/News"] });
    const id = await arrive(w, { folder: "ohmail/News" });
    const fake = fakeAdapter();

    const r = await run(w, fake);

    expect(r).toMatchObject({ sent: 1 });
    expect(fake.delivered).toHaveLength(1);
    expect((await ledger(w, id))!.outcome).toBe("sent");
  });

  it("a RECEIPT is not answered while its pile is unticked, even with the widest audience", async () => {
    const w = await world({ audience: "everyone", piles: ["INBOX", "ohmail/News"] });
    const id = await arrive(w, { folder: "ohmail/Receipts" });
    const fake = fakeAdapter();

    await run(w, fake);

    expect(fake.delivered).toHaveLength(0);
    expect((await ledger(w, id))!.reason).toBe("wrong_pile");
  });

  /**
   * …AND IS ANSWERED WITH THE PILE TICKED (mail 0101), which is the pair that says the box does
   * something. What keeps the MACHINES out of an answered Receipts pile is the header predicate,
   * asserted one case down and per header in `away-eligibility.test.ts`.
   */
  it("a receipt a person typed IS answered once its pile is ticked", async () => {
    const w = await world({ piles: ["INBOX", "ohmail/Receipts"] });
    const id = await arrive(w, { folder: "ohmail/Receipts" });
    const fake = fakeAdapter();

    const r = await run(w, fake);

    expect(r).toMatchObject({ sent: 1 });
    expect(fake.delivered).toHaveLength(1);
    expect((await ledger(w, id))!.outcome).toBe("sent");
  });

  it("a MACHINE receipt in that same ticked pile is still refused, by its header", async () => {
    const w = await world({ piles: ["INBOX", "ohmail/Receipts"] });
    const id = await arrive(w, {
      folder: "ohmail/Receipts", headers: { "list-id": ["<orders.shop.example>"] },
    });
    const fake = fakeAdapter();

    await run(w, fake);

    expect(fake.delivered).toHaveLength(0);
    expect((await ledger(w, id))!.reason).toBe("list_mail");
  });

  /**
   * THE OWNER'S OWN SEQUENCE, as one case: one sender, two messages, two piles. The reply goes to
   * the Ohbox one and the Reads one is left alone — which is the whole of what was asked for, and
   * which no single-message case can show, because it is about the pass choosing BETWEEN them.
   */
  it("one sender, two messages, two piles → the Ohbox one is answered and the Reads one is not", async () => {
    const w = await world();
    const readsId = await arrive(w, { folder: "ohmail/News", subject: "our newsletter" });
    const ohboxId = await arrive(w, { folder: "INBOX", subject: "about the roof" });
    const fake = fakeAdapter();

    const r = await run(w, fake);

    expect(r).toMatchObject({ sent: 1, suppressed: 1 });
    expect(fake.delivered).toHaveLength(1);
    // The one that went out is the OHBOX one — asserted by its subject, because "one send" alone
    // would be satisfied by answering the wrong message.
    expect(fake.delivered[0]!.subject).toContain("about the roof");
    expect((await ledger(w, ohboxId))!.outcome).toBe("sent");
    expect((await ledger(w, readsId))!.reason).toBe("wrong_pile");
  });

  it("an EMPTY piles column answers nobody — it is not read as 'no filter'", async () => {
    const w = await world({ piles: [], audience: "everyone" });
    await arrive(w, { folder: "INBOX" });
    const fake = fakeAdapter();

    const r = await run(w, fake);

    expect(r).toMatchObject({ sent: 0, suppressed: 1 });
    expect(fake.delivered).toHaveLength(0);
  });

  /**
   * THE SCREENER TAKES BOTH CONDITIONS (mail 0101): the wider audience AND its own pile. Both arms
   * here, because the audience alone used to be enough and a single-arm case would not say which
   * of the two admitted the stranger.
   */
  it("`everyone` answers a stranger waiting in the Screener when that pile is ticked", async () => {
    const w = await world({ audience: "everyone", piles: ["INBOX", "ohmail/Screener"] });
    await arrive(w, { folder: "ohmail/Screener" });
    const fake = fakeAdapter();

    const r = await run(w, fake);

    expect(r).toMatchObject({ sent: 1 });
    expect(fake.delivered).toHaveLength(1);
  });

  it("…and does not, with the same audience and the pile unticked", async () => {
    const w = await world({ audience: "everyone" });
    const id = await arrive(w, { folder: "ohmail/Screener" });
    const fake = fakeAdapter();

    const r = await run(w, fake);

    expect(r).toMatchObject({ sent: 0, suppressed: 1 });
    expect(fake.delivered).toHaveLength(0);
    expect((await ledger(w, id))!.reason).toBe("wrong_pile");
  });

  /* ────────────────────────────────────────────────────────────────────────────────────────
     A SITE MAILBOX IN THE ANSWERED PILE (0.16.2 owner report · RFC 3834 §2)

     The pile rule does not reach this one, and that is the whole reason these two cases are
     here rather than only in the eligibility table: measured on a real mailbox, a WordPress
     install's notifications were mostly in Reads and a few in the OHBOX. The Ohbox
     ones are in the pile its owner ticked, carry no `Auto-Submitted`, no `Precedence`, no
     `List-*` and a present `Return-Path`, and are answered on the base.
     ──────────────────────────────────────────────────────────────────────────────────────── */

  it("a site mailbox in the TICKED pile is not answered, and says so in the ledger", async () => {
    const w = await world();
    const id = await arrive(w, { folder: "INBOX", from: "wordpress@them.test" });
    const fake = fakeAdapter();

    const r = await run(w, fake);

    expect(r).toMatchObject({ examined: 1, sent: 0, suppressed: 1 });
    expect(fake.delivered).toHaveLength(0);
    expect((await ledger(w, id))!.reason).toBe("site_notification");
  });

  /**
   * POSITIVE CONTROL through the whole pass: the same pile, the same absence of headers, a local
   * part that merely STARTS with a member. A prefix rule would have refused this person.
   */
  it("POSITIVE CONTROL: `wpeteam@` in that pile is a person, and is answered", async () => {
    const w = await world();
    const id = await arrive(w, { folder: "INBOX", from: "wpeteam@them.test" });
    const fake = fakeAdapter();

    const r = await run(w, fake);

    expect(r).toMatchObject({ sent: 1 });
    expect(fake.delivered).toHaveLength(1);
    expect((await ledger(w, id))!.outcome).toBe("sent");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE END DATE SWITCHES THE RESPONDER OFF (mail 0101)

   `ends_at` already ended the ANSWERING window — the probe's `endsAt >= now` — so a responder
   past its date sent nothing. What it did not do was change the STATE anybody reads: the row
   stayed `enabled`, so the switch said On for ever, and extending the date months later would
   have answered everything that arrived in between, because `enabled_at` only moves on OFF → ON.

   So the pass sweeps them off, once, before the probe.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

const responderRow = async (w: World) => {
  const [row] = await w.db.select().from(awayResponders)
    .where(eq(awayResponders.accountId, w.accountId)).limit(1);
  return row!;
};

describe("the chosen end date", () => {
  it("answers at one second BEFORE the end date — the positive control", async () => {
    const w = await world({ endsAt: new Date(NOW.getTime() + 1000) });
    await arrive(w);
    const fake = fakeAdapter();

    const r = await run(w, fake);

    expect(r).toMatchObject({ sent: 1, expired: 0 });
    expect(fake.delivered).toHaveLength(1);
    expect((await responderRow(w)).enabled).toBe(true);
  });

  it("answers nothing one second AFTER it, and switches the row off exactly once", async () => {
    const w = await world({ endsAt: new Date(NOW.getTime() - 1000) });
    await arrive(w);
    const fake = fakeAdapter();

    const first = await run(w, fake);

    expect(first).toMatchObject({ sent: 0, examined: 0, expired: 1 });
    expect(fake.delivered).toHaveLength(0);
    /* The same write `put` makes when a person switches the responder off: the flag, the
       enablement instant (its invariant is "not enabled ⇒ null"), and the date itself, so a later
       "on" is an open-ended responder rather than one that is instantly expired again. */
    const off = await responderRow(w);
    expect(off.enabled).toBe(false);
    expect(off.enabledAt).toBeNull();
    expect(off.endsAt).toBeNull();

    // ONCE, ACROSS TWO PASSES: idempotent by the statement's own WHERE, not by a flag.
    const second = await run(w, fake);
    expect(second).toMatchObject({ expired: 0 });
    expect(fake.delivered).toHaveLength(0);
  });

  it("a responder with NO end date is never expired, however long it has been on", async () => {
    const w = await world();
    await arrive(w);
    const fake = fakeAdapter();

    const r = await run(w, fake, new Date(NOW.getTime() + 400 * 24 * 60 * 60 * 1000));

    expect(r).toMatchObject({ expired: 0 });
    expect((await responderRow(w)).enabled).toBe(true);
  });

  /**
   * AND IT IS SCOPED BY THE CALLER'S MAILBOXES, exactly as the probe is. Switching somebody's
   * responder off is a product state change, so a drain that named its own mailbox must not make
   * it for an account it was not asked about.
   */
  it("does not expire an account the caller did not ask about", async () => {
    const mine = await world({ endsAt: new Date(NOW.getTime() - 1000) });
    const theirsAccount = randomUUID();
    const [theirMailbox] = await mine.db.insert(mailboxes).values({
      accountId: theirsAccount, provider: "imap", address: "them@away.test",
      organizerRole: "organizer", status: "connected",
    }).returning();
    await mine.db.insert(awayResponders).values({
      accountId: theirsAccount, enabled: true, body: "Back Monday.",
      audience: "screened_in", throttle: "per_day", piles: ["INBOX"],
      enabledAt: ENABLED_AT, endsAt: new Date(NOW.getTime() - 1000), updatedAt: ENABLED_AT,
    });

    const r = await runAwayResponderPass(mine.db, {
      openSendAdapter: fakeAdapter().factory, now: () => NOW,
      mailboxIds: [theirMailbox!.id],
    });

    expect(r).toMatchObject({ expired: 1 });
    // MINE is untouched: the sweep reached exactly the account that owns the named mailbox.
    expect((await responderRow(mine)).enabled).toBe(true);
  });

  /**
   * THE ENABLED-WITHOUT-AN-INSTANT SHAPE still expires. `healMissingEnabledAt` stamps `now()` on
   * exactly that row, and the sweep's WHERE does not read `enabled_at` — so it is switched off
   * whichever of the two runs first, which is the property this case holds. Measured: swapping
   * the two leaves all 61 cases here green, so the order in the pass is a saved write and not an
   * invariant, and this case does not claim to be about it.
   */
  it("an expired row with no enablement instant is switched off, not healed live", async () => {
    const w = await world({ endsAt: new Date(NOW.getTime() - 1000), enabledAt: null });
    const fake = fakeAdapter();

    const r = await run(w, fake);

    expect(r).toMatchObject({ expired: 1, accounts: 0 });
    const row = await responderRow(w);
    expect(row.enabled).toBe(false);
    expect(row.enabledAt).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE BOUNCE, AND WHAT IT TEACHES THE PASS
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/** A delivery report quoting a minted reply id — the shape an MTA actually returns. */
const bounceOf = async (w: World, minted: string, opts: { from?: string; dsn?: boolean } = {}) =>
  arrive(w, {
    from: opts.from ?? "postmaster@relay.test",
    subject: "Undelivered Mail Returned to Sender",
    folder: "INBOX",
    headers: {
      "in-reply-to": [minted],
      ...(opts.dsn === false
        ? { "content-type": ["multipart/mixed; boundary=x"] }
        : { "content-type": ["multipart/report; report-type=delivery-status; boundary=x"] }),
    },
  });

describe("a bounce for an away reply makes that correspondent unreachable", () => {
  it("stamps the sender undeliverable and never answers them again", async () => {
    const w = await world();
    await arrive(w, { from: "gone@them.test", folder: "INBOX" });
    const fake = fakeAdapter();

    // The first reply goes out, and its minted id is what a bounce will quote.
    const first = await run(w, fake);
    expect(first.sent).toBe(1);
    const minted = fake.delivered[0]!.messageId!;

    // The bounce arrives.
    await bounceOf(w, minted);

    // A LATER message from the same correspondent, well past the throttle window, so the refusal
    // below cannot be the once-a-day cap wearing the bounce's clothes.
    const later = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000);
    const laterId = await arrive(w, { from: "gone@them.test", folder: "INBOX", at: later });
    const fake2 = fakeAdapter();

    const second = await run(w, fake2, new Date(later.getTime() + 60_000));

    expect(second.undeliverableMarked).toBe(1);
    expect(fake2.delivered).toHaveLength(0);
    expect((await ledger(w, laterId))!.reason).toBe("undeliverable");
  });

  /**
   * THE CONTROL THAT MATTERS MOST: a HUMAN replying to an away reply also quotes the minted id in
   * `In-Reply-To`. On the id alone, "thanks, have a good trip" marks their address dead and
   * silences them for the rest of the trip — a live correspondent lost to a courtesy.
   */
  it("a HUMAN reply quoting the same id does NOT mark anybody undeliverable", async () => {
    const w = await world();
    await arrive(w, { from: "alive@them.test", folder: "INBOX" });
    const fake = fakeAdapter();
    await run(w, fake);
    const minted = fake.delivered[0]!.messageId!;

    // Same threading header, ordinary content type, ordinary sender.
    await bounceOf(w, minted, { from: "alive@them.test", dsn: false });

    const later = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000);
    await arrive(w, { from: "alive@them.test", folder: "INBOX", at: later });
    const fake2 = fakeAdapter();

    const second = await run(w, fake2, new Date(later.getTime() + 60_000));

    expect(second.undeliverableMarked).toBe(0);
    // …and they are still answered, which is the half a refusal-only test cannot show.
    expect(fake2.delivered).toHaveLength(1);
  });

  /** A delivery report quoting an id we never minted is somebody else's bounce. */
  it("a delivery report for an unrelated id marks nobody", async () => {
    const w = await world();
    await arrive(w, { from: "someone@them.test", folder: "INBOX" });
    const fake = fakeAdapter();
    await run(w, fake);

    await bounceOf(w, "<not-ours-at-all@elsewhere.test>");

    const later = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000);
    await arrive(w, { from: "someone@them.test", folder: "INBOX", at: later });
    const fake2 = fakeAdapter();
    const second = await run(w, fake2, new Date(later.getTime() + 60_000));

    expect(second.undeliverableMarked).toBe(0);
    expect(fake2.delivered).toHaveLength(1);
  });

  /** The stamp is taken ONCE: a bounce that stays in the mailbox must not move the instant on
   *  every tick, or "when did we learn this" stops being answerable. */
  it("a bounce still sitting in the mailbox is not re-stamped on the next run", async () => {
    const w = await world();
    await arrive(w, { from: "gone@them.test", folder: "INBOX" });
    const fake = fakeAdapter();
    await run(w, fake);
    await bounceOf(w, fake.delivered[0]!.messageId!);

    const t1 = new Date(NOW.getTime() + 60_000);
    expect((await run(w, fakeAdapter(), t1)).undeliverableMarked).toBe(1);
    const t2 = new Date(NOW.getTime() + 120_000);
    expect((await run(w, fakeAdapter(), t2)).undeliverableMarked).toBe(0);

    const [state] = await w.db.select().from(awaySenderState)
      .where(and(eq(awaySenderState.accountId, w.accountId),
        eq(awaySenderState.sender, "gone@them.test")));
    expect(state!.undeliverableAt!.getTime()).toBe(t1.getTime());
  });
});
