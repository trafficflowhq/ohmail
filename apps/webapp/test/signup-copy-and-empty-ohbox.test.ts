/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import messages from "../messages/en.json";
import {
  ISO,
  answerSyncWith,
  installShellEnv,
  page,
  mailbox,
  mountShell,
  teardownShellEnv,
  textOf,
  tick,
} from "./fixtures/live-walk-shell";

/**
 * (the code half) — TWO SMALL THINGS THE WALK FOUND, WHICH ARE THE SAME THING TWICE.
 *
 * ── 1. THE SIGNUP ACCOUNT STEP SAID ONE SENTENCE TWICE, FOUR LINES APART ────────────────
 *
 * `JoinScreen`'s account step renders `step_account_lead`, then a label, then an input, then
 * `emailHintOpen`. On the open path those were:
 *
 *     This is your ohmail sign-in. It is not a new email address — your mail stays where it is.
 *     …
 *     Where we will reach you about your account. It is not a new email address.
 *
 * Saying it twice in the same eyeful does not reassure; it makes the reader wonder which one
 * they misread. The lead keeps it, because the lead is where the misconception lives and it is
 * the version that also says what DOES happen to their mail.
 *
 * ── 2. AN EMPTY OHBOX WAS TWO HEADINGS AND NOTHING ELSE ─────────────────────────────────
 *
 * The pane rendered "New" and "Earlier" unconditionally, and its empty-state component
 * (`SyncState`) returned `null` unless `screenerCandidate` — which requires mail to have landed
 * and the mirror to have settled, and is therefore FALSE for the whole of a first sync. On a
 * live account that is a first sync's many minutes, and what was on screen for it was the two words
 * "New" and "Earlier" over a blank column. A heading asserts that a section follows; two
 * headings over nothing read as a screen that failed to load.
 *
 * ── WHY THE TWO ARE IN ONE FILE ─────────────────────────────────────────────────────────
 *
 * They are one finding in the audit and one defect in kind: the product stating something that
 * is not so — once by repetition, once by a label with nothing under it. The guards are
 * separate and fail independently.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────────────────
 *
 * the other two items are owner decisions, not code: the Stripe checkout's public business
 * name, and whether the beta is invite-only (login says it is; `/join` accepted a signup with
 * no code). **Nothing in this file asserts either way about invite-only**, because writing a
 * test for it would be picking a side nobody has picked yet, and the copy would then have
 * a guard holding it in place.
 */

const JOIN = messages.join as unknown as Record<string, string>;

/**
 * The strings the account step actually renders, in order — `JoinScreen.tsx:526-545`. Both
 * branches, because `emailHint` / `emailHintOpen` is a `needsInvite` ternary and a duplicate
 * on either path is the same defect.
 */
const ACCOUNT_STEP = (invite: boolean): string[] => [
  JOIN.step_account_title!,
  JOIN.step_account_lead!,
  JOIN.emailLabel!,
  invite ? JOIN.emailHint! : JOIN.emailHintOpen!,
  JOIN.nameLabel!,
  JOIN.passwordLabel!,
  JOIN.passwordHint!,
];

describe("the signup account step says it once", () => {
  it("'not a new email address' appears exactly once on the step, on either path", () => {
    /**
     * Mutation: restore ". It is not a new email address" to `join.emailHintOpen`. The open
     * branch then counts 2 and fails.
     *
     * Counted over the SENTENCE rather than the key, so moving the duplicate to a different
     * string on the same step does not slip through, and so a rewording of the lead that keeps
     * the phrase is still allowed exactly one home.
     */
    for (const invite of [true, false]) {
      const hits = ACCOUNT_STEP(invite).filter((s) => /not a new email address/i.test(s));
      expect(hits, `${invite ? "invite" : "open"} path repeats the sentence`).toHaveLength(1);
    }
    // And it is the LEAD that keeps it — the version that also says what happens to their mail.
    expect(JOIN.step_account_lead).toMatch(/not a new email address/i);
    expect(JOIN.emailHintOpen).not.toMatch(/not a new email address/i);
    // The hint still has to say something true about the field it sits under.
    expect(JOIN.emailHintOpen).toMatch(/account/i);
  });
});

describe("an empty Ohbox says it is empty", () => {
  beforeEach(installShellEnv);
  afterEach(teardownShellEnv);

  it("no rows means no group headings, and one line saying so", async () => {
    // Mounted through the real shell on a mailbox that has never completed a cycle: no "New"/"Earlier" over an empty
    // column, no empty listbox to land in, and the pane's own one line.
    const c = await mountShell([mailbox({ lastSyncAt: null, createdAt: ISO })]);
    await tick(0);

    expect(c.querySelectorAll(".row[data-id]").length, "the premise: no mail").toBe(0);
    expect([...c.querySelectorAll(".grouplabel")].map((n) => n.textContent)).toEqual([]);
    expect(c.querySelectorAll(".rows[role=listbox]").length, "an empty listbox to land in").toBe(0);
    expect(textOf(c)).toContain("Nothing in your Ohbox.");

    // The pane says what it owns and no more: WHY the list is empty is the frame's notice, which says the first sync.
    expect(textOf(c)).toContain(messages.frame.connection.firstSync.title);

    // One empty state, not two: no "Nothing open." beside "Nothing in your Ohbox.".
    expect(c.querySelector(".read-col")?.textContent ?? "", "a second empty state").toBe("");
  });

  it("and a heading comes back the moment there is something under it", async () => {
    // The other half of "never weaken an assertion": suppressing an EMPTY group must not have
    // suppressed a full one. Red if either label is deleted rather than made conditional.
    //
    // Two unread messages and no read ones, so exactly ONE group is populated — which also
    // pins the narrower claim: the heading that appears is the heading whose rows exist.
    answerSyncWith(() => page(2, "INBOX"));
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);

    expect(c.querySelectorAll(".row[data-id]").length, "the premise: mail arrived").toBe(2);
    expect([...c.querySelectorAll(".grouplabel")].map((n) => n.textContent)).toEqual(["New"]);
    expect(textOf(c)).not.toContain("Nothing in your Ohbox.");
  });
});
