import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, messages, type Tx } from "@trafficflow/db";
import {
  INBOUND_QUIET_ABSOLUTE_MS, INBOUND_QUIET_MIN_AGE_MS, INBOUND_QUIET_RECOVERY_MIN,
  INBOUND_QUIET_SIBLING_MIN, INBOUND_QUIET_WINDOW_MS, inboundQuietPass,
} from "../src/inbound-quiet.js";

/**
 * THE FORWARDING-DETECTION HEURISTIC, judged against the incident it was born from.
 *
 * The fixture in the first test is the real timeline, re-dated: a mailbox synced perfectly for
 * weeks while a provider-level forward (no "keep a copy") diverted every inbound mail before
 * IMAP storage — the user kept SENDING from it, so its Sent folder kept ingesting, and every
 * health signal stayed green. Two days of debugging pointed at ohmail; the answer was upstream.
 *
 * Every threshold is imported, never re-typed, so a tuned constant re-judges these fixtures
 * rather than silently diverging from them. Each behavioural assertion here was watched go RED
 * against a deliberately broken implementation before this file was trusted (the mutations are
 * listed in the slice report): the self-sent exclusion, the sibling gate, each health gate, the
 * hysteresis pair, the coalesce and the fresh-episode stamp all bite.
 */

const NOW = new Date("2026-08-29T12:00:00Z");
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
const hoursAgo = (n: number): Date => new Date(NOW.getTime() - n * 60 * 60 * 1000);

interface MailboxOpts {
  address?: string;
  createdDaysAgo?: number;
  /** Hours since the last completed cycle; null = never synced. */
  lastSyncHoursAgo?: number | null;
  importDone?: boolean;
  /** When the initial import finished; defaults to the creation instant. */
  importDoneAt?: Date;
  status?: string;
  syncBlockedSince?: Date | null;
  inboundQuietSince?: Date | null;
  inboundQuietDismissedAt?: Date | null;
}

/** A mailbox that passes every gate unless an opt says otherwise. */
async function connectMailbox(db: any, accountId: string, opts: MailboxOpts = {}) {
  const createdDaysAgo = opts.createdDaysAgo ?? 90;
  const [mb] = await db.insert(mailboxes).values({
    accountId,
    provider: "imap",
    address: opts.address ?? `m-${randomUUID()}@example.org`,
    createdAt: daysAgo(createdDaysAgo),
    status: opts.status ?? "connected",
    lastSyncAt: opts.lastSyncHoursAgo === null ? null : hoursAgo(opts.lastSyncHoursAgo ?? 1),
    initialImportCompletedAt: (opts.importDone ?? true) ? (opts.importDoneAt ?? daysAgo(createdDaysAgo)) : null,
    syncBlockedSince: opts.syncBlockedSince ?? null,
    inboundQuietSince: opts.inboundQuietSince ?? null,
    inboundQuietDismissedAt: opts.inboundQuietDismissedAt ?? null,
  }).returning();
  return mb;
}

/**
 * One ingested message, carrying BOTH clocks the pass reads: `date` (the header — the sender's
 * claim) and `created_at` (ingestion — when the row actually entered this store). On a live
 * mailbox the two coincide, so `ingestedAt` defaults to the header date; an import fixture sets
 * it explicitly (everything imported yesterday was INGESTED yesterday whatever its headers say),
 * and a date-less message must say when it was ingested because there is no header to default from.
 */
async function arrive(db: any, accountId: string, mailboxId: string, opts: {
  from: string; date: Date | null; ingestedAt?: Date; deletedAt?: Date | null;
}) {
  const dedup = `mid:${randomUUID()}`;
  await db.insert(messages).values({
    accountId, mailboxId, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
    subject: "s", fromAddress: opts.from, date: opts.date,
    createdAt: opts.ingestedAt ?? opts.date ?? NOW,
    nativeLocator: { folder: "INBOX", ref: "1:1" },
    ...(opts.deletedAt !== undefined ? { deletedAt: opts.deletedAt } : {}),
  });
}

const rowOf = async (db: any, id: string) =>
  (await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!;

describe("inbound-quiet pass — the forwarding-detection heuristic (mail 0078)", () => {
  it("trips on the incident's exact shape: healthy sync, an active SENDER, zero genuine inbound, a busy sibling", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();

    // The diverted mailbox. Genuine inbound flowed until three weeks ago, then the provider
    // forward took everything — while the user kept sending (Sent ingests as messages whose
    // From is the mailbox's own address, in whatever CASE the client wrote it, which is what
    // the lower() in the predicate exists for).
    const diverted = await connectMailbox(db, accountId, { address: "mila@lichtgrat.example" });
    for (const d of [80, 60, 35, 28, 21]) {
      await arrive(db, accountId, diverted.id, { from: "sender@corp.example", date: daysAgo(d) });
    }
    for (const d of [10, 5, 2]) {
      await arrive(db, accountId, diverted.id, { from: "Mila@Lichtgrat.example", date: daysAgo(d) });
    }

    // The sibling that proves mail in general reaches this account.
    const sibling = await connectMailbox(db, accountId, { address: "work@atelier.example" });
    for (let d = 1; d <= INBOUND_QUIET_SIBLING_MIN + 1; d += 1) {
      await arrive(db, accountId, sibling.id, { from: `s${d}@corp.example`, date: daysAgo(d) });
    }

    const res = await inboundQuietPass(db as unknown as Tx, NOW, { accountId });
    expect(res).toEqual({ tripped: 1, cleared: 0 });

    // The episode's stamp is the newest GENUINE inbound — the day-21 arrival, not any self-sent
    // date after it and not "now": the client says "the last mail to arrive came {this}".
    const after = await rowOf(db, diverted.id);
    expect(after.inboundQuietSince?.toISOString()).toBe(daysAgo(21).toISOString());
    expect(after.inboundQuietDismissedAt).toBeNull();
    // The busy sibling is untouched.
    expect((await rowOf(db, sibling.id)).inboundQuietSince).toBeNull();
  });

  it("does NOT trip without the sibling's evidence: an account-wide quiet fortnight is a vacation, not a forward", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const a = await connectMailbox(db, accountId);
    const b = await connectMailbox(db, accountId);
    // Both mailboxes have real history and both went quiet — inside the absolute window, so
    // only the comparative arm could speak, and it needs a sibling receiving NORMALLY.
    await arrive(db, accountId, a.id, { from: "x@corp.example", date: daysAgo(30) });
    await arrive(db, accountId, b.id, { from: "y@corp.example", date: daysAgo(25) });

    const res = await inboundQuietPass(db as unknown as Tx, NOW, { accountId });
    expect(res).toEqual({ tripped: 0, cleared: 0 });
    expect((await rowOf(db, a.id)).inboundQuietSince).toBeNull();
    expect((await rowOf(db, b.id)).inboundQuietSince).toBeNull();
  });

  it("a sibling below the receiving-normally bar vouches for nothing", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const quiet = await connectMailbox(db, accountId);
    await arrive(db, accountId, quiet.id, { from: "x@corp.example", date: daysAgo(30) });
    const trickle = await connectMailbox(db, accountId);
    for (let d = 1; d < INBOUND_QUIET_SIBLING_MIN; d += 1) {
      await arrive(db, accountId, trickle.id, { from: `t${d}@corp.example`, date: daysAgo(d) });
    }
    const res = await inboundQuietPass(db as unknown as Tx, NOW, { accountId });
    expect(res).toEqual({ tripped: 0, cleared: 0 });
  });

  it("trips ABSOLUTELY on a single-mailbox account whose newest genuine inbound is months old", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const only = await connectMailbox(db, accountId, { createdDaysAgo: 20 });
    // Connected twenty days ago; the initial import INGESTED the history at connect (created_at
    // twenty days old), and that history's newest header date is 90 days old — the
    // connect-a-diverted-mailbox shape, caught without any sibling once the import itself has
    // aged out of the ingestion window.
    await arrive(db, accountId, only.id, {
      from: "x@corp.example", date: daysAgo(90), ingestedAt: daysAgo(20),
    });

    const res = await inboundQuietPass(db as unknown as Tx, NOW, { accountId });
    expect(res).toEqual({ tripped: 1, cleared: 0 });
    expect((await rowOf(db, only.id)).inboundQuietSince?.toISOString())
      .toBe(daysAgo(90).toISOString());
  });

  it("recently-INGESTED mail holds a trip back whatever its headers claim: old-dated, future-dated and date-less arrivals are all arrivals", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    // Three mailboxes, each with damning DATE evidence and a busy sibling — and each with one
    // row proving mail reached the store inside the window. None may trip: ingestion is the one
    // clock a sender cannot choose, and mail that is arriving is not a diverted mailbox.
    const oldDated = await connectMailbox(db, accountId);
    await arrive(db, accountId, oldDated.id, {
      from: "x@corp.example", date: daysAgo(90), ingestedAt: daysAgo(3),
    });
    const futureDated = await connectMailbox(db, accountId);
    await arrive(db, accountId, futureDated.id, {
      from: "y@corp.example", date: daysAgo(-30), ingestedAt: daysAgo(3),
    });
    const dateless = await connectMailbox(db, accountId);
    await arrive(db, accountId, dateless.id, {
      from: "z@corp.example", date: null, ingestedAt: daysAgo(3),
    });
    const busy = await connectMailbox(db, accountId);
    for (let d = 1; d <= INBOUND_QUIET_SIBLING_MIN; d += 1) {
      await arrive(db, accountId, busy.id, { from: `s${d}@corp.example`, date: daysAgo(d) });
    }
    const res = await inboundQuietPass(db as unknown as Tx, NOW, { accountId });
    expect(res).toEqual({ tripped: 0, cleared: 0 });
  });

  it("a future-dated header cannot hold the absolute arm shut, and cannot become the stamp", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    // A single-mailbox account, months old, whose ONE genuine message ever carries a header
    // date thirty days in the future and was ingested twenty days ago. Without the `date <=
    // now` bound that row reads as "recent history" for ever and the months-quiet mailbox is
    // never judged; with it, the history is empty, the mailbox is old, and the episode stamps
    // the mailbox's creation — never a date ahead of the clock.
    const mb = await connectMailbox(db, accountId, {
      createdDaysAgo: Math.ceil(INBOUND_QUIET_ABSOLUTE_MS / 86_400_000) + 5,
    });
    await arrive(db, accountId, mb.id, {
      from: "spoof@corp.example", date: daysAgo(-30), ingestedAt: daysAgo(20),
    });
    const res = await inboundQuietPass(db as unknown as Tx, NOW, { accountId });
    expect(res).toEqual({ tripped: 1, cleared: 0 });
    const after = await rowOf(db, mb.id);
    expect(after.inboundQuietSince?.toISOString()).toBe(after.createdAt.toISOString());
  });

  it("date-less arrivals END an episode: recovery is judged on ingestion", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const mb = await connectMailbox(db, accountId, { inboundQuietSince: daysAgo(40) });
    for (let d = 1; d <= INBOUND_QUIET_RECOVERY_MIN; d += 1) {
      await arrive(db, accountId, mb.id, { from: `n${d}@corp.example`, date: null, ingestedAt: daysAgo(d) });
    }
    const res = await inboundQuietPass(db as unknown as Tx, NOW, { accountId });
    expect(res).toEqual({ tripped: 0, cleared: 1 });
    expect((await rowOf(db, mb.id)).inboundQuietSince).toBeNull();
  });

  it("a mailbox that NEVER received anything trips only once it is itself months old, and stamps its creation", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    // Old enough: past the absolute window with nothing ever received (self-sent only).
    const never = await connectMailbox(db, accountId, {
      address: "quiet@example.org",
      createdDaysAgo: Math.ceil(INBOUND_QUIET_ABSOLUTE_MS / 86_400_000) + 5,
    });
    await arrive(db, accountId, never.id, { from: "quiet@example.org", date: daysAgo(3) });
    // Not old enough: same emptiness, forty days connected — a new address nobody writes to yet.
    const young = await connectMailbox(db, accountId, { createdDaysAgo: 40 });

    const res = await inboundQuietPass(db as unknown as Tx, NOW, { accountId });
    expect(res).toEqual({ tripped: 1, cleared: 0 });
    const stamped = await rowOf(db, never.id);
    expect(stamped.inboundQuietSince?.toISOString()).toBe(stamped.createdAt.toISOString());
    expect((await rowOf(db, young.id)).inboundQuietSince).toBeNull();
  });

  it("a freshly IMPORTED sibling vouches for nothing: history a connect just wrote is not live flow", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    // The established, genuinely quiet mailbox the user knows is quiet — its newest genuine
    // inbound is a month old, inside the absolute window, so ONLY the comparative arm could
    // ever trip it.
    const quiet = await connectMailbox(db, accountId);
    await arrive(db, accountId, quiet.id, { from: "x@corp.example", date: daysAgo(30) });
    // A sibling connected three days ago whose initial import (finished two days ago) wrote six
    // historical messages — all ingested inside the window, none of them a live arrival.
    // Without the post-import distinction these rows vouch "mail flows to this account" and the
    // quiet mailbox gets a forwarding notice because its owner connected another mailbox.
    const fresh = await connectMailbox(db, accountId, {
      createdDaysAgo: 3, importDoneAt: daysAgo(2),
    });
    for (let i = 0; i <= INBOUND_QUIET_SIBLING_MIN; i += 1) {
      await arrive(db, accountId, fresh.id, {
        from: `h${i}@corp.example`, date: daysAgo(100 + i),
        ingestedAt: new Date(daysAgo(3).getTime() + i * 60_000),
      });
    }
    const res = await inboundQuietPass(db as unknown as Tx, NOW, { accountId });
    expect(res).toEqual({ tripped: 0, cleared: 0 });
    expect((await rowOf(db, quiet.id)).inboundQuietSince).toBeNull();
    // And the same sibling with POST-import arrivals does vouch: live flow, not history.
    // Hours old, so every one of them postdates the two-day-old import completion.
    for (let h = 1; h <= INBOUND_QUIET_SIBLING_MIN; h += 1) {
      await arrive(db, accountId, fresh.id, { from: `live${h}@corp.example`, date: hoursAgo(h) });
    }
    const res2 = await inboundQuietPass(db as unknown as Tx, NOW, { accountId });
    expect(res2).toEqual({ tripped: 1, cleared: 0 });
    expect((await rowOf(db, quiet.id)).inboundQuietSince?.toISOString())
      .toBe(daysAgo(30).toISOString());
  });

  it("judges nothing that is not healthy on its own terms: young, importing, stale, blocked, errored, disabled", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const shapes: Array<[string, MailboxOpts]> = [
      ["young", { createdDaysAgo: Math.floor(INBOUND_QUIET_MIN_AGE_MS / 86_400_000) - 1 }],
      ["importing", { importDone: false }],
      ["stale-sync", { lastSyncHoursAgo: 30 }],
      ["never-synced", { lastSyncHoursAgo: null }],
      ["blocked", { syncBlockedSince: daysAgo(2) }],
      ["errored", { status: "error" }],
      ["disabled", { status: "disabled" }],
    ];
    const ids: string[] = [];
    for (const [, opts] of shapes) {
      const mb = await connectMailbox(db, accountId, opts);
      // Every one of them carries the absolute arm's damning evidence — months-old newest
      // inbound — so ONLY the gate under test can be what holds the trip back.
      await arrive(db, accountId, mb.id, { from: "x@corp.example", date: daysAgo(90) });
      ids.push(mb.id);
    }
    // And a busy sibling, so the comparative arm's evidence is present too.
    const busy = await connectMailbox(db, accountId);
    for (let d = 1; d <= INBOUND_QUIET_SIBLING_MIN; d += 1) {
      await arrive(db, accountId, busy.id, { from: `s${d}@corp.example`, date: daysAgo(d) });
    }

    const res = await inboundQuietPass(db as unknown as Tx, NOW, { accountId });
    expect(res).toEqual({ tripped: 0, cleared: 0 });
    for (const id of ids) expect((await rowOf(db, id)).inboundQuietSince).toBeNull();
  });

  it("holds an episode against a STRAY arrival and clears it on real flow — the hysteresis that keeps a dismissal durable", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const since = daysAgo(40);
    const strays = await connectMailbox(db, accountId, { inboundQuietSince: since });
    // One arrival inside the window — below the recovery bar. A monthly stray must not end the
    // episode: an ended episode re-trips with a fresh stamp, and a fresh stamp newer than a
    // standing dismissal would re-show a notice the user already answered.
    await arrive(db, accountId, strays.id, { from: "x@corp.example", date: daysAgo(6) });

    const flow = await connectMailbox(db, accountId, { inboundQuietSince: since });
    for (let d = 1; d <= INBOUND_QUIET_RECOVERY_MIN; d += 1) {
      await arrive(db, accountId, flow.id, { from: `f${d}@corp.example`, date: daysAgo(d) });
    }

    const res = await inboundQuietPass(db as unknown as Tx, NOW, { accountId });
    expect(res).toEqual({ tripped: 0, cleared: 1 });
    expect((await rowOf(db, strays.id)).inboundQuietSince?.toISOString()).toBe(since.toISOString());
    expect((await rowOf(db, flow.id)).inboundQuietSince).toBeNull();
  });

  it("never advances a live episode's stamp, and never touches a dismissal", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const since = daysAgo(40);
    const dismissedAt = daysAgo(35);
    const mb = await connectMailbox(db, accountId, {
      inboundQuietSince: since, inboundQuietDismissedAt: dismissedAt,
    });
    // The world is arranged so the trip predicate HOLDS AGAIN right now — a stray arrival
    // (day 20: outside the window, so `recent` is 0 and the episode is not cleared; newer than
    // the stamp, so an unguarded re-stamp would advance it past the dismissal) and a busy
    // sibling arming the comparative arm. An implementation that re-judges a live episode
    // re-stamps `since` to day 20 here, which un-dismisses a notice the user answered — the
    // exact defect the coalesce discipline exists for, so this fixture makes it visible.
    await arrive(db, accountId, mb.id, { from: "x@corp.example", date: daysAgo(41) });
    await arrive(db, accountId, mb.id, { from: "stray@corp.example", date: daysAgo(20) });
    const busy = await connectMailbox(db, accountId);
    for (let d = 1; d <= INBOUND_QUIET_SIBLING_MIN; d += 1) {
      await arrive(db, accountId, busy.id, { from: `s${d}@corp.example`, date: daysAgo(d) });
    }

    // Two passes back to back: the second sees the same world and must change nothing.
    await inboundQuietPass(db as unknown as Tx, NOW, { accountId });
    const res = await inboundQuietPass(db as unknown as Tx, NOW, { accountId });
    expect(res).toEqual({ tripped: 0, cleared: 0 });
    const after = await rowOf(db, mb.id);
    expect(after.inboundQuietSince?.toISOString()).toBe(since.toISOString());
    expect(after.inboundQuietDismissedAt?.toISOString()).toBe(dismissedAt.toISOString());
  });

  it("re-fires after a dismissal ONLY through real flow: the new episode's stamp postdates the dismissal", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();

    // Chapter 1 — the episode the user dismissed: newest inbound 50 days ago, episode stamped
    // with it, dismissal a week later.
    const mb = await connectMailbox(db, accountId, {
      inboundQuietSince: daysAgo(50), inboundQuietDismissedAt: daysAgo(43),
    });
    await arrive(db, accountId, mb.id, { from: "x@corp.example", date: daysAgo(50) });

    // Chapter 2 — the forward comes off and mail flows again (16–18 days ago: real flow, inside
    // that moment's window). The pass run "then" clears the episode.
    for (const d of [18, 17, 16]) {
      await arrive(db, accountId, mb.id, { from: `back${d}@corp.example`, date: daysAgo(d) });
    }
    const then = new Date(NOW.getTime() - 15 * 24 * 60 * 60 * 1000);
    const mid = await inboundQuietPass(db as unknown as Tx, then, { accountId });
    expect(mid.cleared).toBe(1);

    // Chapter 3 — the forward is re-added; sixteen silent days later the sibling is busy and
    // the pass runs "now": a NEW episode, stamped with the day-16 arrival — which postdates the
    // dismissal, so the client (`showInboundQuiet`) shows the notice again. State changed;
    // sameness would have held.
    const sibling = await connectMailbox(db, accountId);
    for (let d = 1; d <= INBOUND_QUIET_SIBLING_MIN; d += 1) {
      await arrive(db, accountId, sibling.id, { from: `s${d}@corp.example`, date: daysAgo(d) });
    }
    const res = await inboundQuietPass(db as unknown as Tx, NOW, { accountId });
    expect(res.tripped).toBe(1);
    const after = await rowOf(db, mb.id);
    expect(after.inboundQuietSince?.toISOString()).toBe(daysAgo(16).toISOString());
    expect(after.inboundQuietDismissedAt?.toISOString()).toBe(daysAgo(43).toISOString());
    expect(after.inboundQuietSince!.getTime()).toBeGreaterThan(after.inboundQuietDismissedAt!.getTime());
  });

  it("counts a DELETED arrival as the arrival it was: reading-and-deleting mail is not a quiet mailbox", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const tidy = await connectMailbox(db, accountId);
    // Every recent arrival deleted on reading — rows tombstoned, arrivals real.
    for (const d of [2, 4, 6]) {
      await arrive(db, accountId, tidy.id, {
        from: "x@corp.example", date: daysAgo(d), deletedAt: daysAgo(d - 1),
      });
    }
    const busy = await connectMailbox(db, accountId);
    for (let d = 1; d <= INBOUND_QUIET_SIBLING_MIN; d += 1) {
      await arrive(db, accountId, busy.id, { from: `s${d}@corp.example`, date: daysAgo(d) });
    }
    const res = await inboundQuietPass(db as unknown as Tx, NOW, { accountId });
    expect(res).toEqual({ tripped: 0, cleared: 0 });
    expect((await rowOf(db, tidy.id)).inboundQuietSince).toBeNull();
  });

  it("is scoped to the account it was asked about", async () => {
    const db = await makeTestDb();
    const judged = randomUUID();
    const other = randomUUID();
    // The other account holds the full incident shape; the judged account holds nothing.
    const diverted = await connectMailbox(db, other);
    await arrive(db, other, diverted.id, { from: "x@corp.example", date: daysAgo(90) });

    const res = await inboundQuietPass(db as unknown as Tx, NOW, { accountId: judged });
    expect(res).toEqual({ tripped: 0, cleared: 0 });
    expect((await rowOf(db, diverted.id)).inboundQuietSince).toBeNull();
  });

  it("window arithmetic uses the exported constants: an arrival just inside the window holds the comparative arm back", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const mb = await connectMailbox(db, accountId);
    // One hour inside the window — recent, so arm A cannot speak; well inside the absolute
    // window, so arm B cannot either.
    await arrive(db, accountId, mb.id, {
      from: "x@corp.example",
      date: new Date(NOW.getTime() - INBOUND_QUIET_WINDOW_MS + 60 * 60 * 1000),
    });
    const busy = await connectMailbox(db, accountId);
    for (let d = 1; d <= INBOUND_QUIET_SIBLING_MIN; d += 1) {
      await arrive(db, accountId, busy.id, { from: `s${d}@corp.example`, date: daysAgo(d) });
    }
    const res = await inboundQuietPass(db as unknown as Tx, NOW, { accountId });
    expect(res).toEqual({ tripped: 0, cleared: 0 });
  });
});
