/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import messages from "../messages/en.json";
import {
  ISO,
  goTo,
  installShellEnv,
  mailbox,
  mountShell,
  teardownShellEnv,
  textOf,
  tick,
} from "./fixtures/live-walk-shell";

/**
 * THE FIRST-SYNC STRIP SAID TWO THINGS, AND NEITHER WAS TRUE.
 *
 * ── WHAT WAS WALKED ON THE HOSTED SERVICE, 2026-08-04 ───────────────────────────────────
 *
 * A Cloud trial with a real IMAP mailbox. The strip said:
 *
 *     Waiting for the first mail to arrive. A first sync takes a few minutes.
 *
 * The first sync took **~25 minutes**. And past the ten-minute escalation it said:
 *
 *     Still nothing has arrived.
 *
 * while FIVE messages were sitting in INBOX and the worker had already moved one of them on
 * the server. So the sentence was not merely stale; it made a claim about the MAILBOX, which
 * is the one thing this client cannot see. `deriveMailState`'s `awaiting` arm fires on
 * `lastSyncAt === null` for every connected mailbox and an empty mirror — "no sync cycle has
 * finished", which is a fact about US. Everything the copy is allowed to say has to fit inside
 * that.
 *
 * ── THE DURATION, AND WHY THERE IS NOW NO NUMBER AT ALL ─────────────────────────────────
 *
 * "A few minutes" was not invented; it was measured. `mail-state.ts`'s own note records
 * `mailbox_attach_started → mailbox_attached` at a few minutes for an ordinary mailbox,
 * twice, in production. Two samples at ~6 minutes and one walked observation at ~25 is not a
 * distribution, and a p90 is what a duration promise needs. Two points and an outlier support
 * no number, so the copy names none — the strip already renders the ELAPSED time beside the
 * sentence, which is the honest form of the same information and cannot go stale.
 *
 * ── WHY THIS FILE AND NOT `sync-progress.test.ts` ───────────────────────────────────────
 *
 * That file owns the LADDER — which state fires when, and that a healthy six-minute wait is not
 * escalated. Its assertions were updated to the new strings because they quote them. This file
 * owns something the ladder cannot express: that whatever these two sentences are rewritten to
 * next, they may not promise a duration and may not speak about arrival. It is asserted as a
 * SHAPE, so a future rewording that reintroduces either claim in different words still fails.
 */

/** Every sentence the strip can render about a first sync. */
const SYNC = messages.sync as unknown as Record<string, string>;

describe("the first-sync strip speaks about the sync, not about arrival", () => {
  beforeEach(installShellEnv);
  afterEach(teardownShellEnv);

  it("no sentence in the strip promises how long a first sync takes", () => {
    /**
     * The mutation: restore "A first sync takes a few minutes." to `sync.awaiting`. The
     * `\ba few\b` and `\bminutes\b` arms both catch it.
     *
     * Scoped to the whole `sync` namespace rather than the two keys, because the defect is not
     * that ONE string named a duration — it is that the product made a promise it has no
     * measurement for, and the next place to make it is the next key added here.
     */
    for (const [key, value] of Object.entries(SYNC)) {
      // The elapsed-time keys are exempt BY NAME and only these: they report a measured past,
      // not a predicted future. "connected 4 minutes ago" is a fact; "takes a few minutes" is
      // a forecast.
      if (key === "awaitingWhere" || key === "awaitingFor") continue;
      if (key === "sinceMinutes" || key === "sinceHours") continue;
      expect(value, `sync.${key} forecasts a duration`).not.toMatch(
        /\b(a few|a couple of|several|about (a|an|\d)|usually|normally|typically)\b/i,
      );
      expect(value, `sync.${key} names a duration for work that has not finished`).not.toMatch(
        /\b(takes|should take|will take|takes about)\b/i,
      );
    }
  });

  it("neither first-sync sentence claims anything about what has or has not arrived", () => {
    // The walked falsehood: five messages were in INBOX while the strip said nothing had
    // arrived. This client cannot see the mailbox, so no sentence it renders may describe it.
    expect(SYNC.awaiting).not.toMatch(/arriv/i);
    expect(SYNC.awaitingSlow).not.toMatch(/arriv/i);
    expect(SYNC.awaiting).not.toMatch(/\bnothing\b/i);
    expect(SYNC.awaitingSlow).not.toMatch(/\bnothing\b/i);
    // …and both must speak about the thing this client CAN see.
    expect(SYNC.awaiting).toMatch(/sync/i);
    expect(SYNC.awaitingSlow).toMatch(/sync/i);
  });

  it("the shipped shell renders it, on a mailbox that has never completed a cycle", async () => {
    // Through the real shell, because the string being right in the catalogue and the string being on screen are two
    // different claims. The frame says the waiting first sync as its First sync, with today's line beside it.
    const c = await mountShell([mailbox({ lastSyncAt: null, createdAt: ISO })], { mailboxesNotices: true });
    await goTo("settings/mailboxes");
    await tick(0);

    expect(textOf(c)).toContain(messages.frame.connection.firstSync.title);
    expect(textOf(c)).not.toContain("takes a few minutes");
    expect(textOf(c), "an unfinished first sync was reported as a failure").not.toMatch(
      /failed|error|broken/i,
    );
    // The elapsed time is still beside it — dropping the forecast must not drop the fact.
    await tick(240_000);
    expect(textOf(c)).toContain("connected 4 minutes ago");
  });
});
