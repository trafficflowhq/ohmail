import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drafts, mailboxes, messages, outboundSends, changeLog } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { createLogger, mintMessageId, normalizeMessageId } from "@trafficflow/core/mail";
import type { OpenSendAdapter, OutboundMessage, SendAdapter } from "@trafficflow/core";
import {
  runSendReconcilePass, SEND_RECONCILE_BATCH, SEND_RECONCILE_CALL_CEILING_MS,
  SEND_RECONCILE_CLOSE_CEILING_MS, SEND_RECONCILE_DIAL_DEADLINE_MS,
  SEND_RECONCILE_NET_TIMEOUTS,
  SEND_RECONCILE_GIVE_UP_MS,
  SEND_RECONCILE_SCAN_FACTOR, SEND_STALE_AFTER_MS,
  SEND_UNVERIFIED_RECHECK_MS, SEND_UNVERIFIED_PROBE_AT_MS, SEND_UNVERIFIED_PROBE_WINDOW_MS,
  inUnverifiedProbeWindow,
} from "../src/index.js";

/**
 * THE RECONCILING PASS FOR STRANDED SEND RESERVATIONS.
 *
 * What this file is for: the pass's DECISIONS — which rows it takes, which mailboxes it will
 * dial, what a mirror hit and a mirror miss each mean, and the fact that nothing on the path can
 * put an envelope on the wire. The CONCURRENCY — two resolvers racing one row — is not here and
 * cannot be: PGlite is one connection, so the interleaving does not exist. That is
 * `send-reconcile-race.pg.test.ts`, on real Postgres.
 *
 * Every adapter below counts its own calls, because the assertions that matter most in this file
 * are about what did NOT happen: no dial for a mailbox in `error`, no `send` ever, one LOGIN for
 * two rows on one mailbox.
 */

const NOW = new Date("2026-09-02T12:00:00.000Z");
const MIN = 60_000;

interface Spy {
  factory: OpenSendAdapter;
  /** Every mailbox id the factory was asked to open, in order — length IS the dial count. */
  opened: string[];
  closed: number;
  probed: string[];
  /** Envelopes this adapter was asked to deliver. Must always be empty. */
  delivered: OutboundMessage[];
}

/** An adapter whose Sent folder answers `inSent`, counting every call it receives. */
function spyAdapter(inSent: boolean | (() => boolean | Promise<boolean>)): Spy {
  const spy: Spy = { factory: null as never, opened: [], closed: 0, probed: [], delivered: [] };
  spy.factory = async (mailboxId: string): Promise<SendAdapter> => {
    spy.opened.push(mailboxId);
    return {
      async send(msg: OutboundMessage) {
        spy.delivered.push(msg);
        return { providerMessageId: msg.messageId! };
      },
      async messageInSent(id: string) {
        spy.probed.push(id);
        return typeof inSent === "function" ? inSent() : inSent;
      },
      async close() { spy.closed += 1; },
    };
  };
  return spy;
}

interface World {
  db: Awaited<ReturnType<typeof makeTestDb>>;
  accountId: string;
  mailboxId: string;
}

async function world(mailboxStatus = "connected"): Promise<World> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `owner-${randomUUID().slice(0, 8)}@rec.test`,
    status: mailboxStatus,
  }).returning();
  return { db, accountId, mailboxId: mb!.id };
}

/** A SECOND mailbox in the same world — the dial budget counts distinct connections. */
async function sibling(w: World, mailboxStatus = "connected"): Promise<World> {
  const [mb] = await w.db.insert(mailboxes).values({
    accountId: w.accountId, provider: "imap",
    address: `sib-${randomUUID().slice(0, 8)}@rec.test`, status: mailboxStatus,
  }).returning();
  return { ...w, mailboxId: mb!.id };
}

/**
 * A STRANDED RESERVATION, seeded directly: `outbound_sends` `pending`, its draft at `sending`.
 * That pair is exactly what a killed invocation leaves behind, and seeding it rather than
 * producing it through a crashed send is the point — the pass's subject is wreckage whose
 * producer is gone.
 */
async function stranded(
  w: World, opts: { ageMs?: number; mintedMessageId?: string; draftStatus?: string } = {},
): Promise<{ sendId: string; draftId: string; minted: string }> {
  const ageMs = opts.ageMs ?? 11 * MIN;
  // The REAL minter, so the whole chain is spelled the way production spells it.
  const minted = opts.mintedMessageId ?? mintMessageId("rec.test");
  const at = new Date(NOW.getTime() - ageMs);
  const [d] = await w.db.insert(drafts).values({
    accountId: w.accountId, mailboxId: w.mailboxId, subject: "the stranded one", body: "words",
    to: [{ name: null, address: "you@example.com" }],
    status: opts.draftStatus ?? "sending", createdAt: at, updatedAt: at,
  }).returning();
  const [s] = await w.db.insert(outboundSends).values({
    accountId: w.accountId, idempotencyKey: randomUUID(), draftId: d!.id,
    mintedMessageId: minted, status: "pending", createdAt: at,
  }).returning();
  return { sendId: s!.id, draftId: d!.id, minted };
}

/**
 * A SEND ALREADY CLOSED `unverified` — the state this pass used to leave for ever. `outbound_sends`
 * `unverified`, its draft `unverified`, nobody has answered for it; `ageMs` places the attempt.
 */
async function closedUnverified(
  w: World, opts: { ageMs: number; resolvedBy?: string; draftStatus?: string } = { ageMs: 20 * MIN },
): Promise<{ sendId: string; draftId: string; minted: string }> {
  const minted = mintMessageId("rec.test");
  const at = new Date(NOW.getTime() - opts.ageMs);
  const [d] = await w.db.insert(drafts).values({
    accountId: w.accountId, mailboxId: w.mailboxId, subject: "the ambiguous one", body: "words",
    to: [{ name: null, address: "you@example.com" }],
    status: opts.draftStatus ?? "unverified", createdAt: at, updatedAt: at,
  }).returning();
  const [s] = await w.db.insert(outboundSends).values({
    accountId: w.accountId, idempotencyKey: randomUUID(), draftId: d!.id,
    mintedMessageId: minted, status: "unverified", createdAt: at,
    ...(opts.resolvedBy ? { resolvedBy: opts.resolvedBy, resolvedAt: at } : {}),
  }).returning();
  return { sendId: s!.id, draftId: d!.id, minted };
}

/** The account's own mirror already holds the minted id — the Sent-folder watch got there first. */
async function mirror(w: World, minted: string): Promise<void> {
  // THROUGH THE REAL NORMALIZATION, and this is the whole point of the helper.
  //
  // `mintMessageId` produces `<uuid@domain>`; every writer of `messages.message_id_header` goes
  // through `normalizeMessageId`, which STRIPS the brackets (`record-at-send.pg.test.ts` pins the
  // column as `providerMessageId.replace(/[<>]/g, "")`). This helper first seeded the BRACKETED
  // form, which no writer in this codebase produces — so the mirror arm matched in the test and
  // could never match in production, and the suite was green against a dataset that does not
  // exist. Every no-dial branch depends on this arm being the only evidence there is, so the
  // failure was not merely "one lost optimisation": a `disabled` mailbox or a give-up would have
  // written terminal `unverified` over a message the mirror was holding.
  const header = normalizeMessageId(minted);
  expect(header, "the minted id must normalize to a storable header").not.toBeNull();
  expect(header, "and the stored form is NOT the minted spelling").not.toBe(minted);
  await w.db.insert(messages).values({
    accountId: w.accountId, mailboxId: w.mailboxId, messageIdHeader: header!,
    bodyHash: randomUUID(), dedupKey: randomUUID(), subject: "the stranded one",
    fromAddress: "owner@rec.test", snippet: "words",
    nativeLocator: { folder: "Sent", ref: "1:7" },
  });
}

const run = (w: World, deps: Parameters<typeof runSendReconcilePass>[1]) =>
  runSendReconcilePass(w.db, { now: () => NOW, ...deps });

const sendRow = async (w: World, id: string) =>
  (await w.db.select().from(outboundSends).where(eq(outboundSends.id, id)))[0]!;
const draftRow = async (w: World, id: string) =>
  (await w.db.select().from(drafts).where(eq(drafts.id, id)))[0]!;

/* ════════════════════════════════════════════════════════════════════════════════════════
   WHAT IT TAKES
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("runSendReconcilePass — the claim", () => {
  it("takes a reservation past the stale window and leaves a younger one alone", async () => {
    const w = await world();
    // Nine minutes: a live invocation could still own this, and probing it would be the exact
    // defect `SEND_STALE_AFTER_MS` was introduced against — marking a succeeding send ambiguous.
    const young = await stranded(w, { ageMs: 9 * MIN });
    const old = await stranded(w, { ageMs: 11 * MIN });
    const spy = spyAdapter(true);

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(r.claimed).toBe(1);
    expect(spy.probed).toEqual([old.minted]);
    expect((await sendRow(w, young.sendId)).status, "untouched").toBe("pending");
    expect((await sendRow(w, old.sendId)).status).toBe("sent");
  });

  it("takes NO predicate on the draft's status — the reservation is the subject", async () => {
    // A draft somebody already recovered by hand still leaves a `pending` row that nothing else
    // will ever resolve, and it pages the stuck-send alarm for ever. The reservation is closed;
    // the draft is left exactly as it stands, by the finalizer's own compare-and-swap.
    const w = await world();
    const s = await stranded(w, { draftStatus: "draft" });
    const spy = spyAdapter(false);

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(r.claimed).toBe(1);
    expect(r.unverified).toBe(1);
    expect((await sendRow(w, s.sendId)).status, "the reservation stops paging").toBe("unverified");
    expect((await draftRow(w, s.draftId)).status, "and the recovered draft is NOT dragged back")
      .toBe("draft");
  });

  it("the batch bounds LOGINS — five rows on five mailboxes cost three, oldest first", async () => {
    const w = await world();
    const ages = [40, 60, 20, 80, 30];
    const seeded: Array<{ sendId: string; minted: string }> = [];
    for (const m of ages) seeded.push(await stranded(await sibling(w), { ageMs: m * MIN }));
    const spy = spyAdapter(false);

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(SEND_RECONCILE_BATCH).toBe(3);
    expect(SEND_RECONCILE_SCAN_FACTOR).toBe(4);
    // EXAMINED: all five. The mirror arm is one indexed read, so there is no reason to make a
    // row wait a minute for it — and making rows wait is precisely the starvation below.
    expect(r.claimed).toBe(5);
    // DIALLED: three, and the three a person has been staring at longest — 80, 60, 40.
    expect(spy.opened).toHaveLength(3);
    expect(spy.probed).toEqual([seeded[3]!.minted, seeded[1]!.minted, seeded[0]!.minted]);
    // The two that did not get a login are left exactly as they were, for the next minute.
    expect(r.deferred).toBe(2);
    expect((await sendRow(w, seeded[2]!.sendId)).status).toBe("pending");
    expect((await sendRow(w, seeded[4]!.sendId)).status).toBe("pending");
  });

  it("…but five rows on ONE mailbox cost ONE login, and all five are resolved", async () => {
    // The budget counts CONNECTIONS, not intentions. Charging a slot per row would make the
    // module head's "N ids on one mailbox cost one LOGIN, not N" false and drain a mailbox with a
    // dozen strandings at three a minute over a socket it had already paid for.
    const w = await world();
    const seeded: Array<{ sendId: string }> = [];
    for (const m of [40, 60, 20, 80, 30]) seeded.push(await stranded(w, { ageMs: m * MIN }));
    const spy = spyAdapter(false);

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(spy.opened, "one mailbox, one login").toEqual([w.mailboxId]);
    expect(spy.probed, "and every row got its answer").toHaveLength(5);
    expect(r.unverified).toBe(5);
    expect(r.deferred).toBe(0);
  });

  it("a mailbox ALREADY OPEN is free once the budget is spent — the memo is the point", async () => {
    // The `!shared.has(...)` term, and it is only reachable past the budget: two rows on two
    // mailboxes spend it, and a third row on the FIRST mailbox needs no new connection. Charging
    // it a slot anyway would defer a row whose socket is already open and paid for — which is how
    // "N ids on one mailbox cost one LOGIN, not N" quietly stops being true.
    const w = await world();
    const a = await sibling(w);
    const b = await sibling(w);
    const first = await stranded(a, { ageMs: 90 * MIN });
    await stranded(b, { ageMs: 80 * MIN });
    const alsoOnA = await stranded(a, { ageMs: 70 * MIN });
    const spy = spyAdapter(false);

    const r = await run(w, { openSendAdapter: spy.factory, batch: 2 });

    expect(spy.opened, "two logins, and the budget is now spent").toEqual([a.mailboxId, b.mailboxId]);
    expect(spy.probed, "the third row rode the connection it already had").toHaveLength(3);
    expect(spy.probed).toContain(alsoOnA.minted);
    expect(r.unverified).toBe(3);
    expect(r.deferred, "nothing waited a minute for a socket that was already open").toBe(0);
    expect((await sendRow(w, first.sendId)).status).toBe("unverified");
    expect((await sendRow(w, alsoOnA.sendId)).status).toBe("unverified");
  });

  it("A FAILED CONNECT IS CHARGED — a broken mailbox cannot spend the whole window on logins", async () => {
    // The budget counted successes, so a connect that threw cost NOTHING. Nothing in this pass
    // ever demotes a mailbox (only the sync worker writes `error`), so a mailbox with a rotated
    // password stays `connected` and every one of its dialable rows would attempt a fresh login
    // every minute — the whole examination window instead of the batch. That is the "another
    // failed LOGIN is how a recoverable fault becomes a locked account" hazard, multiplied by the
    // scan factor, introduced by the change meant to remove head-of-line blocking.
    const w = await world();
    for (const m of [90, 85, 80, 75, 70]) await stranded(await sibling(w), { ageMs: m * MIN });
    let attempts = 0;
    const broken: OpenSendAdapter = async () => {
      attempts += 1;
      throw new Error("Invalid credentials (Failure)");
    };

    const r = await run(w, { openSendAdapter: broken });

    expect(r.claimed, "all five examined — the mirror arm is free").toBe(5);
    expect(attempts, "but only the login budget's worth of logins were attempted")
      .toBe(SEND_RECONCILE_BATCH);
    expect(r.deferred).toBe(5);
  });

  it("…while a refusal BEFORE the wire is free — admission is not a login", async () => {
    // The other side of the same line: a `TransientDialRefusal` is raised before any socket
    // exists, so charging it would let a busy mailbox exhaust a budget it never spent.
    const w = await world();
    for (const m of [90, 85, 80, 75]) await stranded(await sibling(w), { ageMs: m * MIN });
    let asked = 0;
    const { TransientDialRefusal } = await import("../src/index.js");
    const busy: OpenSendAdapter = async (mailboxId) => {
      asked += 1;
      throw new TransientDialRefusal(mailboxId, "at its connection ceiling");
    };

    const r = await run(w, { openSendAdapter: busy });

    expect(asked, "every row got its attempt; none was charged a login").toBe(4);
    expect(r.deferred).toBe(4);
    expect(r.unverified, "and none was closed on a refusal that never reached the wire").toBe(0);
  });

  it("a mailbox with NO CREDENTIALS costs no login either — that refusal is a SELECT", async () => {
    // The other pre-wire refusal. `makeSendAdapter` throws `ServiceError` after reading
    // `mailbox_credentials` and finding nothing — no socket, no LOGIN. Charging it would let a
    // mailbox that can never be dialled AT ALL drain the budget and defer every dialable row
    // behind it: the same head-of-line block, entered from the other side.
    const w = await world();
    const { ServiceError } = await import("../src/index.js");
    // Three OLDEST rows on mailboxes whose credentials are gone…
    for (const m of [95, 90, 85]) await stranded(await sibling(w), { ageMs: m * MIN });
    // …and one NEWER row on a mailbox that works.
    const healthy = await sibling(w);
    const reachable = await stranded(healthy, { ageMs: 15 * MIN });

    const spy = spyAdapter(true);
    let refused = 0;
    const routed: OpenSendAdapter = async (mailboxId) => {
      if (mailboxId === healthy.mailboxId) return spy.factory(mailboxId);
      refused += 1;
      throw new ServiceError("mailbox_not_signed_in", 424, "this mailbox is not signed in here, so nothing was fetched or sent — sign in again in Settings", undefined, false);
    };

    const r = await run(w, { openSendAdapter: routed });

    expect(refused, "all three credential-less mailboxes were tried").toBe(3);
    expect(spy.opened, "and the healthy mailbox still got its login").toEqual([healthy.mailboxId]);
    expect((await sendRow(w, reachable.sendId)).status).toBe("sent");
    expect(r.unverified, "the three that can never be dialled are decided, not deferred").toBe(3);
    expect(r.sent).toBe(1);
  });

  it("THE DEADLINE STOPS FURTHER SOCKET WORK, including on a connection already open", async () => {
    // Watched failing, which it could not be before: every other case here runs on a FROZEN
    // clock (`now: () => NOW`), so `now() - startedAt` was always 0 and this branch had never
    // once been reached. An advancing clock is the seam.
    //
    // The gate skipped the whole test for a memoised connection — right for the LOGIN budget,
    // since reusing a socket costs no login, and wrong for the clock. Twelve rows on one mailbox
    // is the case this module keeps citing, and twelve probes consulting no time bound is how the
    // invocation outlives its platform ceiling with its connections still held.
    const w = await world();
    for (const m of [90, 85, 80, 75, 70]) await stranded(w, { ageMs: m * MIN });
    const spy = spyAdapter(false);
    // Each probe "takes" eleven seconds of clock without taking any real time.
    let clock = NOW.getTime();
    const probed: string[] = [];
    const ticking: OpenSendAdapter = async (mailboxId) => {
      const real = await spy.factory(mailboxId);
      return {
        ...real,
        messageInSent: async (id: string) => {
          probed.push(id);
          clock += 11_000;
          return real.messageInSent(id);
        },
      };
    };

    const r = await run(w, { openSendAdapter: ticking, now: () => new Date(clock) });

    expect(SEND_RECONCILE_DIAL_DEADLINE_MS).toBe(12_000);
    // Three probes take the clock past twenty-five seconds; the rest are deferred rather than
    // run on the connection that is already open.
    expect(probed.length, "the deadline stopped further probing").toBeLessThanOrEqual(2);
    expect(r.claimed).toBe(5);
    expect(r.deferred).toBeGreaterThanOrEqual(2);
  });

  it("the invocation's worst case is DERIVED, and every constant that moves it is in the sum", async () => {
    // This guard exists because the previous version of it pinned a sum that was not the worst
    // case: it omitted `socketMs`, which is what actually bounds the LOGIN and the LIST inside a
    // dial — so `socketMs` could have been raised to a minute and the guard stayed green, which
    // is the exact opposite of the property it claims.
    expect(SEND_RECONCILE_NET_TIMEOUTS.connectionMs).toBeLessThan(15_000);
    expect(SEND_RECONCILE_NET_TIMEOUTS.greetingMs).toBeLessThan(15_000);
    expect(SEND_RECONCILE_NET_TIMEOUTS.socketMs).toBeLessThan(25_000);

    // A row that starts the instant before the deadline: its dial can spend connect, greeting and
    // one socket-inactivity window; then its probe ceiling; then the concurrent teardown, which is
    // one ceiling however many handles are held.
    const t = SEND_RECONCILE_NET_TIMEOUTS;
    const worst = SEND_RECONCILE_DIAL_DEADLINE_MS
      + t.connectionMs + t.greetingMs + t.socketMs
      + SEND_RECONCILE_CALL_CEILING_MS
      + SEND_RECONCILE_CLOSE_CEILING_MS;
    expect(worst, "the derived worst case must fit the 60-second invocation").toBeLessThan(60_000);
  });

  it("names the residual it does NOT bound, so nobody reads the sum above as a guarantee", async () => {
    // The honest half, and it is a test rather than a comment because the comment was wrong twice.
    // `SEND_RECONCILE_NET_TIMEOUTS` bounds connect, greeting and socket INACTIVITY. It does not
    // bound a command whose responses keep arriving: `ImapAdapter.connect()` issues a LIST, and
    // every command through the adapter carries a 180-second read deadline — three times this
    // whole invocation. A server that greets, accepts LOGIN, then dribbles its LIST is inside
    // every number in the sum above and outside the platform ceiling.
    //
    // That is ACCEPTED, deliberately, and this test is where the acceptance is written down: the
    // pass runs no caller-side race on the dial, because racing does not stop the command and a
    // ceiling below the adapter's own allowance makes every slow-but-working mailbox breach every
    // cycle. The cost is an invocation killed and admission slots returned by the stale-window
    // reclaim. The cost is NOT a wrong answer: nothing is written on that path.
    const { IMAP_READ_DEADLINE_MS } = await import("@trafficflow/core/adapters/imap");
    expect(
      IMAP_READ_DEADLINE_MS,
      "if this ever drops below the invocation ceiling the residual is gone and the comments "
      + "in send-reconcile-pass.ts that describe it must be rewritten",
    ).toBeGreaterThan(60_000);
  });

  it("a mailbox that does not answer in its deadline is charged and deferred", async () => {
    // What a deadline-honouring adapter actually does: it rejects. That is a fact about the
    // mailbox, so the row defers and the login is charged (the wire was touched).
    const w = await world();
    const s = await stranded(w);
    let attempts = 0;
    const timesOut: OpenSendAdapter = async () => {
      attempts += 1;
      throw new Error("Command failed: connection timeout");
    };

    const r = await run(w, { openSendAdapter: timesOut });

    expect(attempts).toBe(1);
    expect(r.deferred).toBe(1);
    expect((await sendRow(w, s.sendId)).status).toBe("pending");
  });

  it("a MIRROR-resolved row spends no login, so it cannot defer a dialable one behind it", async () => {
    // `dialled` used to be incremented at the gate, before `resolveStale` even looked at the
    // mirror. Three mirror-resolvable rows therefore burned the whole budget having opened zero
    // connections, and every dialable row behind them was deferred for nothing.
    const w = await world();
    const mirrored = [];
    for (const m of [90, 85, 80]) {
      const s = await stranded(await sibling(w), { ageMs: m * MIN });
      await mirror(w, s.minted);
      mirrored.push(s);
    }
    const needsDial = await stranded(await sibling(w), { ageMs: 12 * MIN });
    const spy = spyAdapter(true);

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(r.sent, "three from the mirror and one from the probe").toBe(4);
    expect(spy.opened, "only the row that actually needed a connection opened one")
      .toHaveLength(1);
    expect(spy.probed).toEqual([needsDial.minted]);
    for (const s of mirrored) expect((await sendRow(w, s.sendId)).status).toBe("sent");
    expect((await sendRow(w, needsDial.sendId)).status).toBe("sent");
  });

  it("A ROW THAT ONLY EVER DEFERS CANNOT STARVE THE ONES BEHIND IT", async () => {
    // THE HEAD-OF-LINE FAILURE, and it is not hypothetical: this claim writes nothing, so its
    // `SKIP LOCKED` is released the moment the short transaction commits. A row that defers is
    // left exactly as found and, being oldest, is re-selected every single minute. With a fixed
    // `LIMIT 3`, three mailboxes stuck in `error` would fill the window on every cycle until the
    // 24-hour give-up — and NO newer stranded reservation would be examined for a day, every
    // draft behind them reading "Sending…" the whole time.
    //
    // Three OLD rows on a mailbox stuck in `error`, and one NEWER reservation on a healthy
    // mailbox behind them — one database, one account, two mailboxes, because the pass selects
    // by age alone and the whole question is what the age ordering does to the younger row.
    const w = await world("error");
    const older = await Promise.all([90, 80, 70].map((m) => stranded(w, { ageMs: m * MIN })));
    const [healthy] = await w.db.insert(mailboxes).values({
      accountId: w.accountId, provider: "imap",
      address: `healthy-${randomUUID().slice(0, 8)}@rec.test`, status: "connected",
    }).returning();
    const behind = await stranded(
      { ...w, mailboxId: healthy!.id }, { ageMs: 12 * MIN },
    );
    const spy = spyAdapter(true);

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(r.claimed, "all four were examined").toBe(4);
    expect(
      spy.probed,
      "the three stuck rows ate the dial budget and the newer one was never reached",
    ).toEqual([behind.minted]);
    expect(r.sent).toBe(1);
    expect((await sendRow(w, behind.sendId)).status).toBe("sent");
    for (const o of older) {
      expect((await sendRow(w, o.sendId)).status, "and the stuck rows are untouched")
        .toBe("pending");
    }
    expect(spy.opened, "an `error` mailbox is still never dialled").toEqual([healthy!.id]);
  });

  it("`error` rows CANNOT fill the dialable window — they have their own", async () => {
    // The two-window split, at the boundary where it is the only thing that helps. With one
    // window the oldest rows fill it whatever they are, so a mailbox stuck in `error` with more
    // strandings than the window holds starves every other account for a full day. Driven at a
    // small batch so the boundary is reachable: `batch: 1` ⇒ a dialable window of FOUR and an
    // `error` window of FOUR, against five old `error` rows and one newer healthy reservation.
    // With ONE window those five older rows fill its four slots and the healthy row is never
    // reached; with two, it is claimed on the dialable window's own first slot.
    const w = await world("error");
    for (const m of [95, 90, 85, 80, 75]) await stranded(w, { ageMs: m * MIN });
    const healthy = await sibling(w, "connected");
    const behind = await stranded(healthy, { ageMs: 12 * MIN });
    const spy = spyAdapter(true);

    const r = await run(w, { openSendAdapter: spy.factory, batch: 1 });

    expect(
      spy.probed,
      "with one window the five older error rows fill it and this row is never reached",
    ).toEqual([behind.minted]);
    expect(r.sent).toBe(1);
    expect((await sendRow(w, behind.sendId)).status).toBe("sent");
    expect(r.claimed, "the one dialable row, plus four of the five from the error window")
      .toBe(5);
  });

  it("reports nothing to do without opening a connection", async () => {
    const w = await world();
    const spy = spyAdapter(true);
    const r = await run(w, { openSendAdapter: spy.factory });
    expect(r).toEqual({
      claimed: 0, sent: 0, unverified: 0, deferred: 0, resolvedElsewhere: 0, gaveUp: 0,
      rechecked: 0, recheckedSent: 0, forgotten: 0,
    });
    expect(spy.opened).toEqual([]);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   THE TWO ARMS
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("runSendReconcilePass — mirror first, then the probe", () => {
  it("resolves from the account's own mirror WITHOUT dialling", async () => {
    const w = await world();
    const s = await stranded(w);
    await mirror(w, s.minted);
    const spy = spyAdapter(false);

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(spy.opened, "the mirror already knew — a LOGIN would have been pure cost").toEqual([]);
    expect(r.sent).toBe(1);
    const row = await sendRow(w, s.sendId);
    expect(row.status).toBe("sent");
    expect(row.providerMessageId).toBe(s.minted);
    expect((await draftRow(w, s.draftId)).status).toBe("sent");
  });

  it("A MIRROR MISS SAYS NOTHING — it falls through to the probe, which finds the message", async () => {
    // THE DEFECT THIS GUARDS: the mirror lags the mailbox by up to a poll interval, so "not in
    // the mirror" and "not sent" are indistinguishable there. A pass that read a miss as an
    // answer would mark delivered mail `unverified` and send the reader to look for a message
    // that is already in their Sent folder.
    const w = await world();
    const s = await stranded(w);
    const spy = spyAdapter(true);

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(spy.probed, "the miss was not taken as an answer").toEqual([s.minted]);
    expect(r.sent).toBe(1);
    expect(r.unverified).toBe(0);
    expect((await sendRow(w, s.sendId)).status).toBe("sent");
  });

  it("writes `unverified` only when the ADAPTER says the Sent folder does not hold it", async () => {
    const w = await world();
    const s = await stranded(w);
    const spy = spyAdapter(false);

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(r.unverified).toBe(1);
    expect(r.gaveUp, "decided by evidence, not by the clock").toBe(0);
    expect((await sendRow(w, s.sendId)).status).toBe("unverified");
    expect((await draftRow(w, s.draftId)).status).toBe("unverified");
  });

  it("emits ONE `draft` change per resolved row, so the client learns from /sync", async () => {
    const w = await world();
    const s = await stranded(w);
    const spy = spyAdapter(true);

    await run(w, { openSendAdapter: spy.factory });

    const changes = (await w.db.select().from(changeLog))
      .filter((c) => c.entityId === s.draftId);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.entityType).toBe("draft");
  });

  it("opens ONE connection for two rows on one mailbox, and closes it once", async () => {
    const w = await world();
    await stranded(w, { ageMs: 20 * MIN });
    await stranded(w, { ageMs: 30 * MIN });
    const spy = spyAdapter(false);

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(r.claimed).toBe(2);
    expect(spy.probed, "both ids were probed").toHaveLength(2);
    expect(spy.opened, "on ONE login — the per-row close must not tear the batch down")
      .toEqual([w.mailboxId]);
    expect(spy.closed, "and the connection is not leaked").toBe(1);
  });

  it("FORGETS A CONNECTION THAT FAILED, so the rows behind it re-dial instead of inheriting it", async () => {
    // Without this the memo is a liability rather than a saving: one dead socket would fail every
    // remaining row on that mailbox. And it is not a harmless defer for a row past the give-up —
    // that row is then resolved with no adapter at all, so it would be written terminal
    // `unverified` off ONE connection failure, never having had an answer from the server, when a
    // fresh dial would very likely have said `sent`.
    const w = await world();
    await stranded(w, { ageMs: 30 * MIN });
    const second = await stranded(w, { ageMs: 20 * MIN });
    let call = 0;
    const spy = spyAdapter(() => {
      call += 1;
      if (call === 1) throw new Error("connection reset by peer");
      return true;
    });

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(spy.opened, "the second row got its OWN connection").toHaveLength(2);
    expect(spy.closed, "and the dead one was closed rather than leaked").toBe(2);
    expect(r.deferred).toBe(1);
    expect(r.sent).toBe(1);
    expect((await sendRow(w, second.sendId)).status).toBe("sent");
  });

  it("defers a probe that THROWS and leaves the row exactly as found", async () => {
    const w = await world();
    const s = await stranded(w);
    const spy = spyAdapter(() => { throw new Error("connection reset by peer"); });

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(r.deferred).toBe(1);
    expect(r.unverified, "a terminal state off a failed connection is the ambiguity we avoid")
      .toBe(0);
    expect((await sendRow(w, s.sendId)).status).toBe("pending");
    expect((await draftRow(w, s.draftId)).status).toBe("sending");
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   THE DIAL GATE
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("runSendReconcilePass — which mailboxes it will dial", () => {
  it("a `disabled` mailbox is decided WITHOUT a dial — there is nothing to call", async () => {
    const w = await world("disabled");
    const s = await stranded(w);
    const spy = spyAdapter(true);

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(spy.opened).toEqual([]);
    expect(r.unverified).toBe(1);
    expect((await sendRow(w, s.sendId)).status).toBe("unverified");
  });

  it("an `error` mailbox is NEVER dialled — a probe would add another failed LOGIN", async () => {
    const w = await world("error");
    const s = await stranded(w);
    const spy = spyAdapter(true);

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(spy.opened, "dialling a failing mailbox is how it becomes a locked one").toEqual([]);
    expect(r.deferred).toBe(1);
    expect((await sendRow(w, s.sendId)).status, "it waits for the mailbox to come back")
      .toBe("pending");
  });

  it("but the MIRROR arm still runs for an undialable mailbox", async () => {
    // A disconnected mailbox does not un-send the mail that already left it. The mirror is our
    // own database and costs no socket, so a row it can answer is answered.
    const w = await world("error");
    const s = await stranded(w);
    await mirror(w, s.minted);
    const spy = spyAdapter(true);

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(spy.opened).toEqual([]);
    expect(r.sent).toBe(1);
    expect((await sendRow(w, s.sendId)).status).toBe("sent");
  });

  it("a parked account is not dialled either, and its rows do not starve the batch", async () => {
    const w = await world();
    const parked = await stranded(w, { ageMs: 90 * MIN });
    const spy = spyAdapter(true);

    const r = await run(w, {
      openSendAdapter: spy.factory,
      accountEligible: async () => false,
    });

    // EXAMINED — which is the difference from excluding it at the claim. An excluded row is the
    // oldest candidate for ever, so it would fill this window every minute and everything behind
    // it would never be looked at.
    expect(r.claimed).toBe(1);
    expect(spy.opened, "a suspended account's credentials open no socket").toEqual([]);
    expect(r.deferred).toBe(1);
    expect((await sendRow(w, parked.sendId)).status).toBe("pending");
  });

  it("an ABSENT eligibility gate means eligible — the standalone door has no suspensions", async () => {
    const w = await world();
    await stranded(w);
    const spy = spyAdapter(true);
    const r = await run(w, { openSendAdapter: spy.factory });
    expect(spy.opened).toEqual([w.mailboxId]);
    expect(r.sent).toBe(1);
  });

  it("A BUSY MAILBOX IS DEFERRED, NOT CLOSED — a transient refusal is not evidence", async () => {
    // THE DEFECT THIS EXISTS FOR, found by re-reading the diff rather than by any mutation.
    // The hosted route wraps its factory in the per-mailbox IMAP admission counter, whose cap is
    // TWO and whose slots the attachment path holds. A refusal there was thrown as a
    // `ServiceError`, and `resolveStale` reads any `ServiceError` from a factory as "this mailbox
    // can never be dialled again" and writes a TERMINAL `unverified` — so a reservation for a
    // merely BUSY mailbox was closed as unconfirmed WITHOUT THE SENT FOLDER EVER BEING READ, and
    // terminal means no later cycle would ever read it. The person is told to go and check for a
    // message that is most likely sitting in their Sent folder.
    //
    // No mutation of mine modelled it because every test here injects a factory directly, so the
    // admission wrapper was not on the path at all.
    const w = await world();
    const s = await stranded(w);
    const { TransientDialRefusal } = await import("../src/index.js");
    const busy: OpenSendAdapter = async (mailboxId) => {
      throw new TransientDialRefusal(mailboxId, "at its connection ceiling");
    };

    const r = await run(w, { openSendAdapter: busy });

    expect(r.deferred, "a busy mailbox waits for a slot").toBe(1);
    expect(r.unverified, "and is NEVER closed as unconfirmed on that basis").toBe(0);
    expect((await sendRow(w, s.sendId)).status).toBe("pending");
    expect((await draftRow(w, s.draftId)).status).toBe("sending");
  });

  it("but a transient refusal PAST THE GIVE-UP still closes — patience is bounded", async () => {
    const w = await world();
    const s = await stranded(w, { ageMs: SEND_RECONCILE_GIVE_UP_MS + MIN });
    const { TransientDialRefusal } = await import("../src/index.js");
    const busy: OpenSendAdapter = async (mailboxId) => {
      throw new TransientDialRefusal(mailboxId, "at its connection ceiling");
    };

    const r = await run(w, { openSendAdapter: busy });

    expect(r.gaveUp).toBe(1);
    expect((await sendRow(w, s.sendId)).status).toBe("unverified");
  });

  it("a factory that REFUSES resolves the row rather than leaving it to page for ever", async () => {
    // A mailbox whose credential rows are gone can never be dialled again, so no later cycle can
    // decide this row. `unverified` is the honest terminal answer; `pending` would be permanent.
    const w = await world();
    const s = await stranded(w);
    const { ServiceError } = await import("../src/index.js");
    const refusing: OpenSendAdapter = async () => {
      throw new ServiceError("mailbox_not_signed_in", 424, "this mailbox is not signed in here, so nothing was fetched or sent — sign in again in Settings", undefined, false);
    };

    const r = await run(w, { openSendAdapter: refusing });

    expect(r.unverified).toBe(1);
    expect((await sendRow(w, s.sendId)).status).toBe("unverified");
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   THE GIVE-UP
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("runSendReconcilePass — the day-long give-up", () => {
  it("closes an undecidable row past 24 h as `unverified`, and says so", async () => {
    const w = await world("error");
    const s = await stranded(w, { ageMs: SEND_RECONCILE_GIVE_UP_MS + MIN });
    const spy = spyAdapter(true);
    const lines: string[] = [];

    const r = await run(w, {
      openSendAdapter: spy.factory,
      log: createLogger({ service: "t", sink: (l) => lines.push(l) }),
    });

    expect(spy.opened, "still no dial — the give-up is a decision about time, not a last try")
      .toEqual([]);
    expect(r.unverified).toBe(1);
    expect(r.gaveUp).toBe(1);
    expect((await sendRow(w, s.sendId)).status).toBe("unverified");
    expect(lines.find((l) => l.includes("send_reconcile_gave_up"))).toBeDefined();
  });

  it("a row ONE MINUTE inside the window is still deferred", async () => {
    const w = await world("error");
    const s = await stranded(w, { ageMs: SEND_RECONCILE_GIVE_UP_MS - MIN });
    const spy = spyAdapter(true);
    const r = await run(w, { openSendAdapter: spy.factory });
    expect(r.deferred).toBe(1);
    expect(r.gaveUp).toBe(0);
    expect((await sendRow(w, s.sendId)).status).toBe("pending");
  });

  it("gives up on a probe that keeps throwing, after a day of it", async () => {
    const w = await world();
    const s = await stranded(w, { ageMs: SEND_RECONCILE_GIVE_UP_MS + MIN });
    const spy = spyAdapter(() => { throw new Error("ETIMEDOUT"); });

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(spy.probed, "it did try").toHaveLength(1);
    expect(r.gaveUp).toBe(1);
    expect((await sendRow(w, s.sendId)).status).toBe("unverified");
  });

  it("A WRITE THAT FAILED AFTER THE PROBE ANSWERED NEVER GIVES UP, however old the row", async () => {
    // The give-up re-resolves mirror-only. For a row past the day, a probe that answered
    // `true` followed by a finalize that threw would therefore have its answer thrown away and
    // the OPPOSITE recorded: terminal `unverified` for a message the Sent folder held
    // milliseconds earlier, with nothing ever re-examining it. The database is what failed.
    const w = await world();
    const s = await stranded(w, { ageMs: SEND_RECONCILE_GIVE_UP_MS + 5 * MIN });
    const spy = spyAdapter(true);
    const { SettleFailed } = await import("../src/index.js");
    // The probe answered `sent` and the finalize transaction threw — so nothing was written and
    // the row is still `pending`. Modelled at the seam rather than by letting the real service
    // write first, which would leave the row `sent` and prove nothing.
    //
    // ONLY THE PROBING CALL FAILS. The give-up's re-resolution (`open === null`) is delegated to
    // the real service, so if the pass wrongly applies the give-up here the row IS written
    // `unverified` and this test sees it. A stub that threw on both calls would defer either way
    // and could not tell the fix from the defect — which is how it first passed under the
    // mutation.
    const { sendService } = await import("../src/index.js");
    const brittle = {
      resolveStale: async (...args: Parameters<typeof sendService.resolveStale>) => {
        const [, , mailboxId, open] = args;
        if (open === null) return sendService.resolveStale(...args);
        await (await open(mailboxId)).messageInSent("x");
        throw new SettleFailed("sent", new Error("deadlock detected"));
      },
    } as never;

    const r = await run(w, { openSendAdapter: spy.factory, sends: brittle });

    expect(r.gaveUp, "the clock must not overrule an answer the server gave").toBe(0);
    expect(r.unverified).toBe(0);
    expect(r.deferred).toBe(1);
    expect((await sendRow(w, s.sendId)).status, "left for the next cycle to re-probe")
      .toBe("pending");
  });

  it("KEEPS the connection when only the WRITE failed, and says so on its own event", async () => {
    // `forget()` used to run before the `SettleFailed` test, so a database fault tore down a
    // socket the mailbox had just answered on — and the rows behind it re-dialled and re-logged-in
    // for a fault the mailbox had no part in, spending the login budget and deferring everything
    // else. The connection is known GOOD in that branch; it is the database that is not.
    const w = await world();
    await stranded(w, { ageMs: 40 * MIN });
    await stranded(w, { ageMs: 30 * MIN });
    const spy = spyAdapter(true);
    const lines: string[] = [];
    const { sendService, SettleFailed } = await import("../src/index.js");
    let calls = 0;
    const brittle = {
      resolveStale: async (...args: Parameters<typeof sendService.resolveStale>) => {
        const [, , mailboxId, open] = args;
        calls += 1;
        if (open) await (await open(mailboxId)).messageInSent("x");
        // The FIRST row's write fails; the second is fine.
        if (calls === 1) throw new SettleFailed("sent", new Error("could not serialize access"));
        return sendService.resolveStale(...args);
      },
    } as never;

    const r = await run(w, {
      openSendAdapter: spy.factory, sends: brittle,
      log: createLogger({ service: "t", sink: (l) => lines.push(l) }),
    });

    expect(spy.opened, "ONE login — the healthy socket was kept for the row behind it")
      .toEqual([w.mailboxId]);
    expect(r.deferred).toBe(1);
    const line = lines.find((l) => l.includes("send_reconcile_settle_failed"));
    expect(line, `no distinct event: ${lines.join("\n")}`).toBeDefined();
    expect(line, "at error level — a settle that fails deterministically leaves rows pending "
      + "for ever with gaveUp:0, which reads exactly like a healthy pass").toContain('"level":"error"');
    expect(line).not.toContain("droppedFields");
  });

  it("…and tags the CAS-LOSER's re-read too, which sits after the write", async () => {
    // `answerWinner` runs when the compare-and-swap matched nothing — somebody else resolved the
    // row while we probed. It is part of SETTLING, so a pool fault there is still "the mailbox
    // answered and the database could not record it". Left outside the tagged block it escaped
    // untagged, and for a row past the give-up the pass would then take its mirror-only path.
    //
    // The mirror answers, the row is already terminal so the CAS loses, and the SECOND read —
    // `answerWinner`'s — is the one that fails.
    const w = await world();
    const s = await stranded(w);
    await mirror(w, s.minted);
    await w.db.update(outboundSends).set({ status: "unverified" })
      .where(eq(outboundSends.id, s.sendId));
    const { sendService, SettleFailed } = await import("../src/index.js");
    const [row] = await w.db.select().from(outboundSends).where(eq(outboundSends.id, s.sendId));
    let selects = 0;
    const failsOnReRead = new Proxy(w.db as object, {
      get(t, k, r) {
        if (k === "select") {
          return (...args: unknown[]) => {
            selects += 1;
            // 1 = the mirror arm; 2 = answerWinner, after the CAS has already lost.
            if (selects >= 2) throw new Error("remaining connection slots are reserved");
            return (Reflect.get(t, k, r) as (...a: unknown[]) => unknown).apply(t, args);
          };
        }
        return Reflect.get(t, k, r);
      },
    });

    await expect(sendService.resolveStale(
      { db: failsOnReRead as never, accountId: w.accountId, userId: null, now: () => NOW, requestId: "t" },
      { ...row!, status: "pending" }, w.mailboxId, null, "unverified",
    )).rejects.toBeInstanceOf(SettleFailed);
    expect(selects, "the re-read was reached").toBeGreaterThanOrEqual(2);
  });

  it("a REJECTING close cannot swallow the tag — the `finally` must not replace the throw", async () => {
    // `finally { await adapter.close(); }` REPLACES whatever the try produced. So a close that
    // rejects on an already-broken socket threw away the `SettleFailed` the pass uses to decide
    // never to give up — and on the client door, where this is a real connection rather than the
    // pass's no-op wrapper, it turned a send just committed as `sent` into a 500.
    const w = await world();
    const s = await stranded(w);
    const { sendService, SettleFailed } = await import("../src/index.js");
    const [row] = await w.db.select().from(outboundSends).where(eq(outboundSends.id, s.sendId));
    const noCommit = new Proxy(w.db as object, {
      get(t, k, r) {
        if (k === "transaction") {
          return async () => { throw new Error("could not serialize access"); };
        }
        return Reflect.get(t, k, r);
      },
    });
    const rejectsOnClose: OpenSendAdapter = async () => ({
      send: () => { throw new Error("never"); },
      messageInSent: async () => true,
      close: async () => { throw new Error("socket already destroyed"); },
    });

    await expect(sendService.resolveStale(
      { db: noCommit as never, accountId: w.accountId, userId: null, now: () => NOW, requestId: "t" },
      row!, w.mailboxId, rejectsOnClose, "unverified",
    )).rejects.toBeInstanceOf(SettleFailed);
  });

  it("resolveStale TAGS a write failure, which is what makes the rule above enforceable", async () => {
    // The pass distinguishes "the probe failed" from "the write failed" by the error's CLASS, so
    // the tagging is the load-bearing half and it is asserted against the real service here — the
    // stub above proves the pass's branch, not that anything ever throws a `SettleFailed`.
    //
    // The mirror answers, so `settleSent` runs; the handle lets the mirror read through and
    // refuses the finalize transaction, which is exactly a database that cannot commit.
    const w = await world();
    const s = await stranded(w);
    await mirror(w, s.minted);
    const { sendService, SettleFailed } = await import("../src/index.js");
    const [row] = await w.db.select().from(outboundSends).where(eq(outboundSends.id, s.sendId));
    const noCommit = new Proxy(w.db as object, {
      get(t, k, r) {
        if (k === "transaction") {
          return async () => { throw new Error("could not serialize access"); };
        }
        return Reflect.get(t, k, r);
      },
    });

    await expect(sendService.resolveStale(
      { db: noCommit as never, accountId: w.accountId, userId: null, now: () => NOW, requestId: "t" },
      row!, w.mailboxId, null, "unverified",
    )).rejects.toBeInstanceOf(SettleFailed);
  });

  it("a row PAST THE DAY that the budget never got to is closed, not deferred for ever", async () => {
    // `outOfBudget` used to be excluded from the give-up, on the reasoning that closing a row we
    // never probed is unfair. A day of never getting to it is not a near miss: it is the same
    // permanent "Sending…" by another route, and the ruling's rule is undecidable-past-24h rather
    // than probed-and-undecided. Driven at `batch: 1` so the second row is provably the one the
    // budget could not reach.
    const w = await world();
    const first = await stranded(await sibling(w), { ageMs: SEND_RECONCILE_GIVE_UP_MS + 9 * MIN });
    const never = await stranded(await sibling(w), { ageMs: SEND_RECONCILE_GIVE_UP_MS + 8 * MIN });
    const spy = spyAdapter(false);

    const r = await run(w, { openSendAdapter: spy.factory, batch: 1 });

    expect(spy.opened, "one login — the budget").toHaveLength(1);
    // The first was decided by EVIDENCE (its probe answered "not in Sent"), so it is not a
    // give-up. The second is: a day passed and this pass never got to it.
    expect(r.gaveUp).toBe(1);
    expect(r.unverified, "both end terminal — neither is left pending").toBe(2);
    expect((await sendRow(w, first.sendId)).status).toBe("unverified");
    expect(
      (await sendRow(w, never.sendId)).status,
      "the row the budget never reached was left pending for ever",
    ).toBe("unverified");
  });

  it("an OLD `disabled` mailbox is not a give-up — it was knowable on the first cycle", async () => {
    // `gaveUp` is the loudest counter this pass reports and it has to mean one thing: a day of
    // cycles could not decide this row. A disconnected mailbox is decided immediately, whatever
    // the row's age — so counting it here would turn "we waited a day and gave up" into "this
    // row is old", which is a different and much less interesting statement.
    const w = await world("disabled");
    const s = await stranded(w, { ageMs: SEND_RECONCILE_GIVE_UP_MS + 5 * MIN });
    const r = await run(w, { openSendAdapter: spyAdapter(true).factory });
    expect(r.unverified).toBe(1);
    expect(r.gaveUp, "decided by the mailbox, not by the clock").toBe(0);
    expect((await sendRow(w, s.sendId)).status).toBe("unverified");
  });

  it("A FAULT IN THE GIVE-UP ITSELF COSTS ONE ROW, NOT THE PASS", async () => {
    // The give-up re-resolution runs inside a `catch`, which is outside the per-row `try`. An
    // uncaught fault there — a transaction error, a pool timeout — escapes the loop and aborts
    // `runSendReconcilePass`, so the hosted route answers 503 and EVERY remaining row in the
    // batch is skipped. That contradicts this function's own contract: one undecidable
    // reservation must never stop the others.
    const w = await world();
    const doomed = await stranded(w, { ageMs: SEND_RECONCILE_GIVE_UP_MS + 5 * MIN });
    const ordinary = await stranded(w, { ageMs: 12 * MIN });
    const spy = spyAdapter(() => { throw new Error("ETIMEDOUT"); });
    let resolves = 0;

    // The real service, with only the give-up's second call made to fail.
    const { sendService } = await import("../src/index.js");
    const brittle = {
      resolveStale: async (...args: Parameters<typeof sendService.resolveStale>) => {
        resolves += 1;
        // 1: the doomed row's probe (throws inside resolveStale via the adapter)
        // 2: the doomed row's give-up re-resolution — the one under test
        if (resolves === 2) throw new Error("pool timeout during the give-up write");
        return sendService.resolveStale(...args);
      },
    } as never;

    const r = await run(w, { openSendAdapter: spy.factory, sends: brittle });

    expect(r.claimed).toBe(2);
    expect(r.deferred, "the doomed row is counted, not thrown").toBeGreaterThanOrEqual(1);
    expect((await sendRow(w, doomed.sendId)).status, "and left exactly as found").toBe("pending");
    // THE POINT: the row behind it was still examined.
    expect((await sendRow(w, ordinary.sendId)).status).toBe("pending");
    expect(resolves, "the pass carried on to the next row").toBeGreaterThanOrEqual(3);
  });

  it("a mailbox that never answers IS given up on after a day — the bound must stay reachable", async () => {
    // The previous round exempted every timeout from the give-up, and that removed the bound
    // entirely for the likeliest permanent shape: a mailbox whose status stays `connected`
    // because nothing here demotes it, timing out on every cycle for ever. "Sending…" for ever
    // is the state this whole module exists to end, so a mailbox's own failure to answer must
    // remain something the day-long deadline can act on.
    const w = await world();
    const s = await stranded(w, { ageMs: SEND_RECONCILE_GIVE_UP_MS + 5 * MIN });
    const timesOut: OpenSendAdapter = async () => { throw new Error("connection timeout"); };

    const r = await run(w, { openSendAdapter: timesOut });

    expect(r.gaveUp).toBe(1);
    expect((await sendRow(w, s.sendId)).status).toBe("unverified");
  });

  it("our own probe ceiling defers a FRESH row — a breach is not evidence about the mailbox", async () => {
    const w = await world();
    const s = await stranded(w, { ageMs: 30 * MIN });
    const lines: string[] = [];
    const hangsOnProbe: OpenSendAdapter = async () => ({
      send: () => { throw new Error("never"); },
      messageInSent: () => new Promise<boolean>(() => { /* trickles for ever */ }),
      close: async () => { /* fine */ },
      forceClose: () => { /* destroyed */ },
    });

    const r = await run(w, {
      openSendAdapter: hangsOnProbe,
      log: createLogger({ service: "t", sink: (l) => lines.push(l) }),
    });

    expect(r.gaveUp).toBe(0);
    expect(r.deferred).toBe(1);
    expect((await sendRow(w, s.sendId)).status).toBe("pending");
    expect(lines.find((l) => l.includes("send_reconcile_timed_out"))).toBeDefined();
  }, 40_000);

  it("…but PAST THE DAY it gives up like anything else undecidable", async () => {
    // Exempting our own ceiling from the give-up outright was a defect, not a kindness: a mailbox
    // whose Sent SEARCH is simply slower than ten seconds would breach every cycle for ever, and
    // the draft would read "Sending…" for ever with `gaveUp: 0` while the mailbox was charged a
    // fresh login every minute. The deadline's rule is UNDECIDABLE-past-a-day, not
    // probed-and-undecided.
    const w = await world();
    const s = await stranded(w, { ageMs: SEND_RECONCILE_GIVE_UP_MS + 5 * MIN });
    const hangsOnProbe: OpenSendAdapter = async () => ({
      send: () => { throw new Error("never"); },
      messageInSent: () => new Promise<boolean>(() => { /* trickles for ever */ }),
      close: async () => { /* fine */ },
      forceClose: () => { /* destroyed */ },
    });

    const r = await run(w, { openSendAdapter: hangsOnProbe });

    expect(r.gaveUp).toBe(1);
    expect((await sendRow(w, s.sendId)).status).toBe("unverified");
  }, 40_000);

  it("DROPS a hung handle from the memo, so the rows behind it do not queue on a dead SEARCH", async () => {
    // The ceiling branch `continue`d without dropping the handle, and that made the ceiling
    // actively harmful: the abandoned SEARCH still owns imapflow's command queue, so rows 2..N
    // on that mailbox reused it, each burning the full ceiling for a command that can never
    // answer — and none of them charged a login, because the connection was "already open".
    const w = await world();
    await stranded(w, { ageMs: 40 * MIN });
    const second = await stranded(w, { ageMs: 30 * MIN });
    let opened = 0;
    let forced = 0;
    let probes = 0;
    const hangsOnce: OpenSendAdapter = async () => {
      const mine = ++opened;
      return {
        send: () => { throw new Error("never"); },
        messageInSent: async () => {
          probes += 1;
          // The FIRST connection's search never answers; a fresh one works.
          if (mine === 1) return new Promise<boolean>(() => { /* hangs */ });
          return true;
        },
        close: async () => { /* fine */ },
        forceClose: () => { forced += 1; },
      };
    };

    // DRIVEN CLOCK, not the wall clock. The pass's deadline is real time, so a fixture that
    // relies on the second row starting before it is racing the machine — `startedAt` is captured
    // before the claim, and any slow database setup defers the row and fails the assertion as
    // `opened === 1`. The seam exists; this uses it, and only advances for the probe that hangs.
    let clock = NOW.getTime();
    const r = await run(w, { openSendAdapter: hangsOnce, now: () => new Date(clock) });

    expect(clock, "the driven clock never advanced past the deadline")
      .toBeLessThan(NOW.getTime() + SEND_RECONCILE_DIAL_DEADLINE_MS);
    expect(forced, "the hung socket was destroyed").toBeGreaterThanOrEqual(1);
    expect(opened, "and the row behind it got a FRESH connection, not the dead one").toBe(2);
    expect(probes).toBe(2);
    expect(r.deferred).toBe(1);
    expect(r.sent).toBe(1);
    expect((await sendRow(w, second.sendId)).status).toBe("sent");
  }, 40_000);

  it("ABANDONS a hung handle rather than awaiting its LOGOUT, which queues behind the hang", async () => {
    // `ImapAdapter.forceClose`'s docblock names this caller's mistake exactly: imapflow
    // serialises commands, so a graceful LOGOUT queues BEHIND whatever is hung, and "a caller
    // abandoning a timed-out operation that then awaited close would wait exactly as long as the
    // hang it was escaping". A polite close here costs the ceiling PLUS the socket timeout, per
    // row — which is how the ceiling buys nothing at all.
    const w = await world();
    await stranded(w, { ageMs: 30 * MIN });
    let forced = 0;
    const hangingClose: OpenSendAdapter = async () => ({
      send: () => { throw new Error("never"); },
      messageInSent: () => new Promise(() => { /* hangs */ }),
      close: () => new Promise(() => { /* a LOGOUT queued behind the hung SEARCH */ }),
      forceClose: () => { forced += 1; },
    });

    // The ceiling on a FAKE clock, stepped a second at a time over an in-memory store: the pass
    // meets its ten-second ceiling at its real size and nothing sleeps. A polite close would hang
    // the pass past every step, and the stepping would run out below.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const started = Date.now();
      let done = false;
      const pass = run(w, { openSendAdapter: hangingClose }).finally(() => { done = true; });
      for (let at = 0; !done && at < 60_000; at += 1_000) await vi.advanceTimersByTimeAsync(1_000);
      const r = await pass;

      expect(forced, "the socket was destroyed, not politely asked").toBeGreaterThanOrEqual(1);
      expect(Date.now() - started, "and the pass did not wait out the hang it had just escaped")
        .toBeLessThan(SEND_RECONCILE_CALL_CEILING_MS * 2 + 5_000);
      expect(r.deferred).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  }, 40_000);

  it("age never overrides EVIDENCE — a 30-day row the mirror can answer is `sent`", async () => {
    const w = await world();
    const s = await stranded(w, { ageMs: 30 * 24 * 60 * MIN });
    await mirror(w, s.minted);
    const r = await run(w, { openSendAdapter: spyAdapter(false).factory });
    expect(r.sent).toBe(1);
    expect(r.gaveUp).toBe(0);
    expect((await sendRow(w, s.sendId)).status).toBe("sent");
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   INVARIANT #2 — NOTHING HERE CAN SEND
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("runSendReconcilePass — no envelope can leave", () => {
  it("never calls `send`, whatever the outcome", async () => {
    for (const [inSent, status] of [[true, "sent"], [false, "unverified"]] as const) {
      const w = await world();
      const s = await stranded(w);
      const spy = spyAdapter(inSent);
      await run(w, { openSendAdapter: spy.factory });
      expect(spy.delivered, `${status}: an envelope was offered`).toEqual([]);
      expect((await sendRow(w, s.sendId)).status).toBe(status);
    }
  });

  it("a reservation that VANISHES mid-probe is not re-created, and nothing is offered", async () => {
    // The shape that would bite a resolver built on `reserve` instead of on the finalizers: a
    // conflict replay whose row is gone INSERTs a fresh reservation and sends — which is how a
    // recovery pass turns into a second delivery. This pass never enters `reserve`, so the write
    // simply matches nothing. Asserted rather than argued, because "we do not call that function"
    // is exactly the kind of claim that stops being true in a later edit.
    const w = await world();
    const s = await stranded(w);
    const spy = spyAdapter(async () => {
      await w.db.delete(outboundSends).where(eq(outboundSends.id, s.sendId));
      return true;
    });

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(spy.delivered, "AN ENVELOPE LEFT").toEqual([]);
    expect(r.sent).toBe(0);
    expect(await w.db.select().from(outboundSends), "no reservation was re-created").toEqual([]);
    expect((await draftRow(w, s.draftId)).status, "and the draft was not flipped by a lost write")
      .toBe("sending");
  });

  it("THE ADAPTER IT PROBES THROUGH CANNOT SEND — `send` throws on the handle itself", async () => {
    // The structural half of the guarantee. The assertion above says this pass does not reach for
    // `send` today; this one says a future edit that DID would fail loudly rather than quietly
    // putting a second copy of somebody's message on the wire.
    const w = await world();
    await stranded(w);
    const spy = spyAdapter(false);
    let handed: SendAdapter | null = null;

    await run(w, {
      openSendAdapter: async (mailboxId) => {
        const real = await spy.factory(mailboxId);
        return new Proxy(real, {
          get(t, k, r) { return Reflect.get(t, k, r); },
        });
      },
      sends: {
        resolveStale: async (_ctx, _row, mailboxId, open) => {
          handed = open ? await open(mailboxId) : null;
          return { status: "unverified", providerMessageId: null, draftId: "d", seq: 1, by: "probe" };
        },
      } as never,
    });

    expect(handed, "the pass handed an adapter over").not.toBeNull();
    expect(() => handed!.send({} as OutboundMessage)).toThrow(/may never submit/);
    expect(spy.delivered).toEqual([]);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   THE LOG LINE (risk 3 — a census that silently drops the fields)
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("runSendReconcilePass — the summary an operator reads", () => {
  it("every counter survives the REAL logger's field census", async () => {
    // Drives `createLogger`, not a fake. A test with an injected logger asserts what the call
    // site HANDS OVER and never what the allowlist lets through — this repository has shipped
    // that exact blindness four times, so the census is driven rather than assumed.
    const lines: string[] = [];
    const log = createLogger({ service: "send-reconcile", sink: (l) => lines.push(l) });
    const w = await world();
    const s = await stranded(w);
    const spy = spyAdapter(true);

    await run(w, { openSendAdapter: spy.factory, log });
    const result = {
      claimed: 1, sent: 1, unverified: 0, deferred: 0, resolvedElsewhere: 0, gaveUp: 0,
    };
    log.info("send_reconcile_pass", { ...result });

    const summary = lines.find((l) => l.includes("send_reconcile_pass"));
    expect(summary, lines.join("\n")).toBeDefined();
    expect(summary, "the census refused a field this line exists to report")
      .not.toContain("droppedFields");
    for (const key of Object.keys(result)) expect(summary).toContain(`"${key}"`);

    const perRow = lines.find((l) => l.includes("send_reconcile_sent"));
    expect(perRow).toBeDefined();
    expect(perRow).not.toContain("droppedFields");
    expect(perRow, "and it names HOW the row was decided").toContain("\"decidedBy\":\"probe\"");
    expect(perRow, "never the minted Message-ID, which reads like an address")
      .not.toContain(s.minted);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   THE CAS, in the one shape PGlite CAN show: a row already resolved
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("runSendReconcilePass — a reservation somebody else already settled", () => {
  it("is not selected at all once it holds a terminal state", async () => {
    const w = await world();
    const s = await stranded(w);
    await w.db.update(outboundSends).set({ status: "sent", providerMessageId: s.minted })
      .where(eq(outboundSends.id, s.sendId));
    const spy = spyAdapter(false);

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(r.claimed).toBe(0);
    expect(spy.opened).toEqual([]);
    expect((await sendRow(w, s.sendId)).status, "and `unverified` never overwrote `sent`")
      .toBe("sent");
  });

  it("TERMINAL IS TERMINAL — a late `sent` cannot promote a row already `unverified`", async () => {
    // The mirror image of the case below, and the one this suite was missing: a probe that finds
    // the message arriving after another resolver has already written the ambiguous answer.
    // `unverified` → `sent` is a promotion the state machine does not have, and a finalize
    // without its compare-and-swap performs it silently — the row would end `sent` while the
    // reader has already been shown "we couldn't confirm this", and the two surfaces disagree
    // for ever. Watched red with `finalizeSent`'s `status='pending'` removed.
    const w = await world();
    const s = await stranded(w);
    const spy = spyAdapter(async () => {
      await w.db.update(outboundSends).set({ status: "unverified" })
        .where(eq(outboundSends.id, s.sendId));
      return true;
    });

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(r.resolvedElsewhere).toBe(1);
    expect(r.sent, "the pass must not claim a send it did not record").toBe(0);
    expect((await sendRow(w, s.sendId)).status, "UNVERIFIED was promoted to SENT")
      .toBe("unverified");
  });

  it("the compare-and-swap refuses a finalize whose row moved under it", async () => {
    // The single-connection half of the race the pg suite drives properly: the row is claimed,
    // then settled by somebody else BEFORE this pass writes. `resolvedElsewhere` is the honest
    // count and the winner's state is what stands.
    const w = await world();
    const s = await stranded(w);
    const spy = spyAdapter(async () => {
      // Between the claim and the write — exactly where the other resolver commits.
      await w.db.update(outboundSends).set({ status: "sent", providerMessageId: s.minted })
        .where(eq(outboundSends.id, s.sendId));
      return false;
    });

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(r.resolvedElsewhere).toBe(1);
    expect(r.unverified).toBe(0);
    expect((await sendRow(w, s.sendId)).status, "SENT was not turned into UNVERIFIED").toBe("sent");
  });

  /**
   * THE OTHER HALF OF THE ALARM'S ARITHMETIC, pinned here because it cannot be pinned there.
   *
   * `apps/worker/test/api-cron.test.ts` checks that `stuckSendMs` leaves the reconciler at least
   * two cycles between a row going stale and a human being paged — but it cannot import this
   * constant: `@trafficflow/services` is outside the worker's dependency boundary (the import boundary, and
   * `deps.test.ts` enforces it after a measured boot crash), so it uses a literal ten minutes.
   * This is what makes that literal a pin rather than a guess. If the stale window moves, this
   * assertion is what goes red, and it names the file that has to move with it.
   */
  it("pins SEND_STALE_AFTER_MS, which the worker's alarm arithmetic can only assume", async () => {
    expect(SEND_STALE_AFTER_MS, "the timing guard; the CAS is the structural one").toBe(10 * MIN);
  });
});

/* ═══════════════════════════════════════════════════════════
   THE SECOND LOOK AT A SEND CLOSED `unverified`
   ═══════════════════════════════════════════════════════════

   A reservation the first resolution closed `unverified` was terminal: nothing ever looked in the
   Sent folder again, and the person was asked a question the engine could answer. For
   `SEND_UNVERIFIED_RECHECK_MS` the pass looks again — the mirror every cycle, IMAP inside the probe
   windows — and a hit resolves the row `sent` with `resolved_by = 'sent_folder'`. Every miss
   writes nothing. */
describe("runSendReconcilePass — the second look at an unverified send", () => {
  const inWindow = SEND_UNVERIFIED_PROBE_AT_MS[0]! + MIN;          // one minute into the first window
  const outsideWindows = SEND_UNVERIFIED_PROBE_AT_MS[0]! + SEND_UNVERIFIED_PROBE_WINDOW_MS + MIN;

  /** Mutation: drop the `recheck` page from `claimStale` → `rechecked` reads 0 and the row stays. */
  it("resolves from the MIRROR without a dial, names the resolver, and takes the draft out of Drafts", async () => {
    const w = await world();
    const { sendId, draftId, minted } = await closedUnverified(w, { ageMs: outsideWindows });
    await mirror(w, minted);
    const spy = spyAdapter(false);

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(r.rechecked, "the closed row was never looked at again").toBe(1);
    expect(r.recheckedSent).toBe(1);
    expect(r.claimed, "a second look was counted as a first decision").toBe(0);
    expect(spy.opened, "the mirror had the answer and a LOGIN was spent anyway").toEqual([]);
    const send = await sendRow(w, sendId);
    expect(send.status).toBe("sent");
    expect(send.resolvedBy, "the ledger does not say WHO settled it").toBe("sent_folder");
    expect(send.providerMessageId).toBe(minted);
    expect((await draftRow(w, draftId)).status, "the row still sits in Drafts asking its question").toBe("sent");
    const changes = await w.db.select().from(changeLog).where(eq(changeLog.entityId, draftId));
    expect(changes.length, "the client is never told").toBe(1);
  });

  it("inside a probe window it asks the Sent folder over IMAP — a hit resolves, decided by the probe", async () => {
    const w = await world();
    const { sendId, minted } = await closedUnverified(w, { ageMs: inWindow });
    const spy = spyAdapter(true);

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(spy.opened).toEqual([w.mailboxId]);
    expect(spy.probed).toEqual([minted]);
    expect(r.recheckedSent).toBe(1);
    expect((await sendRow(w, sendId)).resolvedBy).toBe("sent_folder");
    expect(spy.delivered, "a second look put an envelope on the wire").toEqual([]);
  });

  /** Mutation: make a probe miss call `finalizeSentFromUnverified` → the row reads `sent`. */
  it("a probe MISS writes nothing — the row is exactly as it was, still inside its window", async () => {
    const w = await world();
    const { sendId, draftId } = await closedUnverified(w, { ageMs: inWindow });
    const spy = spyAdapter(false);

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(spy.probed.length).toBe(1);
    expect(r.rechecked).toBe(1);
    expect(r.recheckedSent).toBe(0);
    const send = await sendRow(w, sendId);
    expect(send.status).toBe("unverified");
    expect(send.resolvedBy, "a miss was recorded as if somebody had answered").toBeNull();
    expect((await draftRow(w, draftId)).status).toBe("unverified");
  });

  it("outside every window the mirror arm runs and NO login is spent", async () => {
    const w = await world();
    await closedUnverified(w, { ageMs: outsideWindows });
    const spy = spyAdapter(true);

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(r.rechecked).toBe(1);
    expect(spy.opened, "a LOGIN a minute for a day is the cost this window rule exists to refuse").toEqual([]);
    expect(r.recheckedSent).toBe(0);
  });

  it("…but a connection this invocation already holds is used for free", async () => {
    const w = await world();
    // A stranded pending row on the same mailbox opens the connection; the closed row rides it.
    await stranded(w);
    const { sendId } = await closedUnverified(w, { ageMs: outsideWindows });
    const spy = spyAdapter(true);

    const r = await run(w, { openSendAdapter: spy.factory });

    expect(spy.opened, "two rows on one mailbox cost two logins").toEqual([w.mailboxId]);
    expect(r.recheckedSent).toBe(1);
    expect((await sendRow(w, sendId)).status).toBe("sent");
  });

  /** THE WINDOW IS BOUNDED AND NAMED: past it the row is left to the person, and the sentence changes. */
  it("a row older than the recheck window is not looked at again", async () => {
    const w = await world();
    const { sendId, minted } = await closedUnverified(w, { ageMs: SEND_UNVERIFIED_RECHECK_MS + MIN });
    await mirror(w, minted);

    const r = await run(w, { openSendAdapter: spyAdapter(true).factory });

    expect(r.rechecked).toBe(0);
    expect((await sendRow(w, sendId)).status).toBe("unverified");
  });

  it("a row somebody already answered for, and a discarded draft's row, are both left alone", async () => {
    const w = await world();
    const answered = await closedUnverified(w, { ageMs: 20 * MIN, resolvedBy: "person" });
    await mirror(w, answered.minted);
    const discarded = await closedUnverified(w, { ageMs: 20 * MIN });
    await mirror(w, discarded.minted);
    // The discard: the draft goes, `draft_id` follows the FK to NULL, the ledger row is stamped.
    await w.db.update(outboundSends).set({ resolvedBy: "discard", resolvedAt: NOW })
      .where(eq(outboundSends.id, discarded.sendId));
    await w.db.delete(drafts).where(eq(drafts.id, discarded.draftId));

    const r = await run(w, { openSendAdapter: spyAdapter(true).factory });

    expect(r.rechecked).toBe(0);
    expect((await sendRow(w, answered.sendId)).status).toBe("unverified");
    expect((await sendRow(w, discarded.sendId)).status).toBe("unverified");
    expect((await sendRow(w, discarded.sendId)).draftId).toBeNull();
  });

  it("the probe windows are derived from the constants, and a boundary is a boundary", () => {
    for (const at of SEND_UNVERIFIED_PROBE_AT_MS) {
      expect(inUnverifiedProbeWindow(at - 1)).toBe(false);
      expect(inUnverifiedProbeWindow(at)).toBe(true);
      expect(inUnverifiedProbeWindow(at + SEND_UNVERIFIED_PROBE_WINDOW_MS - 1)).toBe(true);
      expect(inUnverifiedProbeWindow(at + SEND_UNVERIFIED_PROBE_WINDOW_MS)).toBe(false);
    }
    expect(SEND_UNVERIFIED_PROBE_AT_MS.length, "two logins per row is the bound this file states").toBe(2);
    expect(Math.max(...SEND_UNVERIFIED_PROBE_AT_MS) + SEND_UNVERIFIED_PROBE_WINDOW_MS)
      .toBeLessThanOrEqual(SEND_UNVERIFIED_RECHECK_MS);
  });

  it("a stranded pending row is decided BEFORE any second look, whatever the ages", async () => {
    const w = await world();
    const older = await closedUnverified(w, { ageMs: inWindow });
    const { sendId } = await stranded(w, { ageMs: 11 * MIN });
    const spy = spyAdapter(false);

    const r = await run(w, { openSendAdapter: spy.factory, batch: 1 });

    expect(r.claimed).toBe(1);
    expect((await sendRow(w, sendId)).status, "the first decision waited behind a second look").toBe("unverified");
    expect(spy.probed[0], "the pending row was not probed first").toBe((await sendRow(w, sendId)).mintedMessageId);
    void older;
  });
});
