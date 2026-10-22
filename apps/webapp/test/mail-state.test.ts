/**
 * THE LADDER AND THE GROWTH REDUCER, on their own.
 *
 * `deriveMailState` is pure and `growthStep` is a reducer, so the precedence table and the
 * two-observation rule can be exercised without a browser, a clock or a network. That is what
 * makes the mutation table in the project's design notes cheap enough to have actually run.
 *
 * What this file cannot prove, and `sync-progress.test.ts` exists for: that anything is WIRED.
 * A perfect ladder nobody renders is exactly the defect this guards.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AWAITING_SLOW_MS,
  GROWTH_WINDOW_MS,
  IMPORT_END_IDLE_MS,
  IMPORT_FLOOR_MAX_MS,
  IMPORT_MIN_DELTA,
  SYNC_BLOCK_REASONS,
  deriveMailState,
  deviceHoldings,
  holdingsSpeak,
  hostedTotal,
  growthStep,
  isGrowing,
  isImporting,
  seedGrowth,
  stripSpeaks,
  type MailStateInputs,
  type MailboxFacts,
} from "../app/shell/mail-state";
import { forgetOpenVerdict, markOpenVerdict } from "../app/shell/access-window";
import { storageOwner } from "../app/shell/storage-owner";
import messages from "../messages/en.json";
import deMessages from "../messages/de.json";

const NOW = Date.parse("2026-08-04T12:00:00.000Z");

const mailbox = (over: Partial<MailboxFacts> = {}): MailboxFacts => ({
  id: "mb1",
  address: "desk@trafficflow.invalid",
  status: "connected",
  errorCode: null,
  // (mail 0027). Null is the ordinary case AND the ordinary disconnect — see the arm in
  // `deriveMailState`, which reads `typeof === "string"` precisely so an omitted field here
  // could not silently promote every `disabled` fixture into an organizer conflict.
  disabledReason: null,
  syncBlockedReason: null,
  syncBlockedSince: null,
  lastSyncAt: null,
  // The import stamp (mail 0038). The DEFAULT is a FINISHED import, so the settled resting fixtures stay settled
  // — the import floor fires only for a fixture that explicitly nulls this AND has a non-empty
  // mirror. A never-synced fixture (`lastSyncAt: null`, mirror 0) reaches `awaiting` above the
  // floor, so this default's non-null value never contradicts it there.
  initialImportCompletedAt: new Date(NOW - 30_000).toISOString(),
  createdAt: new Date(NOW - 60_000).toISOString(),
  ...over,
});

/**
 * A blocked mailbox AS THE WIRE CAN ACTUALLY PRODUCE ONE — both columns, always.
 *
 * Several tests below used to set `syncBlockedReason` alone, which is a row no writer can create:
 * all five set and clear the reason and the timestamp in ONE statement
 * (`apps/worker/src/mailboxes.ts`, `mailbox-service.ts:360-362`). That did not matter while the
 * ladder gated on the reason, and it mattered the moment it gated on the timestamp — so the
 * fixtures were fictional in exactly the dimension the fix turned on. `reason` is explicitly
 * nullable here because `{reason: null, since: <ts>}` IS a legal wire state: the service narrows a
 * member this build does not know and forwards the timestamp regardless.
 */
const blockedMailbox = (
  reason: string | null,
  over: Partial<MailboxFacts> = {},
): MailboxFacts =>
  mailbox({
    syncBlockedReason: reason,
    syncBlockedSince: new Date(NOW - 420_000).toISOString(),
    ...over,
  });

/** The resting mirror size. Named so the `pulled` default below cannot drift from it. */
const MIRRORED_DEFAULT = 495;

/** The healthy resting inputs; every test perturbs exactly what it is about. */
const inputs = (over: Partial<MailStateInputs> = {}): MailStateInputs => ({
  sync: { bootstrapping: false, failures: 0, terminal: false, refused: false, ownerLost: false },
  failureStreak: 3,
  mailboxes: [mailbox({ lastSyncAt: new Date(NOW - 30_000).toISOString() })],
  mirrored: MIRRORED_DEFAULT,
  growth: seedGrowth(MIRRORED_DEFAULT),
  // The resting freshness: current, stamped moments ago. The stale arm's own tests perturb it.
  freshness: { state: "current" as const, asOf: new Date(NOW - 30_000).toISOString() },
  engineFreshness: { state: "current" as const, asOf: new Date(NOW - 30_000).toISOString() },
  now: NOW,
  demo: false,
  ...over,
  /* `pulled` follows `mirrored` unless a case names it: that is the shape wherever no producer
     answered a count, which is every test here but the import numerator's own. */
  pulled: over.pulled ?? over.mirrored ?? MIRRORED_DEFAULT,
});

/** A growth history that IS growing: two rises, seconds apart, from an empty mirror. */
function importingFromEmpty(to: number, at = NOW): ReturnType<typeof seedGrowth> {
  let g = seedGrowth(0);
  g = growthStep(g, Math.max(1, Math.floor(to / 2)), at - 8_000);
  g = growthStep(g, to, at);
  return g;
}

describe("the growth reducer — two observations, never one", () => {
  it("a SINGLE rise is not growth: one arrival is not an import", () => {
    const g = growthStep(seedGrowth(0), 3, NOW);
    expect(g.rises).toBe(1);
    expect(isGrowing(g, NOW), "one rise was reported as a growing mirror").toBe(false);
  });

  it("two rises inside the window ARE growth", () => {
    const g = importingFromEmpty(6);
    expect(g.rises).toBe(2);
    expect(isGrowing(g, NOW)).toBe(true);
  });

  it("the seed claims nothing — a reload onto a settled mirror of a few hundred messages is not an import", () => {
    // The mirror persists into IndexedDB, so a fresh tab starts at 495. Seeding the clock with
    // `Date.now()` would make the next single arrival look like a second rise.
    const seeded = seedGrowth(495);
    expect(seeded.lastRiseAt).toBe(-Infinity);
    expect(isGrowing(seeded, NOW)).toBe(false);
    const one = growthStep(seeded, 496, NOW);
    expect(isGrowing(one, NOW), "one message after a reload announced an import").toBe(false);
  });

  it("growth DECAYS — a mailbox that finished importing three hours ago is not importing", () => {
    const g = importingFromEmpty(495);
    expect(isGrowing(g, NOW)).toBe(true);
    expect(isGrowing(g, NOW + 3 * 3_600_000)).toBe(false);
    expect(isGrowing(g, NOW + GROWTH_WINDOW_MS + 1)).toBe(false);
  });

  it("a gap longer than the window starts a NEW run, and the run's start count moves with it", () => {
    let g = importingFromEmpty(300);
    expect(g.runStartCount).toBe(0);
    g = growthStep(g, 301, NOW + GROWTH_WINDOW_MS + 5_000);
    expect(g.rises, "a rise after the window should have restarted the run").toBe(1);
    expect(g.runStartCount).toBe(300);
  });

  it("a FALL moves the baseline and is not a rise — a delete is not progress", () => {
    const g = growthStep(importingFromEmpty(495), 400, NOW + 1_000);
    expect(g.count).toBe(400);
    expect(g.rises, "a delete was counted as a rise").toBe(2);
    expect(g.lastRiseAt).toBe(NOW);
  });

  it("an unchanged count returns the SAME object — a re-render is not an observation", () => {
    const g = importingFromEmpty(495);
    expect(growthStep(g, 495, NOW + 5_000)).toBe(g);
  });
});

describe("isImporting — three ways in, and none of them is a timestamp", () => {
  it("a run that started on an EMPTY mirror is an import at two rises", () => {
    expect(isImporting(importingFromEmpty(6), false, NOW)).toBe(true);
  });

  it("a bootstrapping tab repopulating its mirror is an import", () => {
    let g = seedGrowth(400);
    g = growthStep(g, 402, NOW - 4_000);
    g = growthStep(g, 404, NOW);
    expect(isImporting(g, false, NOW), "4 messages on a settled mirror is not an import").toBe(false);
    expect(isImporting(g, true, NOW), "a cold device's own drain is one").toBe(true);
  });

  it("A ROUTINE MORNING IS NOT AN IMPORT — this is the flash the strip must not have", () => {
    // Two arrivals in adjacent polls on a mature mailbox. Growth is genuinely true; an import
    // is not, and a strip that appeared here would be chrome people learn to ignore.
    let g = seedGrowth(495);
    g = growthStep(g, 496, NOW - 8_000);
    g = growthStep(g, 497, NOW);
    expect(isGrowing(g, NOW), "the premise: this IS growth").toBe(true);
    expect(isImporting(g, false, NOW), "the strip flashed on two ordinary messages").toBe(false);
  });

  it("a run that has added IMPORT_MIN_DELTA is an import even starting from 300", () => {
    let g = seedGrowth(300);
    g = growthStep(g, 300 + IMPORT_MIN_DELTA - 1, NOW - 8_000);
    expect(isImporting(g, false, NOW - 8_000)).toBe(false);
    g = growthStep(g, 300 + IMPORT_MIN_DELTA, NOW);
    expect(isImporting(g, false, NOW), "a resumed mid-import stall stayed silent").toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   "IT COMES UP AND DISAPPEARS CONSTANTLY"

   Reported 2026-08-04, against a live import. Three defects, one symptom, and each test below is
   named for the one it holds down. Everything runs through the REAL `seedGrowth`/`growthStep`/
   `isImporting`/`deriveMailState`: a fixture that re-implemented the predicate would agree with
   whatever the predicate happened to be, which is the one thing this file must not do.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("an import is an EPISODE, and a fall is not a retraction", () => {
  it("DEFECT 1 — a Screener backfill's moves must not walk the qualifier back", () => {
    /**
     * THE MEASURED SHAPE. The qualifier was `count - runStartCount`, a NET delta, and `:177`
     * moves `count` on a fall while deliberately leaving `runStartCount` alone. So every message
     * that left the mirror SUBTRACTED from the evidence that an import was under way, and a
     * backfill moving mail between folders drove the number back and forth across the threshold
     * with the strip following it.
     *
     * The three steps below are one run — all inside `GROWTH_WINDOW_MS` — and they land the two
     * measures on opposite sides of `IMPORT_MIN_DELTA` on purpose: 30 added, 10 net.
     */
    let g = seedGrowth(300);
    g = growthStep(g, 315, NOW);            // +15 arrive
    g = growthStep(g, 295, NOW + 2_000);    // 20 move out of the mirror — a fall, not a retraction
    g = growthStep(g, 310, NOW + 8_000);    // +15 more arrive

    expect(g.rises, "the premise: the fall must not have counted as a rise").toBe(2);
    expect(g.added, "what actually ARRIVED in this run").toBe(30);
    expect(g.count - g.runStartCount, "…and what the old NET measure saw").toBe(10);
    expect(IMPORT_MIN_DELTA, "the premise: the two measures must straddle the threshold")
      .toBeGreaterThan(g.count - g.runStartCount);

    expect(g.importing, "a delete un-qualified an import that was genuinely running").toBe(true);
    expect(isImporting(g, false, NOW + 8_000)).toBe(true);
  });

  it("…and a fall on its own is still not evidence of anything", () => {
    // The control. `added` may not be a way for departures to TALK the strip into an import
    // either: 40 messages leaving a mirror is not 40 messages arriving.
    let g = seedGrowth(300);
    g = growthStep(g, 260, NOW);
    g = growthStep(g, 240, NOW + 8_000);
    expect(g.added, "a fall added to the arrival count").toBe(0);
    expect(g.rises).toBe(0);
    expect(isImporting(g, false, NOW + 8_000)).toBe(false);
  });

  it("DEFECTS 2+3 — THE MEASURED TRACE: three drains, seconds apart, is ONE appearance", () => {
    /**
     * Verbatim from the reported session: three worker drains with 45 s of idle between them, and
     * 31-second quiet gaps inside them, showed the strip FIVE times.
     *
     * Both remaining defects are visible only in a trace like this one, because both are about
     * what happens AFTER a gap. `runStartCount === 0` cannot be true a second time (`:185` moves
     * the baseline off zero and never back) and `bootstrapping` is false from this tab's first
     * drain onwards — so from the second gap on, the strip had to re-earn two rises AND twenty-five
     * messages, from scratch, every single time.
     *
     * `bootstrapping` is `false` throughout on purpose: that is the state the tab is actually in
     * for all but the first few seconds of a multi-minute import.
     */
    let g = seedGrowth(0);
    let count = 0;
    let t = NOW;
    let appeared = false;
    const vanishedAt: number[] = [];
    const look = (): void => {
      if (isImporting(g, false, t)) appeared = true;
      else if (appeared) vanishedAt.push(Math.round((t - NOW) / 1000));
    };

    for (let drain = 0; drain < 3; drain++) {
      // Four batches, one per client poll — the shape `sync-progress.test.ts` drives live.
      for (let poll = 0; poll < 4; poll++) {
        count += 30;
        g = growthStep(g, count, t);
        t += 8_000;
        look();
      }
      // The quiet gap measured MID-import: one second past `GROWTH_WINDOW_MS`, which is
      // precisely what ended the run and reset `rises` to 1 on the next batch.
      t += 31_000;
      look();
      // …and the rest of the 45 s of idle between two worker cycles.
      t += 14_000;
      look();
    }

    expect(appeared, "the strip never appeared at all — the trace is wrong, not the code").toBe(true);
    expect(vanishedAt, "the strip went silent mid-import at these elapsed seconds").toEqual([]);
    expect(count, "the premise: this is a real import, not three messages").toBe(360);
  });

  it("the latch BYPASSES `isGrowing` — that is the surprising part, so it is asserted", () => {
    // Once an episode is latched the question is no longer "is the mirror growing right now",
    // it is "has it been still long enough to be over". A 45 s gap answers the first with NO and
    // the second with NO, and only the second one is the question worth asking mid-import.
    const g = importingFromEmpty(495);
    const at = NOW + 45_000;
    expect(isGrowing(g, at), "the premise: the run window has expired").toBe(false);
    expect(g.importing, "the premise: the episode latched").toBe(true);
    expect(isImporting(g, false, at), "a 45 s worker cycle read as the end of the import").toBe(true);
  });

  it("…and it ends, on the clock, without a single new observation", () => {
    /**
     * The other half, and it is what keeps the strip from becoming permanent chrome. The reducer
     * only runs when the MIRROR MOVES (`MailStateProvider` folds only a new count), so
     * an import that simply stops produces no further `growthStep` at all. The expiry therefore
     * has to be readable from `isImporting` alone, against the shell's own 5 s clock.
     */
    const g = importingFromEmpty(495);
    expect(isImporting(g, false, NOW + IMPORT_END_IDLE_MS - 1)).toBe(true);
    expect(isImporting(g, false, NOW + IMPORT_END_IDLE_MS), "the episode never ended").toBe(false);
    expect(isImporting(g, false, NOW + 3 * 3_600_000), "…and three hours later it still had not")
      .toBe(false);
  });

  it("a TRICKLE never latches, however long it goes on", () => {
    // The risk the latch introduces, held down: a mailbox that receives two messages every two
    // minutes for an hour must never become "Syncing your mail" — that is the permanent chrome
    // `IMPORT_MIN_DELTA` exists to prevent, and a 90 s window is long enough to be tempting.
    let g = seedGrowth(495);
    let count = 495;
    for (let i = 0; i < 30; i++) {
      count += 2;
      g = growthStep(g, count, NOW + i * 120_000);
      expect(g.importing, `the strip latched on ordinary post at minute ${i * 2}`).toBe(false);
    }
    expect(count - 495, "the premise: an hour of post is more than IMPORT_MIN_DELTA in total")
      .toBeGreaterThan(IMPORT_MIN_DELTA);
  });

  it("`added` IS the net delta whenever nothing fell — the 'and nothing else changed' claim", () => {
    // The whole argument for this change is that it alters the answer for FALLS and for nothing
    // else. That is checkable rather than assertable, so it is checked.
    let g = seedGrowth(300);
    for (const [to, at] of [[312, NOW], [340, NOW + 8_000], [341, NOW + 16_000]] as const) {
      g = growthStep(g, to, at);
      expect(g.added, `a rise-only run disagreed with the net delta at ${to}`)
        .toBe(g.count - g.runStartCount);
    }
    // …and across a run restart, where `runStartCount` moves with it.
    g = growthStep(g, 400, NOW + 16_000 + GROWTH_WINDOW_MS + 1);
    expect(g.rises, "the premise: the run restarted").toBe(1);
    expect(g.added).toBe(g.count - g.runStartCount);
  });

  it("a reload mid-import claims nothing, and re-enters through `bootstrapping` alone", () => {
    // The latch is per-tab state and does not survive a reload — deliberately: a tab opening onto
    // a mirror of a few hundred messages cannot tell an import in progress from a mailbox that finished one
    // yesterday. What carries it through the cold-start window is arm 2, which is the whole
    // reason arm 2 survives.
    let g = seedGrowth(495);
    g = growthStep(g, 500, NOW);
    g = growthStep(g, 505, NOW + 8_000);
    expect(g.importing, "a reload announced an import it cannot know about").toBe(false);
    expect(isImporting(g, false, NOW + 8_000)).toBe(false);
    expect(isImporting(g, true, NOW + 8_000), "the cold device must still be covered").toBe(true);
  });
});

describe("the precedence ladder", () => {
  it("a fixtures world has no sync to report, whatever else is true", () => {
    expect(
      deriveMailState(inputs({
        demo: true,
        sync: { bootstrapping: true, failures: 9, terminal: true, refused: true, ownerLost: false },
      })).key,
    ).toBe("quiet");
  });

  it("terminal outranks everything", () => {
    expect(
      deriveMailState(inputs({
        sync: { bootstrapping: false, failures: 9, terminal: true, refused: false, ownerLost: false },
        mailboxes: [blockedMailbox("at_capacity")],
        growth: importingFromEmpty(495),
      })).key,
    ).toBe("stopped");
  });

  it("an UNCONFIRMED coded refusal is NOT `failing` and NOT `stopped` — a transient is not a failure", () => {
    /**
     * The false alarm reported on open: "Sync failed. Retrying." painted over a healthy first sync,
     * mail loading fine underneath it, cleared a minute later. Its cause was a single coded 401/403
     * the server had not yet re-made (`refused`) being rendered as `failing`. `sync-scheduler.ts`
     * records that a 401 on `/api/sync` is routinely TRANSIENT — a cold function, a warming session,
     * a deploy alias mid-roll — so one such refusal is one request's evidence and must not surface a
     * failure banner. It is a sustained streak or a CONFIRMED refusal that does.
     *
     * `failures: 1` is deliberate: BELOW `failureStreak`, so `refused` is the only thing that could
     * once have made the strip say "failed". This is the arm that used to (now moved); it must
     * no longer.
     */
    const s = deriveMailState(inputs({
      sync: { bootstrapping: false, failures: 1, terminal: false, refused: true, ownerLost: false },
      mirrored: 495,
    }));
    expect(s.key, "a refusal one request old was announced as a revoked session").not.toBe("stopped");
    expect(s.key, "a single transient refusal painted 'Sync failed. Retrying.'").not.toBe("failing");
  });

  it("an UNCONFIRMED refusal on a first sync shows the CALM `awaiting`, never failure and never silence", () => {
    /**
     * The other half: dropping `refused` from `failing` must not answer a first sync with silence.
     * A cold, never-synced mailbox that hits a transient 401 on its first drain has a calm true
     * sentence — the first sync has not finished — and the ladder says it. `bootstrapping: true` and
     * an empty, never-synced mailbox is exactly that first-sync shape.
     */
    const s = deriveMailState(inputs({
      sync: { bootstrapping: true, failures: 1, terminal: false, refused: true, ownerLost: false },
      mailboxes: [mailbox({ lastSyncAt: null })],
      mirrored: 0,
      growth: seedGrowth(0),
    }));
    expect(s.key, "a transient refusal on a first sync was rendered as failure or silence").toBe("awaiting");
  });

  it("and a CONFIRMED one is still `stopped`; the fix moved the threshold, not the state", () => {
    expect(
      deriveMailState(inputs({
        sync: { bootstrapping: false, failures: 2, terminal: true, refused: false, ownerLost: false },
      })).key,
    ).toBe("stopped");
  });

  it("a FAILING loop outranks every progress state — a frozen count is not evidence", () => {
    const s = deriveMailState(inputs({
      sync: { bootstrapping: true, failures: 3, terminal: false, refused: false, ownerLost: false },
      mailboxes: [mailbox()],
      mirrored: 6,
      growth: importingFromEmpty(6),
    }));
    expect(s.key).toBe("failing");
    expect(s.screenerCandidate, "a failing loop offered to explain an empty Ohbox").toBe(false);
  });

  it("`null` facts are NOT an empty account — they withhold every mailbox-keyed state", () => {
    const s = deriveMailState(inputs({ mailboxes: null, mirrored: 0 }));
    expect(s.key, "a shell with no probe invented a mailbox state").toBe("quiet");
  });

  it("`[]` facts ARE an empty account, and that is a different sentence", () => {
    expect(deriveMailState(inputs({ mailboxes: [], mirrored: 0 })).key).toBe("noMailbox");
  });

  it("blocked outranks a growing mirror: a mailbox nobody is syncing is not syncing", () => {
    const s = deriveMailState(inputs({
      mailboxes: [
        blockedMailbox("lease_unreadable", { address: "a@x.invalid" }),
        mailbox({ address: "b@x.invalid", lastSyncAt: new Date(NOW - 10_000).toISOString() }),
      ],
      growth: importingFromEmpty(495),
    }));
    expect(s.key).toBe("blocked");
    expect(s.reason).toBe("lease_unreadable");
    expect(s.address).toBe("a@x.invalid");
    expect(s.minutes).toBe(7);
  });

  it("the wall's own block is not said inside the minute after the service answered open (mail 0135)", () => {
    // The person has just paid: the access read answered open and cleared the column, and a
    // facts read taken a moment before still carries it. "This subscription has ended" is false.
    const closed = blockedMailbox("account_closed");
    try {
      markOpenVerdict(storageOwner(), NOW - 10_000);
      expect(deriveMailState(inputs({ mailboxes: [closed] })).key).not.toBe("blocked");
      // Only the wall's block: any other reason is still this install's report.
      expect(deriveMailState(inputs({ mailboxes: [blockedMailbox("lease_unreadable")] })).key).toBe("blocked");
      // Past the minute, or with no open answer at all, the block is said as before.
      markOpenVerdict(storageOwner(), NOW - 61_000);
      expect(deriveMailState(inputs({ mailboxes: [closed] })).key).toBe("blocked");
      forgetOpenVerdict();
      expect(deriveMailState(inputs({ mailboxes: [closed] })).key).toBe("blocked");
    } finally {
      forgetOpenVerdict();
    }
  });

  it("NO DATE FROM BEFORE THE REOPENING: a stale mirror says `catchingUp` until a drain after the lift", () => {
    const stale = (ago: number) => inputs({ freshness: { state: "stale", asOf: new Date(NOW - ago).toISOString() } });
    try {
      // Paid 20 s ago; the mirror's last completed drain is from before the wall.
      markOpenVerdict(storageOwner(), NOW - 20_000, true);
      const walled = deriveMailState(stale(3 * 86_400_000));
      expect(walled.key, "the strip dated the closure").toBe("catchingUp");
      expect(walled.asOf).toBeNull();
      // The first drain after the lift moves `asOf` past it, and the date is said again.
      expect(deriveMailState(stale(10_000)).key).toBe("stale");
      // CONTROL: an open answer with no refusal before it keeps the date on a days-stale resume.
      forgetOpenVerdict();
      markOpenVerdict(storageOwner(), NOW - 20_000);
      expect(deriveMailState(stale(3 * 86_400_000)).key).toBe("stale");
    } finally {
      forgetOpenVerdict();
    }
  });

  it("A BLOCKED MAILBOX IS `connected` WITH NO errorCode — mail 0029's whole point", () => {
    // The anti-fix the DTO comment warns about: gate this read on `status === 'error'` and the
    // state becomes structurally unreachable, which is the 32 minutes of 2026-08-03 restored.
    const m = blockedMailbox("awaiting_credentials");
    expect(m.status).toBe("connected");
    expect(m.errorCode).toBeNull();
    expect(deriveMailState(inputs({ mailboxes: [m] })).key).toBe("blocked");
  });

  it("a reason this build does not know still gets a state, never silence", () => {
    const s = deriveMailState(inputs({
      mailboxes: [blockedMailbox("a_fourth_reason_from_a_newer_server")],
    }));
    expect(s.key, "an unrecognised reason was answered with silence").toBe("blocked");
    expect(s.reason, "and it must not be passed off as a known member").toBeNull();
  });

  it("`{reason: null, since: <ts>}` IS a block — the shape a SKEWED SERVER sends", () => {
    /**
     * THE ONE THE LADDER USED TO MISS, and the reason the fix needed no new field.
     *
     * `mailbox-service.ts:526-527` narrows the reason to this build's copy of the closed set and
     * forwards `syncBlockedSince` unconditionally. So a worker deployed ahead of the API — or an
     * API alias rolled back under a newer worker — puts exactly this on the wire, and the previous
     * `m.syncBlockedReason !== null` gate answered it with "Synced moments ago". That is the reported
     * 52-minute silence reproduced by deploy order, on the CUSTOMER's screen.
     *
     * MUTATION: revert `mail-state.ts` to gate on `syncBlockedReason` and this must go red while
     * every case above it stays green — the reason-bearing fixtures cannot tell the two gates
     * apart, which is precisely why this case has to exist separately.
     */
    const s = deriveMailState(inputs({ mailboxes: [blockedMailbox(null)] }));
    expect(s.key, "a block whose reason the server narrowed away was rendered as healthy").toBe("blocked");
    expect(s.reason, "there is no reason to report, and inventing one would be worse").toBeNull();
    // The block still carries HOW LONG, which is the whole point of the field being the predicate.
    expect(s.minutes).toBe(7);
  });

  it("mailboxError names the code, and outranks progress", () => {
    const s = deriveMailState(inputs({
      mailboxes: [mailbox({ status: "error", errorCode: "auth" })],
      growth: importingFromEmpty(495),
    }));
    expect(s.key).toBe("mailboxError");
    expect(s.errorCode).toBe("auth");
  });

  /* Review the control: the guest read a blanket "Sync failed. Retrying." beside a healthy
     engine and could not tell WHICH mailbox was failing. One healthy + one failing mailbox must
     produce the NAMED sentence — the failing row's own address, never the healthy one's and
     never the anonymous aggregate (that one is reserved for the tab's own pull loop failing,
     `sync.failures`, which this case leaves at zero). */
  it("one healthy + one failing mailbox: the strip names the FAILING one", () => {
    const s = deriveMailState(inputs({
      mailboxes: [
        mailbox({ id: "mb-ok", address: "healthy@trafficflow.invalid",
          lastSyncAt: new Date(NOW - 30_000).toISOString() }),
        mailbox({ id: "mb-bad", address: "failing@trafficflow.invalid",
          status: "error", errorCode: "connect" }),
      ],
    }));
    expect(s.key, "a failing mailbox beside a healthy one went unreported").toBe("mailboxError");
    expect(s.errorCode).toBe("connect");
    expect(s.address, "the sentence must name the failing mailbox, not the healthy one")
      .toBe("failing@trafficflow.invalid");
  });

  /* offline, the local door knows the server is unreachable from the first failed
     dial, and the list said nothing for two minutes while Settings said "Can't reach the mail
     server". The outage clock is the arm's own condition, at any age; a mailbox refused for
     another reason is named first. Mutation watched red: the `unreachableSince` half of `find`. */
  it("a server this install cannot reach is said from its first observation, on its own row", () => {
    const since = new Date(NOW - 20_000).toISOString();
    const s = deriveMailState(inputs({
      mailboxes: [
        mailbox({ id: "mb-ok", address: "healthy@trafficflow.invalid" }),
        mailbox({ id: "mb-off", address: "offline@trafficflow.invalid", unreachableSince: since }),
      ],
    }));
    expect(s.key, "an unreachable server read as a healthy mailbox").toBe("mailboxError");
    expect(s.unreachable).toBe(true);
    expect(s.errorCode).toBe("connect");
    expect(s.address).toBe("offline@trafficflow.invalid");
    // Past the local door's dead bound the row is `error`/`connect` too: still the one sentence.
    const settled = deriveMailState(inputs({
      mailboxes: [mailbox({ status: "error", errorCode: "connect", unreachableSince: since })],
    }));
    expect(settled.unreachable).toBe(true);
    // A refused sign-in elsewhere is the more specific fact and is named first.
    const refused = deriveMailState(inputs({
      mailboxes: [
        mailbox({ id: "mb-off", address: "offline@trafficflow.invalid", unreachableSince: since }),
        mailbox({ id: "mb-auth", address: "auth@trafficflow.invalid", status: "error", errorCode: "auth" }),
      ],
    }));
    expect(refused.errorCode).toBe("auth");
    expect(refused.unreachable).toBeUndefined();
    // The control: no outage clock, no sentence.
    expect(deriveMailState(inputs({ mailboxes: [mailbox()] })).key).not.toBe("mailboxError");
  });

  it("a `disabled` mailbox is not a mailbox for any of this", () => {
    expect(
      deriveMailState(inputs({ mailboxes: [mailbox({ status: "disabled" })], mirrored: 0 })).key,
    ).toBe("noMailbox");
  });

  /* ── A SUPERSEDED TOMBSTONE DOES NOT GET TO SPEAK ────────────────────────────────────────
   *
   * The stand-down arm scans EVERY mailbox rather than the live ones, deliberately — a stood-down
   * row is `disabled` and dropping it once made the strip say "No mailbox connected" to somebody
   * who had one. What it did not do is notice that the SAME ADDRESS can be back.
   *
   * That pairing is not exotic, it is the supported repair. `mailboxes_active_address_uq` is
   * unique only `WHERE status <> 'disabled'` (`packages/db/src/schema-mail.ts:446`) precisely so
   * that reconnecting an address does not "fail forever against its own tombstone" — so the dead
   * row survives, keeps `organized_elsewhere:*` for ever, and this arm outranks everything below
   * it. Measured live before the fix: Settings → Mailboxes said `connected · N messages ·
   * Synced just now` while the rail said that same address was not organized here.
   */
  it("a stood-down row is SILENT once the same address is connected again", () => {
    const s = deriveMailState(inputs({
      mailboxes: [
        mailbox({ id: "old", address: "louis@example.invalid", status: "disabled",
                  disabledReason: "organized_elsewhere:local" }),
        mailbox({ id: "new", address: "louis@example.invalid", status: "connected",
                  lastSyncAt: new Date(NOW - 5_000).toISOString() }),
      ],
      mirrored: 11,
    }));
    expect(s.key, "a tombstone spoke over the live row that replaced it").not.toBe("blocked");
  });

  /* ── CASE FOLDS, AND WHITESPACE DOES NOT — BOTH BECAUSE THE INDEX SAYS SO ───────────────
   *
   * These two asserted the OPPOSITE of each other for one round each, which is the useful part.
   *
   * Round 1 folded on case and on trim. Round 2, answering a review, made it exact on both. Round
   * 3 is neither of my answers: `addressKey` already existed for exactly this question in
   * `MailboxSection.tsx`, and it folds case and NOT whitespace — the pane and this rail are on
   * one screen, so a rail with its own rule is how one mailbox gets two contradictory sentences.
   *
   * The asymmetry is the index's, not a preference. `mailboxes_active_address_uq` is unique on
   * `lower(address)` where the row is not disabled, so two rows differing only in case cannot
   * both be active and folding them is safe; a row differing by surrounding space is one Postgres
   * considers DISTINCT and will happily keep active, so folding THAT would hide a real mailbox.
   * A grouping may be narrower than the constraint; never wider. */
  it("a case difference folds, because the index folds — the pane's rule, not a second one", () => {
    const s = deriveMailState(inputs({
      mailboxes: [
        mailbox({ id: "old", address: "Louis@Example.invalid", status: "disabled",
                  disabledReason: "organized_elsewhere:local" }),
        mailbox({ id: "new", address: "louis@example.invalid", status: "connected",
                  lastSyncAt: new Date(NOW - 5_000).toISOString() }),
      ],
      mirrored: 11,
    }));
    expect(s.key, "a case-variant tombstone spoke over the row that replaced it").not.toBe("blocked");
  });

  it("but surrounding whitespace does NOT fold — that row is one the database keeps active", () => {
    const s = deriveMailState(inputs({
      mailboxes: [
        mailbox({ id: "old", address: "  louis@example.invalid  ", status: "disabled",
                  disabledReason: "organized_elsewhere:local" }),
        mailbox({ id: "new", address: "louis@example.invalid", status: "connected",
                  lastSyncAt: new Date(NOW - 5_000).toISOString() }),
      ],
      mirrored: 11,
    }));
    expect(s.key, "a trimmed fold hid a mailbox the index treats as distinct").toBe("blocked");
    expect(s.address).toBe("  louis@example.invalid  ");
  });

  /* THE INVARIANT BEHIND BOTH, pinned as itself rather than left to two tables of examples: the
   * rail folds with the SAME function the Mailboxes pane groups with. A future edit to either
   * that reintroduces a private copy reds here, which no example-based case can promise. */
  it("and the rail folds with the Mailboxes pane's own key, not a copy of it", async () => {
    const shell = await import("../app/shell/address-key");
    const pane = await import("../app/(product)/mailbox/MailboxSection");
    expect(pane.addressKey, "the pane no longer re-exports the shared key").toBe(shell.addressKey);
    expect(shell.addressKey("  A@B.test  ")).toBe("  a@b.test  ");
  });

  /* AND THE SOURCE CHECK, because the runtime one above CANNOT reach this half and saying so is
   * the point. The identity assertion proves the pane and the shell share one function object; it
   * would stay green if THIS module quietly inlined `address.toLowerCase()`, because a private
   * copy behaves identically until the shared rule changes — which is precisely the divergence
   * this whole slice exists to prevent, arriving silently. Nothing behavioural can see it, so the
   * check reads the source, in the same spirit as the desktop shell's filesystem census. It pins
   * the IMPORT and the two CALLS, not the word, so the prose above may say `addressKey` freely. */
  it("and mail-state calls the shared key rather than keeping a private copy", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../app/shell/mail-state.ts", import.meta.url), "utf8",
    );
    expect(src, "mail-state no longer imports the shared grouping key")
      .toContain('import { addressKey } from "./address-key"');
    expect(src.match(/addressKey\(/g)?.length ?? 0,
      "the stand-down arm should CALL addressKey on both sides of its comparison")
      .toBeGreaterThanOrEqual(2);
    expect(src, "a private lower-casing of an address came back into this module")
      .not.toMatch(/\.address\.toLowerCase\(\)/);
  });

  /* The other direction, and it is the half that keeps the fix from being a deletion: a
   * stand-down with NO live row for its address is the case the arm was written for, and it must
   * still speak — including while a DIFFERENT mailbox is perfectly healthy. */
  it("but a stand-down with no live row for ITS address still speaks, beside a healthy sibling", () => {
    const s = deriveMailState(inputs({
      mailboxes: [
        mailbox({ id: "gone", address: "peter@example.invalid", status: "disabled",
                  disabledReason: "organized_elsewhere:local" }),
        mailbox({ id: "fine", address: "sarah@example.invalid", status: "connected",
                  lastSyncAt: new Date(NOW - 5_000).toISOString() }),
      ],
      mirrored: 16,
    }));
    expect(s.key).toBe("blocked");
    expect(s.address).toBe("peter@example.invalid");
  });

  it("STATE 2 KEYS ON THE MIRROR — the stamp is irrelevant in BOTH polarities", () => {
    // The whole slice, as one assertion pair. The stubs CONTRADICT each other on purpose: a
    // consistent fixture would pass whichever field the code read.
    const stamped = new Date(NOW - 1_000).toISOString();
    const growing = deriveMailState(inputs({
      mailboxes: [mailbox({ lastSyncAt: stamped })],  // "synced 1 second ago"
      mirrored: 6,
      growth: importingFromEmpty(6),                  // …and the mirror is climbing
    }));
    expect(growing.key, "a fresh stamp suppressed a growing mirror").toBe("importing");
    expect(growing.count).toBe(6);

    const flat = deriveMailState(inputs({
      mailboxes: [mailbox({ lastSyncAt: null })],     // "never synced"
      mirrored: 495,
      growth: seedGrowth(495),                        // …and the mirror is not moving
    }));
    expect(flat.key, "a null stamp invented an import over a still mirror").not.toBe("importing");
  });

  it("awaiting says HOW LONG, from the mailbox's own createdAt", () => {
    const s = deriveMailState(inputs({
      mailboxes: [mailbox({ createdAt: new Date(NOW - 240_000).toISOString() })],
      mirrored: 0,
      growth: seedGrowth(0),
    }));
    expect(s.key).toBe("awaiting");
    expect(s.minutes, "the elapsed time is the only thing that stops this being a dead string").toBe(4);
    expect(s.slow).toBe(false);
    expect(s.address).toBe("desk@trafficflow.invalid");
  });

  it("…and escalates past AWAITING_SLOW_MS without claiming a failure", () => {
    const s = deriveMailState(inputs({
      mailboxes: [mailbox({ createdAt: new Date(NOW - AWAITING_SLOW_MS - 1_000).toISOString() })],
      mirrored: 0,
      growth: seedGrowth(0),
    }));
    expect(s.key).toBe("awaiting");
    expect(s.slow).toBe(true);
    expect(s.errorCode, "an unfinished first sync was reported as an error").toBeNull();
  });

  it("SIX MINUTES OF AN EMPTY MIRROR IS NOT SLOW — a first attach was measured at 358 s", () => {
    const s = deriveMailState(inputs({
      mailboxes: [mailbox({ createdAt: new Date(NOW - 373_000).toISOString() })],
      mirrored: 0,
      growth: seedGrowth(0),
    }));
    expect(s.key).toBe("awaiting");
    expect(s.slow, "a healthy large-mailbox first import was dressed as a fault").toBe(false);
  });

  it("a completed cycle over an empty mailbox is QUIET, not 'waiting' for ever", () => {
    const s = deriveMailState(inputs({
      mailboxes: [mailbox({ lastSyncAt: new Date(NOW - 60_000).toISOString() })],
      mirrored: 0,
      growth: seedGrowth(0),
    }));
    expect(s.key, "an empty mailbox that HAS synced was told it was still waiting").toBe("quiet");
  });

  it("with two mailboxes, one synced and one not, the strip says nothing about either", () => {
    // Deliberate: `some` would attribute the other mailbox's messages to this one. The
    // per-mailbox sentence is the ROW's, and `MailboxSection` renders it.
    const s = deriveMailState(inputs({
      mailboxes: [
        mailbox({ address: "old@x.invalid", lastSyncAt: new Date(NOW - 60_000).toISOString() }),
        mailbox({ address: "new@x.invalid", lastSyncAt: null }),
      ],
      mirrored: 0,
      growth: seedGrowth(0),
    }));
    expect(s.key).toBe("quiet");
  });

  it("the Screener pointer is a CANDIDATE and needs mail to exist", () => {
    const withMail = deriveMailState(inputs({ mirrored: 495, growth: seedGrowth(495) }));
    expect(withMail.key).toBe("quiet");
    expect(withMail.screenerCandidate).toBe(true);
    expect(withMail.count).toBe(495);

    const empty = deriveMailState(inputs({
      mailboxes: [mailbox({ lastSyncAt: new Date(NOW - 60_000).toISOString() })],
      mirrored: 0,
      growth: seedGrowth(0),
    }));
    expect(empty.screenerCandidate, "offered to explain where mail went when none had arrived")
      .toBe(false);
  });

  it("the import FLOOR speaks 'importing' when the server has not stamped the import done", () => {
    // The disclosure case. A cycle has run (`lastSyncAt` set), this client's growth has lapsed
    // (`seedGrowth(300)` is settled), and the mirror has content — but the server still holds a
    // PARTIAL mailbox (`initial_import_completed_at` null). Pre-O2 this fell through to the Screener
    // pointer and the hole read as the whole of the mailbox.
    const s = deriveMailState(inputs({
      mailboxes: [mailbox({
        lastSyncAt: new Date(NOW - 60_000).toISOString(),
        initialImportCompletedAt: null,
      })],
      mirrored: 300,
      growth: seedGrowth(300),
    }));
    expect(s.key, "a partial mailbox with a settled mirror read as complete").toBe("importing");
    expect(s.count).toBe(300);
  });

  it("the floor STOPS once the server stamps the import done — the Screener pointer instead", () => {
    const s = deriveMailState(inputs({
      mailboxes: [mailbox({
        lastSyncAt: new Date(NOW - 60_000).toISOString(),
        initialImportCompletedAt: new Date(NOW - 30_000).toISOString(),
      })],
      mirrored: 300,
      growth: seedGrowth(300),
    }));
    expect(s.key).toBe("quiet");
    expect(s.screenerCandidate).toBe(true);
  });

  it("the floor does NOT fire over an EMPTY mirror — there is no partial mailbox to disclose", () => {
    // `mirrored: 0` — the floor's `some` must not override the `awaiting` arm's deliberate `every`
    // and announce an account-wide import over a mirror with nothing in it.
    const s = deriveMailState(inputs({
      mailboxes: [mailbox({
        lastSyncAt: new Date(NOW - 60_000).toISOString(),
        initialImportCompletedAt: null,
      })],
      mirrored: 0,
      growth: seedGrowth(0),
    }));
    expect(s.key, "'importing' announced over a mirror with nothing in it").toBe("quiet");
  });

  it("a MISSING stamp (a server older than the column) degrades to growth-only, not a false import", () => {
    // `undefined !== null`, so a deploy skew where the field is absent behaves exactly as before the stamp.
    const bare = { ...mailbox({ lastSyncAt: new Date(NOW - 60_000).toISOString() }) } as Record<string, unknown>;
    delete bare.initialImportCompletedAt;
    const s = deriveMailState(inputs({
      mailboxes: [bare as unknown as MailboxFacts],
      mirrored: 300,
      growth: seedGrowth(300),
    }));
    expect(s.key, "an omitted stamp was read as null and announced a false import").toBe("quiet");
  });

  it("`some`: with two mailboxes, one done and one still importing, the account is importing", () => {
    const s = deriveMailState(inputs({
      mailboxes: [
        mailbox({
          address: "done@x.invalid", lastSyncAt: new Date(NOW - 60_000).toISOString(),
          initialImportCompletedAt: new Date(NOW - 30_000).toISOString(),
        }),
        mailbox({
          address: "importing@x.invalid", lastSyncAt: new Date(NOW - 60_000).toISOString(),
          initialImportCompletedAt: null,
        }),
      ],
      mirrored: 300,
      growth: seedGrowth(300),
    }));
    expect(s.key).toBe("importing");
  });

  /* ────────────────────────────────────────────────────────────────────────────────────────
     THE FLOOR IS BOUNDED — a stamp that never lands must not become a permanent sentence.

     Seen on a live account: two connected mailboxes, one stamped, one that had gone FOUR
     DAYS without the worker reaching a no-backlog cycle. The unstamped one held the strip at
     "Syncing your mail. N messages so far" for ever, over a mirror that was complete and
     readable, and the arm's `some` spread it across the stamped mailbox beside it.

     `createdAt` is the axis these turn on, so every case below states it explicitly rather than
     inheriting the fixture's sixty seconds.
     ──────────────────────────────────────────────────────────────────────────────────────── */

  /** An unstamped mailbox connected long enough ago that the absolute window has expired. */
  const staleImport = (over: Partial<MailboxFacts> = {}): MailboxFacts =>
    mailbox({
      lastSyncAt: new Date(NOW - 60_000).toISOString(),
      initialImportCompletedAt: null,
      createdAt: new Date(NOW - IMPORT_FLOOR_MAX_MS - 3_600_000).toISOString(),
      ...over,
    });

  it("RELEASES the floor once the import is implausible and the client can corroborate", () => {
    // The reported defect, at its smallest. Unstamped and old; this tab has drained (`bootstrapping`
    // false) with a healthy loop (`failures` 0); the mirror is settled, so `seedGrowth` leaves
    // `lastRiseAt` at -Infinity and it reads as motionless. Nothing here is evidence of work.
    const s = deriveMailState(inputs({
      mailboxes: [staleImport()],
      mirrored: 5_193,
      growth: seedGrowth(5_193),
    }));
    expect(s.key, "a permanent import was announced over a finished mirror").toBe("quiet");
    expect(s.screenerCandidate).toBe(true);
  });

  it("A WINDOWED ACCOUNT: a bounded mirror beside a stamped sibling says nothing permanent", () => {
    // The shape production actually held — one stamped mailbox, one that never was — with a mirror
    // smaller than the account's true size because the snapshot window is bounded (by its row floor or
    // its day window). The windowed count must not, on its own or through the `some`, produce a standing
    // sentence: the mirror can never reach the account's size, so any rule that waited for it to
    // would wait for ever. Nothing in the ladder compares the two, and this pins that.
    const s = deriveMailState(inputs({
      mailboxes: [
        staleImport({ address: "stamped@x.invalid", id: "mb-done",
          initialImportCompletedAt: new Date(NOW - 200_000).toISOString() }),
        staleImport({ address: "never@x.invalid", id: "mb-stuck" }),
      ],
      mirrored: 5_193,
      growth: seedGrowth(5_193),
    }));
    expect(s.key, "one unstamped mailbox spoke for the whole account, for ever").toBe("quiet");
  });

  it("HOLDS the floor inside the absolute window — mail 0038 is untouched", () => {
    // Connected an hour ago. No corroboration is consulted at all: this is the case the floor was
    // written for, and its behaviour has to be bit-for-bit what it was.
    //
    // The age is an ABSOLUTE hour and deliberately NOT `NOW - IMPORT_FLOOR_MAX_MS + …`. Expressing
    // it relative to the constant under test moves the fixture whenever the constant is mutated —
    // shrinking the bound to zero pushed `createdAt` into the FUTURE and the test passed for a
    // reason that had nothing to do with the code. It was written that way first, and the mutation
    // run is the only thing that found it.
    const s = deriveMailState(inputs({
      mailboxes: [staleImport({ createdAt: new Date(NOW - 3_600_000).toISOString() })],
      mirrored: 300,
      growth: seedGrowth(300),
    }));
    expect(s.key, "a mailbox still plausibly importing was called done").toBe("importing");
    expect(s.count).toBe(300);
  });

  it("HOLDS while this tab has not completed a drain — it has observed nothing yet", () => {
    const s = deriveMailState(inputs({
      sync: { bootstrapping: true, failures: 0, terminal: false, refused: false, ownerLost: false },
      mailboxes: [staleImport()],
      mirrored: 300,
      growth: seedGrowth(300),
    }));
    expect(s.key, "a mid-bootstrap tab released a floor on evidence it did not have").toBe("importing");
  });

  it("HOLDS while drains are FAILING below the streak — a frozen mirror is not a quiet server", () => {
    // `failing` needs `failureStreak` consecutive failures, so one or two land HERE with the mirror
    // frozen for the wrong reason. A still `lastRiseAt` is then absence of observation, and reading
    // it as evidence would be believing a broken instrument.
    const s = deriveMailState(inputs({
      sync: { bootstrapping: false, failures: 1, terminal: false, refused: false, ownerLost: false },
      mailboxes: [staleImport()],
      mirrored: 300,
      growth: seedGrowth(300),
    }));
    expect(s.key, "a frozen mirror was read as a finished import").toBe("importing");
  });

  it("HOLDS while the mirror is still MOVING past the window", () => {
    // One rise, thirty seconds ago: not enough to be `growing` (that needs two), so the arm above
    // does not fire and this one is reached — and mail is plainly still landing.
    const moving = growthStep(seedGrowth(300), 301, NOW - 30_000);
    const s = deriveMailState(inputs({
      mailboxes: [staleImport()], mirrored: 301, growth: moving,
    }));
    expect(s.key, "a mirror that was still filling was called done").toBe("importing");
  });

  it("a MISSING stamp past the window still degrades to growth-only, never to a false import", () => {
    // The deploy-skew rule, re-proved on the far side of the bound: `undefined !== null` leaves the
    // helper at its first line, so an absent column cannot reach the corroboration path at all.
    const bare = { ...staleImport() } as Record<string, unknown>;
    delete bare.initialImportCompletedAt;
    const s = deriveMailState(inputs({
      mailboxes: [bare as unknown as MailboxFacts], mirrored: 300, growth: seedGrowth(300),
    }));
    expect(s.key, "an omitted stamp was read as null").toBe("quiet");

    // …and the absent field must leave the helper at its FIRST line, before corroboration is even
    // consulted. Without this second half the case is insensitive to the rule it names: a loose
    // `!= null` would fall through to a corroboration path that also happens to end in `quiet`, so
    // the assertion above passes while the deploy-skew guarantee is gone. `bootstrapping` makes the
    // two paths disagree — short-circuit says quiet, fall-through says "importing".
    const mid = deriveMailState(inputs({
      sync: { bootstrapping: true, failures: 0, terminal: false, refused: false, ownerLost: false },
      mailboxes: [bare as unknown as MailboxFacts], mirrored: 300, growth: seedGrowth(300),
    }));
    expect(mid.key, "an omitted stamp reached the corroboration path instead of short-circuiting")
      .toBe("quiet");
  });

  it("the release is PER MAILBOX: a fresh connect keeps its floor beside a released sibling", () => {
    const s = deriveMailState(inputs({
      mailboxes: [
        staleImport({ address: "old@x.invalid", id: "mb-old" }),
        // Connected a minute ago and not yet stamped — squarely inside the window.
        mailbox({ address: "new@x.invalid", id: "mb-new", initialImportCompletedAt: null,
          lastSyncAt: new Date(NOW - 10_000).toISOString() }),
      ],
      mirrored: 300,
      growth: seedGrowth(300),
    }));
    expect(s.key, "an account-wide release stripped a fresh mailbox of its floor").toBe("importing");
  });

  it("an UNREADABLE `createdAt` takes the corroborated path, not the absolute one", () => {
    // `new Date("nonsense").getTime()` is NaN, and `now - NaN < bound` is false — so the window is
    // skipped. That is the intended branch (the alternative is a permanent banner for a mailbox
    // whose clock cannot be read) and it is safe only because corroboration still gates it. Pinned
    // in BOTH polarities so it stays a decision rather than an accident of the arithmetic.
    const undated = staleImport({ createdAt: "not-a-date" });
    const released = deriveMailState(inputs({
      mailboxes: [undated], mirrored: 300, growth: seedGrowth(300),
    }));
    expect(released.key, "an unreadable clock produced a permanent banner").toBe("quiet");

    const held = deriveMailState(inputs({
      sync: { bootstrapping: true, failures: 0, terminal: false, refused: false, ownerLost: false },
      mailboxes: [undated], mirrored: 300, growth: seedGrowth(300),
    }));
    expect(held.key, "the corroboration gate was skipped along with the window").toBe("importing");
  });

  it("the floor state carries `clock: true`, which is the only reason the release ever paints", () => {
    // The release is driven by elapsed time and nothing else. Without this flag `MailStateProvider`
    // arms no interval, and the bound would pass every test here while never firing on an idle tab.
    const s = deriveMailState(inputs({
      // An absolute hour, for the reason the window test above records.
      mailboxes: [staleImport({ createdAt: new Date(NOW - 3_600_000).toISOString() })],
      mirrored: 300,
      growth: seedGrowth(300),
    }));
    expect(s.key).toBe("importing");
    expect(s.clock, "the strip would never re-derive and the floor would never lift").toBe(true);
  });

  it("TIME ALONE lifts it: the same inputs, two instants either side of the bound", () => {
    // Every input is shared except `now` — which is exactly what the provider's clock beat changes.
    const facts = [staleImport({
      createdAt: new Date(NOW - IMPORT_FLOOR_MAX_MS).toISOString(),
    })];
    const at = (now: number) =>
      deriveMailState(inputs({ mailboxes: facts, mirrored: 300, growth: seedGrowth(300), now }));

    expect(at(NOW - 3_600_000).key, "released before the window had expired").toBe("importing");
    expect(at(NOW + 1_000).key, "the clock advanced past the bound and nothing lifted").toBe("quiet");
  });

  it("`screenerCandidate` is not a strip state and can never become one", () => {
    // It is a statement about the OHBOX. Rendered above the deck it would tell somebody
    // standing in the Screener that everything is in the Screener.
    expect(stripSpeaks("quiet")).toBe(false);
    for (const key of ["stopped", "failing", "blocked", "mailboxError", "noMailbox", "importing", "awaiting"] as const) {
      expect(stripSpeaks(key), `${key} is a strip state`).toBe(true);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE TWO CROSS-BOUNDARY CLAIMS — read as TEXT, because this app has no `@trafficflow/*` dep
   ══════════════════════════════════════════════════════════════════════════════════════════

   `apps/webapp` deliberately declares no dependency on the backend packages
   (`published-retention-claims.test.ts` sets out why), and `moduleResolution: bundler` with no
   path for them means an import here would not even typecheck. So the source is read and the
   literals extracted — the same technique that file uses. Each extractor asserts that it FOUND
   something first: a probe that finds nothing is a claim about the probe. */

const dbSource = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../packages/db/src/${rel}`, import.meta.url)), "utf8");

/** Pull the members of an `export const NAME = [ … ] as const;` array out of TS source. */
function constArray(source: string, name: string): string[] {
  const block = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`).exec(source);
  expect(block, `${name} is no longer an \`export const … = [ … ] as const\` — rewrite this guard`)
    .not.toBeNull();
  const members = [...block![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
  expect(members.length, `extracted no members from ${name} — the guard is broken, not the code`)
    .toBeGreaterThan(1);
  return members;
}

/**
 * ═══ `settled` — MAY A PANE CALL AN EMPTY LIST EMPTY? ══════════════════════════════════════
 *
 * The flag itself. `pending-is-not-empty.test.tsx` owns whether anything RENDERS it, which is a
 * different property and the one every previous repair in this area lost.
 *
 * Both polarities are asserted for every arm, because the two failure modes are opposite and a
 * one-sided guard catches only one of them: stuck false is a mailbox that spins for ever, stuck
 * true is the reported defect back.
 */
describe("`settled` — the third state the panes used to collapse", () => {
  it("is false while the tab's first drain has not completed", () => {
    // The reported case: a RETURNING account (synced before), mirror not yet read, `/sync` in
    // flight. Every arm of the ladder falls through to `quiet` here, which is why the strip
    // says nothing and the pane was left alone with a false sentence.
    const s = deriveMailState(inputs({
      sync: { bootstrapping: true, failures: 0, terminal: false, refused: false, ownerLost: false },
      // No completion stamp anywhere: the promoted settled rule (INSTANT-ARCH §6.6, pinned in
      // freshness-label.test.tsx) counts a drained-once mirror as settled evidence, and THIS
      // block's subject is the mirror nothing has ever read.
      freshness: { state: "unknown" as const, asOf: null },
      engineFreshness: { state: "unknown" as const, asOf: null },
      mirrored: 0,
      growth: seedGrowth(0),
    }));
    expect(s.key, "the ladder found something to say — this fixture is not the reported case")
      .toBe("quiet");
    expect(s.settled, "an empty list was declared settled before anything had been read")
      .toBe(false);
  });

  it("is true the moment one drain has completed, whatever the mirror holds", () => {
    const empty = deriveMailState(inputs({ mirrored: 0, growth: seedGrowth(0) }));
    expect(empty.settled, "a genuinely empty mailbox was left spinning").toBe(true);
    expect(deriveMailState(inputs()).settled).toBe(true);
  });

  it("is true for the demo and the desktop, which have no sync to wait for", () => {
    // A fixtures engine publishes `SYNC_SETTLED`, so this needs no special case in the
    // derivation — and this asserts that rather than trusting it.
    expect(deriveMailState(inputs({ demo: true })).settled).toBe(true);
  });

  it("is true once the loop is FAILING, so nothing can spin for ever", () => {
    /**
     * `bootstrapping` never clears while every drain fails. Keyed on it alone, a mailbox with no
     * network would say "loading" until the tab was closed — the reported lie traded for a worse
     * one. `failing` is exactly the state in which the strip is already explaining that the
     * mirror is frozen, so from there an empty list is as settled as it will ever get.
     */
    const s = deriveMailState(inputs({
      sync: { bootstrapping: true, failures: 3, terminal: false, refused: false, ownerLost: false },
      mirrored: 0,
      growth: seedGrowth(0),
    }));
    expect(s.key).toBe("failing");
    expect(s.settled).toBe(true);
  });

  it("is true once the loop has STOPPED, for the same reason", () => {
    const s = deriveMailState(inputs({
      sync: { bootstrapping: true, failures: 1, terminal: true, refused: false, ownerLost: false },
      mirrored: 0,
      growth: seedGrowth(0),
    }));
    expect(s.key).toBe("stopped");
    expect(s.settled).toBe(true);
  });

  it("a single coded refusal does NOT settle it — one refusal is not an answer either", () => {
    // Was the weaker claim: a single `refused` reached `failing` and so settled the list. It no
    // longer reaches `failing` (a transient refusal is not a sustained failure), so it no longer
    // settles the list — which is correct: while a first drain is still bootstrapping, a refusal
    // one request old says nothing about whether the mailbox is empty. `settled` reads the ladder's
    // KEY, so this follows for free from the `failing` arm and cannot drift from it. It is the same
    // answer as the plain blip below, which is the point — a refused blip and a network blip are
    // both one request's evidence.
    const s = deriveMailState(inputs({
      sync: { bootstrapping: true, failures: 1, terminal: false, refused: true, ownerLost: false },
      freshness: { state: "unknown" as const, asOf: null },
      engineFreshness: { state: "unknown" as const, asOf: null },
      mirrored: 0,
      growth: seedGrowth(0),
    }));
    expect(s.key).not.toBe("failing");
    expect(s.settled).toBe(false);
  });

  it("a single BLIP does not settle it — one dropped packet is not an answer", () => {
    // Below the streak the ladder is still `quiet`/`awaiting`, the loop intends to try again,
    // and nothing has been read. Withholding is right.
    const s = deriveMailState(inputs({
      sync: { bootstrapping: true, failures: 1, terminal: false, refused: false, ownerLost: false },
      freshness: { state: "unknown" as const, asOf: null },
      engineFreshness: { state: "unknown" as const, asOf: null },
      mirrored: 0,
      growth: seedGrowth(0),
    }));
    expect(s.settled).toBe(false);
  });

  it("every state carries it — a new arm cannot forget the flag", () => {
    /**
     * The stamp is applied by `deriveMailState`'s wrapper, over `climb`'s ten returns. This is
     * the assertion that makes that structural rather than a convention: it walks the arms that
     * are reachable mid-bootstrap and requires the field to be a real boolean in each.
     */
    const boot = { bootstrapping: true, failures: 0, terminal: false, refused: false, ownerLost: false };
    // Unknown freshness on every arm — this walk's subject is the FIRST-EVER bootstrap, and a
    // completion stamp would settle each of them by the promoted rule (freshness-label.test.tsx).
    const fresh = { freshness: { state: "unknown" as const, asOf: null }, engineFreshness: { state: "unknown" as const, asOf: null } };
    const arms: Array<[string, ReturnType<typeof deriveMailState>]> = [
      ["quiet/unknown mailboxes", deriveMailState(inputs({ sync: boot, ...fresh, mailboxes: null }))],
      ["noMailbox", deriveMailState(inputs({ sync: boot, ...fresh, mailboxes: [] }))],
      ["mailboxError", deriveMailState(inputs({
        sync: boot, ...fresh,
        mailboxes: [mailbox({ status: "error", errorCode: "auth_failed" })],
      }))],
      ["awaiting", deriveMailState(inputs({ sync: boot, ...fresh, mirrored: 0, growth: seedGrowth(0) }))],
      ["importing", deriveMailState(inputs({
        sync: boot, ...fresh, mirrored: 60, growth: importingFromEmpty(60),
      }))],
    ];
    for (const [name, s] of arms) {
      expect(typeof s.settled, `${name} carries no \`settled\``).toBe("boolean");
      expect(s.settled, `${name} settled itself while bootstrapping`).toBe(false);
    }
  });
});

describe("the closed set this client re-declares must be THE closed set", () => {
  it("SYNC_BLOCK_REASONS is MAILBOX_SYNC_BLOCK_REASONS, member for member", () => {
    // the brief names the failure this prevents: a fourth `status` value would have rendered
    // the literal key path `status_xxx` in the product. This client cannot import the owning
    // module, so drift has to be a red test instead.
    const owned = constArray(dbSource("mailbox-errors.ts"), "MAILBOX_SYNC_BLOCK_REASONS");
    expect([...SYNC_BLOCK_REASONS]).toEqual(owned);
  });

  it("every reason has a sentence — no member may render a key path", () => {
    const owned = constArray(dbSource("mailbox-errors.ts"), "MAILBOX_SYNC_BLOCK_REASONS");
    const sync = messages.sync as unknown as Record<string, string>;
    for (const reason of owned) {
      expect(sync[`blocked_${reason}`], `sync.blocked_${reason} is missing`).toBeTruthy();
    }
    expect(sync.blockedUnknown, "and a server-side fourth reason needs a fallback").toBeTruthy();
  });

  it("Settings → Mailboxes gates its ROW on the timestamp too (SOURCE, a weaker guard)", () => {
    /**
     * THE SECOND CONSUMER, AND THE ONE NOTHING IN THIS REPOSITORY RENDERS.
     *
     * `mail-state.ts` owns the account-wide strip and the ladder above proves it. `MailboxSection`
     * owns the PER-ROW sentence in Settings → Mailboxes, from the same two fields, with its own
     * gate — and mounting that pane needs `mailboxApi`, the step-up ceremony and a provider tree
     * neither `sync-progress.test.ts` nor `sync-visible.test.ts` builds.
     *
     * FOUND BY MUTATION, NOT BY READING: reverting that gate to `m.syncBlockedReason` left ALL 597
     * webapp tests green. A source assertion proves the file mentions the right field, not that a
     * customer sees the sentence — strictly weaker than the operator console's own render test
     * does for the console's equivalent, and said out loud here so the next reader does not mistake
     * it for a render guard. A render harness for this pane is owed.
     */
    const src = readFileSync(
      fileURLToPath(new URL("../app/(product)/mailbox/MailboxSection.tsx", import.meta.url)),
      "utf8",
    );
    const branch = src.match(/\) : m\.syncBlocked[A-Za-z]+ \?/)?.[0] ?? "";
    expect(branch, "the mailbox row no longer has a sync-block branch at all").not.toBe("");
    expect(
      branch,
      "the row gates on `syncBlockedReason`, so a mailbox whose reason the server narrowed away " +
        "renders as `Synced N minutes ago` in Settings → Mailboxes — the hidden-block defect, on the one " +
        "surface a customer opens to check the mailbox they already think is broken.",
    ).toBe(") : m.syncBlockedSince ?");
  });

  it("every mailbox error code has a sentence — the strip renders the SAME keys as the rows", () => {
    const codes = constArray(dbSource("mailbox-errors.ts"), "MAILBOX_ERROR_CODES");
    const mb = messages.mailboxes as unknown as Record<string, string>;
    for (const code of codes) {
      expect(mb[`err_${code}`], `mailboxes.err_${code} is missing`).toBeTruthy();
    }
    // `toDTO` coerces a null code on an `error` row to "unknown", and the ladder does too.
    expect(mb.err_unknown).toBeTruthy();
  });

  it("THE DEAD STRING IS GONE, and nothing renders it", () => {
    const mb = messages.mailboxes as unknown as Record<string, string>;
    expect(mb.syncPending, 'the "Waiting for first sync" key is still in en.json').toBeUndefined();
    const flat = JSON.stringify(messages);
    expect(flat, "the sentence survived under another key").not.toContain("Waiting for first sync");
  });
});

describe("the escalation must speak before we page ourselves", () => {
  it("AWAITING_SLOW_MS is under the syncLag alert threshold", () => {
    // the `syncBlockGraceMs < DEFAULT_ALERT_THRESHOLDS.syncLagMs`, one layer up. If the alert
    // fires before the SCREEN has escalated, the user is again the last to know — which is
    // exactly the 32 minutes of 2026-08-03.
    const src = dbSource("alerts.ts");
    const m = /syncLagMs:\s*(\d+)\s*\*\s*60\s*\*\s*1000/.exec(src);
    expect(m, "syncLagMs is no longer written as <minutes> * 60 * 1000 — rewrite this guard")
      .not.toBeNull();
    const syncLagMs = Number(m![1]) * 60_000;
    expect(syncLagMs).toBeGreaterThan(0);
    expect(AWAITING_SLOW_MS).toBeLessThan(syncLagMs);
  });

  it("and the growth window must outlast a poll period, or a batch gap reads as a stall", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../app/shell/sync-scheduler.ts", import.meta.url)),
      "utf8",
    );
    const m = /export const POLL_MS = ([\d_]+);/.exec(src);
    expect(m, "POLL_MS is no longer a plain literal — rewrite this guard").not.toBeNull();
    const pollMs = Number(m![1]!.replace(/_/g, ""));
    expect(pollMs).toBeGreaterThan(0);
    expect(GROWTH_WINDOW_MS, "one missed poll would flip `importing` off").toBeGreaterThan(pollMs * 2);
  });

  it("and the EPISODE window must outlast a WORKER cycle, or an import flaps between them", () => {
    /**
     * the anchor, checked against the worker's own source rather than against a sentence.
     *
     * The quiet gap in the middle of an import is one worker cycle: `apps/worker/src/index.ts`
     * kicks `cycle()` on `pollIntervalMs`, and the client then needs up to one `POLL_MS` to see
     * what that cycle wrote. A window shorter than the sum is a window that ends the import
     * between two cycles OF THE SAME IMPORT, which is the measured defect.
     *
     * ── WHAT THIS GUARD DOES NOT COVER, SAID HERE SO NOBODY OVER-READS IT ────────────────
     *
     * It reads the DEFAULT — `DEFAULT_POLL_INTERVAL_MS`. A deployment that sets `POLL_INTERVAL_MS`
     * higher moves the real gap and this guard will not notice, because the client has no way to
     * learn the worker's cadence at runtime and inventing a channel for it would be a far larger
     * change than the one it protects. So: this bounds the shipped default, and nothing more.
     */
    const worker = readFileSync(
      fileURLToPath(new URL("../../worker/src/config.ts", import.meta.url)),
      "utf8",
    );
    const m = /export const DEFAULT_POLL_INTERVAL_MS = ([\d_]+);/.exec(worker);
    expect(m, "the worker's poll default is no longer written that way — rewrite this guard")
      .not.toBeNull();
    // The resolved value is bound once and the returned config carries that binding.
    expect(worker, "the default is not the one loadConfig reads")
      .toMatch(/const pollIntervalMs = pollIntervalMsFrom\(env\);[\s\S]*?\n  return \{[\s\S]*?\n    pollIntervalMs,\n/);
    const workerCycleMs = Number(m![1]!.replace(/_/g, ""));
    expect(workerCycleMs).toBeGreaterThan(0);

    const src = readFileSync(
      fileURLToPath(new URL("../app/shell/sync-scheduler.ts", import.meta.url)),
      "utf8",
    );
    const p = /export const POLL_MS = ([\d_]+);/.exec(src);
    expect(p, "POLL_MS is no longer a plain literal — rewrite this guard").not.toBeNull();
    const pollMs = Number(p![1]!.replace(/_/g, ""));

    expect(
      IMPORT_END_IDLE_MS,
      "one worker cycle plus one client poll reads as the END of an import — the import flap",
    ).toBeGreaterThan(workerCycleMs + pollMs);
    expect(
      IMPORT_END_IDLE_MS,
      "the episode window must outlast the run window or the latch is dead code",
    ).toBeGreaterThan(GROWTH_WINDOW_MS);
  });
});

/**
 * WE HAVE FILED THE MAIL; THE USER'S SERVER HAS NOT.
 *
 * ── THE SILENCE ──────────────────────────────────────────────────────────────────────────
 *
 * The API never opens IMAP (the "Organize-in-place" invariant): a Screener decision writes `folder_state` and the
 * WORKER applies the move on its next cycle. When the mail host is refusing connections that
 * cycle never lands, and every field the ladder already reads keeps saying the mailbox is
 * healthy — `status: "connected"` (one refused cycle is far short of `maxSyncFailures`),
 * `errorCode: null`, `syncBlockedSince: null` (a sync block is OUR infrastructure declining,
 * not theirs). The strip was `quiet` while a backlog of the user's own decisions built up on a
 * server that had applied none of them.
 *
 * ── MUTATIONS WATCHED ────────────────────────────────────────────────────────────────────
 *
 *  · delete the arm ⇒ four of these red, starting with "speaks when our filings are
 *    outstanding" at `quiet`;
 *  · `> 0` → `>= 0` ⇒ six red across the whole ladder, because the arm then swallows every
 *    state below it — including the absent-field case, which reports a backlog of zero over a
 *    mailbox that told this build nothing;
 *  · move the arm above `mailboxError` ⇒ "a broken mailbox outranks it" red;
 *  · move it below `importing` ⇒ "outranks the progress states" red;
 *  · drop `clock: true` ⇒ "runs its own clock" red — and that one is not cosmetic: nothing in
 *    the MIRROR moves when the worker drains this backlog, so a state without a clock freezes
 *    at whatever number it first painted.
 */
describe("the strip says when our own filings have not reached the mail server", () => {
  const withPending = (n: number, over: Partial<MailboxFacts> = {}) =>
    mailbox({ lastSyncAt: new Date(NOW - 30_000).toISOString(), pendingMoves: n, ...over });

  it("speaks when our filings are outstanding, and carries the COUNT and the mailbox", () => {
    const s = deriveMailState(inputs({ mailboxes: [withPending(12)] }));
    expect(s.key, "a growing backlog of the user's own decisions was reported as nothing").toBe("filing");
    expect(s.pending).toBe(12);
    expect(s.address).toBe("desk@trafficflow.invalid");
    // NOT on `count`, which is the MIRROR and means something else in every other state.
    expect(s.count).toBe(495);
  });

  it("runs its own clock — nothing in the mirror moves while the worker drains this", () => {
    // `/sync` carries no change when a move we already applied locally lands on the server, so a
    // state keyed only on mirror movement never re-paints and the number freezes.
    expect(deriveMailState(inputs({ mailboxes: [withPending(3)] })).clock).toBe(true);
  });

  it("says NOTHING at zero — an outstanding count of none is not a sentence", () => {
    const s = deriveMailState(inputs({ mailboxes: [withPending(0)] }));
    expect(s.key, "every healthy account was told it was filing 0 messages").not.toBe("filing");
    expect(s.pending).toBe(0);
  });

  it("says NOTHING when the field is ABSENT — a stale bundle must not report a backlog of zero", () => {
    // The precedent is `initialImportCompletedAt`: an older server omits the column entirely, and
    // the difference between "no backlog" and "this build cannot tell" is the whole contract.
    const s = deriveMailState(inputs({ mailboxes: [mailbox({ lastSyncAt: new Date(NOW - 30_000).toISOString() })] }));
    expect(s.key).not.toBe("filing");
    expect(s.pending).toBe(0);
  });

  it("SUMS across mailboxes and withholds the address when it is about more than one", () => {
    const s = deriveMailState(inputs({
      mailboxes: [
        withPending(4, { id: "mb1", address: "one@ex.example" }),
        withPending(7, { id: "mb2", address: "two@ex.example" }),
      ],
    }));
    expect(s.pending).toBe(11);
    // The strip makes ACCOUNT-WIDE statements. Naming one of two mailboxes beside a total that
    // covers both would be a sentence whose halves are about different things.
    expect(s.address).toBeNull();
  });

  it("a BROKEN mailbox outranks it — 'your server refused us' is the larger, actionable fact", () => {
    const s = deriveMailState(inputs({
      mailboxes: [withPending(9, { status: "error", errorCode: "connect" })],
    }));
    expect(s.key).toBe("mailboxError");
  });

  it("a BLOCKED mailbox outranks it too — our own infrastructure declining is said first", () => {
    const s = deriveMailState(inputs({
      mailboxes: [withPending(9, { syncBlockedReason: "at_capacity", syncBlockedSince: new Date(NOW - 60_000).toISOString() })],
    }));
    expect(s.key).toBe("blocked");
  });

  it("OUTRANKS the progress states — mail going out is not buried under mail coming in", () => {
    // A first import runs for minutes and is expected to. Unapplied filings are not, and burying
    // them under "Syncing your mail" for the length of an import is how this stayed invisible.
    const s = deriveMailState(inputs({
      mailboxes: [withPending(5, { initialImportCompletedAt: null })],
      mirrored: 495,
      growth: importingFromEmpty(495),
    }));
    expect(s.key).toBe("filing");
  });

  it("the strip SPEAKS for it, and there is a real sentence behind the key", () => {
    expect(stripSpeaks("filing")).toBe(true);
    const sync = (messages as unknown as { sync: Record<string, string> }).sync;
    expect(sync.filing).toBeTypeOf("string");
    expect(sync.filing).toContain("{count");
    // The load-bearing half: the mail HAS moved in ohmail, and a bare "Filing 12 messages" reads
    // as a lie about something the user can see is already done.
    expect(sync.filing).toContain("mail server");
    expect(sync.filingWhere).toContain("{address}");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE DENOMINATOR — HOW MUCH OF THE ACCOUNT THIS DEVICE HOLDS
   ══════════════════════════════════════════════════════════════════════════════════════════

   It arrives per mailbox (`hostedMessageCount`) and only a LOCAL engine sends it; a hosted
   browser tab never asks `GET /mailboxes` for counts, so on Cloud everything below is
   unreachable and these fixtures are the only place it is exercised.

   Two consumers, and NEITHER of them is an alarm: the `importing` arm quotes the pair as
   progress while the mirror MOVES, and the Mailboxes pane states it at rest as a quiet fact.
   There was a third — the `behind` strip state — and the block at the bottom of this file is
   what remains of it. */

/** A mailbox that reports the account's own count for itself. */
const counted = (hosted: number, over: Partial<MailboxFacts> = {}): MailboxFacts =>
  mailbox({
    lastSyncAt: new Date(NOW - 30_000).toISOString(),
    hostedMessageCount: hosted,
    ...over,
  });

describe("hostedTotal — every mailbox answers, or there is no denominator", () => {
  it("sums the connected mailboxes", () => {
    expect(hostedTotal([counted(1_000, { id: "a" }), counted(541, { id: "b" })])).toBe(1_541);
  });

  it("ONE silent mailbox withdraws the whole total — a partial sum is a WRONG total, not a small one", () => {
    // The failure this refuses: a count of a partial total rendered against a larger true account. Half a
    // denominator is not half a claim, it is a false one.
    expect(hostedTotal([counted(20_000, { id: "a" }), mailbox({ id: "b" })])).toBeNull();
  });

  it("an absent count is never read as zero", () => {
    expect(hostedTotal([mailbox({ id: "a" })])).toBeNull();
  });

  it("no mailboxes is no denominator", () => {
    expect(hostedTotal([])).toBeNull();
  });

  it("counts a DISABLED mailbox too — the numerator holds its mail, so the sum must", () => {
    expect(hostedTotal([
      counted(1_000, { id: "a" }),
      mailbox({ id: "b", status: "disabled", hostedMessageCount: 100 }),
    ])).toBe(1_100);
  });
});

describe("the strip quotes a total only when it can stand behind it", () => {
  it("`importing` carries the pair: 1,114 of 1,541", () => {
    const s = deriveMailState(inputs({
      mailboxes: [counted(1_541)],
      mirrored: 1_114,
      growth: importingFromEmpty(1_114),
    }));
    expect(s.key).toBe("importing");
    expect(s.count).toBe(1_114);
    expect(s.total).toBe(1_541);
  });

  it("a total the mirror has already PASSED is withheld, not clamped — '1,600 of 1,541' is unreachable", () => {
    // The stale-denominator case, and the reason the guard is a strict `>`: a mailbox removed on
    // the account keeps its mail in the local mirror, so the numerator can honestly exceed a
    // correct denominator. Silence beats a fraction that reads as an error in the product.
    const s = deriveMailState(inputs({
      mailboxes: [counted(1_541)],
      mirrored: 1_600,
      growth: importingFromEmpty(1_600),
    }));
    expect(s.key).toBe("importing");
    expect(s.total).toBeNull();
  });

  it("EQUAL is not ahead: a mirror that holds exactly the account quotes nothing", () => {
    const s = deriveMailState(inputs({
      mailboxes: [counted(1_541)],
      mirrored: 1_541,
      growth: importingFromEmpty(1_541),
    }));
    expect(s.total).toBeNull();
  });

  it("no denominator ⇒ the ladder is byte-identical to what it was before the field existed", () => {
    const withField = deriveMailState(inputs({
      mailboxes: [counted(1_541)],
      mirrored: 1_114,
      growth: importingFromEmpty(1_114),
    }));
    const without = deriveMailState(inputs({
      mailboxes: [mailbox({ lastSyncAt: new Date(NOW - 30_000).toISOString() })],
      mirrored: 1_114,
      growth: importingFromEmpty(1_114),
    }));
    expect(without).toEqual({ ...withField, total: null });
  });
});

describe("A STILL MIRROR THAT IS SHORT OF THE ACCOUNT IS NOT A STRIP STATE, AND MUST NOT BECOME ONE", () => {
  /* ────────────────────────────────────────────────────────────────────────────────────────
     THE REMOVED STATE, AND WHY THE ASSERTIONS POINT THE OTHER WAY NOW.

     There was a `behind` arm here, and it rendered an amber warning triangle at the foot of the
     rail — "This device holds N of the account's M messages", with a link to Settings →
     Mailboxes — for as long as the two numbers differed. Reported with a screenshot on
     2026-08-30: it "appears like a constant warning and is not optimal".

     The ruling, and it is the reason these cases now assert SILENCE:

      · A GAP BETWEEN THE TWO NUMBERS IS THE PRODUCT WORKING. The desktop's Cloud mirror is a
        window over the hosted account (`apps/sidecar/src/cloud-read.ts` says so where it
        deliberately leaves `GET /messages` OUT of its local read table), and the mail outside
        the window is reachable on demand: the list door falls through to the hosted account, and
        so does a body read for a row the mirror never held. Nothing is missing.
      · THE ARM COULD NOT SEE A WRONG SHAPE. Its whole evidence was "the numbers differ and the
        mirror has not moved for 90 s" — equally true of a converged window, a mirror resting
        between the sidecar's 20-second pulls, and one that has genuinely stalled. An alarm that
        fires for all three is an alarm about none of them.
      · IT CONTRADICTED ITS OWN DESTINATION. It pointed at Settings → Mailboxes, where every row
        read "Up to date".

     So the FACT moved to that pane, as a quiet line with no mark (`desktop-mailboxes.test.ts`
     holds those cases), and the strip says nothing. `deviceHoldings` is the one derivation both
     surfaces read, which is what these cases pin.

     ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ────────────────────────────────────────

      · re-add any arm returning a non-quiet key for a still, short, healthy mirror → the first
        four cases go red;
      · drop the `total <= mirrored` clamp in `deviceHoldings`                     → the passed-
        numerator case goes red;
      · make `hostedTotal` skip a silent mailbox instead of withdrawing            → the silent-
        mailbox case goes red;
      · re-add `sync.behind` to either catalog                                     → the catalog
        case goes red. */

  /** The resting freshness verdict: the mirror is known current. */
  const CURRENT = { state: "current" } as const;

  /** Still (`seedGrowth` never rose), drained, healthy — the resting shape the arm keyed on. */
  const stalled = (hosted: number, mirrored: number, over: Partial<MailStateInputs> = {}) =>
    inputs({ mailboxes: [counted(hosted)], mirrored, growth: seedGrowth(mirrored), ...over });

  it("THE REPORTED SHAPE: 5,107 held against 73,525, nothing moving — the strip is SILENT", () => {
    const s = deriveMailState(stalled(73_525, 5_107));
    expect(s.key).toBe("quiet");
    expect(stripSpeaks(s.key)).toBe(false);
    // And it names no denominator either: a total on the strip is progress, and nothing is in
    // progress here. `importing` is the only state left that may quote one.
    expect(s.total).toBeNull();
  });

  it("the fact itself survives — `deviceHoldings` answers the pair the pane renders", () => {
    expect(deviceHoldings([counted(73_525)], 5_107)).toEqual({ count: 5_107, total: 73_525 });
  });

  it("no deficit is too small to be worth a banner, because there is no banner", () => {
    // The arm carried a 25-message threshold to keep the false side quiet. With nothing on the
    // strip to be false, the size of the gap stops being a question the strip has to answer.
    for (const mirrored of [1_099, 1_075, 1_000, 1]) {
      expect(deriveMailState(stalled(1_100, mirrored)).key).toBe("quiet");
    }
  });

  it("a mirror that has been still for HOURS is still silent — that was the permanent case", () => {
    const s = deriveMailState(stalled(73_525, 5_107, { now: NOW + 6 * 60 * 60_000 }));
    expect(s.key).toBe("quiet");
    // No clock either: nothing on screen depends on elapsed time, so `MailStateProvider` must not
    // be beating a five-second interval to repaint a sentence that does not exist.
    expect(s.clock).toBe(false);
  });

  it("a MOVING mirror still says `importing`, with both numbers — progress is not an alarm", () => {
    // The one surviving consumer of the denominator, and it is the honest one: the numbers are
    // quoted while they are CHANGING, and the state ends when the movement does.
    const s = deriveMailState(inputs({
      mailboxes: [counted(1_541)],
      mirrored: 1_114,
      growth: importingFromEmpty(1_114),
    }));
    expect(s.key).toBe("importing");
    expect(s.total).toBe(1_541);
    expect(s.count).toBe(1_114);
  });

  it("the FAILURE arms are untouched — a broken loop is still said, loudly", () => {
    // The removal took the alarm off a HEALTHY state. It must not have quieted an unhealthy one:
    // these are the cases where something is genuinely wrong and the strip is the right place.
    expect(deriveMailState(stalled(1_541, 1_114, {
      sync: { bootstrapping: false, failures: 0, terminal: true, refused: false, ownerLost: false },
    })).key).toBe("stopped");
    expect(deriveMailState(stalled(1_541, 1_114, {
      sync: { bootstrapping: false, failures: 3, terminal: false, refused: false, ownerLost: false },
    })).key).toBe("failing");
    expect(deriveMailState(inputs({
      mailboxes: [counted(1_541, {
        syncBlockedReason: "at_capacity",
        syncBlockedSince: new Date(NOW - 60_000).toISOString(),
      })],
      mirrored: 1_114,
      growth: seedGrowth(1_114),
    })).key).toBe("blocked");
  });

  it("a numerator that has passed the total withdraws the pair rather than clamping it", () => {
    // A mailbox removed on the account keeps its mail in the local mirror, so the numerator can
    // legitimately exceed a correct denominator. Silence, never an even fraction rendered as
    // though the two had been measured together.
    expect(deviceHoldings([counted(1_541), mailbox({ id: "gone", status: "disabled", hostedMessageCount: 5 })], 1_600))
      .toBeNull();
    expect(deviceHoldings([counted(1_000)], 1_000)).toBeNull();
  });

  it("mail retained for a DISABLED mailbox is in the numerator, so it is in the denominator too", () => {
    // `mirrored` is the whole local store and a disconnected mailbox's mail stays in it, so a
    // denominator over the connected rows alone would compare two different populations.
    expect(deviceHoldings(
      [
        counted(1_000),
        mailbox({ id: "b", address: "b@x.test", status: "disabled", hostedMessageCount: 100, lastSyncAt: new Date(NOW - 30_000).toISOString() }),
      ],
      900,
    )).toEqual({ count: 900, total: 1_100 });
  });

  it("ONE silent mailbox, or facts nobody has read yet, withdraws the claim entirely", () => {
    expect(deviceHoldings([counted(1_000), mailbox({ id: "gone", address: "gone@x.test" })], 900)).toBeNull();
    // `null` facts is "we cannot see mailboxes" — the Desktop before its first read, the demo, a
    // Cloud tab whose first poll has not landed. Never "there are none".
    expect(deviceHoldings(null, 900)).toBeNull();
  });

  it("the STRIP has no key for it and NEITHER CATALOG has a sentence — in both languages", () => {
    // The type has no `behind` member, so a re-add cannot be a one-line copy change; and the
    // string is gone from both catalogs, so a re-added arm would render its own key at somebody.
    expect(deriveMailState(stalled(73_525, 5_107)).key).not.toBe("behind");
    for (const catalog of [messages, deMessages]) {
      const sync = (catalog as unknown as { sync: Record<string, string> }).sync;
      expect(sync.behind).toBeUndefined();
      // The `importing` pair stays — the one place a denominator is still spoken on the strip.
      expect(sync.importingOf).toContain("{count");
      expect(sync.importingOf).toContain("{total");
    }
  });

  it("THE SENTENCE MAY ONLY BE SAID ONCE THE MIRROR HAS BEEN READ", () => {
    // The numbers are comparable long before they are FACTS: the window's engine starts empty and
    // fills page by page, so a pane open across a cold launch would count up from zero about a
    // machine whose store is already full. `settled` is the ladder's own "has anything
    // authoritative populated this mirror yet".
    const settled = deriveMailState(stalled(73_525, 5_107));
    expect(settled.settled).toBe(true);
    expect(holdingsSpeak(settled, CURRENT)).toBe(true);
    // THE COLD LAUNCH, in its real shape. The desktop window's engine has no persistent store —
    // its mirror is in memory and rebuilt every launch — so its own freshness stamp starts
    // `unknown` and the `settled` wrapper's third clause (a completed drain is settled evidence)
    // has nothing to admit. Both halves matter: with a stamp already in hand the mirror HAS been
    // read once, which is the case that clause exists for.
    const booting = deriveMailState(stalled(73_525, 0, {
      sync: { bootstrapping: true, failures: 0, terminal: false, refused: false, ownerLost: false },
      engineFreshness: { state: "unknown", asOf: null },
    }));
    expect(booting.settled).toBe(false);
    expect(holdingsSpeak(booting, CURRENT)).toBe(false);
  });

  it("AND ONLY WHILE THE LOOP CAN STILL KEEP ITS PROMISE — this is where it parts from `settled`", () => {
    // `MailState.settled` admits the failure arms on purpose: "the list really is empty" stays
    // true on a dead loop. "The rest load when you reach them" does not — the reach-past doors are
    // network reads — so this gate takes the same set MINUS them.
    for (const sync of [
      { bootstrapping: false, failures: 0, terminal: true, refused: false, ownerLost: false },
      { bootstrapping: false, failures: 3, terminal: false, refused: false, ownerLost: false },
    ]) {
      const s = deriveMailState(stalled(73_525, 5_107, { sync }));
      expect(["stopped", "failing"]).toContain(s.key);
      expect(s.settled, "the empty-list qualification still admits this arm").toBe(true);
      expect(holdingsSpeak(s, CURRENT), "a frozen loop was allowed to promise on-demand loading").toBe(false);
    }
  });

  it("A STALE MIRROR IS SILENT TOO — the offline sidecar whose LOCAL loop looks perfect", () => {
    // Review finding, round 3, and the sharpest of them. On the desktop's Cloud door the reach-past
    // asks are forwarded by the sidecar's proxy to the hosted account, which answers
    // `503 offline_read_only` when it cannot reach it — while the sidecar goes on serving its own
    // local feed, so the WINDOW's loop is healthy, `settled` is true and every failure arm is
    // quiet. `stale` is the one thing on screen that knows: on this surface the freshness verdict
    // is the SIDECAR's stamp against the hosted account, not the window's against the sidecar.
    const s = deriveMailState(stalled(73_525, 5_107, {
      freshness: { state: "stale", asOf: new Date(NOW - 40 * 60_000).toISOString() },
    }));
    expect(s.key).toBe("stale");
    expect(s.settled, "a stale mirror is still renderable truth — that part is unchanged").toBe(true);
    expect(holdingsSpeak(s, { state: "stale" }), "an offline door was allowed to promise on-demand loading").toBe(false);
  });

  it("an unconfirmed refusal is silent as well — a promise made inside a retry is a coin flip", () => {
    const s = deriveMailState(stalled(73_525, 5_107, {
      sync: { bootstrapping: false, failures: 0, terminal: false, refused: true, ownerLost: false },
    }));
    expect(s.key).toBe("catchingUp");
    expect(holdingsSpeak(s, CURRENT)).toBe(false);
  });

  it("AND A DOOR WHOSE CURRENCY WAS NEVER ESTABLISHED IS SILENT — `unknown` is not a key", () => {
    /* Review finding, round 4, and the hole the key list cannot close. `stale` is a KEY and is
       refused; `unknown` is not — the ladder's stale arm does not fire for it — so a desktop
       whose `/mirror/freshness` is hanging or refusing while its local feed serves perfectly
       lands on `quiet`, `settled` is true on nothing more than "the first drain finished", and
       nothing on screen knows whether the hosted account is reachable. A promise about
       on-demand loading is made from evidence or not at all. */
    const s = deriveMailState(stalled(73_525, 5_107, {
      freshness: { state: "unknown", asOf: null },
    }));
    expect(s.key, "an unknown verdict does not reach the stale arm").toBe("quiet");
    expect(s.settled, "and it is settled — the first drain did finish").toBe(true);
    expect(holdingsSpeak(s, { state: "unknown" })).toBe(false);
  });

  it("and the resting case still speaks — the gate is a filter, not an off switch", () => {
    expect(holdingsSpeak(deriveMailState(stalled(73_525, 5_107)), CURRENT)).toBe(true);
  });

  it("THE FACT'S NEW HOME EXISTS, in both languages, with both numbers and the promise", () => {
    // The pane renders it (`desktop-mailboxes.test.ts`); this is the copy contract underneath.
    for (const catalog of [messages, deMessages]) {
      const mailboxes = (catalog as unknown as { mailboxes: Record<string, string> }).mailboxes;
      expect(mailboxes.desktopHoldsCount).toBeTypeOf("string");
      expect(mailboxes.desktopHoldsCount).toContain("{count, number}");
      expect(mailboxes.desktopHoldsCount).toContain("{total, number}");
      // No alarm vocabulary, and the load-bearing promise present. A sentence that states a
      // shortfall without saying the rest is reachable is the banner again, quieter.
      expect(mailboxes.desktopHoldsCount).not.toMatch(/⚠/);
      expect(mailboxes.desktopCopyIsACopy).toBeTypeOf("string");
    }
    expect(messages.mailboxes.desktopHoldsCount).toContain("nothing is missing");
    expect(deMessages.mailboxes.desktopHoldsCount).toContain("es fehlt nichts");
  });
});

describe("owed — a catch-up in flight withholds emptiness (INCIDENT-021)", () => {
  const CATCHING_UP = {
    bootstrapping: true, failures: 0, terminal: false, refused: false, ownerLost: false,
  };
  const STALE_STAMP = { state: "stale" as const, asOf: new Date(NOW - 90 * 60_000).toISOString() };

  /**
   * THE MEASURED SHAPE (production, warm profile, 2026-09-20): a reopened tab hydrates its full
   * mirror, the minutes-old stamp settles every pane, and the catch-up drain is still walking
   * — on an established account no growth arm can fire (the sampler re-baselines while
   * bootstrapping), so `owed` keyed on `importing` alone read false and three piles asserted
   * "Nothing in your Ohbox" / "Nothing new since you were here" over a hydrated mailbox.
   * Mutation: restore `owed: state.key === "importing"` and the first arm goes red.
   */
  it("a warm tab mid-catch-up owes its lists: settled, and still owed", () => {
    const s = deriveMailState(inputs({
      sync: CATCHING_UP, freshness: STALE_STAMP, engineFreshness: STALE_STAMP,
    }));
    expect(s.key).toBe("stale");
    expect(s.settled, "the stamp makes the hydrated rows renderable").toBe(true);
    expect(s.owed, "a catch-up in flight was not owed — the pane asserts emptiness").toBe(true);
  });

  it("a cold first drain in flight is owed too", () => {
    const s = deriveMailState(inputs({ sync: CATCHING_UP }));
    expect(s.owed, "a first drain mid-walk was not owed").toBe(true);
  });

  it("a dead loop owes nothing — the spinner nobody can escape", () => {
    const s = deriveMailState(inputs({
      sync: { ...CATCHING_UP, terminal: true },
    }));
    expect(s.key).toBe("stopped");
    expect(s.owed, "a loop that will not run again withheld a list for ever").toBe(false);
  });

  it("a confirmed-failing loop owes nothing", () => {
    const s = deriveMailState(inputs({
      sync: { ...CATCHING_UP, failures: 3 },
    }));
    expect(s.key).toBe("failing");
    expect(s.owed).toBe(false);
  });

  it("the demo owes nothing — a fixture world has no mail on its way", () => {
    const s = deriveMailState(inputs({ demo: true, sync: CATCHING_UP }));
    expect(s.owed).toBe(false);
  });

  it("the catch-up completed: emptiness is a fact again", () => {
    const s = deriveMailState(inputs({}));
    expect(s.owed, "a settled tab kept its lists withheld").toBe(false);
  });
});

describe("the gap offers on the shell (mail 0151)", async () => {
  const { gapOffers } = await import("../app/shell/mail-state");
  it("one per live mailbox this install organizes whose row carries a positive count", () => {
    expect(gapOffers([
      { id: "a", address: "a@x.test", organizerRole: "organizer", status: "connected", gapLetters: 2 },
      { id: "b", address: "b@x.test", organizerRole: "reader", status: "connected", gapLetters: 2 },
      { id: "c", address: "c@x.test", organizerRole: "organizer", status: "disabled", gapLetters: 2 },
      { id: "d", address: "d@x.test", organizerRole: "organizer", status: "connected", gapLetters: 0 },
      { id: "e", address: "e@x.test", organizerRole: "organizer", status: "connected" },
    ] as never)).toEqual([{ id: "a", address: "a@x.test", count: 2, strangers: 0 }]);
    expect(gapOffers(null)).toEqual([]);
  });
  it("a window of strangers only is an offer, with both counts (mail 0158)", () => {
    expect(gapOffers([
      { id: "a", address: "a@x.test", organizerRole: "organizer", status: "connected", gapLetters: 0, gapStrangers: 3 },
      { id: "b", address: "b@x.test", organizerRole: "organizer", status: "connected", gapLetters: 1, gapStrangers: 2 },
      { id: "c", address: "c@x.test", organizerRole: "organizer", status: "connected", gapLetters: 0, gapStrangers: 0 },
      { id: "d", address: "d@x.test", organizerRole: "organizer", status: "connected", gapLetters: null, gapStrangers: 2 },
    ] as never)).toEqual([
      { id: "a", address: "a@x.test", count: 0, strangers: 3 },
      { id: "b", address: "b@x.test", count: 1, strangers: 2 },
    ]);
  });
  it("the sentence and both verbs exist in both catalogues", () => {
    for (const deck of [messages, deMessages] as Array<{ mailboxes: Record<string, string> }>) {
      for (const k of ["gapLetters", "gapStrangers", "gapBoth", "gapFile", "gapScreen", "gapLeave", "gapChanged", "gapOffline", "gapFailed"]) {
        expect(typeof deck.mailboxes[k], k).toBe("string");
      }
    }
  });
});
