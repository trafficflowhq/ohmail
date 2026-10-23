/**
 * ═══ THE FILING STRIP TOLD ONE SENTENCE FOR FOUR DIFFERENT SITUATIONS ═══════════════════════
 *
 * Reported from real use: the rail read "Filing 1 message on your mail server… <address> · your
 * decisions are already applied here; the server is catching up." for about ten minutes while
 * nothing changed on the mailbox, then cleared by itself. Twice, on two mailboxes, the second
 * time across a worker redeploy.
 *
 * The count was RIGHT both times — one `folder_state` row was genuinely outstanding. What was
 * wrong is that one sentence covered every reason a row can be outstanding, and three of the
 * four are not "the server is catching up":
 *
 *  · WORKING — the organizer has not reached this mailbox in its rotation yet. True, and the
 *    honest version says when the last pass finished, so a person can tell a turn from a stall.
 *  · WAITING — the server REFUSED the move and the retry is scheduled minutes out. The row is
 *    deferred: it is not in the reconciler's queue at all until `next_attempt_at`, so nothing
 *    is catching up with anything.
 *  · STUCK — refused repeatedly, or outstanding far longer than a rotation can explain. The
 *    same sentence, forever, is how this reads today.
 *  · SOMEBODY ELSE FILES IT — a reader install. `reconcileFolders` is skipped for a reader
 *    (`apps/worker/src/sync.ts`), so the decisions made here are applied by whichever install
 *    holds the mailbox, on ITS schedule. "The server is catching up" is false by construction:
 *    the server is not the organizer.
 *
 * ── WHY THIS FILE IS SEPARATE FROM `mail-state.test.ts`'s BLOCK ─────────────────────────
 *
 * That block holds the arm's PRECEDENCE against the rest of the ladder and stays exactly as it
 * was — the arm's position did not move. This file is about which of the four sentences the arm
 * chooses once it has fired, which is a different question with its own operands.
 *
 * ── MUTATIONS WATCHED (each reverted alone; see the lane report for the recorded reds) ──────
 *
 *  · drop the reader arm ⇒ "names WHO files it" red at `arm: "working"`;
 *  · drop the STUCK threshold ⇒ "ten minutes and three refusals is not 'filing'" red at
 *    `arm: "waiting"`;
 *  · count a deferred row as due ⇒ "a deferred row is not work in progress" red;
 *  · drop `lastCycleAt` from the report ⇒ "states the organizer's last pass" red;
 *  · `FILING_STUCK_MS` below the rotation estimate ⇒ "the threshold must outlast a rotation"
 *    red — the arithmetic guard, so a healthy turn can never be called stuck.
 */
import { describe, expect, it } from "vitest";

import {
  FILING_ROTATION_ESTIMATE_MS,
  FILING_STUCK_MS,
  deriveMailState,
  seedGrowth,
  type FilingFacts,
  type MailStateInputs,
  type MailboxFacts,
} from "../app/shell/mail-state";
import en from "../messages/en.json";
import de from "../messages/de.json";

const NOW = Date.parse("2026-09-08T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

/** The resting filing facts: nothing outstanding, read this instant. */
const noFiling: FilingFacts = {
  due: 0,
  deferred: 0,
  oldestPendingAt: null,
  nextAttemptAt: null,
  attempts: 0,
  lastRefusalClass: null,
  asOf: new Date(NOW).toISOString(),
  lastCycleAt: ago(20_000),
};

const mailbox = (over: Partial<MailboxFacts> = {}): MailboxFacts => ({
  id: "mb1",
  address: "person@example.invalid",
  status: "connected",
  errorCode: null,
  disabledReason: null,
  syncBlockedReason: null,
  syncBlockedSince: null,
  lastSyncAt: ago(30_000),
  initialImportCompletedAt: ago(600_000),
  createdAt: ago(900_000),
  ...over,
});

const inputs = (over: Partial<MailStateInputs> = {}): MailStateInputs => ({
  sync: { bootstrapping: false, failures: 0, terminal: false, refused: false },
  failureStreak: 3,
  mailboxes: [mailbox()],
  mirrored: 495,
  growth: seedGrowth(495),
  freshness: { state: "current" as const, asOf: ago(30_000) },
  engineFreshness: { state: "current" as const, asOf: ago(30_000) },
  now: NOW,
  demo: false,
  ...over,
} as MailStateInputs);

/** One mailbox with the given filing facts, otherwise healthy and settled. */
const withFiling = (f: Partial<FilingFacts>, over: Partial<MailboxFacts> = {}) =>
  inputs({ mailboxes: [mailbox({ filing: { ...noFiling, ...f }, ...over })] });

describe("the filing strip distinguishes the four reasons a decision is outstanding", () => {
  it("WORKING — one due move states the organizer's last pass, never 'catching up'", () => {
    const s = deriveMailState(withFiling({ due: 1, lastCycleAt: ago(18_000) }));
    expect(s.key).toBe("filing");
    expect(s.filing?.arm).toBe("working");
    expect(s.filing?.count).toBe(1);
    // THE FACT THAT SEPARATES A TURN FROM A STALL. The organizer runs one serialized rotation
    // per tick and a mailbox gets one bounded turn per pass, so "the last pass finished 18
    // seconds ago" is the difference between "mine is next" and "nothing is running".
    expect(s.filing?.lastPassSeconds).toBe(18);
    expect(s.filing?.asOf).toBe(new Date(NOW).toISOString());
  });

  it("states the organizer's last pass, and withholds it when the heartbeat says nothing", () => {
    // ABSENT is "this deployment cannot tell" — a local engine keeps no heartbeat row. The
    // sentence loses its second half rather than inventing a number.
    const s = deriveMailState(withFiling({ due: 1, lastCycleAt: null }));
    expect(s.filing?.arm).toBe("working");
    expect(s.filing?.lastPassSeconds).toBeNull();
  });

  it("a DEFERRED row is not work in progress — it is not even in the reconciler's queue", () => {
    // `listPendingFolderStates` filters `dueNow(next_attempt_at)`; a deferred row is absent from
    // it. Reporting it as "filing" claims work that nothing is doing.
    const s = deriveMailState(withFiling({
      due: 0, deferred: 1, attempts: 1,
      oldestPendingAt: ago(90_000), nextAttemptAt: new Date(NOW + 210_000).toISOString(),
      lastRefusalClass: "no_such_folder",
    }));
    expect(s.filing?.arm).toBe("waiting");
    expect(s.filing?.deferred).toBe(1);
    expect(s.filing?.reason).toBe("no_such_folder");
    expect(s.filing?.nextAttemptAt).toBe(new Date(NOW + 210_000).toISOString());
  });

  it("STUCK — ten minutes outstanding and three refusals is not 'filing'", () => {
    // The reported sighting's shape, with the ladder actually engaged: nothing about this is
    // "the server is catching up".
    const s = deriveMailState(withFiling({
      due: 0, deferred: 1, attempts: 3,
      oldestPendingAt: ago(600_000), nextAttemptAt: new Date(NOW + 3_600_000).toISOString(),
      lastRefusalClass: "read_only",
    }));
    expect(s.filing?.arm).toBe("stuck");
    expect(s.filing?.waitedMinutes).toBe(10);
    expect(s.filing?.reason).toBe("read_only");
  });

  it("STUCK on the WAIT ALONE — outstanding past a rotation with no refusal recorded", () => {
    // The transport-failure shape: a throw against the mail host writes NOTHING (no attempt
    // count, no deferral), so a row can sit due-now for ever with `attempts` at 0. Keying stuck
    // on `attempts` alone would leave exactly that case saying "filing" indefinitely.
    const s = deriveMailState(withFiling({ due: 1, attempts: 0, oldestPendingAt: ago(660_000) }));
    expect(s.filing?.arm).toBe("stuck");
    expect(s.filing?.reason).toBeNull();
  });

  it("the threshold must OUTLAST a rotation, or a healthy turn is reported as stuck", () => {
    // Arithmetic, not a sentence: one serialized rotation over every mailbox is minutes on a
    // busy deployment, so a stuck threshold at or under it fires on filing that is working.
    expect(FILING_STUCK_MS).toBeGreaterThan(FILING_ROTATION_ESTIMATE_MS);
  });

  it("names WHO files it on a READER install, and never says 'server'", () => {
    // `reconcileFolders` is skipped for a reader, so these decisions are applied by the install
    // that holds the mailbox. Today this renders "Filing 1 message on your mail server…".
    const s = deriveMailState(withFiling(
      { due: 1, oldestPendingAt: ago(120_000) },
      {
        organizerRole: "reader",
        organizedBy: { kind: "local", name: "Louis' iMac", since: ago(86_400_000) },
        organizerState: "held",
        organizeConsentedAt: ago(86_400_000),
      },
    ));
    expect(s.filing?.arm).toBe("elsewhere");
    /* `mailboxId` and `since` ride along for the intention the strip can be silenced by
       (`reading-along.ts`): the id is what an intention is stored against, and `since` is the
       half of the holder's identity that changes when a different install takes the mailbox
       over. Neither is rendered, and both are asserted here rather than relaxing this to a
       partial match — the shape of what the rail is handed is the thing this case pins. */
    expect(s.filing?.who).toEqual({
      kind: "local",
      name: "Louis' iMac",
      stopped: false,
      mailboxId: "mb1",
      since: ago(86_400_000),
    });
  });

  it("THE REPORTED SENTENCE: a reader was told its own mail server was catching up", () => {
    // The sighting, reconstructed from the wire a shipped server sends. `pendingMoves` is the
    // only field the arm reads today, so this renders the old copy — whose second clause names
    // the SERVER as the thing that is behind. On a reader the server is not the organizer, and
    // `reconcileFolders` is skipped for a reader entirely, so nothing on the server was going
    // to file this at all.
    const s = deriveMailState(inputs({
      mailboxes: [mailbox({
        pendingMoves: 1,
        filing: { ...noFiling, due: 1 },
        organizerRole: "reader",
        organizedBy: { kind: "local", name: "Louis' iMac", since: ago(86_400_000) },
        organizerState: "held",
        organizeConsentedAt: ago(86_400_000),
      })],
    }));
    expect(s.key).toBe("filing");
    expect(s.filing?.arm, "a reader was told the server was catching up").toBe("elsewhere");
  });

  it("a reader whose holder STOPPED renewing says so — the two are different situations", () => {
    const s = deriveMailState(withFiling(
      { due: 1 },
      {
        organizerRole: "reader",
        organizedBy: { kind: "local", name: "Louis' iMac", since: ago(86_400_000) },
        organizerState: "stopped",
        organizeConsentedAt: ago(86_400_000),
      },
    ));
    expect(s.filing?.who?.stopped).toBe(true);
  });

  it("a reader with NOBODY named is not the who-files case — it falls to the ordinary arms", () => {
    // The holder columns decay to all-NULL when the claim folder is empty, and claiming "another
    // install files this" over a mailbox nobody holds is a false statement about a machine.
    const s = deriveMailState(withFiling({ due: 1 }, { organizerRole: "reader" }));
    expect(s.filing?.arm).toBe("working");
    expect(s.filing?.who).toBeNull();
  });

  it("says nothing at all when nothing is outstanding", () => {
    expect(deriveMailState(withFiling({})).key).not.toBe("filing");
    expect(deriveMailState(withFiling({})).filing).toBeNull();
  });

  it("an ABSENT report leaves the legacy count in charge — an older server behaves as before", () => {
    // `filing` is the new aggregate; `pendingMoves` is what every shipped server sends. A build
    // that cannot tell must produce the sentence it always produced, not silence and not a
    // fabricated arm.
    const s = deriveMailState(inputs({ mailboxes: [mailbox({ pendingMoves: 4 })] }));
    expect(s.key).toBe("filing");
    expect(s.pending).toBe(4);
    expect(s.filing).toBeNull();
  });

  it("SUMS the report across mailboxes and takes the WORST arm", () => {
    const s = deriveMailState(inputs({
      mailboxes: [
        mailbox({ id: "a", address: "one@example.invalid", filing: { ...noFiling, due: 2 } }),
        mailbox({
          id: "b", address: "two@example.invalid",
          filing: {
            ...noFiling, deferred: 1, attempts: 4,
            oldestPendingAt: ago(900_000), lastRefusalClass: "over_quota",
          },
        }),
      ],
    }));
    expect(s.filing?.arm).toBe("stuck");
    expect(s.filing?.count).toBe(3);
    expect(s.pending).toBe(3);
    // The arm covers the one mailbox it is about, and that mailbox's reason.
    expect(s.filing?.mailboxes).toBe(1);
    expect(s.filing?.first).toEqual({ id: "b", address: "two@example.invalid", displayName: null });
    expect(s.filing?.reason).toBe("over_quota");
    expect(s.filing?.reasonsDiffer).toBe(false);
  });

  it("names how many mailboxes the arm covers, the first of them, and whether their reasons agree", () => {
    const stuck = (cls: string | null) => ({
      ...noFiling, due: 1, oldestPendingAt: ago(4_000_000), stuck: 1, stuckSince: ago(4_000_000), stuckRefusalClass: cls,
    });
    const two = (a: string | null, b: string | null) => deriveMailState(inputs({
      mailboxes: [
        mailbox({ id: "a", address: "one@example.invalid", displayName: "Work", filing: stuck(a) }),
        mailbox({ id: "b", address: "two@example.invalid", filing: stuck(b) }),
        mailbox({ id: "c", address: "three@example.invalid", filing: { ...noFiling, stuck: 0, stuckSince: null, stuckRefusalClass: null } }),
      ],
    })).filing;
    expect(two(null, "read_only")).toMatchObject({
      arm: "stuck", count: 2, mailboxes: 2, reason: null, reasonsDiffer: true,
      first: { id: "a", address: "one@example.invalid", displayName: "Work" },
    });
    expect(two("read_only", "read_only")).toMatchObject({ mailboxes: 2, reason: "read_only", reasonsDiffer: false });
  });

  it("an unrecognised class reads 'unknown', and the waiting title counts the deferred rows", () => {
    const s = deriveMailState(withFiling({
      due: 1, deferred: 2, attempts: 1, oldestPendingAt: ago(60_000), lastRefusalClass: "transport",
      nextAttemptAt: new Date(NOW + 60_000).toISOString(), stuck: 0, stuckSince: null, stuckRefusalClass: null,
    }));
    expect(s.filing).toMatchObject({ arm: "waiting", count: 2, reason: "unknown", mailboxes: 1 });
  });
});

describe("the four sentences exist in both catalogues and none of them says 'catching up'", () => {
  const KEYS = [
    "filingPass", "filingWaiting", "filingStuck", "filingElsewhere",
    "filingReason_refused", "filingReason_no_such_folder", "filingReason_read_only",
    "filingReason_over_quota", "filingReason_stale_locator", "filingReason_unconfirmed", "filingReason_unknown",
    /* BOTH halves of the address line. `filingWhereAsOf` carries the read's instant and
       `filingWhere` does not, and the undated one is required rather than legacy: `asOf` comes
       from the new aggregate, so a server that predates it must still name the mailbox. Gating
       the line on the date dropped it for exactly those servers, and `sync-bar-loader.test.ts`
       caught that — this keeps the pair from being collapsed back into one. */
    "filingWhere", "filingWhereAsOf",
    // The mailbox and the reason, named: hours past the first, a count of mailboxes, and the
    // sentence for mailboxes whose reasons disagree.
    "filingStuckHours", "filingMailboxes", "filingReasonsDiffer", "filingReason_none",
    "filingStuckWhy", "filingWaitingWhy",
  ] as const;

  it("every key this arm renders is in en.json and de.json", () => {
    const enBar = (en as unknown as Record<string, Record<string, string>>).sync ?? {};
    const deBar = (de as unknown as Record<string, Record<string, string>>).sync ?? {};
    for (const k of KEYS) {
      expect(enBar[k], `en.json is missing sync.${k}`).toBeTruthy();
      expect(deBar[k], `de.json is missing sync.${k}`).toBeTruthy();
    }
  });

  it("the FALSE half of the old sentence is gone — the server is not always the organizer", () => {
    // The reported copy claimed the server was catching up. On a reader install the server is
    // not the organizer at all, and on a deferred row nothing is catching up with anything.
    const enBar = (en as unknown as Record<string, Record<string, string>>).sync ?? {};
    expect(enBar.filingWhere).not.toMatch(/catching up/i);
  });
});
