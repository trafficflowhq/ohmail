/** @vitest-environment jsdom */
/**
 * ═══ ONE FAILED SESSION READ IS NOT A SIGN-OUT — the guards, driven on the wire ════════════
 *
 * The defect, measured in production and not supposed: at 2026-09-04T12:40:09.296Z the API
 * answered `GET /auth/session` with `503 db_busy` — its own name for a pooled connection it
 * could not get inside its ceiling — and the webapp rendered **"You are signed out."** over a
 * cookie that answered `200 scope=full` a moment later. Three seconds later somebody
 * screenshotted it. The project's design notes has the request, the reproduction
 * (eight panes out of eleven injected transients) and the two-tab frame where one tab showed
 * the verdict and its neighbour showed the mailbox.
 *
 * Every case below FAILED before the fix — each one rendering `session.endedBody` — and the
 * three at the bottom passed before it and must go on passing, because they are the guards on
 * the fix rather than the fix: a verdict the server actually MAKES must still be immediate.
 *
 * ── WHY THIS MOUNTS `CloudShell` AND NOT `EngineProvider` ──────────────────────────────────
 *
 * Because the predicate used to live in `CloudShell`, and a test that injects its own
 * `resolveOwner` replaces the very thing that was wrong. `live-walk-shell.ts` does inject one
 * — correctly, for what it guards — so these use `fixtures/cloud-confirm-shell.ts`, which
 * mounts the real Cloud entry and scripts `GET /api/auth/session` on the wire.
 *
 * ── THE TIMING ASSERTIONS ARE BOUNDS, BECAUSE THE SCHEDULE IS JITTERED ─────────────────────
 *
 * `nextConfirmDelay` multiplies by `0.5 + 0.5·random` so that N tabs woken together do not
 * return to a starved pool in lockstep (`confirm-schedule.ts`). So a test cannot assert an
 * instant; it asserts the window, and asserts it against the REAL constants — there is no
 * injectable schedule, on purpose, because the shipped numbers must be the ones under test.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACCOUNT, coded401, db503, html502, installConfirmEnv, messages, mountCloudShell, overlay,
  rate429, refresh204, refreshCalls, rememberOwner, scriptRefresh, scriptSession, sessionCalls,
  sessionCallsAt, sessionEnrollment, sessionFull, shellRoot, showsEnded, showsUnconfirmed,
  scriptSync, syncCalls, syncPage,
  teardownConfirmEnv, tick, tryAgainButton, uncoded401, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";
import { markSessionDead, resetSessionTruthForTests, sessionIsDead } from "../app/shell/session-truth";

/** The whole ladder's worst case: 5 s + 8 s + 8 s of waiting, plus slack. */
const LADDER_MS = 30_000;

/**
 * The cold view tree, loaded once, so case 1 stays on 5 s: 3.1-5.0 s cold at load ~26, and
 * 31-56 s in 20 runs under CPUQuota=10% (three over 40 s, so 90 s by #136's ladder).
 */
const WARM_BUDGET_MS = 90_000;
beforeAll(warmCloudShell, WARM_BUDGET_MS);

beforeEach(() => {
  resetSessionTruthForTests();
  installConfirmEnv();
});
afterEach(async () => {
  await teardownConfirmEnv();
  resetSessionTruthForTests();
});

describe("a transient failure of the session read is retried, never rendered as a verdict", () => {
  /**
   * CASE 1 — the measured production failure, exactly.
   *
   * `503 db_busy` with the API's own envelope and `Retry-After: 5`, then a healthy 200. The
   * pane must never appear, the mailbox must arrive, and the second ask must respect the
   * header the server sent: `min(8000, 5000) × [0.5, 1]` = 2.5–5 s.
   */
  it("503 db_busy then 200: no verdict, the mailbox opens, and Retry-After seeds the wait", async () => {
    scriptSession(db503, sessionFull);
    const el = await mountCloudShell();

    expect(showsEnded(el), "a 503 was rendered as a sign-out").toBe(false);
    expect(sessionCalls(), "the confirm did not run on mount").toBe(1);

    // Nothing may happen before the server's own advice has elapsed at its floor.
    await tick(2_400);
    expect(sessionCalls(), "the retry ignored Retry-After and came back early").toBe(1);

    await tick(LADDER_MS);
    expect(sessionCalls(), "the retry never happened, or happened more than once").toBe(2);
    const [, second] = sessionCallsAt();
    expect(second, "the second ask fell outside the jittered Retry-After window")
      .toBeGreaterThanOrEqual(2_500);
    expect(second).toBeLessThanOrEqual(5_000);

    expect(showsEnded(el), "the verdict appeared at some point during the ladder").toBe(false);
    expect(showsUnconfirmed(el), "a ladder that succeeded still reported failure").toBe(false);
    expect(shellRoot(el), "the mailbox never opened after the confirm succeeded").not.toBeNull();
  });

  /**
   * CASE 2 — a PLATFORM failure: 502 with an HTML body and no envelope of ours.
   *
   * The half `code` alone cannot see. `attempt()` fills `code: "internal"` when there is no
   * envelope, so this and a real ohmail 500 are indistinguishable by code — `wire.coded` is
   * the field that tells them apart. With no `Retry-After` the wait is the seed: 300–600 ms.
   */
  it("502 with no envelope then 200: retried on the seed delay", async () => {
    scriptSession(html502, sessionFull);
    const el = await mountCloudShell();
    expect(showsEnded(el)).toBe(false);

    await tick(LADDER_MS);
    expect(sessionCalls()).toBe(2);
    const [, second] = sessionCallsAt();
    expect(second, "an unseeded retry did not use CONFIRM_SEED_MS").toBeGreaterThanOrEqual(300);
    expect(second).toBeLessThanOrEqual(600);
    expect(showsEnded(el)).toBe(false);
    expect(shellRoot(el)).not.toBeNull();
  });

  /** CASE 3 — the socket dies. A wake from sleep, a Wi-Fi roam, a dropped connection. */
  it("a fetch that rejects then 200: retried, no verdict", async () => {
    scriptSession("reject", sessionFull);
    const el = await mountCloudShell();
    expect(showsEnded(el), "a dead socket was rendered as a sign-out").toBe(false);

    await tick(LADDER_MS);
    expect(sessionCalls()).toBe(2);
    expect(showsEnded(el)).toBe(false);
    expect(shellRoot(el)).not.toBeNull();
  });

  /**
   * CASE 4 — the ordinary lapse whose RECOVERY blinks.
   *
   * A coded 401 sends `api()` through the refresh, and the refresh itself gets a 503. The 401
   * is real and coded, so the naive predicate ("coded 401 means revoked") fires — and it is
   * wrong, because nothing was learned: the refresh never happened.
   * `lastRefreshOutcome() === "unavailable"` is what keeps this out of the verdict arm.
   */
  it("coded 401 whose refresh 503s then 200: retried, no verdict", async () => {
    scriptSession(coded401, sessionFull);
    scriptRefresh(() => new Response(JSON.stringify({ error: { code: "db_busy", message: "busy" } }), {
      status: 503, headers: { "content-type": "application/json" },
    }));
    const el = await mountCloudShell();
    expect(showsEnded(el), "a coded 401 with an unavailable refresh was read as revoked").toBe(false);

    await tick(LADDER_MS);
    expect(showsEnded(el)).toBe(false);
    expect(shellRoot(el), "the mailbox never opened").not.toBeNull();
    expect(sessionIsDead(), "an unavailable refresh latched the death store").toBe(false);
  });

  /**
   * CASE 5 — "one refresh, one retry, then the real answer", where the RETRY is what blinks.
   *
   * The 401 is recovered correctly (204, fresh cookies) and the retried read then meets the
   * 503. `api()` is out of retries at that point and rethrows, which is right; what was wrong
   * was the shell reading that rethrow as a statement about the account.
   */
  it("coded 401, refresh 204, retry 503, then 200: retried, no verdict", async () => {
    scriptSession(coded401, db503, sessionFull);
    scriptRefresh(refresh204);
    const el = await mountCloudShell();
    expect(showsEnded(el)).toBe(false);

    await tick(LADDER_MS);
    expect(refreshCalls(), "the lapse was not recovered exactly once").toBe(1);
    expect(sessionCalls(), "the ladder did not re-ask after the retried read blinked").toBe(3);
    expect(showsEnded(el)).toBe(false);
    expect(shellRoot(el)).not.toBeNull();
  });

  /**
   * CASE 6 — THE LADDER RUNS OUT, which is the case that must not regress into the old pane.
   *
   * Four consecutive 503s. The honest answer is that the check did not finish, and `Try again`
   * has to work — this is the state a reader is left in during a real outage, and the whole
   * value of the slice is that the sentence on screen is true.
   */
  it("503 four times: says the check did not finish, never that the session ended", async () => {
    scriptSession(db503);
    const el = await mountCloudShell();

    await tick(LADDER_MS);
    expect(sessionCalls(), "the ladder is not four asks long").toBe(4);
    expect(showsUnconfirmed(el), "the end of the ladder said nothing").toBe(true);
    expect(showsEnded(el), "the end of the ladder claimed the session had ended").toBe(false);

    // And the copy itself must not have crept back toward a verdict.
    const text = el.textContent ?? "";
    expect(text).not.toContain("signed out");
    expect(text).toContain(messages.session.tryAgain);

    // Try again re-asks, and the server is healthy now.
    scriptSession(sessionFull);
    const button = tryAgainButton(el);
    await tick(0);
    button.click();
    await tick(LADDER_MS);
    expect(shellRoot(el), "Try again did not reach the mailbox").not.toBeNull();
    expect(showsUnconfirmed(el), "the failure notice outlived the recovery").toBe(false);
  });

  /** CASE 10 — an UNCODED 401. A platform, not our server; nothing of ours refused anything. */
  it("uncoded 401 whose refresh is also uncoded: retried, and the death store stays clean", async () => {
    scriptSession(uncoded401, sessionFull);
    scriptRefresh(uncoded401);
    const el = await mountCloudShell();

    await tick(LADDER_MS);
    expect(showsEnded(el), "a platform 401 was read as the server's own word").toBe(false);
    expect(sessionIsDead(), "an uncoded 401 latched the death store").toBe(false);
    expect(shellRoot(el)).not.toBeNull();
  });

  /**
   * A REFUSAL THAT SAYS `retryable: false` IS STILL NOT A VERDICT.
   *
   * The classifier is forbidden from keying on that field, and the source guard can only see
   * that the token is absent from one line — an `|| err.wire.retryable === false` bolted onto
   * the verdict arm would satisfy it. This is the behavioural half: a 503 that explicitly
   * declares itself non-retryable must still be `unknown`, because `retryable` describes the
   * REQUEST, never the session (`sync-scheduler.ts` measured what keying on it catches).
   */
  it("a 5xx declaring retryable:false is still retried, never a verdict", async () => {
    scriptSession(
      () => new Response(JSON.stringify({ error: { code: "internal", message: "no", retryable: false } }), {
        status: 503, headers: { "content-type": "application/json" },
      }),
      sessionFull,
    );
    const el = await mountCloudShell();
    await tick(LADDER_MS);
    expect(showsEnded(el), "`retryable: false` was read as a statement about the session").toBe(false);
    expect(sessionCalls(), "a non-retryable refusal stopped the ladder").toBe(2);
    expect(shellRoot(el)).not.toBeNull();
  });

  /** CASE 11 — 429. Advice to come back, answered by the same ladder. */
  it("429 with Retry-After then 200: retried inside the advised window", async () => {
    scriptSession(rate429, sessionFull);
    const el = await mountCloudShell();
    await tick(2_400);
    expect(sessionCalls()).toBe(1);

    await tick(LADDER_MS);
    expect(sessionCalls()).toBe(2);
    const [, second] = sessionCallsAt();
    expect(second).toBeGreaterThanOrEqual(2_500);
    expect(second).toBeLessThanOrEqual(5_000);
    expect(showsEnded(el)).toBe(false);
    expect(shellRoot(el)).not.toBeNull();
  });

  /**
   * CASE 12 — A STALE DEATH LATCH PLUS ONE 503.
   *
   * The trap the ruling names first. `sessionIsDead()` is sticky and deliberately survives a
   * client-side sign-in: `/login` signed out latches it from a truthful coded 401, and
   * `router.push("/")` carries the latch into the freshly signed-in shell, which is why the
   * confirmed owner withdraws the claim. A classifier keying on that latch instead of on
   * `lastRefreshOutcome()` would meet one unrelated 503 and reproduce the pane over a session
   * the server was about to confirm. This case pre-sets the latch and requires the mailbox.
   */
  /**
   * THE STALE LATCH ON THE WARM PATH — the case the first version of this file missed, and the
   * one the reported defect actually travels on.
   *
   * The case below pre-sets the latch but does NOT remember an owner, so there is no warm
   * mirror, `live` is false, `SessionEnded` is never mounted, and the confirming 200 clears the
   * latch before anything could have rendered. That is a weaker arrangement than the world:
   * a real browser arrives at `/` with `tf_owner` set, warm-opens, and mounts the re-auth
   * prompt BEFORE the confirm has answered anything.
   *
   * So: latch a death (as `/login` truthfully does when signed out), remember an owner (as a
   * sign-in does), and let the confirm meet a 503. Nothing may claim the session ended — not
   * `endedBody`, and not `endedMidUse`, which is the sentence that came back through this door.
   */
  it("a held session death plus a WARM mirror and a 503 says nothing about the session", async () => {
    markSessionDead();
    rememberOwner(ACCOUNT);
    scriptSession(db503, sessionFull);
    const el = await mountCloudShell();

    // The instant of the defect: warm mirror up, latch set, confirm not yet answered.
    expect(el.textContent, "a stale latch put the mid-use verdict over a live mailbox")
      .not.toContain(messages.session.endedMidUse);
    expect(showsEnded(el)).toBe(false);

    await tick(LADDER_MS);
    expect(el.textContent, "the mid-use verdict appeared during the ladder")
      .not.toContain(messages.session.endedMidUse);
    expect(showsEnded(el)).toBe(false);
    expect(shellRoot(el), "the mailbox never opened").not.toBeNull();
    expect(sessionIsDead(), "the confirmed owner did not withdraw the stale claim").toBe(false);
  });

  /**
   * And the same latch when the ladder RUNS OUT: the truthful notice must still appear. It
   * used to stand aside for `useSessionDead()`, so a stale claim silenced the one honest
   * sentence available.
   */
  it("a held session death does not suppress the check-did-not-finish notice", async () => {
    markSessionDead();
    rememberOwner(ACCOUNT);
    scriptSession(db503);
    const el = await mountCloudShell();

    await tick(LADDER_MS);
    expect(showsUnconfirmed(el), "a stale latch suppressed the truthful notice").toBe(true);
    expect(el.textContent).not.toContain(messages.session.endedMidUse);
    expect(showsEnded(el)).toBe(false);
    expect(shellRoot(el), "the mail was torn down").not.toBeNull();
  });

  it("a held session death plus one 503 still reaches the mailbox", async () => {
    markSessionDead();
    expect(sessionIsDead()).toBe(true);
    scriptSession(db503, sessionFull);
    const el = await mountCloudShell();

    await tick(LADDER_MS);
    expect(showsEnded(el), "a stale latch plus a 503 reproduced the verdict").toBe(false);
    expect(shellRoot(el), "the mailbox never opened").not.toBeNull();
    expect(sessionIsDead(), "the confirmed owner did not withdraw the stale claim").toBe(false);
  });
});

/**
 * CASE 9 — THE WARM MIRROR, which is the half a person actually sees.
 *
 * A browser that remembers an account paints its mirror immediately and confirms beside it
 * (`tf_owner`, `shell/owner-cookie.ts`). The old code TORE THAT DOWN on the first failure: the
 * mail vanished and the gate replaced it, which is what the production screenshot shows — a
 * bare card, no mail behind it. Two claims here, and they pull in opposite directions:
 *
 *   · while the ladder is running, NOTHING may change. Same root node, no scrim, no message.
 *     `warm` already paints for a whole round trip; a 503 does not make the mail on this
 *     device less real, and dimming it for 600 ms is the flicker in another shape.
 *   · when the ladder runs OUT, the overlay appears AND the mail stays in the DOM. The reader
 *     keeps what their device holds and is told the check did not finish.
 */
describe("the warm mirror survives the ladder", () => {
  it("checking never disturbs the mailbox: same node, no overlay", async () => {
    rememberOwner(ACCOUNT);
    scriptSession(db503, sessionFull);
    const el = await mountCloudShell();

    const before = shellRoot(el);
    expect(before, "the warm open did not happen, so this proves nothing").not.toBeNull();
    expect(overlay(el), "a retry in flight dimmed the mailbox").toBeNull();
    expect(showsEnded(el)).toBe(false);

    // Mid-ladder: past the first failure, before the second answer.
    await tick(1_000);
    expect(overlay(el), "a retry in flight dimmed the mailbox").toBeNull();
    expect(shellRoot(el)!.isSameNode(before), "the engine was rebuilt by a transient").toBe(true);

    await tick(LADDER_MS);
    expect(showsEnded(el)).toBe(false);
    expect(shellRoot(el)!.isSameNode(before), "the confirmation re-mounted the shell").toBe(true);
    /*
     * AND THE RETRY ACTUALLY HAPPENED. Without this the case passes when the ladder is removed
     * outright: the warm mirror is on screen BEFORE the first answer, so "same node, no
     * overlay, no verdict" is true of a shell that simply gave up and left the mirror sitting
     * there. Every negative assertion above is satisfied by doing nothing at all.
     */
    expect(sessionCalls(), "the warm path never re-asked — the ladder did not run").toBe(2);
  });

  /**
   * ═══ AND A SCHEDULED ENGINE IS NOT A MERGING ENGINE ═════════════════════════════════════
   *
   * The mirror is NAMED for the remembered account, `SyncResponse` carries no identity, and the
   * engine writes whatever comes back straight into it. So a warm tab that keeps its scheduler
   * running while the confirm fails is a tab merging whatever session the cookie jar holds into
   * somebody else's mirror — bounded to the ladder at `checking` and unbounded at `unconfirmed`.
   *
   * These read `syncCalls()`, which is only meaningful because the fixture's `/sync` now serves
   * a REAL page: it used to answer a shape the engine cannot flatten, so every drain in this
   * file threw before reaching the store and a zero-merge assertion would have been green with
   * the gate deleted. Case 9 is the control that proves the page merges.
   */
  it("CROSS-ACCOUNT at checking: nothing is merged before the server names the account", async () => {
    rememberOwner(ACCOUNT);
    // The jar's session belongs to somebody else — the shared-browser shape the session check exists for.
    scriptSession(db503, () => sessionFull("acct_SOMEONE_ELSE"));
    scriptSync(() => syncPage("SUBJECT-FROM-ANOTHER-ACCOUNT", "acct_SOMEONE_ELSE"));
    const el = await mountCloudShell();

    await tick(LADDER_MS);
    expect(syncCalls(), "a drain ran before the server named the account").toBe(0);
    expect(el.textContent, "another account's mail was merged into this mirror")
      .not.toContain("SUBJECT-FROM-ANOTHER-ACCOUNT");
    // The session check still ends the tab on the mismatch, and it ends it with the mirror gone.
    expect(showsEnded(el), "the mismatch did not end the tab").toBe(true);
    expect(shellRoot(el), "a mismatched session kept the mailbox on screen").toBeNull();
  });

  it("CROSS-ACCOUNT at unconfirmed: the ladder runs out and still nothing is merged", async () => {
    rememberOwner(ACCOUNT);
    scriptSession(db503);
    scriptSync(() => syncPage("SUBJECT-FROM-ANOTHER-ACCOUNT", "acct_SOMEONE_ELSE"));
    const el = await mountCloudShell();

    // `unconfirmed` is bounded in BYTES, not in time: a tab may sit here indefinitely.
    await tick(LADDER_MS + 60_000);
    expect(syncCalls(), "an unconfirmed tab merged pages for a whole minute").toBe(0);
    expect(showsUnconfirmed(el)).toBe(true);
    expect(el.textContent).not.toContain("SUBJECT-FROM-ANOTHER-ACCOUNT");
    expect(shellRoot(el), "the device's own copy was taken off screen").not.toBeNull();
  });

  /**
   * THE NEGATIVE CONTROL, and the guard against a gate welded shut. Remove `confirmSyncOwner`
   * and this goes to zero — which is the only thing separating "correctly refuses" from
   * "never syncs at all".
   */
  it("NEGATIVE CONTROL: the same account's page merges, but only after the 200", async () => {
    rememberOwner(ACCOUNT);
    scriptSession(db503, sessionFull);
    scriptSync(() => syncPage("SUBJECT-FROM-THIS-ACCOUNT"));
    const el = await mountCloudShell();
    const before = shellRoot(el);
    expect(before, "the warm open did not happen, so this proves nothing").not.toBeNull();

    expect(syncCalls(), "a drain ran before the confirm answered").toBe(0);
    expect(overlay(el), "a retry in flight dimmed the mailbox").toBeNull();

    await tick(LADDER_MS);
    expect(sessionCalls(), "the ladder did not run").toBe(2);
    expect(syncCalls(), "the gate never opened — this mailbox would never sync").toBeGreaterThanOrEqual(1);
    expect(el.textContent, "the account's own page did not reach the screen")
      .toContain("SUBJECT-FROM-THIS-ACCOUNT");
    expect(shellRoot(el)!.isSameNode(before), "opening the gate re-mounted the shell").toBe(true);
    expect(showsEnded(el)).toBe(false);
  });

  /**
   * 7b — THE MID-USE FLIP, which is the case the session check cannot reach at all.
   *
   * A tab confirmed for A keeps polling under whatever cookie the jar holds, and nothing
   * re-runs the confirm on a live binding — `ready` carries no owner. So when the browser
   * signs into B in another tab, the API rewrites `tf_owner`, and this tab merged B's log into
   * A's mirror for as long as it lived. The gate reads the jar on every tick, so a present
   * cookie naming somebody else latches the loop terminal and the strip says so.
   */
  it("a mid-use owner flip stops the loop and says so", async () => {
    rememberOwner(ACCOUNT);
    scriptSession(sessionFull);
    scriptSync(() => syncPage("SUBJECT-FROM-THIS-ACCOUNT"));
    const el = await mountCloudShell();
    await tick(2_000);
    const before = syncCalls();
    expect(before, "the control never drained, so the stop below proves nothing")
      .toBeGreaterThanOrEqual(1);

    // Another tab of the same profile signs in as somebody else; the API rewrites the jar.
    rememberOwner("acct_SOMEONE_ELSE");
    await tick(60_000);
    expect(syncCalls(), "the tab kept merging another account's log into this mirror")
      .toBe(before);
    expect(el.textContent, "the strip did not say the loop had stopped")
      .toContain(messages.sync.stopped);
    // A strip line is allowed here; a dialog is not — the mail on screen is still this
    // device's own copy of A's mailbox, and nothing about it has been disproved.
    expect(showsEnded(el)).toBe(false);
  });

  it("unconfirmed keeps the mail on screen under the notice", async () => {
    rememberOwner(ACCOUNT);
    scriptSession(db503);
    const el = await mountCloudShell();
    const before = shellRoot(el);
    expect(before).not.toBeNull();

    await tick(LADDER_MS);
    expect(showsUnconfirmed(el), "the exhausted ladder said nothing").toBe(true);
    expect(showsEnded(el), "the exhausted ladder claimed the session had ended").toBe(false);
    expect(overlay(el), "the notice did not block the stale mailbox").not.toBeNull();
    expect(shellRoot(el), "the mail was torn down — the original defect").not.toBeNull();
    expect(shellRoot(el)!.isSameNode(before), "the mail on screen is not the mail from before")
      .toBe(true);
  });
});

/**
 * ═══ THE GUARDS ON THE FIX — green BEFORE it and green after ═══════════════════════════════
 *
 * A bounded retry is only correct if it does not slow down an answer the server actually gave.
 * These two passed before this slice and must keep passing: they are how a "retry everything"
 * regression gets caught.
 */
describe("an ANSWERED refusal is still immediate", () => {
  /**
   * CASE 7 — an enrollment-scoped session. The server said so, in a 200.
   *
   * "Zero pending timers" is asserted as what it MEANS rather than as `getTimerCount()`: the
   * shell arms unrelated timers of its own (the build watch, the sync scheduler), so a raw
   * count would be measuring those. Thirty seconds of clock with no further session read is
   * the observable form of "no ladder was armed".
   */
  it("scope enrollment: the verdict on the first ask, and no ladder", async () => {
    scriptSession(sessionEnrollment);
    const el = await mountCloudShell();

    expect(showsEnded(el), "an answered refusal did not reach the verdict").toBe(true);
    expect(sessionCalls(), "the verdict cost more than one ask").toBe(1);
    expect(showsUnconfirmed(el)).toBe(false);

    await tick(LADDER_MS);
    expect(sessionCalls(), "a ladder was armed behind an answered refusal").toBe(1);
    expect(showsEnded(el)).toBe(true);
  });

  /**
   * CASE 8 — the one refusal that IS a verdict: a coded 401 from `POST /auth/refresh`.
   *
   * The server stating the refresh family is revoked and the jar cleared. There is no stronger
   * confirmation to wait for, so this must not be retried — a person whose session really has
   * ended may not be made to watch four asks first.
   */
  it("coded 401 confirmed by a coded 401 from the refresh: the verdict on attempt one", async () => {
    scriptSession(coded401);
    scriptRefresh(coded401);
    const el = await mountCloudShell();

    expect(showsEnded(el), "a revoked family was not reported").toBe(true);
    expect(sessionCalls(), "the verdict cost more than one ask").toBe(1);
    expect(refreshCalls(), "the recovery path was tried more than once").toBe(1);
    expect(sessionIsDead(), "the death store was not told about a revoked family").toBe(true);

    await tick(LADDER_MS);
    expect(sessionCalls(), "a ladder was armed behind a revoked family").toBe(1);
    expect(showsEnded(el)).toBe(true);
  });
});
