/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";
import { LOADING_GRACE_MS } from "@ohmail/app-logic/session/loading-grace";
import type { OwnerOutcome } from "../app/shell/engine";
import {
  ISO,
  answerStoreWith,
  answerSyncWith,
  installShellEnv,
  mailbox,
  mountShell,
  page,
  teardownShellEnv,
  textOf,
  tick,
} from "./fixtures/live-walk-shell";

/**
 * ═══ "NO MESSAGES" IS NOT SOMETHING THE APP MAY SAY BEFORE IT HAS LOOKED ═══════════════════
 *
 * Reported 2026-08-04: *"when opening ohmail.app logged in with a not so fast internet connection,
 * I see 'no messages', this is not optimal and sometimes takes several seconds to load, it should
 * actually load instantly optimally out from cache or so, or in case of loading actually show
 * loading messages."*
 *
 * ── WHAT WAS ON SCREEN, MEASURED AGAINST THE SHIPPED SHELL ──────────────────────────────
 *
 * This file's own harness, with `/sync` held open and one connected mailbox. The first paint and
 * the paint five seconds later were identical:
 *
 *     Ohbox · 0 unread of 0 messages · All clear · ✉ Nothing in your Ohbox.
 *
 * Three separate claims about the user's own mail, made before the first drain had returned a
 * byte, on an account the live truth suite was running against, with real mail in it and
 * senders waiting in the Screener pile. The sync strip said nothing at all, because `deriveMailState` falls
 * through to `quiet` for a returning user whose mailbox has synced before.
 *
 * ── WHAT THIS FILE OWNS, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────────────
 *
 * It owns the RENDERED SURFACE. The whole defect is what a person sees, and every previous
 * repair in this area shipped because the fix was proven against a store or
 * a pure function while the pane went on saying the old thing. So every assertion below is
 * `textContent` of the real `AppShell`, mounted behind the providers the Cloud entry uses.
 *
 * `mail-state.test.ts` owns the derivation of `settled` itself. The two are not the same
 * property: a flag can be correct and unread.
 *
 * ── THE THIRD STATE IS NOT TRADED FOR A FOURTH ──────────────────────────────────────────
 *
 * The last two cases are the other half of the contract and are the reason this is not simply
 * "assert a spinner": a genuinely empty mailbox must still read as empty, promptly, and a
 * loading state must never be a spinner nobody can escape.
 */

/** Every sentence the Ohbox can put in its empty pane. */
const OHBOX = messages.ohbox as unknown as Record<string, string>;
/** The `=0` arms — the two claims that are made in smaller type than the empty pane's. */
const ALL_CLEAR = "All clear";
/* The Ohbox header's zero form. It read "0 new" until this line's count took its noun — the
   number is `unreadIds.length`, and "new" now belongs to the streams' waterline sentence
   (`ohbox.meta`, and `test/waterline-word.test.tsx`). What this file is about is unchanged:
   whether the claim is made at all before the mirror has been read. */
const ZERO_META = "0 unread";

/**
 * A `/sync` that never answers — a slow connection, held open, for as long as the test wants.
 *
 * Installed OVER the harness's own fetch, which answers instantly. The distinction is the whole
 * subject of this file: with an instant `/sync` the pending window is one microtask wide and
 * nothing can be observed in it, which is exactly why this defect survived a green suite.
 */
function holdSync(): void {
  globalThis.fetch = vi.fn(async (input: unknown) => {
    if (String(input).includes("/sync")) return new Promise<Response>(() => {});
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

describe("a signed-in user with mail on the server is never told there is none", () => {
  beforeEach(installShellEnv);
  afterEach(teardownShellEnv);

  it("states no emptiness while the first drain is still in flight", async () => {
    holdSync();
    // `lastSyncAt` non-null: a RETURNING user, the case the ladder had no state for. A first-time
    // account reaches `awaiting` and the strip has always spoken for it.
    const el = await mountShell([mailbox({ lastSyncAt: ISO })]);

    // The pane's sentence, the meta count and the doorbell are three renderings of one claim,
    // and all three were on screen. Each is asserted by itself: a fix that removed the
    // conspicuous one and left the other two would be the same lie in smaller type.
    expect(textOf(el), "the empty pane stated a settled emptiness mid-bootstrap")
      .not.toContain(OHBOX.emptyPlain);
    expect(textOf(el), "the header counted a mailbox it had not read")
      .not.toContain(ZERO_META);
    expect(textOf(el), "the doorbell declared the Screener clear before reading it")
      .not.toContain(ALL_CLEAR);

    // …and it is still true after the grace, when the pane has started speaking. The window is
    // not merely narrowed, it is closed.
    await tick(LOADING_GRACE_MS * 4);
    expect(textOf(el)).not.toContain(OHBOX.emptyPlain);
    expect(textOf(el)).not.toContain(ZERO_META);
    expect(textOf(el)).not.toContain(ALL_CLEAR);
  });

  /**
   * ── THE FOURTH CLAIM, WHICH WAS BELOW THE FOLD AND SO OUTLIVED THE OTHER THREE ──────────
   *
   * Reported 2026-08-07: *"on first open, for up to a minute, the Ohbox says 'Nothing in your
   * Ohbox. This device keeps your recent mail. The rest is on your server. Load older mail',
   * then the mail appears."*
   *
   * The first sentence is `emptyPlain` and it was already gated. The rest is the OLDER-MAIL
   * TAIL, which is a separate block further down the pane and was gated on nothing at all: it
   * rendered whenever the client is windowed, which for the Cloud webapp is always. So the
   * pane's top said "Loading your mail." while its bottom said, as settled fact, that the
   * recent mail is on this device and the remainder is elsewhere — over a mirror that had not
   * been read once.
   *
   * `olderPrompt` is the same category of statement as `emptyPlain`: it describes where the
   * user's mail IS. It is true of a drained windowed mirror and false of an unread one, where
   * "recent" has no referent yet. `olderAction` is worse than untrue, it is a wrong INSTRUCTION
   * — the newest mail is mid-flight, and the one control offered points backwards, past it.
   */
  it("makes no claim about where the mail is kept while the mirror is unread", async () => {
    holdSync();
    const el = await mountShell([mailbox({ lastSyncAt: ISO })]);

    expect(textOf(el), "offered to page backwards before the newest mail had landed")
      .not.toContain(OHBOX.olderAction);

    await tick(LOADING_GRACE_MS * 4);
    expect(textOf(el)).not.toContain(OHBOX.olderAction);
  });

  it("says it is loading once the wait stops being an ordinary one", async () => {
    holdSync();
    const el = await mountShell([mailbox({ lastSyncAt: ISO })]);

    // Below the grace: a quiet frame, which is what `engine.tsx` argues for and what a fast
    // connection gets. Silence is only defensible because the FALSE sentence is gone above.
    expect(textOf(el), "a sentence flashed on a connection fast enough not to need one")
      .not.toContain(OHBOX.loading);

    await tick(LOADING_GRACE_MS + 50);
    expect(textOf(el), "several seconds in, the app still would not say what it was doing")
      .toContain(OHBOX.loading);
  });

  it("says nothing about what it will find — no invented mail, no fabricated count", async () => {
    holdSync();
    const el = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(LOADING_GRACE_MS * 4);
    const text = textOf(el);

    /**
     * THE HAZARD THIS PRODUCT MUST NOT SOLVE A LOADING PROBLEM WITH. `MailStateProvider` and
     * `engine-config.ts` both exist because a plausible-looking placeholder rendered as if it
     * were the user's own mail is the worst failure shape here — `EngineUnarmedError` was
     * written for exactly that. A skeleton row carrying a name, or a count invented to fill the
     * meta slot, would answer the report by creating it.
     *
     * The list is empty and stays empty; only the SENTENCE changes.
     */
    expect(el.querySelectorAll(".row").length, "rendered rows for mail it had not read").toBe(0);
    expect(text).not.toContain("messages so far");
    // No number at all in the header while there is no number to give.
    expect(text).not.toMatch(/\d+\s+new\b/);
  });

  it("a genuinely empty mailbox reads as empty as soon as the drain lands", async () => {
    // The harness's own `/sync` — an immediate, empty, `hasMore: false` page: an Ohbox with no
    // mail in it, and the honest answer is the settled one. The STORE still holds older mail
    // this device never took in, so the way back is owed (with nothing older, it is not — the
    // case below this one).
    answerStoreWith([{ id: "old-1", date: "2025-03-01T09:00:00.000Z" }]);
    const el = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(LOADING_GRACE_MS * 4);

    expect(textOf(el), "an empty mailbox was left spinning").toContain(OHBOX.emptyPlain);
    expect(textOf(el), "the count never came back").toContain(ZERO_META);
    expect(textOf(el), "the doorbell never came back").toContain(ALL_CLEAR);
    expect(textOf(el)).not.toContain(OHBOX.loading);
    // AND THE WAY BACK COMES BACK WITH THEM. The repair above is a delay, not a deletion: a
    // fix that simply removed the block would pass every `not.toContain` in this file and take
    // the feature with it. (The sentence naming a device went with ARCHIVE-024.)
    expect(textOf(el), "the way back to older mail never returned")
      .toContain(OHBOX.olderAction);
  });

  it("an empty store offers no older mail: there is none", async () => {
    // the shape at its smallest: the store holds nothing this device does not, so an
    // offer to load older mail is an offer that cannot be kept.
    const el = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(LOADING_GRACE_MS * 4);

    expect(textOf(el)).toContain(OHBOX.emptyPlain);
    expect(textOf(el), "offered older mail over a store holding none").not.toContain(OHBOX.olderAction);
  });

  it("a drained mailbox with mail in it renders rows, and the tail below them", async () => {
    // The third state, and the one a gate is most likely to break silently: the whole pane in
    // its ordinary condition. `settled` now gates two blocks rather than one, and a boolean
    // that never goes true is indistinguishable from a boolean that is read correctly, for as
    // long as every guard in the file asserts an ABSENCE. The store holds mail older than the
    // window, so the tail is owed.
    answerStoreWith([{ id: "old-1", date: "2025-03-01T09:00:00.000Z" }]);
    answerSyncWith(() => page(3));
    const el = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(LOADING_GRACE_MS * 4);

    expect(el.querySelectorAll(".row").length, "the drain landed and no mail was rendered")
      .toBeGreaterThan(0);
    expect(textOf(el), "mail on screen and the pane still claimed to be loading")
      .not.toContain(OHBOX.loading);
    expect(textOf(el), "mail on screen and the pane also claimed to be empty")
      .not.toContain(OHBOX.emptyPlain);
    expect(textOf(el), "no way back past the newest slice this device kept")
      .toContain(OHBOX.olderAction);
  });

  it("the session gate stays a quiet frame, then says what it is waiting for", async () => {
    /**
     * The FIRST of the two round trips, and the one the panes above cannot cover: until
     * `GET /auth/session` answers there is no engine, because the persistent mirror is named
     * for a server-verified account id (`engine-config.ts`, `idb.ts` — the cross-account leak).
     * `engine.tsx` rendered a blank busy div for the whole of it on the argument that it is
     * "a fraction of a second". On a slow connection it is seconds of nothing.
     *
     * Both halves are asserted, because a fix that simply added text would reintroduce the
     * flash the original argument was right about.
     */
    const el = await mountShell([mailbox({ lastSyncAt: ISO })], {
      resolveOwner: () => new Promise<OwnerOutcome>(() => {}),
    });

    expect(textOf(el), "the gate flashed a sentence at a connection that did not need one")
      .not.toContain(messages.session.opening);

    await tick(LOADING_GRACE_MS + 50);
    expect(textOf(el), "seconds of a blank page with nothing to explain it")
      .toContain(messages.session.opening);
    // Still a gate, not a mailbox: nothing claims to know anything about this account's mail.
    expect(textOf(el)).not.toContain(OHBOX.emptyPlain);
    expect(textOf(el)).not.toContain(ZERO_META);
  });

  it("does not spin for ever when the drains are failing — the strip explains instead", async () => {
    // A loop that fails every time. `bootstrapping` never clears, so a `settled` keyed on it
    // ALONE would hold the loading state open until the tab was closed: one lie for another.
    globalThis.fetch = vi.fn(async (input: unknown) => {
      if (String(input).includes("/sync")) throw new Error("network down");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const el = await mountShell([mailbox({ lastSyncAt: ISO })]);

    // Past the failure streak — the point at which the strip starts speaking for itself.
    await tick(120_000);

    expect(textOf(el), "the pane was still claiming to be loading a mirror nothing can fill")
      .not.toContain(OHBOX.loading);
    expect(textOf(el), "the empty pane never settled").toContain(OHBOX.emptyPlain);
    // And the reason is on screen, from the one surface entitled to say it.
    expect(textOf(el), "no surface explained why the mirror is frozen")
      .toContain(messages.sync.failing);
  });
});
